import 'server-only';
import { getOptionalEnv, isFreshSetupSim } from '@/app/api/_lib/env';
import { serviceConnectionSource } from '@/app/api/_lib/warehouse';
import { invalidateWorkspaceSfConfig, getEnvSnowflakeSecrets, createAdHocSnowflakeConnection } from '@/app/api/_lib/warehouse/snowflake/connection';
import { getDb, sqliteNow } from '@/app/api/_lib/sqlite';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { encryptSecret, decryptSecret } from '@/app/api/_lib/crypto';

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

/**
 * GET /api/accounts/workspace-snowflake — masked workspace service config
 * (admin only). `source` says what the service connection currently resolves
 * to: 'workspace' (saved here), 'env' (.env.local), or 'none'.
 */
export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  try {
    const r = getDb()
      .prepare(
        `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
         FROM workspace_config WHERE id = 1`,
      )
      .get() as any;

    // Non-secret fields fall back to the env config so the setup form
    // prefills; secrets are only reported as present/absent, never returned.
    // Fresh-install simulation hides everything env-derived (saved workspace
    // rows are real state and still show).
    const fresh = isFreshSetupSim();
    const envSecrets = fresh ? {} as ReturnType<typeof getEnvSnowflakeSecrets> : getEnvSnowflakeSecrets();
    const envField = (name: string) => (fresh ? null : getOptionalEnv(name) ?? null);
    const source = serviceConnectionSource();
    return Response.json({
      source:          fresh && source === 'env' ? 'none' : source,
      sf_account:      r?.sf_account   ?? envField('SNOWFLAKE_ACCOUNT'),
      sf_user:         r?.sf_user      ?? envField('SNOWFLAKE_USER'),
      sf_warehouse:    r?.sf_warehouse ?? envField('SNOWFLAKE_WAREHOUSE'),
      sf_role:         r?.sf_role      ?? envField('SNOWFLAKE_ROLE'),
      has_password:    Boolean(r?.sf_password    && r.sf_password    !== ''),
      has_private_key: Boolean(r?.sf_private_key && r.sf_private_key !== ''),
      // A secret exists on the server (env) that a blank save can adopt.
      has_env_secret:  Boolean(envSecrets.password || envSecrets.privateKey),
    });
  } catch (err) {
    console.error('[workspace-snowflake] load failed:', err);
    return Response.json({ error: 'Failed to load workspace Snowflake config' }, { status: 500 });
  }
}

/**
 * POST /api/accounts/workspace-snowflake (admin only)
 *
 * Body: { sf_account, sf_user, sf_warehouse, sf_role?, sf_password?, sf_private_key? }
 *   — connection-tests the credentials, then saves them (secrets encrypted) as
 *     the WORKSPACE service connection. Nothing is saved if the test fails.
 * Body: { clear: true }
 *   — removes the workspace config (service connection falls back to env vars).
 *
 * These are the credentials every pipeline and background poll runs under —
 * distinct from the per-account personal credentials in /api/accounts/snowflake-config.
 */
export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  // ── Clear ─────────────────────────────────────────────────────────────────
  if (body?.clear) {
    try {
      getDb().prepare(`DELETE FROM workspace_config WHERE id = 1`).run();
      invalidateWorkspaceSfConfig();
      return Response.json({ ok: true, cleared: true, source: serviceConnectionSource() });
    } catch (err) {
      console.error('[workspace-snowflake] clear failed:', err);
      return Response.json({ error: 'Failed to clear workspace Snowflake config' }, { status: 500 });
    }
  }

  // ── Validate input ────────────────────────────────────────────────────────
  const sf_account     = String(body?.sf_account    ?? '').trim();
  const sf_user        = String(body?.sf_user       ?? '').trim();
  const sf_warehouse   = String(body?.sf_warehouse  ?? '').trim();
  const sf_role        = String(body?.sf_role       ?? '').trim() || null;
  let   sf_password    = String(body?.sf_password   ?? '').trim() || null;
  let   sf_private_key = String(body?.sf_private_key ?? '').trim() || null;

  if (!sf_account || !sf_user || !sf_warehouse) {
    return Response.json({ error: 'Account identifier, username, and warehouse are required.' }, { status: 400 });
  }

  // No secret typed → keep the already-saved one (change warehouse/role
  // without re-pasting the key). Decrypted only server-side.
  if (!sf_password && !sf_private_key) {
    const saved = getDb()
      .prepare(`SELECT sf_password, sf_private_key FROM workspace_config WHERE id = 1`)
      .get() as any;
    if (saved?.sf_password)    sf_password    = decryptSecret(String(saved.sf_password));
    if (saved?.sf_private_key) sf_private_key = decryptSecret(String(saved.sf_private_key));
  }
  // Still nothing → adopt the env-configured secret (lets the admin save the
  // workspace connection without hunting for the key; it never left the
  // server). Suppressed by the fresh-install simulation.
  if (!sf_password && !sf_private_key && !isFreshSetupSim()) {
    const env = getEnvSnowflakeSecrets();
    sf_password    = env.password   ?? null;
    sf_private_key = env.privateKey ?? null;
  }
  if (!sf_password && !sf_private_key) {
    return Response.json({ error: 'Either a password or a private key is required.' }, { status: 400 });
  }

  // ── Test the connection BEFORE saving ─────────────────────────────────────
  // A broken workspace config would take down every pipeline — refuse to save
  // credentials that can't even open a session.
  const conn = buildConn(sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key);
  try {
    await new Promise<void>((resolve, reject) => {
      conn.connect((err: any) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      conn.execute({
        sqlText: `SELECT CURRENT_VERSION()`,
        complete: (err: any) => (err ? reject(err) : resolve()),
      });
    });
  } catch (err: any) {
    console.error('[workspace-snowflake] connection test failed:', err);
    const raw = String(err?.message ?? err ?? '');
    let error: string;
    if (/incorrect username or password|password|jwt|private key|authenticat|390100|390144|mfa/i.test(raw)) {
      error = 'Authentication failed — nothing was saved. Check the username and the private key or password.';
    } else if (/enotfound|econn|etimedout|certificate|could not connect|network|account.*(not exist|not found)|404/i.test(raw)) {
      error = 'Could not reach that Snowflake account — nothing was saved. Check the account identifier.';
    } else {
      error = 'Connection failed — nothing was saved. Check the details and try again.';
    }
    return Response.json({ ok: false, error }, { status: 400 });
  } finally {
    await new Promise<void>((resolve) => { conn.destroy(() => resolve()); });
  }

  // ── Save (secrets encrypted at rest) ──────────────────────────────────────
  try {
    getDb()
      .prepare(
        `INSERT INTO workspace_config (id, sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key, configured_by, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sf_account = excluded.sf_account, sf_user = excluded.sf_user,
           sf_warehouse = excluded.sf_warehouse, sf_role = excluded.sf_role,
           sf_password = excluded.sf_password, sf_private_key = excluded.sf_private_key,
           configured_by = excluded.configured_by, updated_at = excluded.updated_at`,
      )
      .run(
        sf_account, sf_user, sf_warehouse, sf_role,
        sf_password    ? encryptSecret(sf_password)    : null,
        sf_private_key ? encryptSecret(sf_private_key) : null,
        Number(session.accountId), sqliteNow(),
      );
    invalidateWorkspaceSfConfig();
  } catch (err) {
    console.error('[workspace-snowflake] save failed:', err);
    return Response.json({ error: 'Connection worked but saving failed. Try again.' }, { status: 500 });
  }

  return Response.json({ ok: true, source: 'workspace' });
}
