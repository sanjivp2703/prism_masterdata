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
    `-- Run once as ACCOUNTADMIN, right after installing:`,
    `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US';  -- lets Cortex reach Claude`,
    `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION "${app}";`,
  ].join('\n');
}

/** Durable grants TO THE APPLICATION — what pipelines require (and the only
 *  path in strict-list mode). Runnable by whoever owns the schema. */
export function buildNativeAppGrantSql(appName: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  return [
    `-- Run as a role with grant authority on the schema (its owner, or ACCOUNTADMIN)`,
    `GRANT USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT USAGE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    `-- one table:`,
    `GRANT SELECT ON TABLE <db>.<schema>.<table> TO APPLICATION "${app}";`,
    `-- or every table currently in the schema:`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    `-- (Snowflake does not allow FUTURE grants to an application — re-run the`,
    `--  line above after adding new tables, or grant new tables one by one.)`,
    `-- to let Prism write export tables there too:`,
    `GRANT CREATE TABLE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
  ].join('\n');
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
export function buildNativeCallerGrantSql(appName: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  return [
    `-- Recommended, one-time. Run as a role with MANAGE CALLER GRANTS (e.g. ACCOUNTADMIN).`,
    `-- Lets Prism clean any table the signed-in user can ALREADY access — using that`,
    `-- user's own access (never more), per database you opt in:`,
    `GRANT CALLER USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL TABLES IN DATABASE <db> TO APPLICATION "${app}";`,
    `-- once per account (Prism's own warehouse, used for the queries it runs as you):`,
    `GRANT CALLER USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION "${app}";`,
  ].join('\n');
}
