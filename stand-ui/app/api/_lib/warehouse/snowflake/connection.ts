// Snowflake implementation of the warehouse adapter (see ../types.ts and
// docs/MSSQL_PORT_PLAN.md). This is the ONLY module tree allowed to import
// `snowflake-sdk`. Consumers go through `_lib/warehouse` (the facade); the
// snowflake-specific setup surfaces (test-snowflake, workspace-snowflake,
// snowflake-config, verify-install routes + grants.ts) may import this module
// directly until Phase 6 generalizes them.
import 'server-only';

import fs from 'node:fs';
import snowflake from 'snowflake-sdk';

import { getDb } from '../../sqlite';
import { decryptSecret } from '../../crypto';
import { getOptionalEnv } from '../../env';
import { isNativeEdition } from '../../edition';
import { NoUserWarehouseConfig, type WarehouseAdapter } from '../types';

type SnowflakeConnection = ReturnType<typeof snowflake.createConnection>;

function getRequiredEnv(name: string): string {
  const v = getOptionalEnv(name);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Add it to stand-ui/.env.local`
    );
  }
  return v;
}

function getPrivateKeyFromEnv(): string | undefined {
  const key = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY');
  if (!key) return undefined;
  // Allow env var to contain "\n" sequences.
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

function getPrivateKeyFromPath(): string | undefined {
  const path = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY_PATH');
  if (!path) return undefined;
  try {
    const stat = fs.statSync(path);
    if (stat.isDirectory()) {
      throw new Error(
        `SNOWFLAKE_PRIVATE_KEY_PATH points to a directory: ${path}. It must point to your private key file (e.g. .../rsa_key.p8).`
      );
    }
    return fs.readFileSync(path, 'utf8');
  } catch (e: any) {
    const code = e?.code ? String(e.code) : '';
    if (code === 'ENOENT') {
      throw new Error(
        `SNOWFLAKE_PRIVATE_KEY_PATH does not exist: ${path}. Set it to the full path of your private key file (e.g. /Users/sanjivp27/snowflake_keys/rsa_key.p8).`
      );
    }
    // Re-throw with original message for other cases (permissions, etc.)
    throw e;
  }
}

// ── SPCS ambient auth (native edition only — docs/NATIVE_APP_PLAN.md N2) ─────
//
// Inside a Snowpark Container Services container, Snowflake mounts a rotating
// OAuth token at /snowflake/session/token and sets SNOWFLAKE_HOST /
// SNOWFLAKE_ACCOUNT. No credentials are configured anywhere — the container
// IS the identity. The token rotates, so it is read fresh for every
// connection (which fits the no-pool, fresh-connection-per-call design).
// Gated on the native edition so the standard edition's resolution is
// byte-identical even if its image ever runs inside SPCS.

const SPCS_TOKEN_PATH = '/snowflake/session/token';

/** True when running inside SPCS with the ambient token available. */
export function spcsAmbientAvailable(): boolean {
  if (!isNativeEdition()) return false;
  if (!getOptionalEnv('SNOWFLAKE_HOST') || !getOptionalEnv('SNOWFLAKE_ACCOUNT')) return false;
  try { return fs.statSync(SPCS_TOKEN_PATH).isFile(); } catch { return false; }
}

function createSpcsSnowflakeConnection(): SnowflakeConnection {
  const host    = getRequiredEnv('SNOWFLAKE_HOST');
  const account = getRequiredEnv('SNOWFLAKE_ACCOUNT');
  // Fresh read every connection — the platform rotates the token in place.
  const token = fs.readFileSync(SPCS_TOKEN_PATH, 'utf8').trim();
  const port  = getOptionalEnv('SNOWFLAKE_PORT') ?? '443';

  // Inside a NATIVE APP the session database must be the APPLICATION (the
  // consumer names it — unknowable statically). PRISM_INTERNAL_DB pins it
  // when set; otherwise the session default is left ALONE so ambient
  // resolution lands on the app database. Never force PRISM_DB here — the
  // app has no access to it (install-test failure 2026-08-13).
  const database  = getOptionalEnv('PRISM_INTERNAL_DB') ?? getOptionalEnv('SNOWFLAKE_DATABASE');
  const schema    = getOptionalEnv('SNOWFLAKE_SCHEMA');
  const warehouse = getOptionalEnv('SNOWFLAKE_WAREHOUSE') ?? 'PRISM_APP_WH';

  return snowflake.createConnection({
    accessUrl: `https://${host}:${port}`,
    account,
    token,
    authenticator: 'OAUTH',
    warehouse,
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
  } as any);
}

