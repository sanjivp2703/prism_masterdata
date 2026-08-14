// Native-edition grant SQL shown to consumers (docs/NATIVE_APP_PLAN.md §2.9).
// Pure + client-safe — shared by NativeTablePicker's "don't see your table?"
// panel and the /setup first-run page so the two can never drift. The app
// name is resolved live (/api/accounts/accessible-tables → app_name); the
// placeholder keeps the SQL legible before that fetch lands.

export const APP_NAME_PLACEHOLDER = '<your Prism app name>';

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
    `-- or the whole schema, current and future tables:`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    `GRANT SELECT ON FUTURE TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    `-- to let Prism write export tables there too:`,
    `GRANT CREATE TABLE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
  ].join('\n');
}

/** §2.9 caller grants — the one-time admin OPT-IN that lets interactive work
 *  (one-time cleaning, table preview) run with each signed-in user's OWN
 *  Snowflake access. Pipelines still require the durable grants above. */
export function buildNativeCallerGrantSql(appName: string): string {
  const app = appName || APP_NAME_PLACEHOLDER;
  return [
    `-- Optional, one-time. Run as a role with MANAGE CALLER GRANTS (e.g. ACCOUNTADMIN).`,
    `-- Lets Prism clean any table the signed-in user can ALREADY read — using that`,
    `-- user's own access, per database you opt in:`,
    `GRANT CALLER USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT INHERITED CALLER USAGE ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
    `GRANT INHERITED CALLER SELECT ON ALL TABLES IN DATABASE <db> TO APPLICATION "${app}";`,
    `-- (add CREATE TABLE the same way to let one-time results export to your schemas:)`,
    `GRANT INHERITED CALLER CREATE TABLE ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
  ].join('\n');
}
