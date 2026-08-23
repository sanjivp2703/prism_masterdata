/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../types.ts). */
// Microsoft SQL Server implementation of the warehouse adapter.
// The ONLY module (with this directory) allowed to import `mssql`.
//
// Phase 3 scope (docs/MSSQL_PORT_PLAN.md): service connection from env config,
// query execution with ?→@pN bind translation, error classification/
// sanitization, serverless-tier detection. Workspace-config credentials and
// personal (per-account) credentials arrive in Phase 6.
import 'server-only';

import sql from 'mssql';

import { getOptionalEnv } from '../../env';
import { getDb } from '../../sqlite';
import { decryptSecret } from '../../crypto';
import { NoUserWarehouseConfig, type WarehouseAdapter } from '../types';
import { translateBinds, isServerlessAzureTier } from './dialect';

// ── Config resolution (env tier only until Phase 6) ─────────────────────────
//
//   MSSQL_SERVER      host[\instance] (required)
//   MSSQL_PORT        default 1433
//   MSSQL_DATABASE    default PRISM_DB
//   MSSQL_USER / MSSQL_PASSWORD   SQL auth (required until Entra ID lands)
//   MSSQL_ENCRYPT     'true' (default) | 'false'
//   MSSQL_TRUST_SERVER_CERT  'true' for local dev containers (self-signed
//                            certs); default 'false'

export function getMssqlEnvConfig(): sql.config | null {
  const server = getOptionalEnv('MSSQL_SERVER');
  const user = getOptionalEnv('MSSQL_USER');
  const password = getOptionalEnv('MSSQL_PASSWORD');
  if (!server || !user || !password) return null;
  return {
    server,
    port: Number(getOptionalEnv('MSSQL_PORT') ?? 1433),
    database: getOptionalEnv('MSSQL_DATABASE') ?? 'PRISM_DB',
    user,
    password,
    options: {
      encrypt: (getOptionalEnv('MSSQL_ENCRYPT') ?? 'true').toLowerCase() !== 'false',
      trustServerCertificate:
        (getOptionalEnv('MSSQL_TRUST_SERVER_CERT') ?? 'false').toLowerCase() === 'true',
    },
    pool: { max: 1, min: 0, idleTimeoutMillis: 5_000 },
    requestTimeout: 600_000, // parity with PRISM_WH STATEMENT_TIMEOUT (600 s)
  };
}

// ── Workspace-tier credentials (saved from /setup — Phase 6) ────────────────
// Same resolution shape as the Snowflake side: workspace_config (encrypted,
// 10 s cache + invalidation) → env fallback.

export interface WorkspaceMsConfig {
  server: string; port: number; database: string; user: string; password: string;
  encrypt: boolean; trustServerCertificate: boolean;
}

let _wsMsCache: { value: WorkspaceMsConfig | null; at: number } | null = null;
const WS_MS_CACHE_TTL_MS = 10_000;

export function invalidateWorkspaceMsConfig(): void {
  _wsMsCache = null;
}

/**
 * The SQL Server login Prism actually connects as — the grantee for every
 * GRANT Prism issues or displays.
 *
 * NEVER hardcode the literal 'prism_svc'. The setup wizard's username field is
 * free text and merely DEFAULTS to prism_svc, so a differently-named service
 * login is a fully supported configuration. Hardcoding broke it two ways, both
 * proven live: the automatic "Grant access" reported success while granting to
 * a principal that may not even exist (leaving the real login still unable to
 * write), and the manual fix-SQL shown to admins named the wrong grantee too —
 * so following the instructions exactly still did not fix it. See KI-61/KI-215.
 *
 * Falls back to the env tier, then to 'prism_svc' as a last resort so the
 * displayed SQL is never empty.
 */
export function getServiceLoginName(): string {
  const ws = getWorkspaceMsConfig();
  if (ws?.user) return ws.user;
  const envUser = process.env.MSSQL_USER;
  if (envUser && envUser.trim()) return envUser.trim();
  return 'prism_svc';
}

export function getWorkspaceMsConfig(): WorkspaceMsConfig | null {
  if (_wsMsCache && Date.now() - _wsMsCache.at < WS_MS_CACHE_TTL_MS) return _wsMsCache.value;
  let value: WorkspaceMsConfig | null = null;
  try {
    const r = getDb()
      .prepare(`SELECT ms_server, ms_port, ms_database, ms_user, ms_password, ms_encrypt, ms_trust_server_cert
                FROM workspace_config WHERE id = 1`)
      .get() as any;
    if (r?.ms_server && r?.ms_user && r?.ms_password) {
      value = {
        server: String(r.ms_server),
        port: Number(r.ms_port ?? 1433),
        database: String(r.ms_database ?? 'PRISM_DB'),
        user: String(r.ms_user),
        password: decryptSecret(String(r.ms_password)),
        encrypt: r.ms_encrypt !== 0,
        trustServerCertificate: r.ms_trust_server_cert === 1,
      };
    }
  } catch (err) {
    console.error('[mssql] workspace config unreadable, falling back to env:', err);
    value = null;
  }
  _wsMsCache = { value, at: Date.now() };
  return value;
}