// ── Workspace-level service credentials (saved from /setup onboarding) ───────
//
// The service connection resolves in tiers:
//   0. SPCS ambient token (native edition inside a container — see above)
//   1. workspace_config (SQLite, saved by an admin on the /setup flow — secrets
//      encrypted at rest, decrypted only here)
//   2. SNOWFLAKE_* env vars (the operator fallback / escape hatch)
// Pipelines, the poller, and the shared lookup all go through this resolution
// via withSnowflake; personal (per-account) credentials are a separate path
// used only by the one-time flow.

export interface WorkspaceSfConfig {
  account:     string;
  username:    string;
  warehouse:   string;
  role?:       string;
  password?:   string;
  privateKey?: string;
}

// Short-TTL cache: the poller opens a connection every cycle and this is a
// per-connection SQLite read + decrypt. Explicit invalidation covers the
// same-module case; the TTL covers any other module instance after hot-reload.
let _workspaceSfCache: { value: WorkspaceSfConfig | null; at: number } | null = null;
const WORKSPACE_SF_CACHE_TTL_MS = 10_000;

export function invalidateWorkspaceSfConfig(): void {
  _workspaceSfCache = null;
}

export function getWorkspaceSfConfig(): WorkspaceSfConfig | null {
  if (_workspaceSfCache && Date.now() - _workspaceSfCache.at < WORKSPACE_SF_CACHE_TTL_MS) {
    return _workspaceSfCache.value;
  }
  let value: WorkspaceSfConfig | null = null;
  try {
    const r = getDb()
      .prepare(
        `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
         FROM workspace_config WHERE id = 1`,
      )
      .get() as any;
    if (r?.sf_account && r?.sf_user && r?.sf_warehouse && (r?.sf_password || r?.sf_private_key)) {
      value = {
        account:   String(r.sf_account),
        username:  String(r.sf_user),
        warehouse: String(r.sf_warehouse),
        ...(r.sf_role        ? { role: String(r.sf_role) } : {}),
        ...(r.sf_password    ? { password: decryptSecret(String(r.sf_password)) } : {}),
        ...(r.sf_private_key ? { privateKey: decryptSecret(String(r.sf_private_key)) } : {}),
      };
    }
  } catch (err) {
    // A decrypt failure (e.g. rotated PRISM_ENCRYPTION_KEY) must not take the
    // whole service connection down — fall back to env vars.
    console.error('[snowflake] workspace config unreadable, falling back to env:', err);
    value = null;
  }
  _workspaceSfCache = { value, at: Date.now() };
  return value;
}

/** The env-configured service secrets, for server-side fallback when saving
 *  workspace credentials without typing a secret (never sent to the browser). */
export function getEnvSnowflakeSecrets(): { password?: string; privateKey?: string } {
  let privateKey: string | undefined;
  try {
    privateKey = getPrivateKeyFromEnv() ?? getPrivateKeyFromPath();
  } catch {
    privateKey = undefined; // bad key path — treat as no env key
  }
  return { password: getOptionalEnv('SNOWFLAKE_PASSWORD'), privateKey };
}

