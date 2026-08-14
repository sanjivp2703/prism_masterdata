/**
 * GET /api/accounts/accessible-tables (native edition; any valid session) —
 * the tables Prism can currently reach, for the connect/one-time table
 * pickers. Two sources, merged (docs/NATIVE_APP_PLAN.md §2.9):
 *
 *  1. What the APPLICATION can see — the consumer's durable grants
 *     (directly or via references). These power pipelines.
 *  2. What the CALLING USER can see through the caller's-rights session
 *     (their own privileges ∩ the account's caller grants for the app).
 *     These power interactive work — one-time cleaning, probing — with no
 *     per-table admin ritual. Skipped silently when the account never
 *     opted into caller grants (the session then sees nothing extra).
 *
 * Metadata-layer only (SHOW DATABASES / SHOW TABLES IN DATABASE — never wakes
 * a warehouse). One-shot user-clicked surface: called when a picker opens,
 * never from polling. Also returns `app_name` so the client can build the
 * copy-paste grant SQL for the "don't see your table?" panel.
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, withUserWarehouse, executeQuery, NoUserWarehouseConfig } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';
import { reportError } from '@/app/api/_lib/report-error';

export const dynamic = 'force-dynamic';

const MAX_TABLES = 1_000;
// Never useful as standardization sources; the app db is internal state.
const SKIP_DBS = new Set(['SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA']);

interface AccessibleTable { fqn: string; db: string; schema: string; table: string }

/** SHOW-based enumeration of every table this connection can see (capped). */
async function enumerateTables(
  conn: unknown,
  appName: string,
  cap: number,
): Promise<{ tables: AccessibleTable[]; truncated: boolean }> {
  const dbs = (await executeQuery(conn, 'SHOW DATABASES')) as Array<Record<string, unknown>>;
  const tables: AccessibleTable[] = [];
  let truncated = false;

  for (const dbRow of dbs) {
    const db = String(dbRow.name ?? '');
    if (!db || db === appName || SKIP_DBS.has(db.toUpperCase())) continue;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = (await executeQuery(conn, `SHOW TABLES IN DATABASE "${db.replace(/"/g, '""')}"`)) as Array<Record<string, unknown>>;
    } catch {
      continue; // db visible but tables not enumerable — skip quietly
    }
    for (const r of rows) {
      if (tables.length >= cap) { truncated = true; break; }
      const schema = String(r.schema_name ?? '');
      const table  = String(r.name ?? '');
      if (!schema || !table || schema.toUpperCase() === 'INFORMATION_SCHEMA') continue;
      tables.push({ fqn: `${db}.${schema}.${table}`, db, schema, table });
    }
    if (truncated) break;
  }
  return { tables, truncated };
}

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('Accessible-table enumeration');

  try {
    // 1. App-visible tables (service connection).
    const appView = await withWarehouse(async (conn) => {
      const appRows = await executeQuery(conn, 'SELECT CURRENT_DATABASE() AS D');
      const appName = String(appRows?.[0]?.D ?? appRows?.[0]?.d ?? '');
      const { tables, truncated } = await enumerateTables(conn, appName, MAX_TABLES);
      return { appName, tables, truncated };
    });

    // 2. Caller-visible tables (caller's-rights session, §2.9) — best-effort:
    // no token / no caller grants / any failure degrades to app-only.
    const merged = new Map(appView.tables.map(t => [t.fqn, t]));
    let truncated = appView.truncated;
    if (!truncated) {
      try {
        const callerView = await withUserWarehouse(Number(auth.accountId), (conn) =>
          enumerateTables(conn, appView.appName, MAX_TABLES));
        for (const t of callerView.tables) {
          if (merged.size >= MAX_TABLES) { truncated = true; break; }
          if (!merged.has(t.fqn)) merged.set(t.fqn, t);
        }
        truncated = truncated || callerView.truncated;
      } catch (err) {
        if (!(err instanceof NoUserWarehouseConfig)) {
          console.warn('[accessible-tables] caller enumeration skipped:', (err as Error)?.message ?? err);
        }
      }
    }

    return Response.json({ app_name: appView.appName, tables: [...merged.values()], truncated });
  } catch (err) {
    reportError(err, { where: 'accessible-tables' });
    return Response.json({ app_name: '', tables: [], truncated: false, error: 'Could not list accessible tables.' }, { status: 500 });
  }
}
