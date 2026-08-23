/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/mssql-config — PERSONAL SQL Server credentials on the
// member's own account row (SQL Server port Phase 7). The mssql analog of
// snowflake-config: used ONLY by the one-time flow's access fallback; the
// service connection is never affected. requireValidSession (any member may
// save their own); there is no grants pass (nothing to grant — the point is
// the member's own entitlements).
import 'server-only';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';
import { withAdHocMssql, getWorkspaceMsConfig, mssqlErrorResponse } from '@/app/api/_lib/warehouse/mssql/connection';

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const r = getDb()
    .prepare(`SELECT ms_server, ms_port, ms_database, ms_user,
                     (ms_password IS NOT NULL AND ms_password != '') AS has_secret
              FROM accounts WHERE account_id = ?`)
    .get(Number(session.accountId)) as any;

  // Prefill the server from the workspace config — one SQL Server per
  // installation, so members only ever type their own login + password.
  const ws = getWorkspaceMsConfig();
  return Response.json({
    server: r?.ms_server ?? ws?.server ?? null,
    port: r?.ms_port ?? ws?.port ?? 1433,
    database: r?.ms_database ?? null,
    user: r?.ms_user ?? null,
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
      .prepare(`UPDATE accounts SET ms_server = NULL, ms_port = NULL, ms_database = NULL, ms_user = NULL, ms_password = NULL WHERE account_id = ?`)
      .run(Number(session.accountId));
    return Response.json({ ok: true, cleared: true });
  }

  const ws = getWorkspaceMsConfig();
  const server = String(body?.server ?? '').trim() || ws?.server || '';
  const port = Number(body?.port ?? ws?.port ?? 1433);
  // Personal credentials: an empty database stays empty (finding #26).
  // Inheriting the workspace's PRISM_DB pointed personal logins at Prism's
  // internal database, which they are not granted on.
  const database = String(body?.database ?? '').trim();
  const user = String(body?.user ?? '').trim();
  let password = typeof body?.password === 'string' ? body.password : '';

  if (!server || !user) {
    return Response.json({ error: 'Server and username are required.' }, { status: 400 });
  }

  // Blank password keeps the saved one (change server/database without re-typing).
  if (!password) {
    const saved = getDb()
      .prepare(`SELECT ms_password FROM accounts WHERE account_id = ?`)
      .get(Number(session.accountId)) as any;
    if (saved?.ms_password) password = decryptSecret(String(saved.ms_password));
  }
  if (!password) {
    return Response.json({ error: 'A password is required.' }, { status: 400 });
  }

  try {
    await withAdHocMssql(
      {
        server, port, database, user, password,
        encrypt: ws?.encrypt ?? true,
        trustServerCertificate: ws?.trustServerCertificate ?? false,
      },
      async (pool) => { await pool.request().query('SELECT 1 AS ok'); },
    );
  } catch (err) {
    return mssqlErrorResponse(err, 'Could not connect to SQL Server with these credentials.');
  }

  getDb()
    .prepare(`UPDATE accounts SET ms_server = ?, ms_port = ?, ms_database = ?, ms_user = ?, ms_password = ? WHERE account_id = ?`)
    .run(server, port, database, user, encryptSecret(password), Number(session.accountId));

  return Response.json({ ok: true });
}
