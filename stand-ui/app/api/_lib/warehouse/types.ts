/* eslint-disable @typescript-eslint/no-explicit-any --
   WarehouseConnection is deliberately `any` in Phase 1 (see its doc comment);
   result rows are untyped driver output by nature. */
// The warehouse adapter contract (Phase 1 of the SQL Server port — see
// docs/MSSQL_PORT_PLAN.md).
//
// Prism supports one warehouse per installation. Everything that talks to the
// warehouse goes through a WarehouseAdapter obtained from `_lib/warehouse`
// (the facade re-exports ergonomic top-level functions). The hard rule:
// NO driver import (`snowflake-sdk`, future `mssql`) may exist outside
// `_lib/warehouse/` — enforced by lint.
//
// Phase 1 scope: the connection seam (service + personal connections, query
// execution, error classification/sanitization). Higher-level operations
// (change detection, export rebuild, bulk mapping upserts, grants,
// verify-install probes) still live in their existing warehouse-specific
// modules and join this interface in later phases as the SQL Server
// implementations are built (plan §3.1).

/**
 * An open connection owned by the active adapter. Deliberately opaque —
 * consumers must only pass it back into adapter functions (executeQuery),
 * never call driver methods on it directly. Typed `any` for now: the run-state
 * codebase passes connections through many `conn: any` signatures; tightening
 * to a branded type is planned once the second adapter exists.
 */
export type WarehouseConnection = any;

/**
 * A column-mode privilege failure, already carrying customer-facing fix text.
 *
 * Lives here — in the neutral adapter-contract module — because BOTH warehouse
 * builders must be able to throw it and `withColumnModeFailureSurfaced` in
 * export-table.ts must be able to catch it. Putting it in export-table.ts made
 * it unreachable from warehouse/mssql/export.ts (that file is imported BY
 * export-table.ts, so importing back would be circular), which is precisely why
 * the mssql builder kept throwing a plain Error and its privilege failures were
 * never classified — the pause fired on Snowflake and silently did not on SQL
 * Server (OUT-15).
 *
 * The rule it encodes: NEVER classify an error by matching text across a
 * rethrow. Carry the classification in the TYPE, and keep the original driver
 * error as `cause` so nothing is lost.
 */
export class ColumnModeAccessError extends Error {
  readonly isColumnModeAccessError = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ColumnModeAccessError';
    if (options?.cause !== undefined) (this as unknown as { cause: unknown }).cause = options.cause;
  }
}

export class NoUserWarehouseConfig extends Error {
  constructor() {
    super('No personal warehouse credentials saved for this account.');
    this.name = 'NoUserWarehouseConfig';
  }
}

export interface WarehouseAdapter {
  /** Which warehouse this adapter drives. */
  readonly kind: 'snowflake' | 'mssql' | 'postgres' | 'mysql';

  /** Safe bind-parameter budget per statement (Snowflake ~65k → 60000;
   *  SQL Server ~2100 → 2000). Callers building IN-lists or VALUES batches
   *  must size their batches within this. */
  readonly bindLimit: number;

  /** Run `fn` with a SERVICE connection (workspace config → env fallback).
   *  Opens a fresh connection and destroys it in `finally` — no pooling. */
  withConnection<T>(fn: (conn: WarehouseConnection) => Promise<T>): Promise<T>;

  /** Like withConnection, but with the account's PERSONAL credentials
   *  (one-time flow access fallback + change-tracking auto-fix only).
   *  Throws NoUserWarehouseConfig when none are saved. */
  withUserConnection<T>(
    accountId: number,
    fn: (conn: WarehouseConnection) => Promise<T>,
  ): Promise<T>;

  /** True when the account has a usable personal credential saved. */
  hasUserConfig(accountId: number): boolean;

  /** Execute one statement, resolving to its result rows. */
  executeQuery(
    conn: WarehouseConnection,
    sqlText: string,
    binds?: any[],
  ): Promise<any[]>;

  /** True when an error reads as "no access / object not visible" rather than
   *  a transient or syntax failure — the trigger for falling back from the
   *  service connection to the user's personal one. */
  isAccessError(err: unknown): boolean;

  /** Sanitized HTTP error response — full detail logged server-side only,
   *  never raw SQL/driver messages to the browser. */
  errorResponse(error: unknown, fallbackPublicMessage: string): Response;

  /** Where the service connection's credentials come from right now. */
  // 'spcs' = the native edition's ambient SPCS token (Snowflake adapter only,
  // inside a Snowpark Container Services container — docs/NATIVE_APP_PLAN.md N2).
  serviceConnectionSource(): 'spcs' | 'workspace' | 'env' | 'none';
}