/** Where the service connection's credentials come from right now. */
export function serviceConnectionSource(): 'spcs' | 'workspace' | 'env' | 'none' {
  if (spcsAmbientAvailable()) return 'spcs';
  if (getWorkspaceSfConfig()) return 'workspace';
  if (
    getOptionalEnv('SNOWFLAKE_ACCOUNT') &&
    getOptionalEnv('SNOWFLAKE_USER') &&
    (getOptionalEnv('SNOWFLAKE_PASSWORD') ||
      getOptionalEnv('SNOWFLAKE_PRIVATE_KEY') ||
      getOptionalEnv('SNOWFLAKE_PRIVATE_KEY_PATH'))
  ) {
    return 'env';
  }
  return 'none';
}

function createWorkspaceSnowflakeConnection(ws: WorkspaceSfConfig): SnowflakeConnection {
  const rawKey = ws.privateKey;
  const privateKey = rawKey
    ? (rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey)
    : undefined;
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'PRISM_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'INTERNAL';

  return snowflake.createConnection({
    account:   ws.account,
    username:  ws.username,
    warehouse: ws.warehouse,
    database,
    schema,
    ...(ws.role ? { role: ws.role } : {}),
    ...(privateKey
      ? { authenticator: 'SNOWFLAKE_JWT', privateKey }
      : { password: ws.password ?? '' }),
  } as any);
}

export function createSnowflakeConnection(): SnowflakeConnection {
  if (spcsAmbientAvailable()) return createSpcsSnowflakeConnection();
  const ws = getWorkspaceSfConfig();
  if (ws) return createWorkspaceSnowflakeConnection(ws);

  const account = getRequiredEnv('SNOWFLAKE_ACCOUNT');
  const username = getRequiredEnv('SNOWFLAKE_USER');
  const warehouse = getRequiredEnv('SNOWFLAKE_WAREHOUSE');

  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'PRISM_DB';
  const schema = getOptionalEnv('SNOWFLAKE_SCHEMA') ?? 'INTERNAL';
  const role = getOptionalEnv('SNOWFLAKE_ROLE');

  const privateKey = getPrivateKeyFromEnv() ?? getPrivateKeyFromPath();
  const privateKeyPass = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE');

  // If a private key is provided, default to JWT/key-pair auth unless explicitly overridden.
  const envAuthenticator = getOptionalEnv('SNOWFLAKE_AUTHENTICATOR');
  const authenticator = envAuthenticator ?? (privateKey ? 'SNOWFLAKE_JWT' : undefined);

  const password = getOptionalEnv('SNOWFLAKE_PASSWORD');
  const passcode = getOptionalEnv('SNOWFLAKE_PASSCODE');
  const passcodeInPassword =
    (getOptionalEnv('SNOWFLAKE_PASSCODE_IN_PASSWORD') ?? '').toLowerCase() ===
    'true';

  if (!privateKey && !password) {
    throw new Error(
      'Snowflake credentials missing. Connect the workspace on the setup page (/setup), or set SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY/SNOWFLAKE_PRIVATE_KEY_PATH in stand-ui/.env.local'
    );
  }

  return snowflake.createConnection({
    account,
    username,
    warehouse,
    database,
    schema,
    ...(role ? { role } : {}),
    ...(authenticator ? { authenticator } : {}),
    ...(privateKey
      ? {
          privateKey,
          ...(privateKeyPass ? { privateKeyPass } : {}),
        }
      : {
          password: password ?? '',
          ...(passcode ? { passcode } : {}),
          ...(passcodeInPassword ? { passcodeInPassword } : {}),
        }),
  } as any);
}

async function connect(connection: SnowflakeConnection): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function destroy(connection: SnowflakeConnection): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.destroy((err) => {
      // If connection failed earlier, snowflake-sdk often reports "Already disconnected".
      if (err && !String((err as any)?.message ?? err).includes('Already disconnected')) {
        console.error('Error closing connection:', err);
      }
      resolve();
    });
  });
}

