/**
 * GET /api/accounts/databases (native edition; any valid session) — the
 * databases visible to this installation, for the /setup caller-grant
 * database picker. Union of what the APPLICATION can see and what the
 * CALLING USER's caller session can see (best-effort — on a fresh install,
 * before any caller opt-in, both may see little or nothing; the picker
 * pairs this list with a type-in for exactly that reason).
 *
 * Three sources, merged: SHOW DATABASES on both connections (metadata-layer,
 * free), plus — when the consumer granted the optional IMPORTED PRIVILEGES
 * ON SNOWFLAKE DB at install — the account-usage DATABASES view, which lists
 * every database NAME in the account so the picker works before any data
 * grant exists. That last source is a real SELECT (wakes PRISM_APP_WH),
 * which is acceptable here because this is a one-shot user-clicked surface:
 * called when /setup loads, never from polling. Also returns `app_name` so
 * the client can build the grant SQL.
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, withUserWarehouse, executeQuery, NoUserWarehouseConfig } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';
import { reportError } from '@/app/api/_lib/report-error';

export const dynamic = 'force-dynamic';

// Never useful as standardization sources; the app db is internal state.
const SKIP_DBS = new Set(['SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA']);
// Snowsight personal databases (USER$<name>) can't be granted to an app —
// "Granting create privilege on an object in personal database is not
// supported" — so listing them only produces a block that fails halfway
// (live-found 2026-10-04, finding #9). They are private scratch space, never
// a pipeline source.
const isSkippedDb = (db: string) => SKIP_DBS.has(db.toUpperCase()) || db.toUpperCase().startsWith('USER$');

async function enumerateDatabases(conn: unknown, appName: string): Promise<string[]> {
  const rows = (await executeQuery(conn, 'SHOW DATABASES')) as Array<Record<string, unknown>>;
  return rows
    .map(r => String(r.name ?? ''))
    .filter(db => db && db !== appName && !isSkippedDb(db));
}

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('Database enumeration');

  try {
    const appView = await withWarehouse(async (conn) => {
      const appRows = await executeQuery(conn, 'SELECT CURRENT_DATABASE() AS D');
      const appName = String(appRows?.[0]?.D ?? appRows?.[0]?.d ?? '');
      const databases = await enumerateDatabases(conn, appName);
      // Account-usage names (needs the optional install grant; up to ~3 h
      // behind for newly created databases). Declined grant → quiet skip.
      try {
        const rows = (await executeQuery(
          conn,
          'SELECT DATABASE_NAME FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASES WHERE DELETED IS NULL',
        )) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const db = String(r.DATABASE_NAME ?? r.database_name ?? '');
          if (db && db !== appName && !isSkippedDb(db) && !databases.includes(db)) {
            databases.push(db);
          }
        }
      } catch {
        // IMPORTED PRIVILEGES ON SNOWFLAKE DB not granted — SHOW results only.
      }
      return { appName, databases };
    });

    const merged = new Set(appView.databases);
    try {
      const callerDbs = await withUserWarehouse(Number(auth.accountId), (conn) =>
        enumerateDatabases(conn, appView.appName));
      for (const db of callerDbs) merged.add(db);
    } catch (err) {
      if (!(err instanceof NoUserWarehouseConfig)) {
        console.warn('[databases] caller enumeration skipped:', (err as Error)?.message ?? err);
      }
    }

    return Response.json({ app_name: appView.appName, databases: [...merged].sort() });
  } catch (err) {
    reportError(err, { where: 'accounts/databases' });
    return Response.json({ app_name: '', databases: [], error: 'Could not list databases.' }, { status: 500 });
  }
}
