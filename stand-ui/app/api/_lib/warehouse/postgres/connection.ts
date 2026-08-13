/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../types.ts). */
// PostgreSQL implementation of the warehouse adapter.
// The ONLY module (with this directory) allowed to import `pg`.
//
// Phase P1 scope (docs/POSTGRES_PORT_PLAN.md): service connection from env
// config, query execution with ?→$n bind translation, error classification/
// sanitization, scale-to-zero host warning. Workspace-config credentials and
// personal (per-account) credentials arrive in Phase P4 — the readers below
// already tolerate the missing columns (they simply resolve to "none saved")
// so this module does not change shape when the migration lands.
import 'server-only';

import pg from 'pg';

import { getOptionalEnv } from '../../env';
import { getDb } from '../../sqlite';
import { decryptSecret } from '../../crypto';
import { NoUserWarehouseConfig, type WarehouseAdapter } from '../types';
import { translateBinds, isScaleToZeroHost, isPgAccessErrorShape } from './dialect';

// COUNT(*)/SUM come back as int8/numeric, which node-postgres returns as
// STRINGS by default (int8 can exceed 2^53). Prism's counts are far below
// that, and the whole codebase does `Number(r.c)` anyway — parse int8 to
// number so pg rows behave like the other adapters'.
pg.types.setTypeParser(20, (v: string) => Number(v));

// ── Config resolution (env tier until Phase P4) ─────────────────────────────
//
//   PG_HOST        (required)
//   PG_PORT        default 5432
//   PG_DATABASE    (required — the ONE database this installation standardizes;
//                   Postgres cannot query across databases)
//   PG_USER / PG_PASSWORD   (required)
//   PG_SSLMODE     'disable' (default — local dev container) | 'require' |
//                  'verify-full' (managed providers; verify-full needs
//                  PG_SSL_CA_PATH for a provider CA bundle when applicable)
//   PG_SSL_CA_PATH optional CA certificate file for verify-full

export interface PgDriverConfig {
  host: string; port: number; database: string; user: string; password: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
}

function sslFromMode(mode: string | undefined, caPath?: string | null): PgDriverConfig['ssl'] {
  const m = (mode ?? 'disable').toLowerCase();
  if (m === 'disable' || m === '') return false;
  if (m === 'verify-full') {
    let ca: string | undefined;
    if (caPath) {
      // Read lazily at connect-config time; a missing file should fail loudly.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ca = require('node:fs').readFileSync(caPath, 'utf8');
    }
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  }
  // 'require': encrypted transport without CA verification (the common
  // managed-provider setting when no CA bundle is distributed).
  return { rejectUnauthorized: false };
}

export function getPgEnvConfig(): PgDriverConfig | null {
  const host = getOptionalEnv('PG_HOST');
  const database = getOptionalEnv('PG_DATABASE');
  const user = getOptionalEnv('PG_USER');
  const password = getOptionalEnv('PG_PASSWORD');
  if (!host || !database || !user || !password) return null;
  return {
    host,
    port: Number(getOptionalEnv('PG_PORT') ?? 5432),
    database,
    user,
    password,
    ssl: sslFromMode(getOptionalEnv('PG_SSLMODE'), getOptionalEnv('PG_SSL_CA_PATH')),
  };
}

// ── Workspace-tier credentials (saved from /setup — Phase P4) ───────────────
// Same resolution shape as the other adapters: workspace_config (encrypted,
// 10 s cache + invalidation) → env fallback. Until migration adds the pg_*
// columns, the SELECT throws and this resolves to null (env tier).

export interface WorkspacePgConfig {
  host: string; port: number; database: string; user: string; password: string;
  sslmode: string;
}

let _wsPgCache: { value: WorkspacePgConfig | null; at: number } | null = null;
const WS_PG_CACHE_TTL_MS = 10_000;

export function invalidateWorkspacePgConfig(): void {
  _wsPgCache = null;
}

