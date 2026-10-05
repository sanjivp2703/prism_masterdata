// Internal data-plane table references that work on EVERY warehouse.
//
// Snowflake and SQL Server both resolve `PRISM_DB.INTERNAL.<NAME>` — the mssql
// install deliberately names its database PRISM_DB with an INTERNAL schema so
// shared SQL keeps working verbatim. Postgres cannot reference other databases
// at all (docs/POSTGRES_PORT_PLAN.md §2.1): its install creates lowercase
// `prism_internal.*` tables in the connected database, so shared SQL resolves
// table names through here instead of hardcoding the 3-part form.
// NATIVE (Marketplace) edition: inside a Native App the database is the
// APPLICATION itself (whatever the consumer named it) and the schemas are
// setup.sql's `internal_state` (data) + `app_code` (UDF). PRISM_INTERNAL_DB
// carries the app database name into the container (service spec / resolved
// at boot); when unset, references stay database-relative — correct for all
// in-session SQL, and view bodies must resolve the app name explicitly.
import 'server-only';

import { getWarehouseAdapter } from './warehouse';
import { isNativeEdition } from './edition';
import { getOptionalEnv } from './env';

type InternalTable =
  | 'LITERAL_ALIAS_MATCHES'
  | 'APPROVED_ALIAS_NAMES'
  | 'PIPELINE_QUEUE'
  | 'ONE_TIME_FILE_ROWS'
  | 'ONE_TIME_FILE_BLOBS'
  | 'RUN_STATE'
  | 'VALIDATION_LOG';

/** The app database prefix in native mode ('"MY_PRISM".' or '' when relative). */
function nativeDbPrefix(): string {
  const db = getOptionalEnv('PRISM_INTERNAL_DB');
  return db ? `"${db.replace(/"/g, '""')}".` : '';
}

export function internalTable(name: InternalTable): string {
  if (isNativeEdition()) return `${nativeDbPrefix()}internal_state.${name}`;
  const kind = getWarehouseAdapter().kind;
  // Postgres: prism_internal is a SCHEMA in the connected database.
  // MySQL: prism_internal is a DATABASE (no schema level) — same spelling,
  // deliberately (docs/MYSQL_PORT_PLAN.md §2.1): shared SQL works verbatim.
  if (kind === 'postgres' || kind === 'mysql') {
    return `prism_internal.${name.toLowerCase()}`;
  }
  return `PRISM_DB.INTERNAL.${name}`;
}

/** The PRISM_NORMALIZE UDF's qualified name for SQL text. ⚠ KI-149: view
 *  bodies resolve names against the VIEW's own schema, so generated view SQL
 *  must use this (never a bare call) — in native mode with PRISM_INTERNAL_DB
 *  unset, view-creating paths must resolve the app database name first.
 *  Snowflake-family only (pg/mysql normalize app-side). The 99 hardcoded
 *  `PRISM_DB.INTERNAL.PRISM_NORMALIZE` sites converge here (N3 sweep). */
export function prismNormalizeFn(): string {
  if (isNativeEdition()) return `${nativeDbPrefix()}app_code.PRISM_NORMALIZE`;
  return `PRISM_DB.INTERNAL.PRISM_NORMALIZE`;
}

/** SQL predicate: the column holds a value Prism can standardize — not NULL
 *  and not BLANK (normalizes to '': empty, whitespace-only, control-only).
 *  The SQL twin of `isBlankLiteral` (normalize.ts); Snowflake-family only, it
 *  runs the UDF so SQL and app agree EXACTLY on what "blank" means. Every
 *  source-side filter that used to read `col IS NOT NULL` goes through here —
 *  '' is NOT NULL on every warehouse, which is how a blank cell became a
 *  permanently "Unstandardized" value no path could ever standardize
 *  (2026-09-14). */
export function notBlankSql(colExpr: string): string {
  return `(${colExpr} IS NOT NULL AND ${prismNormalizeFn()}(TO_VARCHAR(${colExpr})) <> '')`;
}

/** Negation of `notBlankSql` — NULL or blank: passes through the export
 *  as-is, is never counted, queued, or standardized. */
export function isBlankSql(colExpr: string): string {
  return `(${colExpr} IS NULL OR ${prismNormalizeFn()}(TO_VARCHAR(${colExpr})) = '')`;
}

/** Generic internal-schema OBJECT reference for streams, staging/scratch
 *  tables, and the debug inspector — anything that isn't one of the 7 typed
 *  internal tables. The name is appended VERBATIM after the schema prefix
 *  (pass it pre-quoted when it needs quoting, e.g. `"PIPELINE_STREAM_5"`).
 *  These objects exist only on the Snowflake-family warehouses (Snowflake +
 *  mssql — pg/mysql have no streams and their ports name their own scratch
 *  objects), so there is no lowercase prism_internal spelling here. */
export function internalObject(name: string): string {
  if (isNativeEdition()) return `${nativeDbPrefix()}internal_state.${name}`;
  return `PRISM_DB.INTERNAL.${name}`;
}

/** The internal schema itself, for schema-level SQL —
 *  `SHOW STREAMS IN SCHEMA <x>` / `CREATE STREAM <x>."NAME"` style text. */
export function internalSchemaFqn(): string {
  if (isNativeEdition()) return `${nativeDbPrefix()}internal_state`;
  return `PRISM_DB.INTERNAL`;
}
