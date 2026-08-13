/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/workspace-mysql (admin only) — the MySQL counterpart
// of workspace-snowflake/workspace-mssql/workspace-postgres: the workspace
// SERVICE connection saved from the /setup onboarding flow (MySQL port
// Phase M4).
//
// GET  — masked status/prefill: non-secret fields + has_secret/has_env_secret +
//        source + the resolved warehouse type. Secrets never travel to the
//        browser.
// POST — { test_only?: true, clear?: true, host, port?, database?, user,
//          password?, ssl? }.
//        * test_only: live connection test of the typed credentials (blank
//          password falls back to the SAVED secret, then the env secret),
//          nothing persisted.
//        * clear: wipe the saved my_* credentials (warehouse_type stays —
//          clearing credentials is not a platform switch).
//        * otherwise: connection-test then save (encrypted) AND set
//          warehouse_type = 'mysql' — saving MySQL credentials IS the
//          platform choice.
//
// database is OPTIONAL, defaulting to 'prism_internal' — deliberately NOT the
// pg route's required-database validation: on MySQL the field is only the
// session's default database, not a scope. MySQL joins across databases
// freely, so sources can live in any database the service account can read
// (docs/MYSQL_PORT_PLAN.md §2.1).
import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret } from '@/app/api/_lib/crypto';
import { getOptionalEnv } from '@/app/api/_lib/env';
import { getWarehouseAdapter, invalidateWarehouseTypeCache } from '@/app/api/_lib/warehouse';
import {
  withAdHocMysql,
  getWorkspaceMyConfig,
  getMysqlEnvConfig,
  invalidateWorkspaceMyConfig,
  mysqlServiceConnectionSource,
  mysqlErrorResponse,
} from '@/app/api/_lib/warehouse/mysql/connection';

const SSL_MODES = new Set(['false', 'true', 'strict']);

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const r = getDb()
    .prepare(`SELECT my_host, my_port, my_database, my_user, my_ssl,
                     (my_password IS NOT NULL AND my_password != '') AS has_secret,
                     warehouse_type
              FROM workspace_config WHERE id = 1`)
    .get() as any;

  return Response.json({
    warehouse_type: getWarehouseAdapter().kind,
    saved_warehouse_type: r?.warehouse_type ?? null,
    source: mysqlServiceConnectionSource(),
    host: r?.my_host ?? getOptionalEnv('MYSQL_HOST') ?? null,
    port: r?.my_port ?? Number(getOptionalEnv('MYSQL_PORT') ?? 3306),
    database: r?.my_database ?? getOptionalEnv('MYSQL_DATABASE') ?? 'prism_internal',
    user: r?.my_user ?? getOptionalEnv('MYSQL_USER') ?? null,
    ssl: r?.my_ssl ?? getOptionalEnv('MYSQL_SSL') ?? 'true',
    has_secret: Boolean(r?.has_secret),
    has_env_secret: Boolean(getOptionalEnv('MYSQL_PASSWORD')),
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
       SET my_host = NULL, my_port = NULL, my_database = NULL, my_user = NULL,
           my_password = NULL, my_ssl = NULL
       WHERE id = 1`,
    ).run();
    invalidateWorkspaceMyConfig();
    return Response.json({ ok: true, cleared: true, source: mysqlServiceConnectionSource() });
  }

  const host = String(body?.host ?? '').trim();
  const user = String(body?.user ?? '').trim();
  const port = Number(body?.port ?? 3306);
  // Session default only — see the header comment; never required.
  const database = String(body?.database ?? '').trim() || 'prism_internal';
  const ssl = String(body?.ssl ?? 'true').trim().toLowerCase();
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!host || !user) {
    return Response.json({ error: 'Host and username are required.' }, { status: 400 });
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return Response.json({ error: 'Port must be a number between 1 and 65535.' }, { status: 400 });
  }
  if (!SSL_MODES.has(ssl)) {
    return Response.json({ error: "ssl must be 'false', 'true', or 'strict'." }, { status: 400 });
  }

  // Blank password adopts the SAVED secret, then the env secret (change
  // host/database without re-pasting) — same convention as the Snowflake
  // workspace route's env adoption.
  if (!password) {
    const saved = getWorkspaceMyConfig();
    if (saved?.password) password = saved.password;
  }
  if (!password) {
    const env = getMysqlEnvConfig();
    if (env?.password) password = env.password;
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  // Live connection test before anything persists.
  try {
    await withAdHocMysql(
      { host, port, database, user, password, ssl },
      async (conn) => { await conn.query('SELECT 1'); },
    );
  } catch (err) {
    return mysqlErrorResponse(err, 'Could not connect to MySQL with these credentials.');
  }

  if (body?.test_only === true) {
    return Response.json({ ok: true, tested: true });
  }

  db.prepare(
    `UPDATE workspace_config
     SET my_host = ?, my_port = ?, my_database = ?, my_user = ?, my_password = ?,
         my_ssl = ?,
         warehouse_type = 'mysql'
     WHERE id = 1`,
  ).run(host, port, database, user, encryptSecret(password), ssl);

  invalidateWorkspaceMyConfig();
  invalidateWarehouseTypeCache();
  return Response.json({ ok: true, source: mysqlServiceConnectionSource(), warehouse_type: 'mysql' });
}
