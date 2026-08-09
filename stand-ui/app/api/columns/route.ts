/**
 * GET /api/columns?table_fqn=DB.SCHEMA.TABLE
 *
 * Returns column ordinal positions from Snowflake INFORMATION_SCHEMA.COLUMNS
 * for the given fully-qualified table.
 *
 * Access model: tries the service connection first. INFORMATION_SCHEMA shows
 * zero rows (not an error) for tables the role can't see, so an empty result
 * falls back to the caller's PERSONAL Snowflake connection when they have one
 * saved — this is what lets a user run one-time standardizations on tables
 * Prism itself was never granted. The response's `connection` field tells the
 * client which one succeeded; `needs_user_connection: true` means the service
 * role can't see the table and no personal credentials are saved.
 */

import { withWarehouse, withUserWarehouse, hasUserWarehouseConfig, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getPrimaryKeyColumns, isCtEnabled } from '@/app/api/_lib/warehouse/mssql/detection';

// This response depends on which account/connection is calling — never let
// the browser (or an intermediary) reuse a cached response across accounts.
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

function json(body: any, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

async function fetchColumns(conn: any, db: string, schema: string, table: string) {
  const rows = await exec(conn,
    `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE
     FROM ${db}.INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
  );
  // `columns` (name → ordinal) is kept for existing callers; `fields` carries
  // the type info the pipeline-creation column picker needs. Snowflake reports
  // VARCHAR/CHAR/STRING all as 'TEXT'; SQL Server reports the concrete type
  // (VARCHAR/NVARCHAR/…) — both sets are standardizable text.
  // TEXT / NTEXT are deliberately EXCLUDED, even though they hold text.
  //
  // SQL Server cannot GROUP BY, SELECT DISTINCT or compare those legacy LOB
  // types, and every mssql scan/export path uses bare column references —
  // live-reproduced: GROUP BY on a TEXT column throws Msg 306, SELECT DISTINCT
  // on NTEXT throws Msg 421. Offering them let a user create a pipeline that
  // then failed at detection/export time, well after the point where the error
  // was explainable (PIPE-01). They have been deprecated by Microsoft for years;
  // the fix for a customer who has one is `ALTER TABLE … ALTER COLUMN <c>
  // NVARCHAR(MAX)`, not something Prism can paper over with a CAST — a CAST
  // would still have to be threaded through detection, staging and export
  // identically on every path, and any one miss reintroduces the same late
  // failure.
  const MSSQL_TEXT = new Set(['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR']);
  const MSSQL_UNSUPPORTED_TEXT = new Set(['TEXT', 'NTEXT']);
  const isTextType = (t: string) =>
    getWarehouseAdapter().kind === 'mssql' ? MSSQL_TEXT.has(t) : t === 'TEXT';
  // Object.create(null) — keyed by column names read from the customer's
  // catalog. A source column literally named __proto__ is legal in both
  // warehouses and would otherwise be silently dropped from the picker.
  const columns: Record<string, number> = Object.create(null);
  const fields: { name: string; type: string; isText: boolean; unsupportedReason?: string }[] = [];
  for (const row of rows) {
    const name = String(row.COLUMN_NAME ?? row.column_name ?? '').toUpperCase();
    const pos  = Number(row.ORDINAL_POSITION ?? row.ordinal_position ?? 0);
    const type = String(row.DATA_TYPE ?? row.data_type ?? '').toUpperCase();
    if (name) {
      columns[name] = pos;
      const unsupportedReason =
        getWarehouseAdapter().kind === 'mssql' && MSSQL_UNSUPPORTED_TEXT.has(type)
          ? `${type} columns can't be standardized — SQL Server can't group or compare this legacy type. Convert it with: ALTER TABLE … ALTER COLUMN ${name} NVARCHAR(MAX);`
          : undefined;
      fields.push({ name, type, isText: isTextType(type), ...(unsupportedReason ? { unsupportedReason } : {}) });
    }
  }
  return { columns, fields };
}

/**
 * mssql only — a dry status check (no side effects, never attempts to enable
 * anything): 'no_pk' when Change Tracking can't be enabled at all (SQL
 * Server requires a primary key), 'enabled' when it's already on, 'available'
 * when it could be enabled but isn't yet. Drives the connect-form disclosure
 * that offers to enable it with explicit consent.
 */
async function fetchMssqlCtStatus(conn: any, fqn: string): Promise<'enabled' | 'available' | 'no_pk'> {
  const pkCols = await getPrimaryKeyColumns(conn, fqn);
  if (pkCols.length === 0) return 'no_pk';
  const ct = await isCtEnabled(conn, fqn);
  return ct.db && ct.table ? 'enabled' : 'available';
}

export async function GET(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const session = authz;
  const { searchParams } = new URL(request.url);
  const table_fqn = searchParams.get('table_fqn')?.trim() ?? '';
  // Which surface is asking. The remedy for "Prism can't see this table"
  // DIFFERS by caller and the route cannot infer it: the one-time flow can fall
  // back to the user's OWN credentials (so "connect your credentials" is
  // actionable, and that card renders a /setup link), whereas a PIPELINE always
  // runs on the service connection — personal credentials would not help it, so
  // telling a pipeline user to connect them is advice they cannot act on, and
  // the connect form deliberately renders no /setup link. The message used to
  // be written for the one-time case and shown to both (PIPE-01).
  const surface = searchParams.get('for') === 'pipeline' ? 'pipeline' : 'one_time';

  if (!table_fqn) {
    return json({ error: 'table_fqn is required' }, 400);
  }

  const parts = table_fqn.split('.');
  if (parts.length !== 3) {
    return json({ error: 'table_fqn must be DATABASE.SCHEMA.TABLE' }, 400);
  }

  const [db, schema, table] = parts.map(p => p.trim().replace(/^"|"$/g, '').toUpperCase());

  const isMssql = getWarehouseAdapter().kind === 'mssql';

  try {
    // 1. Service connection (covers everything granted to PRISM_SERVICE).
    let result: { columns: Record<string, number>; fields: any[]; ct_status?: 'enabled' | 'available' | 'no_pk' } | null = null;
    try {
      const viaService = await withWarehouse(async (conn) => {
        const cols = await fetchColumns(conn, db, schema, table);
        const ct_status = isMssql ? await fetchMssqlCtStatus(conn, table_fqn) : undefined;
        return { ...cols, ct_status };
      });
      if (viaService.fields.length > 0) {
        return json({ ...viaService, connection: 'service' });
      }
    } catch (serviceErr) {
      // Service connection itself broken — fall through to the personal one
      // if available; otherwise surface the sanitized error.
      if (!hasUserWarehouseConfig(Number(session.accountId))) throw serviceErr;
    }

    // 2. Personal connection fallback (one-time standardization use case).
    if (hasUserWarehouseConfig(Number(session.accountId))) {
      result = await withUserWarehouse(Number(session.accountId), async (conn) => {
        const cols = await fetchColumns(conn, db, schema, table);
        const ct_status = isMssql ? await fetchMssqlCtStatus(conn, table_fqn) : undefined;
        return { ...cols, ct_status };
      });
      if (result.fields.length > 0) {
        return json({ ...result, connection: 'user' });
      }
      // Neither connection can see it.
      return json({
        columns: {}, fields: [], connection: 'user',
        error: 'Neither Prism nor your connected Snowflake user can see this table. Check the name and your access.',
      });
    }

    // Service saw nothing and there's no personal connection to try.
    return json({
      columns: {}, fields: [], connection: 'service',
      needs_user_connection: true,
      error: surface === 'pipeline'
        ? "Prism can't see this table. Pipelines always read with Prism's own service connection, so an administrator needs to grant it access — the exact GRANT statements are in setup step 2, Part D."
        // The "stored encrypted, used only on your behalf" clause has to live
        // HERE, not only in the client's `??` fallback. The client prefers
        // body.error whenever the server sends one — which is always on this
        // path — so the fallback string carrying that disclosure was
        // unreachable, and the security doc credited a sentence no user ever
        // saw (SEC-07).
        : "Prism doesn't have access to this table, so it needs to confirm YOU have access before standardizing it. Connect your own credentials to continue — they're stored encrypted and used only on your behalf.",
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to fetch column order');
  }
}
