/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/pg-config — PERSONAL PostgreSQL credentials on the
// member's own account row (Postgres port Phase P4). The pg analog of
// snowflake-config/mssql-config: used ONLY by the one-time flow's access
// fallback; the service connection is never affected. requireValidSession
// (any member may save their own); there is no grants pass (nothing to grant —
// the point is the member's own entitlements).
import 'server-only';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';
import { getOptionalEnv } from '@/app/api/_lib/env';
import { withAdHocPostgres, getWorkspacePgConfig, pgErrorResponse } from '@/app/api/_lib/warehouse/postgres/connection';

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const r = getDb()
    .prepare(`SELECT pg_host, pg_port, pg_database, pg_user,
                     (pg_password IS NOT NULL AND pg_password != '') AS has_secret
              FROM accounts WHERE account_id = ?`)
    .get(Number(session.accountId)) as any;

  // Prefill host/database from the workspace config — one Postgres database
  // per installation, so members only ever type their own role + password.
  const ws = getWorkspacePgConfig();
  return Response.json({
    host: r?.pg_host ?? ws?.host ?? null,
    port: r?.pg_port ?? ws?.port ?? 5432,
    database: r?.pg_database ?? ws?.database ?? null,
    user: r?.pg_user ?? null,
    has_secret: Boolean(r?.has_secret),
  });
}

export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }

  if (body?.clear === true) {
    getDb()
      .prepare(`UPDATE accounts SET pg_host = NULL, pg_port = NULL, pg_database = NULL, pg_user = NULL, pg_password = NULL WHERE account_id = ?`)
      .run(Number(session.accountId));
    return Response.json({ ok: true, cleared: true });
  }

  const ws = getWorkspacePgConfig();
  const host = String(body?.host ?? '').trim() || ws?.host || '';
  const port = Number(body?.port ?? ws?.port ?? 5432);
  const database = String(body?.database ?? '').trim() || ws?.database || '';
  const user = String(body?.user ?? '').trim();
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!host || !user) {
    return Response.json({ error: 'Host and username are required.' }, { status: 400 });
  }
  if (!database) {
    return Response.json({ error: 'A database is required.' }, { status: 400 });
  }

  // Blank password keeps the saved one (change host/database without re-typing).
  if (!password) {
    const saved = getDb()
      .prepare(`SELECT pg_password FROM accounts WHERE account_id = ?`)
      .get(Number(session.accountId)) as any;
    if (saved?.pg_password) password = decryptSecret(String(saved.pg_password));
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  try {
    await withAdHocPostgres(
      {
        host, port, database, user, password,
        // Personal connections reuse the workspace's TLS posture (same server).
        sslmode: ws?.sslmode ?? getOptionalEnv('PG_SSLMODE') ?? 'disable',
      },
      async (client) => { await client.query('SELECT 1'); },
    );
  } catch (err) {
    return pgErrorResponse(err, 'Could not connect to PostgreSQL with these credentials.');
  }

  getDb()
    .prepare(`UPDATE accounts SET pg_host = ?, pg_port = ?, pg_database = ?, pg_user = ?, pg_password = ? WHERE account_id = ?`)
    .run(host, port, database, user, encryptSecret(password), Number(session.accountId));

  return Response.json({ ok: true });
}
