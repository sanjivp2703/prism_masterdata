import { NextRequest } from 'next/server';
import { warehouseErrorResponse, withWarehouse, executeQuery, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { isNativeEdition } from '@/app/api/_lib/edition';

// Snowflake-side tables (read via the service connection)
const SNOWFLAKE_TABLES = [
  'LITERAL_ALIAS_MATCHES',
  'APPROVED_ALIAS_NAMES',
  'PIPELINE_QUEUE',
  'PIPELINE_FILE_ROWS',
  'RUN_STATE',        // run review state blobs (data residency — warehouse-side)
  'VALIDATION_LOG',   // export-referee audit trail (data residency — warehouse-side)
];

// Local SQLite app-state tables (secrets column-filtered)
const SQLITE_TABLES: Record<string, string> = {
  RUNS:      'SELECT * FROM runs ORDER BY run_id DESC LIMIT 1000',
  PIPELINES: 'SELECT * FROM pipelines LIMIT 1000',
  COLUMN_SPECS:              'SELECT * FROM column_specs ORDER BY spec_id DESC LIMIT 1000',
  INVITATIONS:               'SELECT invitation_id, invited_email, invited_by, invited_role, status, created_at, accepted_at, expires_at FROM invitations LIMIT 1000',
  ONE_TIME_STANDARDIZATIONS: 'SELECT * FROM one_time_standardizations ORDER BY ots_id DESC LIMIT 1000',
  // never expose sf_password / sf_private_key, even to operators
  ACCOUNTS:                  'SELECT account_id, google_id, email, name, role, session_version, created_at, last_login_at FROM accounts LIMIT 1000',
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tableName: string }> }
) {
  // Operator-only debug tooling — the route does not exist in customer
  // deployments unless PRISM_DEBUG_TOOLS is explicitly enabled. Hard-off in
  // the native (Marketplace) edition regardless of env.
  if (isNativeEdition() || process.env.PRISM_DEBUG_TOOLS !== 'true') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // The env gate alone is NOT access control (KI-02). It decides whether the
  // route exists, not who may call it — so on any install where debug tooling
  // is deliberately on (this dev machine included), the env check was the only
  // thing between a request and raw dumps of accounts, invitations, runs and
  // one-time standardizations. Every route must carry a session guard; this one
  // had none at all, not even bare decodeSession.
  //
  // Admin, not merely valid: these are whole-table dumps including the ACCOUNTS
  // row set. Runs AFTER the 404 so an unauthenticated probe still cannot tell
  // whether debug tooling is enabled on this install.
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const { tableName } = await params;
  const noStore = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  };

  if (SQLITE_TABLES[tableName]) {
    try {
      const rows = getDb().prepare(SQLITE_TABLES[tableName]).all();
      return Response.json({ data: rows }, { headers: noStore });
    } catch (error) {
      console.error('SQLite error:', error);
      return Response.json({ error: 'Failed to fetch data' }, { status: 500 });
    }
  }

  if (!SNOWFLAKE_TABLES.includes(tableName)) {
    return Response.json(
      { error: 'Table not allowed' },
      { status: 400 }
    );
  }

  // LIMIT is Snowflake-only. Every other warehouse call site branches to TOP
    // for mssql; this one did not, so on a SQL Server install four of the six
    // /debug dropdown tables returned a 500 with `Msg 102 ... Incorrect syntax
    // near '1000'` instead of data (SEC-03, reproduced across three passes).
    const sqlText = getWarehouseAdapter().kind === 'mssql'
      ? `SELECT TOP (1000) * FROM PRISM_DB.INTERNAL.${tableName}`
      : getWarehouseAdapter().kind === 'postgres' || getWarehouseAdapter().kind === 'mysql'
      // Postgres/MySQL installs use lowercase prism_internal.* tables (a
      // schema on pg, a database on mysql); the allowlisted names are the
      // canonical uppercase forms.
      ? `SELECT * FROM prism_internal.${tableName.toLowerCase()} LIMIT 1000`
      : `SELECT * FROM PRISM_DB.INTERNAL.${tableName} LIMIT 1000`;

  try {
    return await withWarehouse(async (connection) => {
      const rows = await executeQuery(connection, sqlText);
      return Response.json({ data: rows }, { headers: noStore });
    });
  } catch (error) {
    console.error('Database error:', error);
    return warehouseErrorResponse(error, 'Failed to fetch data');
  }
}
