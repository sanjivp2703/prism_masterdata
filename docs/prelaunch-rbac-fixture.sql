-- ============================================================================
-- PRELAUNCH RBAC FIXTURE — run this ONCE, by hand, in a Snowflake worksheet
-- ============================================================================
--
-- WHY THIS EXISTS
--
-- Three open pre-launch items are all blocked by the same thing: on this
-- account, the only Snowflake identity Prism can authenticate as
-- non-interactively is its own service identity (PRISM_SVC / PRISM_SERVICE),
-- and every table that identity can create it also OWNS. Ownership by itself
-- confers UPDATE, so:
--
--   * REVOKE UPDATE ... FROM ROLE PRISM_SERVICE succeeds but affects 0 objects,
--     and the UPDATE still works  -> PRELAUNCH_CHECKLIST §1.4 cannot be tested
--   * a probe cannot tell "default-deny is working" apart from "the role owns
--     the table"                  -> PRELAUNCH_CHECKLIST §1.5(b) cannot be tested
--   * the same ambiguity blocks   -> PRELAUNCH_CHECKLIST §2 (RBAC default-deny),
--     which is already flagged as unresolved after a dev account was once
--     observed NOT enforcing default-deny
--
-- This script creates the realistic CUSTOMER shape instead: fixture tables
-- owned by a role OUTSIDE PRISM_SERVICE's hierarchy, where Prism holds only
-- the explicit grants a real customer would give it. That makes REVOKE bite
-- and makes default-deny observable.
--
-- WHY YOU HAVE TO RUN IT (not Claude)
--
-- CREATE ROLE is an account-level privilege, so it needs ACCOUNTADMIN, and
-- that user requires MFA/TOTP — it cannot be scripted. Nothing here needs a
-- password or key from you; just run it in a worksheet while signed in.
--
-- WHAT IT TOUCHES
--
-- Creates one role (PRELAUNCH_OWNER) and two tables, both named PRELAUNCH_*,
-- in TEST_DB.PUBLIC. It grants Prism NO new access to anything except one
-- fixture table. Teardown is at the bottom. It does not touch PRISM_DB, the
-- demo table, or any existing pipeline.
--
-- Estimated time: about 10 minutes including the MFA prompt.
-- ============================================================================


-- ── 1. A role deliberately OUTSIDE PRISM_SERVICE's hierarchy ────────────────
-- This role plays "the customer's own admin". PRISM_SERVICE must never inherit
-- from it, which is what makes the default-deny test meaningful.

USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS PRELAUNCH_OWNER;

-- Let yourself act as it. Replace the username if yours differs — check with
--   SELECT CURRENT_USER();
GRANT ROLE PRELAUNCH_OWNER TO USER SANJIVP2703;

-- It needs just enough to build the fixtures, and nothing more.
GRANT USAGE        ON DATABASE TEST_DB        TO ROLE PRELAUNCH_OWNER;
GRANT USAGE        ON SCHEMA   TEST_DB.PUBLIC TO ROLE PRELAUNCH_OWNER;
GRANT CREATE TABLE ON SCHEMA   TEST_DB.PUBLIC TO ROLE PRELAUNCH_OWNER;
GRANT USAGE        ON WAREHOUSE PRISM_WH      TO ROLE PRELAUNCH_OWNER;


-- ── 2. Fixture A — the "consented source table" ─────────────────────────────
-- Owned by PRELAUNCH_OWNER. Prism gets ONLY SELECT + UPDATE on it, which is
-- exactly what a customer grants at column-mode consent time.

USE ROLE      PRELAUNCH_OWNER;
USE WAREHOUSE PRISM_WH;
USE DATABASE  TEST_DB;
USE SCHEMA    PUBLIC;

CREATE OR REPLACE TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC (
  ID      NUMBER(10,0),
  CARRIER VARCHAR,
  NOTE    VARCHAR
);

INSERT INTO TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC VALUES
  (1, 'vzw',     'do-not-touch'),
  (2, 'ATT',     'do-not-touch'),
  (3, 'Verizon', 'do-not-touch'),
  (4, 'at&t ',   'do-not-touch'),
  (5, NULL,      'do-not-touch');

-- Streams need this.
ALTER TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC SET CHANGE_TRACKING = TRUE;

-- The companion column is added by the OWNER, mirroring what
-- provisionColumnModeAccess does with the pipeline creator's own credentials
-- (ADD COLUMN needs ownership; UPDATE does not confer it).
ALTER TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC
  ADD COLUMN "CARRIER_STANDARDIZED" VARCHAR;

-- The realistic customer grant: read + write, on this ONE table. No ownership.
GRANT SELECT, UPDATE ON TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC
  TO ROLE PRISM_SERVICE;


-- ── 3. Fixture B — the default-deny probe ───────────────────────────────────
-- Same schema, same owner, but PRISM_SERVICE is granted NOTHING on it.
-- Prism must not be able to read it or write it. If it can, this account is
-- not enforcing default-deny — which is the exact failure a previous
-- investigation observed and never resolved.

CREATE OR REPLACE TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_DENY (
  ID     NUMBER(10,0),
  SECRET VARCHAR
);

INSERT INTO TEST_DB.PUBLIC.PRELAUNCH_RBAC_DENY VALUES
  (1, 'prism-must-not-read-this');

-- (deliberately no GRANT of any kind to PRISM_SERVICE)


-- ── 4. Confirm the setup is the shape we want ───────────────────────────────
-- Expect: OWNERSHIP -> PRELAUNCH_OWNER, and for PRISM_SERVICE only SELECT and
-- UPDATE on PRELAUNCH_RBAC_SRC. PRELAUNCH_RBAC_DENY should list no grant to
-- PRISM_SERVICE at all.

SHOW GRANTS ON TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC;
SHOW GRANTS ON TABLE TEST_DB.PUBLIC.PRELAUNCH_RBAC_DENY;

-- Sanity: PRISM_SERVICE must NOT be in this role's inheritance chain.
SHOW GRANTS TO ROLE PRISM_SERVICE;


-- ============================================================================
-- TELL CLAUDE WHEN THIS HAS RUN. It will then execute, against these fixtures:
--   §1.4  revoke UPDATE mid-flight -> pipeline must pause with the exact GRANT
--         SQL, and PRELAUNCH_RBAC_SRC must be byte-identical afterwards
--   §1.5b PRISM_SERVICE must fail to SELECT or UPDATE PRELAUNCH_RBAC_DENY
--   §2    the same probe answers the standing RBAC default-deny question
-- Claude will not need ACCOUNTADMIN for any of it — it runs as PRISM_SVC.
-- ============================================================================


-- ── TEARDOWN — run after Claude reports the results ─────────────────────────
-- Safe to run at any time; removes only what this script created.
--
-- USE ROLE ACCOUNTADMIN;
-- DROP TABLE IF EXISTS TEST_DB.PUBLIC.PRELAUNCH_RBAC_SRC;
-- DROP TABLE IF EXISTS TEST_DB.PUBLIC.PRELAUNCH_RBAC_DENY;
-- DROP ROLE  IF EXISTS PRELAUNCH_OWNER;
--
-- Verify nothing is left:
-- SHOW TABLES LIKE 'PRELAUNCH_%' IN SCHEMA TEST_DB.PUBLIC;   -- expect 0 rows
-- SHOW ROLES  LIKE 'PRELAUNCH_OWNER';                        -- expect 0 rows
