/**
 * GET /api/accounts/accessible-tables (native edition; any valid session) —
 * the tables the APPLICATION can currently see, for the connect/one-time
 * table pickers. Inside a Native App there is no INFORMATION_SCHEMA browsing
 * of the account: the app sees exactly what the consumer granted (directly or
 * via references), so enumeration IS the honest picture of what Prism can
 * standardize right now.
 *
 * Metadata-layer only (SHOW DATABASES / SHOW TABLES IN DATABASE — never wakes
 * a warehouse). One-shot user-clicked surface: called when a picker opens,
 * never from polling. Also returns `app_name` so the client can build the
 * copy-paste grant SQL for the "don't see your table?" panel.
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, executeQuery } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';
import { reportError } from '@/app/api/_lib/report-error';

export const dynamic = 'force-dynamic';

const MAX_TABLES = 1_000;
// Never useful as standardization sources; the app db is internal state.
const SKIP_DBS = new Set(['SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA']);

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('Accessible-table enumeration');

  try {
    return await withWarehouse(async (conn) => {
      const appRows = await executeQuery(conn, 'SELECT CURRENT_DATABASE() AS D');
      const appName = String(appRows?.[0]?.D ?? appRows?.[0]?.d ?? '');

      const dbs = (await executeQuery(conn, 'SHOW DATABASES')) as Array<Record<string, unknown>>;
      const tables: Array<{ fqn: string; db: string; schema: string; table: string }> = [];
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
          if (tables.length >= MAX_TABLES) { truncated = true; break; }
          const schema = String(r.schema_name ?? '');
          const table  = String(r.name ?? '');
          if (!schema || !table || schema.toUpperCase() === 'INFORMATION_SCHEMA') continue;
          tables.push({ fqn: `${db}.${schema}.${table}`, db, schema, table });
        }
        if (truncated) break;
      }

      return Response.json({ app_name: appName, tables, truncated });
    });
  } catch (err) {
    reportError(err, { where: 'accessible-tables' });
    return Response.json({ app_name: '', tables: [], truncated: false, error: 'Could not list accessible tables.' }, { status: 500 });
  }
}