export function getWorkspacePgConfig(): WorkspacePgConfig | null {
  if (_wsPgCache && Date.now() - _wsPgCache.at < WS_PG_CACHE_TTL_MS) return _wsPgCache.value;
  let value: WorkspacePgConfig | null = null;
  try {
    const r = getDb()
      .prepare(`SELECT pg_host, pg_port, pg_database, pg_user, pg_password, pg_sslmode
                FROM workspace_config WHERE id = 1`)
      .get() as any;
    if (r?.pg_host && r?.pg_database && r?.pg_user && r?.pg_password) {
      value = {
        host: String(r.pg_host),
        port: Number(r.pg_port ?? 5432),
        database: String(r.pg_database),
        user: String(r.pg_user),
        password: decryptSecret(String(r.pg_password)),
        sslmode: String(r.pg_sslmode ?? 'require'),
      };
    }
  } catch {
    value = null; // columns not migrated yet / fresh install — env tier
  }
  _wsPgCache = { value, at: Date.now() };
  return value;
}

/**
 * The Postgres role Prism actually connects as — the grantee for every GRANT
 * Prism issues or displays. NEVER hardcode 'prism_svc' (see the mssql
 * getServiceLoginName doc comment — KI-61/KI-215: a differently-named service
 * login is a supported configuration, and hardcoding broke both the automatic
 * grants and the displayed fix SQL).
 */
export function getServiceRoleName(): string {
  const ws = getWorkspacePgConfig();
  if (ws?.user) return ws.user;
  const envUser = process.env.PG_USER;
  if (envUser && envUser.trim()) return envUser.trim();
  return 'prism_svc';
}

/** The ONE database this installation standardizes (for cross-db FQN checks). */
export function getConnectedPgDatabase(): string | null {
  const ws = getWorkspacePgConfig();
  if (ws?.database) return ws.database;
  return getOptionalEnv('PG_DATABASE') ?? null;
}

function workspaceToDriverConfig(ws: WorkspacePgConfig): PgDriverConfig {
  return {
    host: ws.host, port: ws.port, database: ws.database, user: ws.user, password: ws.password,
    ssl: sslFromMode(ws.sslmode),
  };
}

/** Where the postgres service connection's credentials come from right now. */
export function pgServiceConnectionSource(): 'workspace' | 'env' | 'none' {
  if (getWorkspacePgConfig()) return 'workspace';
  if (getPgEnvConfig()) return 'env';
  return 'none';
}

function requireConfig(): PgDriverConfig {
  const ws = getWorkspacePgConfig();
  if (ws) return workspaceToDriverConfig(ws);
  const cfg = getPgEnvConfig();
  if (!cfg) {
    throw new Error(
      'PostgreSQL credentials missing. Connect the workspace on the setup page (/setup), or set PG_HOST, PG_DATABASE, PG_USER and PG_PASSWORD in stand-ui/.env.local',
    );
  }
  return cfg;
}

// Scale-to-zero warning: log once per process, not per connection.
let scaleToZeroChecked = false;

async function openClient(cfg: PgDriverConfig): Promise<pg.Client> {
  const client = new pg.Client({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password, ssl: cfg.ssl,
    // Fail fast on unreachable hosts instead of hanging a poll cycle.
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  // Parity with PRISM_WH's STATEMENT_TIMEOUT_IN_SECONDS = 600.
  await client.query('SET statement_timeout = 600000');
  if (!scaleToZeroChecked) {
    scaleToZeroChecked = true;
    if (isScaleToZeroHost(cfg.host)) {
      console.warn(
        `[postgres] Host ${cfg.host} looks like a scale-to-zero provider (Neon). ` +
        `Prism's polling will keep the database from suspending — stretch the polling cadence ` +
        `or use an always-on tier. See docs/POSTGRES_PORT_PLAN.md §2.4.`,
      );
    }
  }
  return client;
}

/** A fresh connection per call, closed in `finally` — mirrors the other
 *  adapters' semantics (no pooling). */
export async function withPostgres<T>(fn: (conn: pg.Client) => Promise<T>): Promise<T> {
  const client = await openClient(requireConfig());
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* already closed */ });
  }
}

/** connect → fn → close for AD-HOC (typed, unsaved) credentials — setup
 *  surfaces only, mirrors withAdHocMssql's role. */
