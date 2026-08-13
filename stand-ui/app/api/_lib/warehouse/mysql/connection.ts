/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../types.ts). */
// MySQL implementation of the warehouse adapter.
// The ONLY module (with this directory) allowed to import `mysql2`.
//
// Phase M1 scope (docs/MYSQL_PORT_PLAN.md): service connection from env
// config, query execution with native-`?` bind validation, error
// classification/sanitization, scale-to-zero host warning. Workspace-config
// credentials and personal (per-account) credentials arrive in Phase M4 —
// the readers below already tolerate the missing columns (resolving to
// "none saved") so this module does not change shape when the migration lands.
import 'server-only';

import mysql from 'mysql2/promise';

import { getOptionalEnv } from '../../env';
import { getDb } from '../../sqlite';
import { decryptSecret } from '../../crypto';
import { NoUserWarehouseConfig, type WarehouseAdapter } from '../types';
import { translateBinds, isScaleToZeroHost, isMysqlAccessErrorShape } from './dialect';

// ── Config resolution (env tier until Phase M4) ─────────────────────────────
//
//   MYSQL_HOST       (required)
//   MYSQL_PORT       default 3306
//   MYSQL_DATABASE   default connection database — 'prism_internal' (unlike
//                    Postgres this is NOT a scope: cross-database queries work,
//                    it's only the session default)
//   MYSQL_USER / MYSQL_PASSWORD   (required)
//   MYSQL_SSL        'false' (default — local dev container) | 'true'
//                    (encrypted, no CA verification) | 'strict' (verify CA)

export interface MysqlDriverConfig {
  host: string; port: number; database: string; user: string; password: string;
  ssl: undefined | { rejectUnauthorized: boolean };
}

function sslFromMode(mode: string | undefined): MysqlDriverConfig['ssl'] {
  const m = (mode ?? 'false').toLowerCase();
  if (m === 'false' || m === '' || m === 'disable') return undefined;
  if (m === 'strict' || m === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false }; // 'true' / 'require'
}

export function getMysqlEnvConfig(): MysqlDriverConfig | null {
  const host = getOptionalEnv('MYSQL_HOST');
  const user = getOptionalEnv('MYSQL_USER');
  const password = getOptionalEnv('MYSQL_PASSWORD');
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(getOptionalEnv('MYSQL_PORT') ?? 3306),
    database: getOptionalEnv('MYSQL_DATABASE') ?? 'prism_internal',
    user,
    password,
    ssl: sslFromMode(getOptionalEnv('MYSQL_SSL')),
  };
}

// ── Workspace-tier credentials (saved from /setup — Phase M4) ───────────────

export interface WorkspaceMyConfig {
  host: string; port: number; database: string; user: string; password: string;
  ssl: string;
}

let _wsMyCache: { value: WorkspaceMyConfig | null; at: number } | null = null;
const WS_MY_CACHE_TTL_MS = 10_000;

export function invalidateWorkspaceMyConfig(): void {
  _wsMyCache = null;
}

export function getWorkspaceMyConfig(): WorkspaceMyConfig | null {
  if (_wsMyCache && Date.now() - _wsMyCache.at < WS_MY_CACHE_TTL_MS) return _wsMyCache.value;
  let value: WorkspaceMyConfig | null = null;
  try {
    const r = getDb()
      .prepare(`SELECT my_host, my_port, my_database, my_user, my_password, my_ssl
                FROM workspace_config WHERE id = 1`)
      .get() as any;
    if (r?.my_host && r?.my_user && r?.my_password) {
      value = {
        host: String(r.my_host),
        port: Number(r.my_port ?? 3306),
        database: String(r.my_database ?? 'prism_internal'),
        user: String(r.my_user),
        password: decryptSecret(String(r.my_password)),
        ssl: String(r.my_ssl ?? 'true'),
      };
    }
  } catch {
    value = null; // columns not migrated yet / fresh install — env tier
  }
  _wsMyCache = { value, at: Date.now() };
  return value;
}

/** The MySQL account Prism connects as — the grantee for every GRANT Prism
 *  issues or displays. NEVER hardcode 'prism_svc' (KI-61/KI-215 — see the
 *  mssql getServiceLoginName doc comment; the wizard's username field only
 *  DEFAULTS to prism_svc). MySQL grants address 'user'@'host' accounts;
 *  displayed fix SQL uses @'%' which matches the install template. */
