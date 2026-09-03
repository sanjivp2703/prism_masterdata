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

/** The ONE combined /setup block (owner request 2026-09-02): AI starter (when
 *  AI isn't configured yet) + the caller-grants opt-in + the per-database app
 *  grants with their change-tracking loop — everything a fresh installation
 *  needs, in a single ACCOUNTADMIN paste. Composed from the individual
 *  builders so the pieces can't drift; the optional refresh task stays its
 *  own block (it's a CREATE TASK the customer may not want). */
export function buildNativeSetupSql(
  appName: string,
  dbs: string[],
  opts: { includeStarter: boolean },
): string {
  const parts: string[] = [];
  if (opts.includeStarter) parts.push(buildNativeStarterSql(appName));
  if (dbs.length > 0) {
    parts.push(buildNativeCallerGrantSql(appName, dbs));
    parts.push(buildNativeAppDbGrantSql(appName, dbs));
  }
  return parts.join('\n\n');
}

/** Role guide for the combined /setup block (owner request 2026-09-03: keep
 *  ONE block, but say which lines need which role — only the AI lines are
 *  truly ACCOUNTADMIN-locked; caller grants need MANAGE CALLER GRANTS, and
 *  the pipeline grants + change-tracking loop only need the role that owns
 *  the database, since granting on owned objects and ALTERing owned tables
 *  are ownership powers). Line ranges are computed from the same builders
 *  that render the block, so the numbers cannot drift from the SQL. */
export function buildNativeSetupSqlRoleNote(
  appName: string,
  dbs: string[],
  opts: { includeStarter: boolean },
): string {
  const lineCount = (s: string) => s.split('\n').length;
  const segments: string[] = [];
  let line = 1;
  const advance = (sql: string): [number, number] => {
    const start = line;
    const end = line + lineCount(sql) - 1;
    line = end + 2; // the joining blank line
    return [start, end];
  };
  if (opts.includeStarter) {
    const [s, e] = advance(buildNativeStarterSql(appName));
    segments.push(`lines ${s}-${e} (AI) must run as ACCOUNTADMIN`);
  }
  if (dbs.length > 0) {
    const [cs, ce] = advance(buildNativeCallerGrantSql(appName, dbs));
    segments.push(`lines ${cs}-${ce} (each user's own access) need a role with MANAGE CALLER GRANTS`);
    const [ds, de] = advance(buildNativeAppDbGrantSql(appName, dbs));
    segments.push(`lines ${ds}-${de} (pipeline access and change detection) can be run by the role that owns the database`);
  }
  if (segments.length === 0) return '';
  return `ACCOUNTADMIN can run the whole block, but it splits by team: ${segments.join('; ')}.`;
}

/** The database part of a picker-typed FQN (verbatim, matching parseFqn), or
 *  null when nothing usable was typed — the db-scoped builders then emit
 *  their legible <db> placeholder. */
export function dbFromFqn(tableFqn?: string): string | null {
  const db = (tableFqn ?? '').trim().split('.')[0]?.trim() ?? '';
  return db !== '' ? db : null;
}

// (The schema-scoped grant block and the reference follow-up SQL were removed
// 2026-09-02 with the manifest's references section: no per-table or
// per-schema rituals — the database-scoped block below is the single path.)

/** Per-database read grants TO THE APPLICATION — what pipelines need. THE
 *  single grant path (owner decision 2026-09-02): shown on /setup (selected
 *  databases) and in the table picker's panel (db from the typed FQN). One
 *  run covers every table in the database, change detection included; the
 *  refresh task below keeps it current for tables created later. */
export function buildNativeAppDbGrantSql(appName: string, dbs?: string[]): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const targets = dbs && dbs.length ? dbs.map(d => `"${d.replace(/"/g, '""')}"`) : ['<db>'];
  const blocks: string[] = [];
  for (const db of targets) {
    blocks.push([
      `GRANT USAGE ON DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT USAGE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT SELECT ON ALL TABLES IN DATABASE ${db} TO APPLICATION "${app}";`,
      // Pipelines write their standardized output to NEW tables next to the
      // source (2026-09-02; without this the export build fails with a
      // second grant ask after everything else works). Prism never writes to
      // existing tables — column mode is off in this edition.
      `GRANT CREATE TABLE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
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
    `  GRANT CREATE TABLE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
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
