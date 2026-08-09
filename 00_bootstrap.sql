CREATE DATABASE IF NOT EXISTS PRISM_DB;
CREATE SCHEMA IF NOT EXISTS PRISM_DB.INTERNAL;

-- PRISM:INSTALL-SCRIPT-END
-- Everything above this marker is what the setup wizard serves to customers
-- as the install script (/api/accounts/install-script truncates here).
-- Everything below is dev-only and never shown to customers.

-- ============================================================================
-- ONBOARDING MIRROR (dev/testing convenience)
--
-- Everything below reproduces the SQL the /setup wizard (step 2, Parts B–D)
-- has a customer admin run by hand in a Snowflake worksheet, so a dev reset
-- never needs the wizard: run 00 + 01 and the account is fully onboarded.
-- All statements are idempotent — safe to re-run any time.
--
-- KEEP IN SYNC with stand-ui/app/setup/page.tsx (SERVICE_USER_SQL and
-- buildDataAccessGrants) whenever the onboarding SQL changes — this block
-- exists precisely so onboarding edits can be tested by re-running this file.
-- ============================================================================
USE ROLE ACCOUNTADMIN;

-- ── Parts B/C — the service user Prism signs in as ──────────────────────────
-- The role is pre-created here with IF NOT EXISTS so 00 can run before 01 on
-- a fresh account (01's ROLES AND GRANTS block also creates it — harmless).
-- DEFAULT_WAREHOUSE is only a session default; PRISM_WH itself is created by 01.
CREATE ROLE IF NOT EXISTS PRISM_SERVICE;
CREATE USER IF NOT EXISTS PRISM_SVC
  DEFAULT_ROLE = PRISM_SERVICE
  DEFAULT_WAREHOUSE = PRISM_WH
  -- () NOT the Snowflake default of ALL. With ALL, every role granted to this
  -- user is activated on every session, so the primary role is advisory: an
  -- admin who narrows Prism's configured role to something weaker gets no
  -- actual reduction in privilege. Live-confirmed on the dev account
  -- (CURRENT_ROLE()=PRISM_USER while PRISM_SERVICE's privileges still applied).
  DEFAULT_SECONDARY_ROLES = ()
  TYPE = SERVICE;
GRANT ROLE PRISM_SERVICE TO USER PRISM_SVC;
-- Existing installs: CREATE USER IF NOT EXISTS will NOT change an account that
-- already exists, so apply it explicitly once.
ALTER USER PRISM_SVC SET DEFAULT_SECONDARY_ROLES = ();

-- One-time per account: uncomment and paste the public key printed by the
-- wizard's openssl commands (grep -v "PUBLIC KEY" rsa_key.pub | tr -d '\n').
-- Deliberately left commented so re-runs never clobber the live key.
-- ALTER USER PRISM_SVC SET RSA_PUBLIC_KEY = '<public key here>';

-- ── Part D — data-access grants for the dev source schemas ──────────────────
-- Mirror of the wizard's generated per-schema block, applied to the dev
-- account's test schema. Add more schema blocks here as dev needs them.
-- These give Prism READ access plus the ability to create its OWN output
-- tables and views (which it owns and maintains). Prism gets NO write access
-- to existing tables here — the "Column" output mode's UPDATE is granted per
-- table, at consent time, by the app (provisionColumnModeAccess), never in
-- onboarding.
CREATE DATABASE IF NOT EXISTS TEST_DB;
CREATE SCHEMA IF NOT EXISTS TEST_DB.PUBLIC;

GRANT USAGE ON DATABASE TEST_DB TO ROLE PRISM_SERVICE;
GRANT USAGE ON SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT SELECT ON ALL TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT CREATE TABLE ON SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT CREATE VIEW ON SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
