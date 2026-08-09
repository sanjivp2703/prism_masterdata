USE DATABASE PRISM_DB;
USE SCHEMA INTERNAL;

-- ============================================================================
-- CUSTOMER INSTALL SCRIPT — everything Prism requires in the customer's
-- Snowflake account: the PRISM_NORMALIZE UDF, the four internal data-plane
-- tables, and the roles/grants. Contains NO demo or test data — that lives in
-- 02_demo_data.sql (dev/demo only, never run on a customer account).
--
-- FULL DEV RESET = 00 + THIS FILE + 02_demo_data.sql + THE APP-STATE RESET
-- Re-running this file resets the Snowflake side (lookup tables, queue, file
-- rows, pipeline streams); 02_demo_data.sql resets the demo source table.
-- PIPELINES / RUNS / specs live in the local SQLite app database, which
-- snowsql cannot touch — reset them with the companion:
--     cd stand-ui && npm run reset-app-state
-- then restart the dev server (the poller holds in-memory state).
-- ============================================================================

-- ============================================================================
-- PRISM_NORMALIZE — canonical normalization for literal MATCHING only.
-- Folds case, normalizes Unicode to NFC, strips control characters, and
-- collapses/trims whitespace, so byte-variant spellings of the same value
-- ("AT&T " vs "at&t", NFD vs NFC, stray control chars) compare equal.
--
-- The ORIGINAL value is always what gets stored in literal_value (so the LLM
-- still sees casing — useful for acronyms); this function is applied only when
-- comparing/matching/deduping.  It is mirrored EXACTLY by normalizeLiteral() in
-- stand-ui/app/api/_lib/normalize.ts (same JS engine semantics) so in-memory
-- matching and SQL matching always agree — keep the two in sync.
-- ============================================================================
CREATE OR REPLACE FUNCTION PRISM_DB.INTERNAL.PRISM_NORMALIZE(V STRING)
RETURNS STRING
LANGUAGE JAVASCRIPT
AS $$
  if (V === null || V === undefined) return null;
  var s = String(V).normalize('NFC');
  // strip control chars (C0 0-31, DEL 127, C1 128-159) via char codes
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c <= 31 || c === 127 || (c >= 128 && c <= 159)) continue;
    out += s.charAt(i);
  }
  out = out.replace(/\s+/g, ' ').trim();  // collapse whitespace runs, trim
  return out.toLowerCase();                        // case-fold
$$;

-- ============================================================================
-- CLASSIFICATION TABLES
-- RUNS is the sole run table for this pipeline — it stores both run
-- metadata (source, concept_key, status) and the full grouping state blob.
-- ============================================================================

-- Drop dependent tables first (FK order).
DROP TABLE IF EXISTS LITERAL_ALIAS_MATCHES;
DROP TABLE IF EXISTS APPROVED_ALIAS_NAMES;
DROP TABLE IF EXISTS PIPELINE_QUEUE;

