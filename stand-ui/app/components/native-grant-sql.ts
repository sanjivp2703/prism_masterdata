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

/** The ONE combined /setup block (owner request 2026-09-02, extended
 *  2026-09-29): AI starter (when AI isn't configured yet) + the caller-grants
 *  opt-in + the per-database app grants with their change-tracking loop + the
 *  hourly grant-refresh task — everything a fresh installation needs, in a
 *  single ACCOUNTADMIN paste. The refresh task used to be a separate
 *  "optional" block; it is mandatory now (owner decision 2026-09-29: a
 *  pipeline that silently loses sight of a recreated table is worse than one
 *  extra CREATE TASK). Composed from the individual builders so the pieces
 *  can't drift. */
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
    parts.push(buildNativeGrantRefreshTaskSql(appName, dbs));
  }
  return parts.join('\n\n');
}

/** One entry per section of the combined /setup block, for the expandable
 *  "what this does and the permissions it needs" guide under the code. */
export type NativeSetupGuideSection = {
  /** 1-based inclusive line range of this section inside buildNativeSetupSql. */
  lines: [number, number];
  title: string;
  /** Plain-language purpose. */
  purpose: string;
  /** The least-privileged role/privileges that can run just this section. */
  needs: string;
};

/** Permissions guide for the combined /setup block (owner request 2026-09-03:
 *  keep ONE block, but say which lines need which role — only the AI lines are
 *  truly ACCOUNTADMIN-locked; caller grants need MANAGE CALLER GRANTS; the
 *  pipeline grants + change-tracking loop only need the role that owns the
 *  database, since granting on owned objects and ALTERing owned tables are
 *  ownership powers; the serverless refresh task additionally needs the
 *  account-level EXECUTE MANAGED TASK (serverless) and EXECUTE TASK (to run
 *  it), both ACCOUNTADMIN-granted per docs.snowflake.com/user-guide/tasks-intro).
 *  Line ranges are computed from the same builders that render the block, so
 *  the numbers cannot drift from the SQL. Rewritten 2026-09-29 from a single
 *  sentence to structured sections so the page can render a bulleted list. */