export function getServiceAccountName(): string {
  const ws = getWorkspaceMyConfig();
  if (ws?.user) return ws.user;
  const envUser = process.env.MYSQL_USER;
  if (envUser && envUser.trim()) return envUser.trim();
  return 'prism_svc';
}

function workspaceToDriverConfig(ws: WorkspaceMyConfig): MysqlDriverConfig {
  return {
    host: ws.host, port: ws.port, database: ws.database, user: ws.user, password: ws.password,
    ssl: sslFromMode(ws.ssl),
  };
}

/** Where the mysql service connection's credentials come from right now. */
export function mysqlServiceConnectionSource(): 'workspace' | 'env' | 'none' {
  if (getWorkspaceMyConfig()) return 'workspace';
  if (getMysqlEnvConfig()) return 'env';
  return 'none';
}

function requireConfig(): MysqlDriverConfig {
  const ws = getWorkspaceMyConfig();
  if (ws) return workspaceToDriverConfig(ws);
  const cfg = getMysqlEnvConfig();
  if (!cfg) {
    throw new Error(
      'MySQL credentials missing. Connect the workspace on the setup page (/setup), or set MYSQL_HOST, MYSQL_USER and MYSQL_PASSWORD in stand-ui/.env.local',
    );
  }
  return cfg;
}

// Scale-to-zero warning: log once per process, not per connection.
let scaleToZeroChecked = false;

async function openConnection(cfg: MysqlDriverConfig): Promise<mysql.Connection> {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password, ssl: cfg.ssl,
    // Bind-free calls may carry BEGIN;…;COMMIT sequences (the other adapters'
    // multi-statement convention); parameterized calls stay single-statement.
    multipleStatements: true,
    connectTimeout: 30_000,
  });
  // Parity with PRISM_WH's 600 s statement timeout. ⚠️ MySQL applies
  // MAX_EXECUTION_TIME to SELECT only — long writes are bounded by
  // innodb_lock_wait_timeout instead (documented, not pretended away).
  //
  // information_schema_stats_expiry = 0 is LOAD-BEARING for detection: MySQL
  // caches statistics-backed I_S columns (UPDATE_TIME, TABLE_ROWS) for 24
  // HOURS by default, which would blind the diff-scan heartbeat for a day
  // after a write (docs/MYSQL_PORT_PLAN.md §2.2 / warehouse/mysql/detection.ts
  // header). Fresh reads come from InnoDB dynamic metadata — cheap, no scan.
  await conn.query('SET SESSION MAX_EXECUTION_TIME = 600000, SESSION information_schema_stats_expiry = 0');
  if (!scaleToZeroChecked) {
    scaleToZeroChecked = true;
    if (isScaleToZeroHost(cfg.host)) {
      console.warn(
        `[mysql] Host ${cfg.host} looks like a sleep-on-idle provider (PlanetScale). ` +
        `Prism's polling will keep the database awake — use an always-on tier ` +
        `or stretch the polling cadence. See docs/MYSQL_PORT_PLAN.md §2.7.`,
      );
    }
  }
  return conn;
}

/** A fresh connection per call, closed in `finally` — mirrors the other
 *  adapters' semantics (no pooling). */
export async function withMysql<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await openConnection(requireConfig());
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => { /* already closed */ });
  }
}

/** connect → fn → close for AD-HOC (typed, unsaved) credentials — setup
 *  surfaces only, mirrors the other adapters' ad-hoc helpers. */
