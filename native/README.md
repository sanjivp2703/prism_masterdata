# Prism — native (Snowflake Marketplace) edition

## Install (consumer quick start)

After installing the app from the listing, run this once in a worksheet as
**ACCOUNTADMIN** (substitute your app's name). The first two statements enable
the AI (the install dialog cannot ask for them; the first lets Cortex serve
Claude from a nearby region). The third starts Prism's compute pool, warehouse,
and web service, and the last returns your Prism URL after about two minutes:

```sql
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US';
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION <app_name>;

CALL <app_name>.app_code.start_app();
SHOW ENDPOINTS IN SERVICE <app_name>.services.prism_app;
```

Notes from real installs: have any warehouse in the account before clicking
Get (the install dialog needs one selected); sign in to Snowsight once before
opening the app URL (the app's login page can't complete a first-login
password reset); the app URL takes a few minutes to appear after
`start_app()`. To pause all compute: `CALL <app_name>.app_code.stop_app()`.

## Granting Prism access to your tables

One step per database, never per table: run the `GRANT ... TO APPLICATION`
block Prism's setup page (or the connect form's access help) generates for
your database. It grants read access to every table in the database, lets
Prism create its standardized output tables there (Prism never modifies your
existing tables), and turns on change detection — all in the same run. Add
the optional hourly refresh task (also generated on the setup page) and
tables created later are covered automatically — nothing to re-run, ever.