export async function withSnowflake<T>(
  fn: (connection: SnowflakeConnection) => Promise<T>
): Promise<T> {
  const connection = createSnowflakeConnection();
  try {
    await connect(connection);
    return await fn(connection);
  } finally {
    await destroy(connection);
  }
}

// ── Per-account (personal) Snowflake connections ─────────────────────────────
//
// Any user can save their own Snowflake credentials (accounts.sf_* — encrypted
// at rest). These personal connections are used ONLY for one-time
// standardizations of tables the PRISM_SERVICE role cannot see: the read runs
// under the user's own Snowflake entitlements, and the output table is written
// under them too. Pipelines and the shared lookup always use the service
// connection (withSnowflake).

// (The "no personal credentials" error class lives in ../types.ts as
// NoUserWarehouseConfig — shared across adapters.)

/** True when the account has a usable personal Snowflake credential saved. */
export function hasUserSnowflakeConfig(accountId: number): boolean {
  const r = getDb()
    .prepare(
      `SELECT sf_account, sf_user, sf_warehouse,
              (sf_password IS NOT NULL AND sf_password != '') OR
              (sf_private_key IS NOT NULL AND sf_private_key != '') AS has_secret
       FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as any;
  return Boolean(r?.sf_account && r?.sf_user && r?.sf_warehouse && r?.has_secret);
}

function createUserSnowflakeConnection(accountId: number): SnowflakeConnection {
  const r = getDb()
    .prepare(
      `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
       FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as any;
  if (!r?.sf_account || !r?.sf_user || !r?.sf_warehouse || (!r?.sf_password && !r?.sf_private_key)) {
    throw new NoUserWarehouseConfig();
  }

  const rawKey = r.sf_private_key ? decryptSecret(String(r.sf_private_key)) : null;
  const privateKey = rawKey
    ? (rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey)
    : undefined;
  const password = r.sf_password ? decryptSecret(String(r.sf_password)) : undefined;
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'PRISM_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'INTERNAL';

  return snowflake.createConnection({
    account:   String(r.sf_account),
    username:  String(r.sf_user),
    warehouse: String(r.sf_warehouse),
    database,
    schema,
    ...(r.sf_role ? { role: String(r.sf_role) } : {}),
    ...(privateKey
      ? { authenticator: 'SNOWFLAKE_JWT', privateKey }
      : { password: password ?? '' }),
  } as any);
}

/** Like withSnowflake, but connects with the account's PERSONAL credentials. */
export async function withUserSnowflake<T>(
  accountId: number,
  fn: (connection: SnowflakeConnection) => Promise<T>,
): Promise<T> {
  const connection = createUserSnowflakeConnection(accountId);
  try {
    await connect(connection);
    return await fn(connection);
  } finally {
    await destroy(connection);
  }
}

/** True when an error reads as "no access / object not visible" rather than a
 *  transient or syntax failure — the trigger for falling back from the service
 *  connection to the user's personal one. */
export function isSnowflakeAccessError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('does not exist or not authorized') ||
    msg.includes('insufficient privileges') ||
    msg.includes('insufficient privilege') ||
    msg.includes('not authorized') ||
    msg.includes('access control error') ||
    msg.includes('object does not exist')
  );
}

// ── Per-account Snowflake config ──────────────────────────────────────────────

interface AccountSfConfig {
  account:    string;
  username:   string;
  warehouse:  string;
  role?:      string;
  password?:  string;
  privateKey?: string;
}

// In-process cache: accountId → config (null = no custom config, use env vars)
const _accountSfConfigCache = new Map<number, AccountSfConfig | null>();

export function invalidateAccountSfConfig(accountId: number): void {
  _accountSfConfigCache.delete(accountId);
}

function normalizeError(error: unknown): { message: string; code?: unknown } {
  const message = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  })();
  const code = (error as any)?.code;
  return { message, code };
}