-- ── Retired tables ───────────────────────────────────────────────────────────
-- Nothing here is created by this script any more; these DROPs exist so that
-- re-running it CLEANS UP a long-lived install rather than leaving orphans
-- behind forever. A fresh account never had them, and the DROPs are no-ops.
--
-- Two generations of leftovers:
--
-- 1. App-state tables that moved to SQLite (2026-07). Prism's metadata —
--    accounts, invitations, pipelines, runs, the one-time archive — lives in
--    the local SQLite file now; only tables that get JOINed against customer
--    data inside warehouse SQL stayed here. DOMAINS went further and was
--    removed outright, replaced by per-column specs.
DROP TABLE IF EXISTS ACCOUNTS;
DROP TABLE IF EXISTS INVITATIONS;
DROP TABLE IF EXISTS PIPELINES;
DROP TABLE IF EXISTS RUNS;
DROP TABLE IF EXISTS DOMAINS;
DROP TABLE IF EXISTS ONE_TIME_STANDARDIZATIONS;
--
-- 2. PIPELINE_FILE_ROWS — row snapshots for file-based PIPELINES. Files,
--    Google Sheets and pasted lists are one-shot by nature and moved to the
--    one-time flow (which has its own ONE_TIME_FILE_ROWS); pipelines are
--    warehouse-only, so nothing writes this any more.
DROP TABLE IF EXISTS PIPELINE_FILE_ROWS;
--
-- 3. The original deterministic grouping pipeline, deleted from the codebase
--    long before this. Unreferenced by any live code path.
DROP TABLE IF EXISTS CONCEPTS;
DROP TABLE IF EXISTS ALIASES;
DROP TABLE IF EXISTS ALIAS_SUMMARY;
DROP TABLE IF EXISTS RAW_VALUES;
DROP TABLE IF EXISTS TOKENS_SUMMARY;
DROP TABLE IF EXISTS ALIAS_TOKEN_COUNT;
DROP TABLE IF EXISTS GLOBAL_TOKEN_COUNT;
DROP TABLE IF EXISTS RUN_GROUPS;
DROP TABLE IF EXISTS RUN_ITEMS;
DROP TABLE IF EXISTS RUN_APPLIED_TARGETS;
DROP TABLE IF EXISTS AUDIT_LOG;
DROP TABLE IF EXISTS CLASSIFICATION_METADATA_PROFILES;
DROP TABLE IF EXISTS CONCEPT_COMPATIBILITY;

-- Drop ALL pipeline streams — the pipelines they belong to are reset by the
-- companion app-state reset (npm run reset-app-state), and stale streams from
-- previous pipeline generations otherwise accumulate forever. New pipelines
-- get new ids, so their streams are recreated fresh by the poller.
EXECUTE IMMEDIATE $$
BEGIN
  SHOW STREAMS LIKE 'PIPELINE_STREAM_%' IN SCHEMA PRISM_DB.INTERNAL;
  LET c1 CURSOR FOR SELECT "name" AS n FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
  FOR r IN c1 DO
    EXECUTE IMMEDIATE 'DROP STREAM IF EXISTS PRISM_DB.INTERNAL."' || r.n || '"';
  END FOR;
  RETURN 'pipeline streams dropped';
END;
$$;


-- NOTE: RUNS, PIPELINES, and per-column standardization specs (COLUMN_SPECS)
-- live in the local SQLite app database (stand-ui/app/api/_lib/sqlite.ts). The
-- `domain_id` columns below are a HISTORICAL name — they now hold a
-- COLUMN_SPECS.spec_id (the per-column lookup scope; domains were removed). The
-- run_id / pipeline_id / domain_id columns are cross-store references —
-- Snowflake never enforced FKs anyway.


-- ----------------------------------------------------------------------------
-- PIPELINE_QUEUE
-- Tracks values detected by polling that have not yet been standardized.
-- Inserted when a poll finds new unmapped values; deleted when a run that
-- covers this pipeline's source is successfully exported.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE PIPELINE_QUEUE (
    queue_id        INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    pipeline_id     INTEGER         NOT NULL,  -- SQLite pipelines.pipeline_id (cross-store ref)
    literal_value    VARCHAR         NOT NULL,
    source_frequency INTEGER         NOT NULL DEFAULT 1,                 -- source rows this distinct value currently represents
    detected_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipeline_queue UNIQUE (pipeline_id, literal_value)
);


-- ----------------------------------------------------------------------------
-- APPROVED_ALIAS_NAMES
-- Catalog of alias names confirmed through at least one export.
-- Surrogate alias_id PK allows alias names to be renamed in one row without
-- cascading updates to LITERAL_ALIAS_MATCHES, and allows the same alias name
-- to exist under different per-column scopes (enforced by
-- UNIQUE(alias_name, domain_id) — domain_id now holds a COLUMN_SPECS.spec_id).
-- usage_count is incremented each time the name appears in an export.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE APPROVED_ALIAS_NAMES (
    alias_id      INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_name    VARCHAR(1000)   NOT NULL,
    domain_id     INTEGER,                                         -- SQLite column_specs.spec_id (per-column scope; historical name)
    usage_count   INTEGER         NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMP_NTZ,
    CONSTRAINT uq_approved_alias_names UNIQUE (alias_name, domain_id)
);

