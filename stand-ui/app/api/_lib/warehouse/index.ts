/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ./types.ts). */
// The warehouse facade — the ONLY module consumers import to talk to the
// installation's warehouse. See ./types.ts for the adapter contract and
// docs/MSSQL_PORT_PLAN.md for the port plan.
//
// Phase 1: the factory returns the Snowflake adapter unconditionally. Phase 3+
// reads the installation's warehouse type (workspace_config) and returns the
// matching adapter — consumer code does not change when that happens.
import 'server-only';

import type { WarehouseAdapter, WarehouseConnection } from './types';
import { snowflakeAdapter } from './snowflake/connection';
import { mssqlAdapter } from './mssql/connection';
import { postgresAdapter } from './postgres/connection';
import { mysqlAdapter } from './mysql/connection';
import { getOptionalEnv } from '../env';
import { isNativeEdition } from '../edition';
import { getDb } from '../sqlite';

export { NoUserWarehouseConfig } from './types';
export type { WarehouseAdapter, WarehouseConnection } from './types';

// ── Warehouse-type resolution ────────────────────────────────────────────────
// (1) workspace_config.warehouse_type — the setup-wizard choice (SQLite);
// (2) PRISM_WAREHOUSE_TYPE env — dev/operator switch;
// (3) 'snowflake' default.
// Short TTL cache: this runs on every warehouse call, including each poll
// cycle. Invalidated by the setup save route.

let _whTypeCache: { value: string | null; at: number } | null = null;
const WH_TYPE_CACHE_TTL_MS = 10_000;

export function invalidateWarehouseTypeCache(): void {
  _whTypeCache = null;
}

function workspaceWarehouseType(): string | null {
  if (_whTypeCache && Date.now() - _whTypeCache.at < WH_TYPE_CACHE_TTL_MS) {
    return _whTypeCache.value;
  }
  let value: string | null = null;
  try {
    const r = getDb().prepare(`SELECT warehouse_type FROM workspace_config WHERE id = 1`).get() as any;
    const t = String(r?.warehouse_type ?? '').toLowerCase();
    value = t === 'mssql' || t === 'snowflake' || t === 'postgres' || t === 'mysql' ? t : null;
  } catch {
    value = null; // table missing / fresh install — fall through to env
  }
  _whTypeCache = { value, at: Date.now() };
  return value;
}

export function getWarehouseAdapter(): WarehouseAdapter {
  // The Marketplace (native) edition runs inside the consumer's Snowflake
  // account and is Snowflake-only by definition — stored/env warehouse types
  // are ignored outright (docs/NATIVE_APP_PLAN.md §1).
  if (isNativeEdition()) return snowflakeAdapter;
  const kind = workspaceWarehouseType()
    ?? (getOptionalEnv('PRISM_WAREHOUSE_TYPE') ?? 'snowflake').toLowerCase();
  if (kind === 'mssql') return mssqlAdapter;
  if (kind === 'postgres') return postgresAdapter;
  if (kind === 'mysql') return mysqlAdapter;
  return snowflakeAdapter;
}

// ── Ergonomic top-level delegates ─────────────────────────────────────────────

/** Run `fn` with a SERVICE connection (fresh per call, destroyed in finally). */
export function withWarehouse<T>(
  fn: (conn: WarehouseConnection) => Promise<T>,
): Promise<T> {
  return getWarehouseAdapter().withConnection(fn);
}

/** Like withWarehouse, but with the account's PERSONAL credentials.
 *  Throws NoUserWarehouseConfig when none are saved. */
export function withUserWarehouse<T>(
  accountId: number,
  fn: (conn: WarehouseConnection) => Promise<T>,
): Promise<T> {
  return getWarehouseAdapter().withUserConnection(accountId, fn);
}

/** True when the account has a usable personal credential saved. */
export function hasUserWarehouseConfig(accountId: number): boolean {
  return getWarehouseAdapter().hasUserConfig(accountId);
}

/** Execute one statement, resolving to its result rows. */
export function executeQuery(
  conn: WarehouseConnection,
  sqlText: string,
  binds?: any[],
): Promise<any[]> {
  return getWarehouseAdapter().executeQuery(conn, sqlText, binds);
}

/** True when an error reads as "no access / object not visible". */
export function isWarehouseAccessError(err: unknown): boolean {
  return getWarehouseAdapter().isAccessError(err);
}

/** Sanitized HTTP error response (full detail logged server-side only). */
export function warehouseErrorResponse(
  error: unknown,
  fallbackPublicMessage: string,
): Response {
  return getWarehouseAdapter().errorResponse(error, fallbackPublicMessage);
}

/** Where the service connection's credentials come from right now.
 *  'spcs' = native edition running inside SPCS (ambient token). */
export function serviceConnectionSource(): 'spcs' | 'workspace' | 'env' | 'none' {
  return getWarehouseAdapter().serviceConnectionSource();
}
