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

/** Durable grants TO THE APPLICATION — what pipelines require (and the only
 *  path in strict-list mode). Runnable by whoever owns the schema. */
export function buildNativeAppGrantSql(appName: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  return [
    `GRANT USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT USAGE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
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
    `GRANT CALLER USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL TABLES IN DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT CALLER USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION "${app}";`,
  ].join('\n');
}