function workspaceToDriverConfig(ws: WorkspaceMsConfig): sql.config {
  return {
    server: ws.server, port: ws.port, database: ws.database, user: ws.user, password: ws.password,
    options: { encrypt: ws.encrypt, trustServerCertificate: ws.trustServerCertificate },
    pool: { max: 1, min: 0, idleTimeoutMillis: 5_000 },
    requestTimeout: 600_000,
  };
}

/** Where the mssql service connection's credentials come from right now. */
export function mssqlServiceConnectionSource(): 'workspace' | 'env' | 'none' {
  if (getWorkspaceMsConfig()) return 'workspace';
  if (getMssqlEnvConfig()) return 'env';
  return 'none';
}

function requireConfig(): sql.config {
  const ws = getWorkspaceMsConfig();
  if (ws) return workspaceToDriverConfig(ws);
  const cfg = getMssqlEnvConfig();
  if (!cfg) {
    throw new Error(
      'SQL Server credentials missing. Connect the workspace on the setup page (/setup), or set MSSQL_SERVER, MSSQL_USER and MSSQL_PASSWORD in stand-ui/.env.local',
    );
  }
  return cfg;
}

/** connect → fn → close for AD-HOC (typed, unsaved) credentials — setup
 *  surfaces only, mirrors createAdHocSnowflakeConnection's role. */
export async function withAdHocMssql<T>(
  cfg: { server: string; port?: number; database?: string; user: string; password: string; encrypt?: boolean; trustServerCertificate?: boolean },
  fn: (conn: sql.ConnectionPool) => Promise<T>,
): Promise<T> {
  const pool = new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port ?? 1433,
    // undefined = let SQL Server use the login's default database.
    ...(cfg.database ? { database: cfg.database } : {}),
    user: cfg.user,
    password: cfg.password,
    options: { encrypt: cfg.encrypt !== false, trustServerCertificate: cfg.trustServerCertificate === true },
    pool: { max: 1, min: 0 },
    requestTimeout: 60_000,
  });
  try {
    await pool.connect();
    return await fn(pool);
  } finally {
    await pool.close().catch(() => {});
  }
}

// ── Personal (per-account) credentials — one-time flow fallback ─────────────

export function hasUserMssqlConfig(accountId: number): boolean {
  try {
    const r = getDb()
      .prepare(`SELECT ms_server, ms_user,
                       (ms_password IS NOT NULL AND ms_password != '') AS has_secret
                FROM accounts WHERE account_id = ?`)
      .get(accountId) as any;
    return Boolean(r?.ms_server && r?.ms_user && r?.has_secret);
  } catch { return false; }
}

