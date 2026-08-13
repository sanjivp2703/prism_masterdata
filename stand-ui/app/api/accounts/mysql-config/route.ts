/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/mysql-config — PERSONAL MySQL credentials on the
// member's own account row (MySQL port Phase M4). The mysql analog of
// snowflake-config/mssql-config/pg-config: used ONLY by the one-time flow's
// access fallback and Column-mode consent provisioning; the service
// connection is never affected. requireValidSession (any member may save
// their own); there is no grants pass (nothing to grant — the point is the
// member's own MySQL entitlements).
import 'server-only';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';
import { getOptionalEnv } from '@/app/api/_lib/env';
import { withAdHocMysql, getWorkspaceMyConfig, mysqlErrorResponse } from '@/app/api/_lib/warehouse/mysql/connection';

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const r = getDb()
    .prepare(`SELECT my_host, my_port, my_database, my_user,
                     (my_password IS NOT NULL AND my_password != '') AS has_secret
              FROM accounts WHERE account_id = ?`)
    .get(Number(session.accountId)) as any;

  // Prefill host/database from the workspace config — one MySQL server per
  // installation, so members only ever type their own account + password.
  const ws = getWorkspaceMyConfig();
  return Response.json({
    host: r?.my_host ?? ws?.host ?? null,
    port: r?.my_port ?? ws?.port ?? 3306,
    database: r?.my_database ?? ws?.database ?? 'prism_internal',
    user: r?.my_user ?? null,
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
      .prepare(`UPDATE accounts SET my_host = NULL, my_port = NULL, my_database = NULL, my_user = NULL, my_password = NULL WHERE account_id = ?`)
      .run(Number(session.accountId));
    return Response.json({ ok: true, cleared: true });
  }

  const ws = getWorkspaceMyConfig();
  const host = String(body?.host ?? '').trim() || ws?.host || '';
  const port = Number(body?.port ?? ws?.port ?? 3306);
  // Session default only — MySQL joins across databases (never a scope).
  const database = String(body?.database ?? '').trim() || ws?.database || 'prism_internal';
  const user = String(body?.user ?? '').trim();
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!host || !user) {
    return Response.json({ error: 'Host and username are required.' }, { status: 400 });
  }

  // Blank password keeps the saved one (change host/database without re-typing).
  if (!password) {
    const saved = getDb()
      .prepare(`SELECT my_password FROM accounts WHERE account_id = ?`)
      .get(Number(session.accountId)) as any;
    if (saved?.my_password) password = decryptSecret(String(saved.my_password));
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  try {
    await withAdHocMysql(
      {
        host, port, database, user, password,
        // Personal connections reuse the workspace's TLS posture (same server).
        ssl: ws?.ssl ?? getOptionalEnv('MYSQL_SSL') ?? 'false',
      },
      async (conn) => { await conn.query('SELECT 1'); },
    );
  } catch (err) {
    return mysqlErrorResponse(err, 'Could not connect to MySQL with these credentials.');
  }

  getDb()
    .prepare(`UPDATE accounts SET my_host = ?, my_port = ?, my_database = ?, my_user = ?, my_password = ? WHERE account_id = ?`)
    .run(host, port, database, user, encryptSecret(password), Number(session.accountId));

  return Response.json({ ok: true });
}