-- ----------------------------------------------------------------------------
-- LITERAL_ALIAS_MATCHES
-- Confirmed mappings from a raw literal value to a canonical alias.
-- References APPROVED_ALIAS_NAMES via alias_id (integer FK) so that renaming
-- an alias only touches one row and never requires a scan of this table.
-- domain_id (now a COLUMN_SPECS.spec_id) is denormalized from the parent alias
-- for fast per-column scope filtering.
--
-- NOTE: literal_value is NOT the primary key — the same raw string can map
-- to different canonical values under different per-column scopes.
-- Uniqueness within a scope is enforced by the MERGE ON conditions in
-- upsertLiteralMatch; match_id is a surrogate key for safe FK references.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE LITERAL_ALIAS_MATCHES (
    match_id        INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value   VARCHAR         NOT NULL,
    -- normalized_value is PRISM_NORMALIZE(literal_value) materialized at WRITE
    -- time so lookup/export joins can compare a plain stored column instead of
    -- re-running the JS UDF on this (only-growing) table every query. The source
    -- side still runs the UDF; the lookup side becomes a hash-joinable equality,
    -- letting Snowflake prune micro-partitions. Every code path that INSERTs/
    -- MERGEs here MUST set normalized_value = PRISM_NORMALIZE(literal_value).
    -- (A virtual column would be recomputed on read, defeating the purpose, so
    -- this is a real stored column.) If PRISM_NORMALIZE logic ever changes, this
    -- column must be backfilled — see normalize.ts sync note.
    normalized_value VARCHAR,
    alias_id        INTEGER         NOT NULL
                                    REFERENCES APPROVED_ALIAS_NAMES(alias_id)
                                    ON DELETE RESTRICT,
    domain_id       INTEGER,                                        -- SQLite column_specs.spec_id (per-column scope; denormalized from alias)
    run_id          INTEGER         NOT NULL,  -- SQLite runs.run_id (cross-store ref; 0 = seed sentinel)
    confirmed_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);