async function withUserMssql<T>(accountId: number, fn: (conn: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const r = getDb()
    .prepare(`SELECT ms_server, ms_port, ms_database, ms_user, ms_password FROM accounts WHERE account_id = ?`)
    .get(accountId) as any;
  if (!r?.ms_server || !r?.ms_user || !r?.ms_password) throw new NoUserWarehouseConfig();
  const ws = getWorkspaceMsConfig();
  return withAdHocMssql(
    {
      server: String(r.ms_server),
      port: Number(r.ms_port ?? 1433),
      // NOT ws.database: that is PRISM_DB, Prism's internal database, which
      // a personal (least-privilege) login is not supposed to reach. Blank
      // means "this login's own default database" — fine, because every
      // source table is addressed by full three-part name (finding #26).
      database: String(r.ms_database ?? '').trim() || undefined,
      user: String(r.ms_user),
      password: decryptSecret(String(r.ms_password)),
      encrypt: ws?.encrypt ?? true,
      trustServerCertificate: ws?.trustServerCertificate ?? false,
    },
    fn,
  );
}

// Serverless-tier warning: log once per process, not per connection.
let serverlessChecked = false;

/** A fresh connection per call, closed in `finally` — mirrors the Snowflake
 *  adapter's semantics (a size-1 pool object wraps the single connection). */
export async function withMssql<T>(fn: (conn: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = new sql.ConnectionPool(requireConfig());
  try {
    await pool.connect();
    if (!serverlessChecked) {
      serverlessChecked = true;
      detectServerlessTier(pool).catch(() => { /* best-effort */ });
    }
    return await fn(pool);
  } finally {
    await pool.close().catch(() => { /* already closed */ });
  }
}

/** Azure SQL serverless auto-pauses like a Snowflake warehouse — steady
 *  polling would hold it awake 24/7 and negate the customer's savings. Phase 4
 *  wires this into the poller cadence; for now it warns loudly. */
async function detectServerlessTier(pool: sql.ConnectionPool): Promise<void> {
  const r = await pool
    .request()
    .query(`SELECT CONVERT(NVARCHAR(128), DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective')) AS so`);
  const objective = r.recordset?.[0]?.so ?? null;
  if (isServerlessAzureTier(objective)) {
    console.warn(
      `[mssql] Database is on the Azure SQL SERVERLESS tier (${objective}). ` +
      `Prism's polling will keep it from auto-pausing — stretch the polling cadence ` +
      `or use a provisioned tier. See docs/MSSQL_PORT_PLAN.md §2.3.`,
    );
  }
}

/** Execute one statement. Accepts the codebase's `?` placeholder convention
 *  and translates to @pN named parameters. Returns result rows. */
export async function executeQuery(
  conn: any,
  sqlText: string,
  binds?: any[],
): Promise<any[]> {
  const pool = conn as sql.ConnectionPool;
  const { text, count } = translateBinds(sqlText);
  const params = binds ?? [];
  if (count !== params.length) {
    throw new Error(
      `[mssql] Bind count mismatch: statement has ${count} placeholders, got ${params.length} values`,
    );
  }
  const request = pool.request();
  params.forEach((value, i) => {
    request.input(`p${i + 1}`, mssqlType(value), value ?? null);
  });
  const result = await request.query(text);
  return result.recordset ?? [];
}

/** Explicit type mapping (driver inference guesses badly for null/number). */
function mssqlType(value: unknown): sql.ISqlType | (() => sql.ISqlType) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? sql.BigInt : sql.Float;
  }
  if (typeof value === 'boolean') return sql.Bit;
  if (value instanceof Date) return sql.DateTime2;
  return sql.NVarChar; // strings and nulls
}

// ── Error classification & sanitization ──────────────────────────────────────

/** SQL Server error numbers that read as "no access / object not visible". */
const ACCESS_ERROR_NUMBERS = new Set([
  229,   // permission denied on object
  230,   // permission denied on column
  262,   // permission denied (CREATE/ALTER…)
  297,   // user is not able to access the database
  300,   // permission denied on database
  208,   // invalid object name (missing OR not visible — indistinguishable)
  4060,  // cannot open database
  916,   // login cannot access the database
  18456, // login failed
]);

export function isMssqlAccessError(err: unknown): boolean {
  const num = Number((err as any)?.number ?? (err as any)?.originalError?.info?.number ?? NaN);
  if (ACCESS_ERROR_NUMBERS.has(num)) return true;
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('permission was denied') ||
    msg.includes('permission denied') ||
    msg.includes('invalid object name') ||
    msg.includes('cannot open database') ||
    msg.includes('login failed')
  );
}

export function mssqlErrorResponse(error: unknown, fallbackPublicMessage: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.number ?? (error as any)?.code;

  // Full detail stays server-side only — never echo raw driver messages or
  // SQL text back to the client.
  console.error(`[mssql] ${fallbackPublicMessage}:`, message, code != null ? `(code ${code})` : '');

  if (message.startsWith('SQL Server credentials missing')) {
    return Response.json({ error: message }, { status: 500 });
  }
  // 4060 must be tested BEFORE 18456: SQL Server reports "Cannot open
  // database ... The login failed", so the generic login-failed branch used
  // to swallow it and blame the credentials, which were valid (finding #26).
  const lower = message.toLowerCase();
  if (String(code) === '4060' || lower.includes('cannot open database')) {
    const named = /cannot open database "([^"]+)"/i.exec(message)?.[1];
    return Response.json(
      {
        error: named
          ? `Signed in successfully, but this login has no access to the database "${named}". Leave the database field blank to use the login's own default database, or enter one this login can open.`
          : `Signed in successfully, but this login cannot open the database requested. Leave the database field blank to use the login's own default database.`,
        code,
      },
      { status: 401 },
    );
  }
  if (String(code) === '18456' || lower.includes('login failed')) {
    return Response.json(
      { error: 'SQL Server login failed. Check the username and password.', code },
      { status: 401 },
    );
  }
  return Response.json({ error: fallbackPublicMessage, code }, { status: 500 });
}

// ── The adapter object (see ../types.ts) ─────────────────────────────────────

export const mssqlAdapter: WarehouseAdapter = {
  kind: 'mssql',
  bindLimit: 2_000,
  withConnection: withMssql,
  withUserConnection: withUserMssql,
  hasUserConfig: hasUserMssqlConfig,
  executeQuery,
  isAccessError: isMssqlAccessError,
  errorResponse: mssqlErrorResponse,
  serviceConnectionSource: mssqlServiceConnectionSource,
};
