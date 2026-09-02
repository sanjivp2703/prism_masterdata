// Native-edition grant SQL shown to consumers (docs/NATIVE_APP_PLAN.md §2.9).
// Pure + client-safe — shared by NativeTablePicker's "don't see your table?"
// panel and the /setup first-run page so the two can never drift. The app
// name is resolved live (/api/accounts/accessible-tables → app_name); the
// placeholder keeps the SQL legible before that fetch lands.

export const APP_NAME_PLACEHOLDER = '<your Prism app name>';

/** The two statements EVERY installation must run once (ACCOUNTADMIN) before
 *  the AI can work — the install dialog cannot request either (live-found on
 *  the first consumer install, 2026-08-16): Claude on Cortex requires
 *  cross-region inference, and database roles can't be granted through an
 *  app manifest. */
export function buildNativeStarterSql(appName: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  return [
    `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US';`,
    `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION "${app}";`,
  ].join('\n');
}

/** db/schema/table from a picker-typed FQN (DB.SCHEMA.TABLE or DB.SCHEMA,
 *  parts interpolated verbatim, matching parseFqn); legible placeholders
 *  otherwise. Shared by the grant builders below. */
function fqnPartsOrPlaceholders(tableFqn?: string): { db: string; schema: string; table: string } {
  const parts = (tableFqn ?? '').trim().split('.');
  const [db, schema] =
    (parts.length === 3 || parts.length === 2) && parts.slice(0, 2).every(p => p.trim() !== '')
      ? [parts[0].trim(), parts[1].trim()]
      : ['<db>', '<schema>'];
  const table = parts.length === 3 && parts[2].trim() !== '' ? parts[2].trim() : '<table>';
  return { db, schema, table };
}

/** Durable grants TO THE APPLICATION — what pipelines require (and the only
 *  path in strict-list mode). Runnable by whoever owns the schema.
 *  Schema-scoped by owner decision 2026-09-01 (one run covers every table
 *  currently in the schema). */
