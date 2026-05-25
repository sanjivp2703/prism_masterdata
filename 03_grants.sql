-- ============================================================================
-- 03_grants.sql
--
-- All Snowflake role and privilege grants for Prism.
-- Run as ACCOUNTADMIN after 00_bootstrap.sql and 01_internal_tables.sql.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

-- ============================================================================
-- SECTION 1 — Roles
-- ============================================================================

CREATE ROLE IF NOT EXISTS STAND_ADMIN;   -- full access; used by the Prism app service user
CREATE ROLE IF NOT EXISTS STAND_USER;    -- reserved for future human users
CREATE ROLE IF NOT EXISTS STAND_VIEWER;  -- reserved for read-only access

-- Hierarchy: STAND_ADMIN inherits STAND_USER which inherits STAND_VIEWER
GRANT ROLE STAND_USER   TO ROLE STAND_ADMIN;
GRANT ROLE STAND_VIEWER TO ROLE STAND_USER;

-- ============================================================================
-- SECTION 2 — Prism internal database / schema access
-- ============================================================================

GRANT USAGE ON DATABASE STAND_DB TO ROLE STAND_ADMIN;
GRANT USAGE ON DATABASE STAND_DB TO ROLE STAND_USER;
GRANT USAGE ON DATABASE STAND_DB TO ROLE STAND_VIEWER;

-- STAND_INTERNAL is private — only STAND_ADMIN
GRANT USAGE         ON SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;
GRANT ALL PRIVILEGES ON SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;

-- Current live tables (01_internal_tables.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.DOMAINS               TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINES              TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE         TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.RUNS                   TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.ACCOUNTS               TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.INVITATIONS            TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.VALIDATION_LOG         TO ROLE STAND_ADMIN;

-- Future tables created in STAND_INTERNAL automatically get full access
GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;

-- ============================================================================
-- SECTION 3 — UDF privilege (needed for any custom functions in STAND_INTERNAL)
-- ============================================================================

GRANT CREATE FUNCTION ON SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;
GRANT ALL PRIVILEGES  ON FUTURE FUNCTIONS IN SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;

-- ============================================================================
-- SECTION 4 — Source database / schema access
--
-- STAND_ADMIN needs USAGE on any database/schema that contains a source table
-- connected to a pipeline (for INFORMATION_SCHEMA column discovery and SELECT
-- when building the export table).
--
-- It also needs CREATE TABLE on any schema where an export table will live.
--
-- Add one block for every source/export database+schema you onboard.
-- ============================================================================

-- GRANT USAGE        ON DATABASE <source_db>              TO ROLE STAND_ADMIN;
-- GRANT USAGE        ON SCHEMA   <source_db>.<schema>     TO ROLE STAND_ADMIN;
-- GRANT SELECT       ON ALL TABLES IN SCHEMA <source_db>.<schema> TO ROLE STAND_ADMIN;
-- GRANT CREATE TABLE ON SCHEMA   <export_db>.<schema>     TO ROLE STAND_ADMIN;

-- Development / test
GRANT USAGE        ON DATABASE TEST_DB        TO ROLE STAND_ADMIN;
GRANT USAGE        ON SCHEMA   TEST_DB.PUBLIC TO ROLE STAND_ADMIN;
GRANT SELECT       ON ALL TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE STAND_ADMIN;
GRANT CREATE TABLE ON SCHEMA   TEST_DB.PUBLIC TO ROLE STAND_ADMIN;

-- ============================================================================
-- SECTION 5 — Assign the service user to STAND_ADMIN
--
-- The Snowflake user the Prism backend connects as (SNOWFLAKE_USER in
-- .env.local) must hold STAND_ADMIN for all privileges above to take effect.
-- ============================================================================

-- GRANT ROLE STAND_ADMIN TO USER <your_service_user>;

-- Development
GRANT ROLE STAND_ADMIN TO USER SANJIVP2703;

-- ============================================================================
-- SECTION 6 — Verification queries (run after setup to confirm)
-- ============================================================================

-- All grants held by STAND_ADMIN:
-- SHOW GRANTS TO ROLE STAND_ADMIN;

-- Confirm the export table was created after a standardization pass:
-- SHOW TABLES IN SCHEMA TEST_DB.PUBLIC;
