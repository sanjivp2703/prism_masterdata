/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/workspace-postgres (admin only) — the PostgreSQL
// counterpart of workspace-snowflake/workspace-mssql: the workspace SERVICE
// connection saved from the /setup onboarding flow (Postgres port Phase P4).
//
// GET  — masked status/prefill: non-secret fields + has_secret/has_env_secret +
//        source + the resolved warehouse type. Secrets never travel to the
//        browser.
// POST — { test_only?: true, clear?: true, host, port?, database, user,
//          password?, sslmode? }.
//        * test_only: live connection test of the typed credentials (blank
//          password falls back to the SAVED secret, then the env secret),
//          nothing persisted.
//        * clear: wipe the saved pg_* credentials (warehouse_type stays —
//          clearing credentials is not a platform switch).
//        * otherwise: connection-test then save (encrypted) AND set
//          warehouse_type = 'postgres' — saving Postgres credentials IS the
//          platform choice.
//
// database is REQUIRED and load-bearing: Postgres cannot query across
// databases, so this field is the ONE database the installation standardizes
// (docs/POSTGRES_PORT_PLAN.md §2.1).
import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret } from '@/app/api/_lib/crypto';
import { getOptionalEnv } from '@/app/api/_lib/env';
import { getWarehouseAdapter, invalidateWarehouseTypeCache } from '@/app/api/_lib/warehouse';
import {
  withAdHocPostgres,
  getWorkspacePgConfig,
  getPgEnvConfig,
  invalidateWorkspacePgConfig,
  pgServiceConnectionSource,
  pgErrorResponse,
} from '@/app/api/_lib/warehouse/postgres/connection';

const SSLMODES = new Set(['disable', 'require', 'verify-full']);

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const r = getDb()
    .prepare(`SELECT pg_host, pg_port, pg_database, pg_user, pg_sslmode,
                     (pg_password IS NOT NULL AND pg_password != '') AS has_secret,
                     warehouse_type
              FROM workspace_config WHERE id = 1`)
    .get() as any;

  return Response.json({
    warehouse_type: getWarehouseAdapter().kind,
    saved_warehouse_type: r?.warehouse_type ?? null,
    source: pgServiceConnectionSource(),
    host: r?.pg_host ?? getOptionalEnv('PG_HOST') ?? null,
    port: r?.pg_port ?? Number(getOptionalEnv('PG_PORT') ?? 5432),
    database: r?.pg_database ?? getOptionalEnv('PG_DATABASE') ?? null,
    user: r?.pg_user ?? getOptionalEnv('PG_USER') ?? null,
    sslmode: r?.pg_sslmode ?? getOptionalEnv('PG_SSLMODE') ?? 'require',
    has_secret: Boolean(r?.has_secret),
    has_env_secret: Boolean(getOptionalEnv('PG_PASSWORD')),
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
       SET pg_host = NULL, pg_port = NULL, pg_database = NULL, pg_user = NULL,
           pg_password = NULL, pg_sslmode = NULL
       WHERE id = 1`,
    ).run();
    invalidateWorkspacePgConfig();
    return Response.json({ ok: true, cleared: true, source: pgServiceConnectionSource() });
  }

  const host = String(body?.host ?? '').trim();
  const user = String(body?.user ?? '').trim();
  const port = Number(body?.port ?? 5432);
  const database = String(body?.database ?? '').trim();
  const sslmode = String(body?.sslmode ?? 'require').trim().toLowerCase();
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!host || !user) {
    return Response.json({ error: 'Host and username are required.' }, { status: 400 });
  }
  if (!database) {
    return Response.json({ error: 'A database is required — Postgres installations standardize one database.' }, { status: 400 });
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return Response.json({ error: 'Port must be a number between 1 and 65535.' }, { status: 400 });
  }
  if (!SSLMODES.has(sslmode)) {
    return Response.json({ error: "sslmode must be 'disable', 'require', or 'verify-full'." }, { status: 400 });
  }

  // Blank password adopts the SAVED secret, then the env secret (change
  // host/database without re-pasting) — same convention as the Snowflake
  // workspace route's env adoption.
  if (!password) {
    const saved = getWorkspacePgConfig();
    if (saved?.password) password = saved.password;
  }
  if (!password) {
    const env = getPgEnvConfig();
    if (env?.password) password = env.password;
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  // Live connection test before anything persists.
  try {
    await withAdHocPostgres(
      { host, port, database, user, password, sslmode },
      async (client) => { await client.query('SELECT 1'); },
    );
  } catch (err) {
    return pgErrorResponse(err, 'Could not connect to PostgreSQL with these credentials.');
  }

  if (body?.test_only === true) {
    return Response.json({ ok: true, tested: true });
  }

  db.prepare(
    `UPDATE workspace_config
     SET pg_host = ?, pg_port = ?, pg_database = ?, pg_user = ?, pg_password = ?,
         pg_sslmode = ?,
         warehouse_type = 'postgres'
     WHERE id = 1`,
  ).run(host, port, database, user, encryptSecret(password), sslmode);

  invalidateWorkspacePgConfig();
  invalidateWarehouseTypeCache();
  return Response.json({ ok: true, source: pgServiceConnectionSource(), warehouse_type: 'postgres' });
}
