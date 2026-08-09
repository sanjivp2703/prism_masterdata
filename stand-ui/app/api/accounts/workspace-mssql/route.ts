/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/workspace-mssql (admin only) — the SQL Server
// counterpart of workspace-snowflake: the workspace SERVICE connection saved
// from the /setup onboarding flow (SQL Server port Phase 6).
//
// GET  — masked status/prefill: non-secret fields + has_secret + source +
//        the resolved warehouse type.
// POST — { test_only?: true, clear?: true, server, port?, database?, user,
//          password?, trust_server_cert? }.
//        * test_only: live connection test of the typed credentials (blank
//          password falls back to the SAVED secret), nothing persisted.
//        * clear: wipe the saved ms_* credentials (warehouse_type stays —
//          clearing credentials is not a platform switch).
//        * otherwise: connection-test then save (encrypted) AND set
//          warehouse_type = 'mssql' — saving SQL Server credentials IS the
//          platform choice.
import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';
import { getWarehouseAdapter, invalidateWarehouseTypeCache } from '@/app/api/_lib/warehouse';
import {
  withAdHocMssql,
  getWorkspaceMsConfig,
  invalidateWorkspaceMsConfig,
  mssqlServiceConnectionSource,
  mssqlErrorResponse,
} from '@/app/api/_lib/warehouse/mssql/connection';

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const r = getDb()
    .prepare(`SELECT ms_server, ms_port, ms_database, ms_user, ms_trust_server_cert,
                     (ms_password IS NOT NULL AND ms_password != '') AS has_secret,
                     warehouse_type
              FROM workspace_config WHERE id = 1`)
    .get() as any;

  return Response.json({
    warehouse_type: getWarehouseAdapter().kind,
    saved_warehouse_type: r?.warehouse_type ?? null,
    source: mssqlServiceConnectionSource(),
    server: r?.ms_server ?? null,
    port: r?.ms_port ?? 1433,
    database: r?.ms_database ?? 'PRISM_DB',
    user: r?.ms_user ?? null,
    trust_server_cert: r?.ms_trust_server_cert === 1,
    has_secret: Boolean(r?.has_secret),
  });
}

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body */ }

  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO workspace_config (id, sf_account, sf_user, sf_warehouse) VALUES (1, '', '', '')`).run();

  if (body?.clear === true) {
    db.prepare(
      `UPDATE workspace_config
       SET ms_server = NULL, ms_port = NULL, ms_database = NULL, ms_user = NULL,
           ms_password = NULL, ms_encrypt = NULL, ms_trust_server_cert = NULL
       WHERE id = 1`,
    ).run();
    invalidateWorkspaceMsConfig();
    return Response.json({ ok: true, cleared: true, source: mssqlServiceConnectionSource() });
  }

  const server = String(body?.server ?? '').trim();
  const user = String(body?.user ?? '').trim();
  const port = Number(body?.port ?? 1433);
  const database = String(body?.database ?? 'PRISM_DB').trim() || 'PRISM_DB';
  const trustServerCertificate = body?.trust_server_cert === true;
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!server || !user) {
    return Response.json({ error: 'Server and username are required.' }, { status: 400 });
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return Response.json({ error: 'Port must be a number between 1 and 65535.' }, { status: 400 });
  }

  // Blank password adopts the SAVED secret (change server/user without
  // re-pasting), same convention as the Snowflake workspace route.
  if (!password) {
    const saved = getWorkspaceMsConfig();
    if (saved?.password) password = saved.password;
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  // Live connection test before anything persists.
  try {
    await withAdHocMssql(
      { server, port, database, user, password, trustServerCertificate },
      async (pool) => { await pool.request().query('SELECT 1 AS ok'); },
    );
  } catch (err) {
    return mssqlErrorResponse(err, 'Could not connect to SQL Server with these credentials.');
  }

  if (body?.test_only === true) {
    return Response.json({ ok: true, tested: true });
  }

  db.prepare(
    `UPDATE workspace_config
     SET ms_server = ?, ms_port = ?, ms_database = ?, ms_user = ?, ms_password = ?,
         ms_encrypt = 1, ms_trust_server_cert = ?,
         warehouse_type = 'mssql'
     WHERE id = 1`,
  ).run(server, port, database, user, encryptSecret(password), trustServerCertificate ? 1 : 0);

  invalidateWorkspaceMsConfig();
  invalidateWarehouseTypeCache();
  return Response.json({ ok: true, source: mssqlServiceConnectionSource(), warehouse_type: 'mssql' });
}