export async function withAdHocPostgres<T>(
  cfg: { host: string; port?: number; database: string; user: string; password: string; sslmode?: string },
  fn: (conn: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await openClient({
    host: cfg.host,
    port: cfg.port ?? 5432,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: sslFromMode(cfg.sslmode),
  });
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Personal (per-account) credentials — one-time flow fallback (Phase P4) ──

export function hasUserPgConfig(accountId: number): boolean {
  try {
    const r = getDb()
      .prepare(`SELECT pg_host, pg_user,
                       (pg_password IS NOT NULL AND pg_password != '') AS has_secret
                FROM accounts WHERE account_id = ?`)
      .get(accountId) as any;
    return Boolean(r?.pg_host && r?.pg_user && r?.has_secret);
  } catch { return false; } // columns not migrated yet
}

async function withUserPostgres<T>(accountId: number, fn: (conn: pg.Client) => Promise<T>): Promise<T> {
  let r: any;
  try {
    r = getDb()
      .prepare(`SELECT pg_host, pg_port, pg_database, pg_user, pg_password FROM accounts WHERE account_id = ?`)
      .get(accountId);
  } catch { throw new NoUserWarehouseConfig(); }
  if (!r?.pg_host || !r?.pg_user || !r?.pg_password) throw new NoUserWarehouseConfig();
  const ws = getWorkspacePgConfig();
  return withAdHocPostgres(
    {
      host: String(r.pg_host),
      port: Number(r.pg_port ?? 5432),
      database: String(r.pg_database ?? ws?.database ?? getOptionalEnv('PG_DATABASE') ?? ''),
      user: String(r.pg_user),
      password: decryptSecret(String(r.pg_password)),
      sslmode: ws?.sslmode ?? getOptionalEnv('PG_SSLMODE') ?? 'disable',
    },
    fn,
  );
}

/** Execute one statement. Accepts the codebase's `?` placeholder convention
 *  and translates to $n positional parameters. Returns result rows.
 *
 *  Bind-free calls go through the simple query protocol, which also permits
 *  multi-statement text (used by BEGIN/…/COMMIT sequences); parameterized
 *  calls are single-statement, same as every other adapter. */
export async function executeQuery(
  conn: any,
  sqlText: string,
  binds?: any[],
): Promise<any[]> {
  const client = conn as pg.Client;
  const { text, count } = translateBinds(sqlText);
  const params = binds ?? [];
  if (count !== params.length) {
    throw new Error(
      `[postgres] Bind count mismatch: statement has ${count} placeholders, got ${params.length} values`,
    );
  }
  const result = params.length === 0
    ? await client.query(text)
    : await client.query(text, params.map((v) => (v === undefined ? null : v)));
  if (Array.isArray(result)) {
    // Multi-statement simple query — resolve to the LAST statement's rows.
    const last = result[result.length - 1];
    return last?.rows ?? [];
  }
  return result.rows ?? [];
}

// ── Error classification & sanitization ──────────────────────────────────────

export function isPgAccessError(err: unknown): boolean {
  return isPgAccessErrorShape(err);
}

export function pgErrorResponse(error: unknown, fallbackPublicMessage: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;

  // Full detail stays server-side only — Postgres error messages can embed
  // SQL fragments, so never echo raw driver messages to the client.
  console.error(`[postgres] ${fallbackPublicMessage}:`, message, code != null ? `(code ${code})` : '');

  if (message.startsWith('PostgreSQL credentials missing')) {
    return Response.json({ error: message }, { status: 500 });
  }
  if (String(code) === '28P01' || String(code) === '28000' || message.toLowerCase().includes('password authentication failed')) {
    return Response.json(
      { error: 'PostgreSQL login failed. Check the service role credentials.', code },
      { status: 401 },
    );
  }
  return Response.json({ error: fallbackPublicMessage, code }, { status: 500 });
}

// ── The adapter object (see ../types.ts) ─────────────────────────────────────

export const postgresAdapter: WarehouseAdapter = {
  kind: 'postgres',
  // Postgres's hard ceiling is 65,535 binds/statement; 60,000 leaves margin
  // (same batching budget as Snowflake — EXPORT_MERGE_BATCH-sized batches fit).
  bindLimit: 60_000,
  withConnection: withPostgres,
  withUserConnection: withUserPostgres,
  hasUserConfig: hasUserPgConfig,
  executeQuery,
  isAccessError: isPgAccessError,
  errorResponse: pgErrorResponse,
  serviceConnectionSource: pgServiceConnectionSource,
};