-- ----------------------------------------------------------------------------
-- ONE_TIME_FILE_ROWS
-- Row snapshot for a ONE-TIME standardization whose source is an uploaded file
-- or a Google Sheet (rather than a warehouse table). Keyed by the session
-- nonce, not a pipeline_id — one-time sessions have no pipeline.
--
-- Why it exists at all: a one-time session is not instantaneous. The user
-- uploads, reviews groups (possibly for a long while), then exports; the export
-- must reproduce EVERY source row with the standardized columns substituted, so
-- the rows have to outlive the request that uploaded them.
--
-- Why here and not SQLite: these are customer VALUES. The data-residency rule
-- is that values live in the customer's warehouse and SQLite keeps only
-- metadata/config.
--
-- Lifecycle: written at session creation, read at export, deleted when the
-- session is discarded or its archive row is removed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_TIME_FILE_ROWS (
    row_id        INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    session_nonce VARCHAR         NOT NULL,
    row_num       INTEGER         NOT NULL,
    column_data   VARIANT         NOT NULL,
    created_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- RUN_STATE — the run review state blob (data residency).
-- One row per run: the full grouping/review JSON for that run. The blob
-- contains the customer's distinct column values under review, so it lives in
-- the CUSTOMER's warehouse, never in the app's local SQLite (which keeps only
-- run metadata: status, source, nonce). The optimistic-concurrency revision
-- counter lives INSIDE the blob (state:rev; missing = 0) — the app's
-- rev-checked save compares it in SQL. run_id references the SQLite runs
-- table (plain integer, no FK — same as pipeline_id elsewhere).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE RUN_STATE (
    run_id      INTEGER         NOT NULL PRIMARY KEY,
    state       VARIANT,
    updated_at  TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- VALIDATION_LOG — append-only audit trail of export-referee decisions.
-- Contains literal source values, so it lives warehouse-side (data residency).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE VALIDATION_LOG (
    id                  INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value       VARCHAR         NOT NULL,
    run_id              INTEGER,
    original_alias_name VARCHAR,
    user_changed_to     VARCHAR,
    llm_decision        VARCHAR,        -- 'user' | 'original'
    decided_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ============================================================================
-- MOVED TO SQLITE
-- ACCOUNTS, INVITATIONS, ONE_TIME_STANDARDIZATIONS, RUNS (metadata only —
-- the state blob is warehouse-side in RUN_STATE above), and PIPELINES live in
-- the local app database (stand-ui/app/api/_lib/sqlite.ts), not in Snowflake.
-- The rule: anything holding customer VALUES lives here in the customer's
-- warehouse; pure app-state (accounts, configs, run/pipeline metadata) stays
-- in SQLite.
-- ============================================================================

-- ============================================================================
-- ROLES AND GRANTS
--
-- Consolidated here so a single `snowsql -f 01_internal_tables.sql` is all
-- that is needed for a fresh install. Run as ACCOUNTADMIN.
--
-- These same statements are executed automatically by the app when a user
-- saves their Snowflake credentials via Settings → Snowflake connection.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

-- ── Roles ─────────────────────────────────────────────────────────────────────
CREATE ROLE IF NOT EXISTS PRISM_SERVICE;       -- app service role (all writes)
CREATE ROLE IF NOT EXISTS PRISM_DATA_ADMIN;  -- human-only: manual lookup-table maintenance
CREATE ROLE IF NOT EXISTS PRISM_USER;        -- reserved for future human users (no write)
CREATE ROLE IF NOT EXISTS PRISM_READONLY;      -- reserved for read-only access

-- Role hierarchy
GRANT ROLE PRISM_USER   TO ROLE PRISM_SERVICE;
GRANT ROLE PRISM_READONLY TO ROLE PRISM_USER;

-- ── Dedicated warehouse ───────────────────────────────────────────────────────
-- Prism runs on its own XSMALL warehouse so its compute cost is isolated and
-- attributable on the customer's bill, and auto-suspend tuning never affects
-- their other workloads. IF NOT EXISTS: re-running this script never clobbers
-- a warehouse an installer has since resized — adjust via ALTER WAREHOUSE.
-- Set SNOWFLAKE_WAREHOUSE=PRISM_WH (or Settings → warehouse) to use it.
CREATE WAREHOUSE IF NOT EXISTS PRISM_WH
    WAREHOUSE_SIZE               = XSMALL
    AUTO_SUSPEND                 = 60      -- seconds idle before suspending
    AUTO_RESUME                  = TRUE
    INITIALLY_SUSPENDED          = TRUE
    STATEMENT_TIMEOUT_IN_SECONDS = 600     -- caps the cost of any runaway query
    COMMENT = 'Dedicated warehouse for the Prism standardization service';

GRANT USAGE, OPERATE ON WAREHOUSE PRISM_WH TO ROLE PRISM_SERVICE;
GRANT USAGE          ON WAREHOUSE PRISM_WH TO ROLE PRISM_DATA_ADMIN;

-- ── Database-level access (all roles) ────────────────────────────────────────
-- PRISM_USER and PRISM_READONLY get DB visibility only; INTERNAL is private.
GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_USER;
GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_READONLY;

-- ── PRISM_DB / INTERNAL access (service role) ──────────────────────────
GRANT USAGE          ON DATABASE PRISM_DB                     TO ROLE PRISM_SERVICE;
GRANT USAGE          ON SCHEMA   PRISM_DB.INTERNAL      TO ROLE PRISM_SERVICE;
-- PRISM_DB.PUBLIC is the default destination for lookup-table exports
-- (PRISM_DB.PUBLIC.<DOMAIN>_LOOKUP / GLOBAL_CANONICAL_MAPPINGS).
GRANT USAGE          ON SCHEMA   PRISM_DB.PUBLIC        TO ROLE PRISM_SERVICE;
GRANT CREATE TABLE   ON SCHEMA   PRISM_DB.PUBLIC        TO ROLE PRISM_SERVICE;
GRANT CREATE VIEW    ON SCHEMA   PRISM_DB.PUBLIC        TO ROLE PRISM_SERVICE;
GRANT ALL PRIVILEGES ON SCHEMA   PRISM_DB.INTERNAL      TO ROLE PRISM_SERVICE;

-- Explicit grants on every current table (CREATE OR REPLACE resets ownership;
-- FUTURE TABLES below only covers tables created AFTER this script runs).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.PIPELINE_QUEUE             TO ROLE PRISM_SERVICE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS        TO ROLE PRISM_SERVICE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES       TO ROLE PRISM_SERVICE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES      TO ROLE PRISM_SERVICE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.RUN_STATE                  TO ROLE PRISM_SERVICE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.VALIDATION_LOG             TO ROLE PRISM_SERVICE;

-- Future tables auto-inherit full access
GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE;

-- UDF access (PRISM_NORMALIZE was just created above; FUTURE covers later UDFs)
GRANT CREATE FUNCTION ON SCHEMA  PRISM_DB.INTERNAL                                TO ROLE PRISM_SERVICE;
GRANT ALL PRIVILEGES  ON FUTURE FUNCTIONS IN SCHEMA PRISM_DB.INTERNAL             TO ROLE PRISM_SERVICE;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA PRISM_DB.INTERNAL                          TO ROLE PRISM_SERVICE;
GRANT USAGE ON FUNCTION PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR)                TO ROLE PRISM_SERVICE;

-- ── PRISM_DATA_ADMIN (human maintenance role) ─────────────────────────────────
GRANT USAGE ON DATABASE PRISM_DB                     TO ROLE PRISM_DATA_ADMIN;
GRANT USAGE ON SCHEMA   PRISM_DB.INTERNAL      TO ROLE PRISM_DATA_ADMIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES      TO ROLE PRISM_DATA_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES       TO ROLE PRISM_DATA_ADMIN;
GRANT USAGE ON FUNCTION PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR)                         TO ROLE PRISM_DATA_ADMIN;

-- ── Assign roles to users ────────────────────────────────────────────────────
-- The Snowflake user the Prism backend connects as must hold PRISM_SERVICE.
-- Human admins who hand-edit lookup/config tables get PRISM_DATA_ADMIN only.
-- Never give the service user PRISM_DATA_ADMIN; never give human users PRISM_SERVICE.
-- (The setup wizard's step 2 creates the PRISM_SVC service user and grants it
-- PRISM_SERVICE; dev-account grants live in 02_demo_data.sql.)
-- GRANT ROLE PRISM_SERVICE      TO USER <service_user>;
-- GRANT ROLE PRISM_DATA_ADMIN TO USER <human_admin>;

-- ── Source / export database access ──────────────────────────────────────────
-- PRISM_SERVICE needs USAGE on every database/schema that contains a source or
-- export table connected to a pipeline. Add one block per database.
-- GRANT USAGE        ON DATABASE <source_db>                         TO ROLE PRISM_SERVICE;
-- GRANT USAGE        ON SCHEMA   <source_db>.<schema>                TO ROLE PRISM_SERVICE;
-- GRANT SELECT       ON ALL TABLES IN SCHEMA <source_db>.<schema>    TO ROLE PRISM_SERVICE;
-- GRANT CREATE TABLE ON SCHEMA   <export_db>.<schema>                TO ROLE PRISM_SERVICE;
-- GRANT CREATE VIEW  ON SCHEMA   <export_db>.<schema>                TO ROLE PRISM_SERVICE;  -- needed for the "view" export mode
-- Let the customer's consuming roles read every export table Prism creates in
-- the schema — COPY GRANTS carries the materialized grant through rebuilds:
-- GRANT SELECT ON FUTURE TABLES IN SCHEMA <export_db>.<schema>      TO ROLE <consumer_role>;
-- (Dev/test grants for TEST_DB live in 02_demo_data.sql.)

-- ── Verification (run after setup to confirm) ─────────────────────────────────
-- SHOW GRANTS TO ROLE PRISM_SERVICE;
-- SHOW GRANTS TO ROLE PRISM_DATA_ADMIN;
