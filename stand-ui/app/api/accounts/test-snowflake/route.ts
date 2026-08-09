import 'server-only';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getOptionalEnv, isFreshSetupSim } from '@/app/api/_lib/env';
import { withWarehouse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import {
  getWorkspaceSfConfig,
  createAdHocSnowflakeConnection,
  // The ad-hoc connection below is always a Snowflake connection, so its
  // queries must run through the Snowflake driver directly. The facade's
  // executeQuery dispatches on the ACTIVE adapter, which on a SQL Server
  // install would call mssql's pool.request() on a snowflake-sdk connection.
  executeQuery as execSnowflake,
} from '@/app/api/_lib/warehouse/snowflake/connection';
import { getDb } from '@/app/api/_lib/sqlite';
import { decryptSecret } from '@/app/api/_lib/crypto';

/**
 * GET /api/accounts/test-snowflake — test the SERVICE connection (workspace
 * config saved on /setup, falling back to env vars). Used by the setup card to
 * decide whether "continue with the existing connection" is a safe primary
 * action.
 */
export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  // SQL Server installs: the setup entry check tests the mssql service
  // connection instead (SQL Server port Phase 6). Same shape: ok + identifiers.
  if (getWarehouseAdapter().kind === 'mssql') {
    try {
      const info = await withWarehouse(async (conn) => {
        const rows = await exec(conn, `SELECT DB_NAME() AS d, SUSER_SNAME() AS u`);
        const r = rows[0] ?? {};
        return { database: String(r.d ?? ''), role: String(r.u ?? ''), warehouse: '' };
      });
      return Response.json({ ok: true, warehouse_type: 'mssql', account: '', ...info });
    } catch {
      return Response.json({ ok: false, warehouse_type: 'mssql', account: '' });
    }
  }

  // Dev-only fresh-install simulation: pretend no connection exists so /setup
  // enters the full guided flow. Once workspace credentials are saved during
  // the walkthrough, they count as real state and show through.
  if (isFreshSetupSim()) {
    const ws = getWorkspaceSfConfig();
    if (!ws) return Response.json({ ok: false, account: '' });
  }

  // The workspace's account identifier — one Snowflake account per client, so
  // personal connections always target the same one. Prefilled in the form so
  // members only ever enter their own username + credential.
  const account = getWorkspaceSfConfig()?.account ?? getOptionalEnv('SNOWFLAKE_ACCOUNT') ?? '';

  try {
    const info = await withWarehouse(async (conn) => {
      // CURRENT_ROLE() is the ground truth for what the service connection is
      // ACTUALLY running as — surfaced here as a diagnostic, since an env var
      // reading correctly in a file doesn't guarantee the driver ends up
      // activating that role (e.g. a malformed/unrecognized role name can be
      // silently ignored by some auth paths, falling back to the user's
      // Snowflake default role instead).
      const rows = await exec(conn, `SELECT CURRENT_WAREHOUSE() AS w, CURRENT_DATABASE() AS d, CURRENT_ROLE() AS r`);
      const r = rows[0] ?? {};
      return {
        warehouse: String(r.W ?? r.w ?? ''),
        database:  String(r.D ?? r.d ?? ''),
        role:      String(r.R ?? r.r ?? ''),
      };
    });
    return Response.json({ ok: true, account, ...info });
  } catch {
    // No env credentials configured, or they don't work — either way, the
    // setup form is the only path forward.
    return Response.json({ ok: false, account });
  }
}

/**
 * POST /api/accounts/test-snowflake — validate credentials without saving them.
 *
 * When no secret is supplied but the account has SAVED credentials, the saved
 * (encrypted) secret is decrypted server-side and used for the test — it never
 * travels to the browser. Typed non-secret fields override saved ones, so
 * "test my saved key against a different warehouse" works.
 */
