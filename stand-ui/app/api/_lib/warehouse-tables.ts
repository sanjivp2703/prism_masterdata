// Internal data-plane table references that work on EVERY warehouse.
//
// Snowflake and SQL Server both resolve `PRISM_DB.INTERNAL.<NAME>` — the mssql
// install deliberately names its database PRISM_DB with an INTERNAL schema so
// shared SQL keeps working verbatim. Postgres cannot reference other databases
// at all (docs/POSTGRES_PORT_PLAN.md §2.1): its install creates lowercase
// `prism_internal.*` tables in the connected database, so shared SQL resolves
// table names through here instead of hardcoding the 3-part form.
import 'server-only';

import { getWarehouseAdapter } from './warehouse';

type InternalTable =
  | 'LITERAL_ALIAS_MATCHES'
  | 'APPROVED_ALIAS_NAMES'
  | 'PIPELINE_QUEUE'
  | 'ONE_TIME_FILE_ROWS'
  | 'ONE_TIME_FILE_BLOBS'
  | 'RUN_STATE'
  | 'VALIDATION_LOG';

export function internalTable(name: InternalTable): string {
  const kind = getWarehouseAdapter().kind;
  // Postgres: prism_internal is a SCHEMA in the connected database.
  // MySQL: prism_internal is a DATABASE (no schema level) — same spelling,
  // deliberately (docs/MYSQL_PORT_PLAN.md §2.1): shared SQL works verbatim.
  if (kind === 'postgres' || kind === 'mysql') {
    return `prism_internal.${name.toLowerCase()}`;
  }
  return `PRISM_DB.INTERNAL.${name}`;
}