export function snowflakeErrorResponse(
  error: unknown,
  fallbackPublicMessage: string
): Response {
  const { message, code } = normalizeError(error);

  // Full detail stays server-side only — never echo raw driver messages or SQL
  // text back to the client.
  console.error(`[snowflake] ${fallbackPublicMessage}:`, message, code != null ? `(code ${code})` : '');

  if (message.includes('A password must be specified')) {
    return Response.json(
      {
        error:
          'Snowflake auth is not configured. Set SNOWFLAKE_PRIVATE_KEY_PATH (recommended) to your private key file (rsa_key.p8), or set SNOWFLAKE_PASSWORD.',
        code,
      },
      { status: 500 }
    );
  }

  // Snowflake error code for "MFA with TOTP is required" is commonly 394508
  if (String(code) === '394508' || message.includes('MFA with TOTP is required')) {
    return Response.json(
      {
        error:
          'Snowflake login blocked by MFA (TOTP). Use key-pair auth (recommended) or a user exempt from MFA for API access.',
        code,
      },
      { status: 401 }
    );
  }

  // Missing env / misconfiguration
  if (message.startsWith('Missing required environment variable') || message.startsWith('Snowflake credentials missing')) {
    return Response.json(
      { error: message },
      { status: 500 }
    );
  }

  return Response.json(
    { error: fallbackPublicMessage, code },
    { status: 500 }
  );
}

// ── Query execution ───────────────────────────────────────────────────────────

/** Execute one statement, resolving to its result rows. The single shared
 *  implementation of the `exec()` helper formerly duplicated in ~30 modules. */
export function executeQuery(
  conn: any,
  sqlText: string,
  binds?: any[],
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) =>
        err ? reject(err) : resolve(rows ?? []),
    });
  });
}

// ── Ad-hoc connections (setup surfaces only) ─────────────────────────────────
//
// The credential-testing routes (test-snowflake, workspace-snowflake,
// snowflake-config) connect with user-TYPED credentials before anything is
// saved. They build connections from explicit fields rather than the resolved
// service/personal config.

export interface AdHocSnowflakeConfig {
  account:        string;
  username:       string;
  warehouse:      string;
  role?:          string;
  password?:      string;
  privateKey?:    string;
  /** Explicit authenticator override; defaults to SNOWFLAKE_JWT when a
   *  privateKey is present. */
  authenticator?: string;
}

export function createAdHocSnowflakeConnection(cfg: AdHocSnowflakeConfig): SnowflakeConnection {
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'PRISM_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'INTERNAL';
  const authenticator = cfg.authenticator ?? (cfg.privateKey ? 'SNOWFLAKE_JWT' : undefined);
  return snowflake.createConnection({
    account: cfg.account, username: cfg.username, warehouse: cfg.warehouse, database, schema,
    ...(cfg.role        ? { role: cfg.role }   : {}),
    ...(authenticator   ? { authenticator }    : {}),
    ...(cfg.privateKey  ? { privateKey: cfg.privateKey } : { password: cfg.password ?? '' }),
  } as any);
}

/** connect → fn → destroy for an ad-hoc connection (setup surfaces only). */
export async function withAdHocSnowflake<T>(
  cfg: AdHocSnowflakeConfig,
  fn: (connection: SnowflakeConnection) => Promise<T>,
): Promise<T> {
  const connection = createAdHocSnowflakeConnection(cfg);
  try {
    await connect(connection);
    return await fn(connection);
  } finally {
    await destroy(connection);
  }
}

// ── The adapter object (see ../types.ts) ─────────────────────────────────────

export const snowflakeAdapter: WarehouseAdapter = {
  kind: 'snowflake',
  bindLimit: 60_000,
  withConnection: withSnowflake,
  withUserConnection: withUserSnowflake,
  hasUserConfig: hasUserSnowflakeConfig,
  executeQuery,
  isAccessError: isSnowflakeAccessError,
  errorResponse: snowflakeErrorResponse,
  serviceConnectionSource,
};


