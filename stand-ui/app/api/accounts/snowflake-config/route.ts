import 'server-only';
import { invalidateAccountSfConfig, createAdHocSnowflakeConnection } from '@/app/api/_lib/warehouse/snowflake/connection';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';
import { applyGrants, type GrantResult } from '@/app/api/_lib/grants';

function buildConn(sf_account: string, sf_user: string, sf_warehouse: string, sf_role: string | null, sf_password: string | null, sf_private_key: string | null) {
  const privateKey = sf_private_key
    ? (sf_private_key.includes('\\n') ? sf_private_key.replace(/\\n/g, '\n') : sf_private_key)
    : undefined;
  return createAdHocSnowflakeConnection({
    account: sf_account, username: sf_user, warehouse: sf_warehouse,
    ...(sf_role     ? { role: sf_role }         : {}),
    ...(privateKey  ? { privateKey }            : {}),
    ...(sf_password ? { password: sf_password } : {}),
  });
}

/** GET /api/accounts/snowflake-config — return masked config for the current account */
export async function GET(_request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  try {
    const r = getDb()
      .prepare(
        `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
         FROM accounts WHERE account_id = ?`,
      )
      .get(Number(session.accountId)) as any;
    if (!r) return Response.json({ error: 'Account not found' }, { status: 404 });

    return Response.json({
      sf_account:      r.sf_account    ?? null,
      sf_user:         r.sf_user       ?? null,
      sf_warehouse:    r.sf_warehouse  ?? null,
      sf_role:         r.sf_role       ?? null,
      has_password:    Boolean(r.sf_password    && r.sf_password    !== ''),
      has_private_key: Boolean(r.sf_private_key && r.sf_private_key !== ''),
    });
  } catch (err) {
    console.error('[snowflake-config] load failed:', err);
    return Response.json({ error: 'Failed to load Snowflake config' }, { status: 500 });
  }
}

/**
 * POST /api/accounts/snowflake-config
 *
 * Body: { sf_account, sf_user, sf_warehouse, sf_role, sf_password?, sf_private_key? }
 *   — saves credentials, then applies all Prism grants on the connected account.
 * Body: { clear: true }
 *   — wipes per-account config (falls back to env vars).
 */
export async function POST(request: Request) {
  // Any member may save credentials — they are stored on the caller's OWN
  // account row. For admins these double as the workspace credentials (and
  // saving applies the Prism role grants); for regular users they are
  // PERSONAL credentials used only for one-time standardizations of tables
  // the service role can't see. The app's pipelines always run on the
  // env-configured service connection either way.
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;
  const isAdmin = session.role === 'admin';

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  // ── Clear ─────────────────────────────────────────────────────────────────
  if (body?.clear) {
    try {
      getDb()
        .prepare(
          `UPDATE accounts
           SET sf_account = NULL, sf_user = NULL, sf_warehouse = NULL,
               sf_role = NULL, sf_password = NULL, sf_private_key = NULL
           WHERE account_id = ?`,
        )
        .run(Number(session.accountId));
      invalidateAccountSfConfig(Number(session.accountId));
      return Response.json({ ok: true, cleared: true });
    } catch (err) {
      console.error('[snowflake-config] clear failed:', err);
      return Response.json({ error: 'Failed to clear Snowflake config' }, { status: 500 });
    }
  }

  // ── Validate input ────────────────────────────────────────────────────────
  const sf_account     = String(body?.sf_account    ?? '').trim();
  const sf_user        = String(body?.sf_user       ?? '').trim();
  const sf_warehouse   = String(body?.sf_warehouse  ?? '').trim();
  const sf_role        = String(body?.sf_role       ?? '').trim() || null;
  let   sf_password    = String(body?.sf_password   ?? '').trim() || null;
  let   sf_private_key = String(body?.sf_private_key ?? '').trim() || null;

  if (!sf_account || !sf_user || !sf_warehouse || !sf_role) {
    return Response.json({ error: 'Account identifier, username, warehouse, and role are required.' }, { status: 400 });
  }

  // No secret typed → keep the already-saved one (lets an admin change
  // warehouse/role without re-pasting the key). Decrypted only server-side.
  if (!sf_password && !sf_private_key) {
    const saved = getDb()
      .prepare(`SELECT sf_password, sf_private_key FROM accounts WHERE account_id = ?`)
      .get(Number(session.accountId)) as any;
    if (saved?.sf_password)    sf_password    = decryptSecret(String(saved.sf_password));
    if (saved?.sf_private_key) sf_private_key = decryptSecret(String(saved.sf_private_key));
  }
  if (!sf_password && !sf_private_key) {
    return Response.json({ error: 'Either a password or a private key is required.' }, { status: 400 });
  }

  // ── Save credentials ──────────────────────────────────────────────────────
  // Secrets are encrypted only at the moment of persistence — everything held
  // in memory (e.g. the grants connection below) stays plaintext.
  try {
    getDb()
      .prepare(
        `UPDATE accounts
         SET sf_account = ?, sf_user = ?, sf_warehouse = ?,
             sf_role = ?, sf_password = ?, sf_private_key = ?
         WHERE account_id = ?`,
      )
      .run(
        sf_account, sf_user, sf_warehouse, sf_role,
        sf_password    ? encryptSecret(sf_password)    : null,
        sf_private_key ? encryptSecret(sf_private_key) : null,
        Number(session.accountId),
      );
    invalidateAccountSfConfig(Number(session.accountId));
  } catch (err) {
    console.error('[snowflake-config] save failed:', err);
    return Response.json({ error: 'Failed to save Snowflake config' }, { status: 500 });
  }

  // ── Apply grants on the customer's Snowflake (admins only) ────────────────
  // A regular user's personal credentials have no business running grant
  // statements — skip the pass entirely.
  if (!isAdmin) {
    return Response.json({ ok: true, grants: null });
  }

  // Connect with the provided credentials and run all Prism grant statements.
  const customerConn = buildConn(sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key);
  let grantResults: GrantResult[] = [];
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
  const grantsSkipped = grantResults.filter(r => r.ok && r.skipped).length;
  const grantsApplied = grantResults.filter(r => r.ok && !r.skipped).length;

  return Response.json({
    ok: true,
    grants: {
      applied:  grantsApplied,
      skipped:  grantsSkipped,
      failed:   grantsFailed.length,
      errors:   grantsFailed.map(r => ({ sql: r.sql, error: r.error })),
      conn_error: grantsError,
    },
  });
}