export function buildNativeSetupSqlGuide(
  appName: string,
  dbs: string[],
  opts: { includeStarter: boolean },
): NativeSetupGuideSection[] {
  const lineCount = (s: string) => s.split('\n').length;
  const sections: NativeSetupGuideSection[] = [];
  let line = 1;
  const advance = (sql: string): [number, number] => {
    const start = line;
    const end = line + lineCount(sql) - 1;
    line = end + 2; // the joining blank line
    return [start, end];
  };
  if (opts.includeStarter) {
    sections.push({
      lines: advance(buildNativeStarterSql(appName)),
      title: 'Enable AI',
      purpose: "Lets Prism use Snowflake's built-in AI (Cortex) to group values.",
      needs: 'ACCOUNTADMIN.',
    });
  }
  if (dbs.length > 0) {
    sections.push({
      lines: advance(buildNativeCallerGrantSql(appName, dbs)),
      title: "Each user's own access",
      purpose: 'When someone uses Prism interactively, it sees only the tables that person can already see.',
      needs: 'A role with MANAGE CALLER GRANTS.',
    });
    sections.push({
      lines: advance(buildNativeAppDbGrantSql(appName, dbs)),
      title: 'Pipeline access',
      purpose: 'Lets background pipelines read your tables, create their output tables or views next to them, and switch on change tracking so edits are noticed.',
      needs: 'The role that owns the database.',
    });
    sections.push({
      lines: advance(buildNativeGrantRefreshTaskSql(appName, dbs)),
      title: 'Keep access current',
      purpose: "Snowflake doesn't extend grants to tables created later, so this hourly task re-runs the pipeline grants automatically.",
      needs: 'The role that owns the database, plus EXECUTE TASK and EXECUTE MANAGED TASK on the account (ACCOUNTADMIN grants these).',
    });
  }
  return sections;
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
      // Pipelines write their standardized output to NEW tables or views next
      // to the source (2026-09-02; without this the export build fails with a
      // second grant ask after everything else works). CREATE VIEW was missing
      // until 2026-10-01 — the first View-output pipeline on the client-test
      // install failed with the fix-SQL banner. Prism never writes to existing
      // tables — column mode is off in this edition.
      `GRANT CREATE TABLE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
      `GRANT CREATE VIEW ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
      // Change tracking is per-table with no ALL form — loop the database's
      // tables. Already-enabled tables are a no-op; the app can't do this
      // itself with read-only grants.
      //
      // The per-table EXCEPTION handler is load-bearing (live-found 2026-09-06):
      // the cursor returns EVERY base table in the database, and once a
      // pipeline has built its first export table, that table is owned by the
      // APPLICATION — not by the customer. ALTERing it fails with
      // "Insufficient privileges … must have MODIFY", and Snowflake Scripting
      // aborts the whole block on the first error, so every table the cursor
      // had not yet reached silently never got change tracking. Skipping what
      // we cannot own costs nothing: Prism's own _STANDARDIZED output is never
      // a polled source.
      `EXECUTE IMMEDIATE $$`,
      `DECLARE`,
      `  skipped INTEGER DEFAULT 0;`,
      `  c1 CURSOR FOR SELECT '"'||table_catalog||'"."'||table_schema||'"."'||table_name||'"' AS fqn`,
      `    FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE';`,
      `BEGIN`,
      `  FOR r IN c1 DO`,
      `    BEGIN`,
      `      EXECUTE IMMEDIATE 'ALTER TABLE ' || r.fqn || ' SET CHANGE_TRACKING = TRUE';`,
      `    EXCEPTION`,
      `      WHEN OTHER THEN skipped := skipped + 1;`,
      `    END;`,
      `  END FOR;`,
      `  RETURN 'change tracking enabled; skipped ' || skipped || ' table(s) you do not own';`,
      `END;`,
      `$$;`,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/** Per-database grant-refresh task — the last part of the combined /setup
 *  block (mandatory since 2026-09-29; was a separate optional block).
 *  Snowflake forbids FUTURE grants to an application (live-confirmed
 *  2026-08-16), so tables created or RECREATED after the pipeline grant are
 *  invisible to the app until the ALL TABLES grant is re-run. This
 *  customer-owned hourly task re-runs it automatically. Serverless (no
 *  warehouse clause); lives in the database's PUBLIC schema by convention —
 *  the setup guide tells the customer to adjust the schema if theirs differs. */
export function buildNativeGrantRefreshTaskSql(appName: string, dbs?: string[]): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  const targets = dbs && dbs.length ? dbs.map(d => `"${d.replace(/"/g, '""')}"`) : ['<db>'];
  const blocks = targets.map(db => [
    // OR REPLACE (2026-10-01; was IF NOT EXISTS): re-running the block must
    // refresh the task body too — with IF NOT EXISTS an existing install kept
    // the pre-CREATE-VIEW task forever. Replacing a task leaves it suspended,
    // which the RESUME below undoes.
    `CREATE OR REPLACE TASK ${db}.PUBLIC.PRISM_GRANT_REFRESH`,
    `  SCHEDULE = '60 MINUTE'`,
    `AS`,
    `DECLARE`,
    `  skipped INTEGER DEFAULT 0;`,
    `  c1 CURSOR FOR SELECT '"'||table_catalog||'"."'||table_schema||'"."'||table_name||'"' AS fqn`,
    `    FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE';`,
    `BEGIN`,
    `  GRANT USAGE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
    `  GRANT SELECT ON ALL TABLES IN DATABASE ${db} TO APPLICATION "${app}";`,
    `  GRANT CREATE TABLE ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
    `  GRANT CREATE VIEW ON ALL SCHEMAS IN DATABASE ${db} TO APPLICATION "${app}";`,
    // Same per-table handler as the setup block, and it matters MORE here: an
    // app-owned export table would make this task fail on every run, and
    // Snowflake auto-suspends a task after SUSPEND_TASK_AFTER_NUM_FAILURES
    // (default 10) — silently ending the grant refresh that keeps newly
    // created tables visible to the app.
    `  FOR r IN c1 DO`,
    `    BEGIN`,
    `      EXECUTE IMMEDIATE 'ALTER TABLE ' || r.fqn || ' SET CHANGE_TRACKING = TRUE';`,
    `    EXCEPTION`,
    `      WHEN OTHER THEN skipped := skipped + 1;`,
    `    END;`,
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