export function buildNativeAppGrantSql(appName: string, tableFqn?: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const { db, schema, table } = fqnPartsOrPlaceholders(tableFqn);
  return [
    `GRANT USAGE ON DATABASE ${db} TO APPLICATION "${app}";`,
    `GRANT USAGE ON SCHEMA ${db}.${schema} TO APPLICATION "${app}";`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${db}.${schema} TO APPLICATION "${app}";`,
    `GRANT CREATE TABLE ON SCHEMA ${db}.${schema} TO APPLICATION "${app}";`,
    // Pipelines watch for changes via a stream, which needs change tracking
    // on (per-table; the app can't enable it with read-only grants).
    `ALTER TABLE ${db}.${schema}.${table} SET CHANGE_TRACKING = TRUE;`,
  ].join('\n');
}

/** Follow-up SQL for a table granted through the PERMISSION UI (the app's
 *  source_table reference, added in Snowsight's Security tab). The reference
 *  carries SELECT only — ALTER is not a legal reference privilege and SCHEMA
 *  is not referenceable — so change detection and the standardized output
 *  table still need these. Runnable by whoever owns the schema. The last
 *  three statements are unnecessary when the pipeline's output goes to a
 *  schema Prism can already create tables in. */
export function buildNativeReferenceFollowupSql(appName: string, tableFqn?: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const { db, schema, table } = fqnPartsOrPlaceholders(tableFqn);
  return [
    `ALTER TABLE ${db}.${schema}.${table} SET CHANGE_TRACKING = TRUE;`,
    `GRANT USAGE ON DATABASE ${db} TO APPLICATION "${app}";`,
    `GRANT USAGE ON SCHEMA ${db}.${schema} TO APPLICATION "${app}";`,
    `GRANT CREATE TABLE ON SCHEMA ${db}.${schema} TO APPLICATION "${app}";`,
  ].join('\n');
}

/** Per-database read grants TO THE APPLICATION — what pipelines need, at
 *  database scope for the /setup picker (the table picker's panel emits the
 *  schema-scoped variant). Covers objects existing at run time; the refresh
 *  task below keeps it current. */
export function buildNativeAppDbGrantSql(appName: string, dbs?: string[]): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const targets = dbs && dbs.length ? dbs.map(d => `"${d.replace(/"/g, '""')}"`) : ['<db>'];
  const blocks: string[] = [];
  for (const db of targets) {
    blocks.push([
      `GRANT USAGE ON DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT USAGE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT SELECT ON ALL TABLES IN DATABASE ${db} TO APPLICATION "${app}";`,
      // Change tracking is per-table with no ALL form — loop the database's
      // tables. Already-enabled tables are a no-op; the app can't do this
      // itself with read-only grants.
      `EXECUTE IMMEDIATE $$`,
      `DECLARE`,
      `  c1 CURSOR FOR SELECT '"'||table_catalog||'"."'||table_schema||'"."'||table_name||'"' AS fqn`,
      `    FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE';`,
      `BEGIN`,
      `  FOR r IN c1 DO`,
      `    EXECUTE IMMEDIATE 'ALTER TABLE ' || r.fqn || ' SET CHANGE_TRACKING = TRUE';`,
      `  END FOR;`,
      `  RETURN 'change tracking enabled';`,
      `END;`,
      `$$;`,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/** Optional per-database grant-refresh task. Snowflake forbids FUTURE grants
 *  to an application (live-confirmed 2026-08-16), so tables created or
 *  RECREATED after the pipeline grant are invisible to the app until the
 *  ALL TABLES grant is re-run. This customer-owned hourly task re-runs it
 *  automatically. Serverless (no warehouse clause); lives in the database's
 *  PUBLIC schema by convention — the setup copy tells the customer to adjust
 *  the schema if theirs differs. */
export function buildNativeGrantRefreshTaskSql(appName: string, dbs?: string[]): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const targets = dbs && dbs.length ? dbs.map(d => `"${d.replace(/"/g, '""')}"`) : ['<db>'];
  const blocks = targets.map(db => [
    `CREATE TASK IF NOT EXISTS ${db}.PUBLIC.PRISM_GRANT_REFRESH`,
    `  SCHEDULE = '60 MINUTE'`,
    `AS`,
    `DECLARE`,
    `  c1 CURSOR FOR SELECT '"'||table_catalog||'"."'||table_schema||'"."'||table_name||'"' AS fqn`,
    `    FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE';`,
    `BEGIN`,
    `  GRANT USAGE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
    `  GRANT SELECT ON ALL TABLES IN DATABASE ${db} TO APPLICATION "${app}";`,
    `  FOR r IN c1 DO`,
    `    EXECUTE IMMEDIATE 'ALTER TABLE ' || r.fqn || ' SET CHANGE_TRACKING = TRUE';`,
    `  END FOR;`,
    `END;`,
    `ALTER TASK ${db}.PUBLIC.PRISM_GRANT_REFRESH RESUME;`,
  ].join('\n'));
  return blocks.join('\n\n');
}

/** §2.9 caller grants — the one-time admin OPT-IN that lets interactive work
 *  (one-time cleaning, table preview, one-time exports) run with each
 *  signed-in user's OWN Snowflake access. Pipelines still require the
 *  durable grants above.
 *
 *  The ALL forms are deliberate (live-found 2026-08-14): restricted caller's
 *  rights checks EVERY privilege against the opt-in — a SELECT-only set
 *  stalls the export's INSERT even on a table the session itself created.
 *  "All of the caller's own privileges, in the databases you opt in" is both
 *  the working set and the honest consent statement — the app can never do
 *  more than the signed-in user themselves can. */
export function buildNativeCallerGrantSql(appName: string, dbs?: string[]): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  // No selection yet → the legible <db> placeholder form (the table-picker
  // panel's copy-paste block). Selected names are quoted identifiers.
  const targets = dbs && dbs.length ? dbs.map(d => `"${d.replace(/"/g, '""')}"`) : ['<db>'];
  const lines: string[] = [];
  for (const db of targets) {
    lines.push(
      `GRANT CALLER USAGE ON DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL TABLES IN DATABASE ${db} TO APPLICATION "${app}";`,
    );
  }
  lines.push(`GRANT CALLER USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION "${app}";`);
  return lines.join('\n');
}
