# Prism — native (Snowflake Marketplace) edition

## Install (consumer quick start)

After installing the app from the listing, run this once in a worksheet as
**ACCOUNTADMIN** (substitute your app's name). The first two statements are
required before the AI can run — the install dialog cannot ask for them:

```sql
-- AI prerequisites (required once per account):
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US';   -- lets Cortex reach Claude
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION <app_name>;

-- Start Prism (creates its compute pool, warehouse, and web service):
CALL <app_name>.app_code.start_app();
-- After ~2 minutes, get your Prism URL:
SHOW ENDPOINTS IN SERVICE <app_name>.services.prism_app;
```

Notes from real installs: have any warehouse in the account before clicking
Get (the install dialog needs one selected); sign in to Snowsight once before
opening the app URL (the app's login page can't complete a first-login
password reset); the app URL takes a few minutes to appear after
`start_app()`. To pause all compute: `CALL <app_name>.app_code.stop_app()`.