export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  let sf_account     = String(body?.sf_account    ?? '').trim();
  let sf_user        = String(body?.sf_user       ?? '').trim();
  let sf_warehouse   = String(body?.sf_warehouse  ?? '').trim();
  let sf_role        = String(body?.sf_role       ?? '').trim() || null;
  let sf_password    = String(body?.sf_password   ?? '').trim() || null;
  let sf_private_key = String(body?.sf_private_key ?? '').trim() || null;

  // Fall back to the account's saved configuration for anything not typed.
  let usedSaved = false;
  if (!sf_password && !sf_private_key) {
    const saved = getDb()
      .prepare(
        `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
         FROM accounts WHERE account_id = ?`,
      )
      .get(Number(session.accountId)) as any;
    if (saved?.sf_password || saved?.sf_private_key) {
      usedSaved = true;
      sf_account     = sf_account   || String(saved.sf_account   ?? '');
      sf_user        = sf_user      || String(saved.sf_user      ?? '');
      sf_warehouse   = sf_warehouse || String(saved.sf_warehouse ?? '');
      sf_role        = sf_role      || (saved.sf_role ? String(saved.sf_role) : null);
      sf_password    = saved.sf_password    ? decryptSecret(String(saved.sf_password))    : null;
      sf_private_key = saved.sf_private_key ? decryptSecret(String(saved.sf_private_key)) : null;
    }
  }

  if (!sf_account || !sf_user || !sf_warehouse || !sf_role) {
    return Response.json({ error: 'Account, username, warehouse, and role are required.' }, { status: 400 });
  }
  if (!sf_password && !sf_private_key) {
    return Response.json({ error: 'Either a password or a private key is required.' }, { status: 400 });
  }

  const privateKey = sf_private_key
    ? (sf_private_key.includes('\\n') ? sf_private_key.replace(/\\n/g, '\n') : sf_private_key)
    : undefined;

  const conn = createAdHocSnowflakeConnection({
    account:   sf_account,
    username:  sf_user,
    warehouse: sf_warehouse,
    ...(sf_role     ? { role: sf_role }         : {}),
    ...(privateKey  ? { privateKey }            : {}),
    ...(sf_password ? { password: sf_password } : {}),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });

    const rows = await execSnowflake(conn, `SELECT CURRENT_VERSION() AS v, CURRENT_WAREHOUSE() AS w, CURRENT_DATABASE() AS d`);
    const r = rows[0] ?? {};

    // Connecting with a nonexistent warehouse succeeds (it's only a session
    // default), so verify it exists and check its auto-suspend setting.
    // LIKE treats '_' as a wildcard — match the exact name from the results.
    let warning: string | null = null;
    const whPattern = sf_warehouse.replace(/'/g, "''");
    const whRows = await execSnowflake(conn, `SHOW WAREHOUSES LIKE '${whPattern}'`);
    const wh = whRows.find(
      (row: any) => String(row.name ?? row.NAME ?? '').toUpperCase() === sf_warehouse.toUpperCase(),
    );
    if (!wh) {
      return Response.json({
        ok: false,
        error: `Connected, but warehouse "${sf_warehouse}" does not exist or is not visible to this role.`,
      }, { status: 400 });
    }
    const autoSuspend = Number(wh.auto_suspend ?? wh.AUTO_SUSPEND ?? NaN);
    if (!Number.isFinite(autoSuspend) || autoSuspend <= 0) {
      warning = 'This warehouse never auto-suspends — it will bill continuously. Prism recommends AUTO_SUSPEND = 60.';
    } else if (autoSuspend > 60) {
      warning = `This warehouse auto-suspends after ${autoSuspend}s of inactivity. Prism recommends 60s to minimize cost.`;
    }

    return Response.json({
      ok:        true,
      used:      usedSaved ? 'saved' : 'typed',
      version:   String(r.V ?? r.v ?? ''),
      warehouse: String(r.W ?? r.w ?? ''),
      database:  String(r.D ?? r.d ?? ''),
      ...(warning ? { warning } : {}),
    });
  } catch (err: any) {
    // Log the raw driver error server-side; return only the failure CLASS to
    // the client (auth vs network vs other), never the raw message.
    console.error('[test-snowflake] connection test failed:', err);
    const raw  = String(err?.message ?? err ?? '');
    const code = (err as any)?.code;
    let error: string;
    if (/incorrect username or password|password|jwt|private key|authenticat|390100|390144|mfa/i.test(raw)) {
      error = 'Authentication failed. Check your username and password or private key.';
    } else if (/enotfound|econn|etimedout|certificate|could not connect|network|account.*(not exist|not found)|404/i.test(raw)) {
      error = 'Could not reach that Snowflake account. Check the account identifier and your network.';
    } else if (/warehouse/i.test(raw)) {
      error = 'Connected, but the warehouse could not be used. Check the warehouse name and its state.';
    } else {
      error = 'Connection failed. Check the account details and try again.';
    }
    return Response.json({ ok: false, error, code }, { status: 400 });
  } finally {
    await new Promise<void>((resolve) => {
      conn.destroy(() => resolve());
    });
  }
}
