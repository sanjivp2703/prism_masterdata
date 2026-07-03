import 'server-only';
import { cookies } from 'next/headers';
import snowflake from 'snowflake-sdk';
import {
  withSnowflake,
  getOptionalEnv,
  invalidateAccountSfConfig,
  snowflakeErrorResponse,
} from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { encryptSecret } from '@/app/api/_lib/crypto';
import { applyGrants } from '@/app/api/_lib/grants';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[] | undefined) => (err ? reject(err) : resolve(rows ?? [])),
    });
  });
}

function col(r: any, key: string) {
  return r[key.toUpperCase()] ?? r[key.toLowerCase()];
}

function buildConn(sf_account: string, sf_user: string, sf_warehouse: string, sf_role: string | null, sf_password: string | null, sf_private_key: string | null) {
  const privateKey = sf_private_key
    ? (sf_private_key.includes('\\n') ? sf_private_key.replace(/\\n/g, '\n') : sf_private_key)
    : undefined;
  const authenticator = privateKey ? 'SNOWFLAKE_JWT' : undefined;
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'STAND_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'STAND_INTERNAL';

  return snowflake.createConnection({
    account: sf_account, username: sf_user, warehouse: sf_warehouse, database, schema,
    ...(sf_role       ? { role: sf_role }   : {}),
    ...(authenticator ? { authenticator }    : {}),
    ...(privateKey ? { privateKey } : { password: sf_password ?? '' }),
  } as any);
}

/** GET /api/accounts/snowflake-config — return masked config for the current account */
export async function GET(_request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT sf_account, sf_user, sf_warehouse, sf_role,
                IFF(sf_password    IS NOT NULL AND sf_password    != '', true, false) AS has_password,
                IFF(sf_private_key IS NOT NULL AND sf_private_key != '', true, false) AS has_private_key
         FROM STAND_DB.STAND_INTERNAL.ACCOUNTS
         WHERE account_id = ? LIMIT 1`,
        [session.accountId],
      );
      if (!rows.length) return Response.json({ error: 'Account not found' }, { status: 404 });
      const r = rows[0];
      return Response.json({
        sf_account:      col(r, 'sf_account')  ?? null,
        sf_user:         col(r, 'sf_user')      ?? null,
        sf_warehouse:    col(r, 'sf_warehouse') ?? null,
        sf_role:         col(r, 'sf_role')      ?? null,
        has_password:    Boolean(col(r, 'has_password')),
        has_private_key: Boolean(col(r, 'has_private_key')),
      });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load Snowflake config');
  }
}

/**
 * POST /api/accounts/snowflake-config
 *
 * Body: { sf_account, sf_user, sf_warehouse, sf_role?, sf_password?, sf_private_key? }
 *   — saves credentials, then applies all Prism grants on the connected account.
 * Body: { clear: true }
 *   — wipes per-account config (falls back to env vars).
 */
export async function POST(request: Request) {
  // Admin only — saving or wiping workspace Snowflake credentials must not be
  // possible for regular users. Also enforces the session-version check.
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  // ── Clear ─────────────────────────────────────────────────────────────────
  if (body?.clear) {
    try {
      await withSnowflake(async (conn) => {
        await exec(
          conn,
          `UPDATE STAND_DB.STAND_INTERNAL.ACCOUNTS
           SET sf_account = NULL, sf_user = NULL, sf_warehouse = NULL,
               sf_role = NULL, sf_password = NULL, sf_private_key = NULL
           WHERE account_id = ?`,
          [session.accountId],
        );
      });
      invalidateAccountSfConfig(session.accountId);
      return Response.json({ ok: true, cleared: true });
    } catch (err) {
      return snowflakeErrorResponse(err, 'Failed to clear Snowflake config');
    }
  }

  // ── Validate input ────────────────────────────────────────────────────────
  const sf_account     = String(body?.sf_account    ?? '').trim();
  const sf_user        = String(body?.sf_user       ?? '').trim();
  const sf_warehouse   = String(body?.sf_warehouse  ?? '').trim();
  const sf_role        = String(body?.sf_role       ?? '').trim() || null;
  const sf_password    = String(body?.sf_password   ?? '').trim() || null;
  const sf_private_key = String(body?.sf_private_key ?? '').trim() || null;

  if (!sf_account || !sf_user || !sf_warehouse) {
    return Response.json({ error: 'Account identifier, username, and warehouse are required.' }, { status: 400 });
  }
  if (!sf_password && !sf_private_key) {
    return Response.json({ error: 'Either a password or a private key is required.' }, { status: 400 });
  }

  // ── Save credentials ──────────────────────────────────────────────────────
  // Secrets are encrypted only at the moment of persistence — everything held
  // in memory (e.g. the grants connection below) stays plaintext.
  try {
    await withSnowflake(async (conn) => {
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.ACCOUNTS
         SET sf_account = ?, sf_user = ?, sf_warehouse = ?,
             sf_role = ?, sf_password = ?, sf_private_key = ?
         WHERE account_id = ?`,
        [
          sf_account, sf_user, sf_warehouse, sf_role,
          sf_password    ? encryptSecret(sf_password)    : null,
          sf_private_key ? encryptSecret(sf_private_key) : null,
          session.accountId,
        ],
      );
    });
    invalidateAccountSfConfig(session.accountId);
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to save Snowflake config');
  }

  // ── Apply grants on the customer's Snowflake ──────────────────────────────
  // Connect with the provided credentials and run all Prism grant statements.
  const customerConn = buildConn(sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key);
  let grantResults: { sql: string; ok: boolean; error: string | null }[] = [];
  let grantsError: string | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      customerConn.connect((err: any) => (err ? reject(err) : resolve()));
    });
    grantResults = await applyGrants(customerConn, sf_user);
  } catch (err: any) {
    grantsError = String(err?.message ?? err);
  } finally {
    await new Promise<void>((resolve) => { customerConn.destroy(() => resolve()); });
  }

  const grantsFailed  = grantResults.filter(r => !r.ok);
  const grantsApplied = grantResults.filter(r => r.ok).length;

  return Response.json({
    ok: true,
    grants: {
      applied:  grantsApplied,
      failed:   grantsFailed.length,
      errors:   grantsFailed.map(r => ({ sql: r.sql, error: r.error })),
      conn_error: grantsError,
    },
  });
}
