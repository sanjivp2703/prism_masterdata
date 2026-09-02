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

// Native-edition (Snowflake-only) manifest-reference resolution: maps a
// pipeline's source FQN to reference('source_table','<alias>') when the
// consumer granted the table through the permission UI instead of direct
// GRANT SQL. resolveSourceReference returns null in the standard edition and
// on every non-Snowflake warehouse (native pins Snowflake), so call sites use
// `resolved?.refSql ?? <quoted FQN>` with zero standard-edition impact.
export {
  resolveSourceReference,
  listSourceTableBindings,
  invalidateSourceReferenceCache,
} from './snowflake/references';
export type { ResolvedSourceReference } from './snowflake/references';
// Pure DESCRIBE-result helpers for the reference path (a bound table has no
// FQN visibility, so SHOW COLUMNS / INFORMATION_SCHEMA reads become
// DESCRIBE TABLE reference(...)).
export { describeRowsToColumns } from './snowflake/reference-sql';
export type { SourceReferenceBinding } from './snowflake/reference-sql';

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

/** Like withWarehouse, but with the USER'S OWN access — saved personal
 *  credentials, or (native edition) an SPCS caller's-rights session from the
 *  current request's ingress token (docs/NATIVE_APP_PLAN.md §2.9).
 *  Throws NoUserWarehouseConfig when neither is available. */
export function withUserWarehouse<T>(
  accountId: number,
  fn: (conn: WarehouseConnection) => Promise<T>,
  opts?: { role?: string },
): Promise<T> {
  return getWarehouseAdapter().withUserConnection(accountId, fn, opts);
}

/** True when a user-scoped connection is possible. Async — the native
 *  edition's answer comes from the current request's headers. ALWAYS await
 *  this: an un-awaited Promise is truthy and silently takes the wrong branch. */
export async function hasUserWarehouseConfig(accountId: number): Promise<boolean> {
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