export async function withAdHocMysql<T>(
  cfg: { host: string; port?: number; database?: string; user: string; password: string; ssl?: string },
  fn: (conn: mysql.Connection) => Promise<T>,
): Promise<T> {
  const conn = await openConnection({
    host: cfg.host,
    port: cfg.port ?? 3306,
    database: cfg.database ?? 'prism_internal',
    user: cfg.user,
    password: cfg.password,
    ssl: sslFromMode(cfg.ssl),
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

// ── Personal (per-account) credentials — one-time flow fallback (Phase M4) ──

export function hasUserMysqlConfig(accountId: number): boolean {
  try {
    const r = getDb()
      .prepare(`SELECT my_host, my_user,
                       (my_password IS NOT NULL AND my_password != '') AS has_secret
                FROM accounts WHERE account_id = ?`)
      .get(accountId) as any;
    return Boolean(r?.my_host && r?.my_user && r?.has_secret);
  } catch { return false; } // columns not migrated yet
}

async function withUserMysql<T>(accountId: number, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  let r: any;
  try {
    r = getDb()
      .prepare(`SELECT my_host, my_port, my_database, my_user, my_password FROM accounts WHERE account_id = ?`)
      .get(accountId);
  } catch { throw new NoUserWarehouseConfig(); }
  if (!r?.my_host || !r?.my_user || !r?.my_password) throw new NoUserWarehouseConfig();
  const ws = getWorkspaceMyConfig();
  return withAdHocMysql(
    {
      host: String(r.my_host),
      port: Number(r.my_port ?? 3306),
      database: String(r.my_database ?? ws?.database ?? getOptionalEnv('MYSQL_DATABASE') ?? 'prism_internal'),
      user: String(r.my_user),
      password: decryptSecret(String(r.my_password)),
      ssl: ws?.ssl ?? getOptionalEnv('MYSQL_SSL') ?? 'false',
    },
    fn,
  );
}

/** Execute one statement. `?` placeholders are NATIVE on this driver —
 *  translateBinds only validates/counts (quote/comment-aware), the text is
 *  unchanged. Returns result rows; DML resolves to a one-element array
 *  holding the driver's OkPacket (callers read `affectedRows` from it — the
 *  RETURNING/OUTPUT analog on this warehouse). Bind-free multi-statement
 *  text resolves to the LAST statement's rows (adapter convention). */
export async function executeQuery(
  conn: any,
  sqlText: string,
  binds?: any[],
): Promise<any[]> {
  const client = conn as mysql.Connection;
  const { count } = translateBinds(sqlText);
  const params = binds ?? [];
  if (count !== params.length) {
    throw new Error(
      `[mysql] Bind count mismatch: statement has ${count} placeholders, got ${params.length} values`,
    );
  }
  const [rows] = params.length === 0
    ? await client.query(sqlText)
    : await client.query(sqlText, params.map((v) => (v === undefined ? null : v)));
  if (Array.isArray(rows)) {
    // Multi-statement results come back as an array of result sets — resolve
    // to the LAST one (same convention as the pg adapter). A single SELECT
    // returns a plain row array (whose elements are objects, not arrays).
    if (rows.length > 0 && Array.isArray(rows[rows.length - 1])) {
      return rows[rows.length - 1] as any[];
    }
    return rows as any[];
  }
  // DML OkPacket ({affectedRows, insertId, …}) — wrap so callers can read it.
  return rows ? [rows] : [];
}

// ── Error classification & sanitization ──────────────────────────────────────

export function isMysqlAccessError(err: unknown): boolean {
  return isMysqlAccessErrorShape(err);
}

export function mysqlErrorResponse(error: unknown, fallbackPublicMessage: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  const errno = (error as any)?.errno;

  // Full detail stays server-side only — MySQL error messages can embed SQL
  // fragments, so never echo raw driver messages to the client.
  console.error(`[mysql] ${fallbackPublicMessage}:`, message, errno != null ? `(errno ${errno})` : '');

  if (message.startsWith('MySQL credentials missing')) {
    return Response.json({ error: message }, { status: 500 });
  }
  if (Number(errno) === 1045 || message.toLowerCase().includes('access denied for user')) {
    return Response.json(
      { error: 'MySQL login failed. Check the service account credentials.', errno },
      { status: 401 },
    );
  }
  return Response.json({ error: fallbackPublicMessage, errno }, { status: 500 });
}

// ── The adapter object (see ../types.ts) ─────────────────────────────────────

export const mysqlAdapter: WarehouseAdapter = {
  kind: 'mysql',
  // mysql2's query() interpolates client-side (no server prepare), so there is
  // no protocol bind ceiling — 60,000 keeps the batching budget consistent
  // with the Snowflake/pg adapters (bounded statements, sane packet sizes).
  bindLimit: 60_000,
  withConnection: withMysql,
  withUserConnection: withUserMysql,
  hasUserConfig: hasUserMysqlConfig,
  executeQuery,
  isAccessError: isMysqlAccessError,
  errorResponse: mysqlErrorResponse,
  serviceConnectionSource: mysqlServiceConnectionSource,
};
