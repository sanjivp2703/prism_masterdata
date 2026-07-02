USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

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
CREATE OR REPLACE FUNCTION STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(V STRING)
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

-- Drop dependent tables first (FK order), then the run table.
DROP TABLE IF EXISTS LITERAL_ALIAS_MATCHES;
DROP TABLE IF EXISTS VALIDATION_LOG;
DROP TABLE IF EXISTS APPROVED_ALIAS_NAMES;
DROP TABLE IF EXISTS RUNS;
DROP TABLE IF EXISTS PIPELINE_QUEUE;
DROP TABLE IF EXISTS PIPELINES;
DROP TABLE IF EXISTS DOMAINS;

-- ----------------------------------------------------------------------------
-- RUNS
-- The primary run table. Each row is a complete run: metadata + state blob.
--
-- state VARIANT schema:
-- {
--   "status": "created" | "running" | "complete" | "failed",
--   "items": [
--     {
--       "run_item_id":         1,
--       "literal_value":       "VZW",
--       "source_frequency":    14,
--       "matched_from_lookup": false,
--       "alias_name":          "Verizon"   // present when matched
--     }
--   ],
--   "groups": [
--     {
--       "group_id":          1,
--       "alias_name":        "Verizon",
--       "alias_name_source": "lookup_validated" | "llm_proposed" | "user_override",
--       "confidence":        "h" | "m" | "l",
--       "from_lookup_chunk": true,
--       "items": [
--         { "literal_value": "VZW", "matched_from_lookup": true }
--       ]
--     }
--   ],
--   "ungrouped": [
--     { "literal_value": "some literal", "matched_from_lookup": false }
--   ]
-- }
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- DOMAINS
-- Subject/category of what is being standardized (e.g. "Mobile Carriers",
-- "Company Names"). Used in auto_export mode to scope alias names and literal
-- matches so that the same raw string can map to different canonical values
-- across different domains. Basic mode runs have domain_id = NULL.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE DOMAINS (
    domain_id             INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    name                  VARCHAR(500)    NOT NULL,
    description           VARCHAR,                         -- optional human description of what values this domain represents
    standardization_rules VARCHAR,                         -- JSON array of free-text rule strings (e.g. "group subsidiaries under parent")
    convention_type       VARCHAR(20),                    -- NULL | 'regex' | 'examples' | 'natural' — naming convention for auto-standardized canonical names
    convention_value      VARCHAR,                         -- the regex source, newline-separated examples, or the natural-language description
    convention_rules      VARCHAR,                         -- JSON of structured naming rules (case, spaces, suffixes, length, …) — see convention-rules.ts
    usage_count           INTEGER         NOT NULL DEFAULT 0,
    last_used_at          TIMESTAMP_NTZ,
    created_at            TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at            TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_domains_name UNIQUE (name)
);
-- Migration (existing DBs):
-- ALTER TABLE DOMAINS ADD COLUMN IF NOT EXISTS convention_type        VARCHAR(20);
-- ALTER TABLE DOMAINS ADD COLUMN IF NOT EXISTS convention_value       VARCHAR;
-- ALTER TABLE DOMAINS ADD COLUMN IF NOT EXISTS convention_rules       VARCHAR;
-- ALTER TABLE DOMAINS ADD COLUMN IF NOT EXISTS description            VARCHAR;
-- ALTER TABLE DOMAINS ADD COLUMN IF NOT EXISTS standardization_rules  VARCHAR;

-- Seed default domains (no initial standardizations — just the empty buckets).
INSERT INTO DOMAINS (name) VALUES ('Mobile Carriers'), ('Company Names');

-- ----------------------------------------------------------------------------
-- PIPELINES
-- Each row represents a configured auto-export pipeline: a Snowflake source
-- table + column watched for new values, scoped to a domain.
-- status: 'active' = polling / 'paused' = stopped / 'pending_baseline' =
--         initial standardization run has not yet been accepted.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE PIPELINES (
    pipeline_id         INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    name                VARCHAR(500),                                           -- user label; NULL = use table.column
    table_fqn           VARCHAR(1000)   NOT NULL,
    column_name         VARCHAR(500)    NOT NULL,
    export_table_fqn    VARCHAR(1000),                                          -- destination table for standardized output (Premium mode)
    domain_id           INTEGER         NOT NULL REFERENCES DOMAINS(domain_id), -- every pipeline must belong to a domain
    status              VARCHAR(50)     NOT NULL DEFAULT 'active',              -- active | paused | pending_baseline
    status_message      VARCHAR(2000),                                          -- human-readable reason shown while paused/blocked (NULL = healthy)
    mode                VARCHAR(20)     NOT NULL DEFAULT 'auto',                -- auto | manual
    export_unmapped_rows BOOLEAN        NOT NULL DEFAULT TRUE,                   -- manual only: include unmapped rows in export as raw values (TRUE) or exclude them (FALSE)
    queue_size          INTEGER         NOT NULL DEFAULT 0,
    total_new_values    INTEGER         NOT NULL DEFAULT 0,
    total_mapped        INTEGER         NOT NULL DEFAULT 0,              -- source rows with a confirmed mapping (non-distinct)
    total_source_values INTEGER         NOT NULL DEFAULT 0,              -- total non-null source rows; updated each poll / recount
    last_polled_at      TIMESTAMP_NTZ,
    last_queue_empty_at TIMESTAMP_NTZ,                                          -- last time the queue was fully drained
    created_by          INTEGER,                                                -- ACCOUNTS.account_id of creator (FK not declared: ACCOUNTS is created later & Snowflake doesn't enforce FKs). NULL = unknown/legacy. Scopes alert notifications for non-admins.
    source_type         VARCHAR(20)     NOT NULL DEFAULT 'snowflake',              -- 'snowflake' | 'csv' | 'excel' | 'sheets'
    file_source_meta    VARIANT,                                                   -- non-Snowflake sources: { original_name, spreadsheet_id?, ... }
    file_export_meta    VARIANT,                                                   -- file export info: { type, suggested_name?, spreadsheet_id?, ... }
    created_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipelines_source UNIQUE (table_fqn, column_name, domain_id)
);

-- Migrations: run these if you already have data and do not want to DROP/RECREATE:
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS export_table_fqn VARCHAR(1000);
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS total_mapped INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS total_source_values INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS status_message VARCHAR(2000);
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS created_by INTEGER;
-- ALTER TABLE PIPELINES ALTER COLUMN domain_id SET NOT NULL;   -- domain is mandatory (backfill any NULLs first)
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS export_unmapped_rows BOOLEAN NOT NULL DEFAULT TRUE;
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'snowflake';
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS file_source_meta VARIANT;
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS file_export_meta VARIANT;
-- ALTER TABLE PIPELINE_QUEUE ADD COLUMN IF NOT EXISTS source_frequency INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE LITERAL_ALIAS_MATCHES ADD COLUMN IF NOT EXISTS normalized_value VARCHAR;
-- UPDATE LITERAL_ALIAS_MATCHES SET normalized_value = PRISM_NORMALIZE(literal_value) WHERE normalized_value IS NULL;  -- backfill

-- Seed an example premium pipeline on TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT,
-- standardizing two columns into one shared export table (mirrors the "Connect
-- source table" setup form). Each watched column is its own PIPELINES row (same
-- table + export table), scoped to its own domain. status='active' so the
-- background poller picks them up immediately; existing rows are standardized by
-- the reconciliation sweep (~15s after boot) and new ones via the stream.
-- TEMP: initial pipeline seed disabled — re-enable (with the domains seed above)
-- to restore the demo pipeline.
/*
INSERT INTO PIPELINES (name, table_fqn, column_name, export_table_fqn, domain_id, status, mode)
SELECT NULL,
       'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT',
       'RAW_CARRIER_VALUE',
       'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT_STANDARDIZED',
       domain_id, 'active', 'auto'
FROM DOMAINS WHERE name = 'Mobile Carrier';

INSERT INTO PIPELINES (name, table_fqn, column_name, export_table_fqn, domain_id, status, mode)
SELECT NULL,
       'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT',
       'RAW_COMPANY_VALUE',
       'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT_STANDARDIZED',
       domain_id, 'active', 'auto'
FROM DOMAINS WHERE name = 'Company Name';
*/

-- ----------------------------------------------------------------------------
-- PIPELINE_QUEUE
-- Tracks values detected by polling that have not yet been standardized.
-- Inserted when a poll finds new unmapped values; deleted when a run that
-- covers this pipeline's source is successfully exported.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE PIPELINE_QUEUE (
    queue_id        INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    pipeline_id     INTEGER         NOT NULL
                                    REFERENCES PIPELINES(pipeline_id)
                                    ON DELETE CASCADE,
    literal_value    VARCHAR         NOT NULL,
    source_frequency INTEGER         NOT NULL DEFAULT 1,                 -- source rows this distinct value currently represents
    detected_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipeline_queue UNIQUE (pipeline_id, literal_value)
);

CREATE OR REPLACE TABLE RUNS (
    run_id          INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_key     VARCHAR(500)    NOT NULL DEFAULT 'mobile_carrier',
    source_relation VARCHAR(1000)   NOT NULL DEFAULT '__unknown__',
    source_column   VARCHAR(500)    NOT NULL DEFAULT '__unknown__',
    domain_id       INTEGER         REFERENCES DOMAINS(domain_id),
    mode            VARCHAR(50)     NOT NULL DEFAULT 'review',
    -- 'normal' = domain-scoped run that writes to the shared lookup on export;
    -- 'one_time' = throwaway run that exports to a standalone Snowflake table and
    -- NEVER touches LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES.
    run_type        VARCHAR(20)     NOT NULL DEFAULT 'normal',
    -- ACCOUNTS.account_id of the creator — used to scope the one-time archive.
    created_by      INTEGER,
    run_status      VARCHAR(50)     NOT NULL DEFAULT 'created',
    state           VARIANT,
    stats_snapshot  VARIANT,
    -- Used to retrieve the auto-assigned run_id immediately after INSERT.
    creation_nonce  VARCHAR(200),
    created_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
-- Incremental migrations (uncomment to apply to an existing DB):
-- ALTER TABLE RUNS ADD COLUMN IF NOT EXISTS run_type   VARCHAR(20) NOT NULL DEFAULT 'normal';
-- ALTER TABLE RUNS ADD COLUMN IF NOT EXISTS created_by INTEGER;
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_account     VARCHAR(500);
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_user        VARCHAR(500);
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_warehouse   VARCHAR(500);
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_role        VARCHAR(200);
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_password    VARCHAR(2000);
-- ALTER TABLE ACCOUNTS ADD COLUMN IF NOT EXISTS sf_private_key VARCHAR(8000);

-- ----------------------------------------------------------------------------
-- APPROVED_ALIAS_NAMES
-- Catalog of alias names confirmed through at least one export.
-- Surrogate alias_id PK allows alias names to be renamed in one row without
-- cascading updates to LITERAL_ALIAS_MATCHES, and allows the same alias name
-- to exist in different domains (enforced by UNIQUE(alias_name, domain_id)).
-- usage_count is incremented each time the name appears in an export.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE APPROVED_ALIAS_NAMES (
    alias_id      INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_name    VARCHAR(1000)   NOT NULL,
    domain_id     INTEGER         REFERENCES DOMAINS(domain_id),   -- NULL = basic mode (global)
    usage_count   INTEGER         NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMP_NTZ,
    CONSTRAINT uq_approved_alias_names UNIQUE (alias_name, domain_id)
);

-- ----------------------------------------------------------------------------
-- LITERAL_ALIAS_MATCHES
-- Confirmed mappings from a raw literal value to a canonical alias.
-- References APPROVED_ALIAS_NAMES via alias_id (integer FK) so that renaming
-- an alias only touches one row and never requires a scan of this table.
-- domain_id is denormalized from the parent alias for fast domain filtering.
--
-- NOTE: literal_value is NOT the primary key — the same raw string can map
-- to different canonical values in different domains (or in basic/null mode).
-- Uniqueness within a domain is enforced by the MERGE ON conditions in
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
    domain_id       INTEGER         REFERENCES DOMAINS(domain_id),  -- denormalized copy from alias
    run_id          INTEGER         NOT NULL
                                    REFERENCES RUNS(run_id),
    confirmed_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- DEMO SEED — RAW_MOBILE_CARRIERS_SHORT + pre-confirmed standardizations
-- A two-column source table whose first column (RAW_CARRIER_VALUE) is
-- standardized in the "Mobile Carrier" domain and whose second column
-- (RAW_COMPANY_VALUE) is standardized in the "Company Name" domain. The lookup
-- is pre-seeded so both columns' values are already standardized in their
-- respective domains. (run_id 0 is a seed sentinel — Snowflake does not enforce
-- the RUNS FK.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT (
    RAW_CARRIER_VALUE VARCHAR,
    RAW_COMPANY_VALUE VARCHAR
);
INSERT INTO TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES
('AT&T', 'Goldman Sachs'),
('ATT', 'Goldman Sachs & Co'),
('A T & T', 'Goldman Sachs Group'),
('American Telephone and Telegraph', 'JPMorgan'),
('American Telephone & Telegraph Company', 'JP Morgan Chase'),
('AT and T', 'JPMorgan Chase & Co.'),
('Verizon', 'McKinsey'),
('Verizon Wireless', 'McKinsey & Company'),
('Verizon Wirless', 'McKinsey and Company Inc'),
('VZW', 'Deloitte'),
('Verizon Communications', 'Deloitte LLP'),
('T-Mobile', 'Deloitte Touche Tohmatsu'),
('T Mobile', 'PricewaterhouseCoopers'),
('TMobile', 'PwC'),
('T-Mobile USA', 'Pricewaterhouse Coopers LLP'),
('Sprint', 'Ernst & Young'),
('Sprint PCS', 'EY'),
('Boost Mobile', 'Ernst and Young LLP'),
('Boost', 'KPMG'),
('Cricket', 'KPMG International'),
('Cricket Wireless', 'Bain & Company'),
('MetroPCS', 'Bain and Co'),
('Metro PCS', 'Bain'),
('Metro by T-Mobile', 'Boston Consulting Group'),
('US Cellular', 'BCG'),
('USCellular', 'The Boston Consulting Group'),
('Capital One', 'Accenture'),
('C1', 'Accenture PLC');

-- Canonical alias names for each domain.
-- TEMP: initial standardizations (canonical alias names + the confirmed
-- literal→alias mappings below) disabled — re-enable (with the domains seed) to
-- restore the pre-confirmed demo lookup.
/*
INSERT INTO APPROVED_ALIAS_NAMES (alias_name, domain_id)
SELECT canon, (SELECT domain_id FROM DOMAINS WHERE name = 'Mobile Carrier')
FROM VALUES
  ('AT&T'),('Verizon'),('T-Mobile'),('Sprint'),('Boost Mobile'),
  ('Cricket Wireless'),('Metro by T-Mobile'),('UScellular'),('Capital One')
  AS t(canon)
UNION ALL
SELECT canon, (SELECT domain_id FROM DOMAINS WHERE name = 'Company Name')
FROM VALUES
  ('Goldman Sachs'),('JPMorgan Chase'),('McKinsey & Company'),('Deloitte'),('PwC'),
  ('Ernst & Young'),('KPMG'),('Bain & Company'),('Boston Consulting Group'),('Accenture')
  AS t(canon);

-- Confirmed literal -> alias mappings: first column into Mobile Carrier...
INSERT INTO LITERAL_ALIAS_MATCHES (literal_value, normalized_value, alias_id, domain_id, run_id)
SELECT m.lit, PRISM_NORMALIZE(m.lit), a.alias_id, a.domain_id, 0
FROM VALUES
  ('AT&T','AT&T'),
  ('ATT','AT&T'),
  ('A T & T','AT&T'),
  ('American Telephone and Telegraph','AT&T'),
  ('American Telephone & Telegraph Company','AT&T'),
  ('AT and T','AT&T'),
  ('Verizon','Verizon'),
  ('Verizon Wireless','Verizon'),
  ('Verizon Wirless','Verizon'),
  ('VZW','Verizon'),
  ('Verizon Communications','Verizon'),
  ('T-Mobile','T-Mobile'),
  ('T Mobile','T-Mobile'),
  ('TMobile','T-Mobile'),
  ('T-Mobile USA','T-Mobile'),
  ('Sprint','Sprint'),
  ('Sprint PCS','Sprint'),
  ('Boost Mobile','Boost Mobile'),
  ('Boost','Boost Mobile'),
  ('Cricket','Cricket Wireless'),
  ('Cricket Wireless','Cricket Wireless'),
  ('MetroPCS','Metro by T-Mobile'),
  ('Metro PCS','Metro by T-Mobile'),
  ('Metro by T-Mobile','Metro by T-Mobile'),
  ('US Cellular','UScellular'),
  ('USCellular','UScellular'),
  ('Capital One','Capital One'),
  ('C1','Capital One')
  AS m(lit, canon)
JOIN APPROVED_ALIAS_NAMES a
  ON a.alias_name = m.canon
 AND a.domain_id = (SELECT domain_id FROM DOMAINS WHERE name = 'Mobile Carrier')
UNION ALL
-- ...second column into Company Name.
SELECT m.lit, PRISM_NORMALIZE(m.lit), a.alias_id, a.domain_id, 0
FROM VALUES
  ('Goldman Sachs','Goldman Sachs'),
  ('Goldman Sachs & Co','Goldman Sachs'),
  ('Goldman Sachs Group','Goldman Sachs'),
  ('JPMorgan','JPMorgan Chase'),
  ('JP Morgan Chase','JPMorgan Chase'),
  ('JPMorgan Chase & Co.','JPMorgan Chase'),
  ('McKinsey','McKinsey & Company'),
  ('McKinsey & Company','McKinsey & Company'),
  ('McKinsey and Company Inc','McKinsey & Company'),
  ('Deloitte','Deloitte'),
  ('Deloitte LLP','Deloitte'),
  ('Deloitte Touche Tohmatsu','Deloitte'),
  ('PricewaterhouseCoopers','PwC'),
  ('PwC','PwC'),
  ('Pricewaterhouse Coopers LLP','PwC'),
  ('Ernst & Young','Ernst & Young'),
  ('EY','Ernst & Young'),
  ('Ernst and Young LLP','Ernst & Young'),
  ('KPMG','KPMG'),
  ('KPMG International','KPMG'),
  ('Bain & Company','Bain & Company'),
  ('Bain and Co','Bain & Company'),
  ('Bain','Bain & Company'),
  ('Boston Consulting Group','Boston Consulting Group'),
  ('BCG','Boston Consulting Group'),
  ('The Boston Consulting Group','Boston Consulting Group'),
  ('Accenture','Accenture'),
  ('Accenture PLC','Accenture')
  AS m(lit, canon)
JOIN APPROVED_ALIAS_NAMES a
  ON a.alias_name = m.canon
 AND a.domain_id = (SELECT domain_id FROM DOMAINS WHERE name = 'Company Name');
*/

-- ----------------------------------------------------------------------------
-- ACCOUNTS
-- One row per authenticated user. Created on first Google OAuth login.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ACCOUNTS (
    account_id      INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    google_id       VARCHAR(200)    NOT NULL,
    email           VARCHAR(500)    NOT NULL,
    name            VARCHAR(500),
    picture_url     VARCHAR(2000),
    role            VARCHAR(20)     NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
    creation_nonce  VARCHAR(200),
    -- Per-account Snowflake configuration (nullable; falls back to env vars when NULL)
    sf_account      VARCHAR(500),
    sf_user         VARCHAR(500),
    sf_warehouse    VARCHAR(500),
    sf_role         VARCHAR(200),
    sf_password     VARCHAR(2000),
    sf_private_key  VARCHAR(8000),
    created_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    last_login_at   TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_accounts_google_id UNIQUE (google_id),
    CONSTRAINT uq_accounts_email     UNIQUE (email)
);

-- ----------------------------------------------------------------------------
-- INVITATIONS
-- Tracks pending and accepted invitations to join Prism.
-- A unique token is emailed to the invitee; they present it during OAuth
-- to have their account created.  Invitations expire after 7 days.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE INVITATIONS (
    invitation_id   INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    invited_email   VARCHAR(500)    NOT NULL,
    invited_by      INTEGER         NOT NULL
                                    REFERENCES ACCOUNTS(account_id),
    invited_role    VARCHAR(20)     NOT NULL DEFAULT 'user',       -- 'admin' | 'user'
    token           VARCHAR(200)    NOT NULL,
    status          VARCHAR(50)     NOT NULL DEFAULT 'pending',    -- pending | accepted | revoked
    created_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    accepted_at     TIMESTAMP_NTZ,
    expires_at      TIMESTAMP_NTZ   NOT NULL
                                    DEFAULT DATEADD('day', 7, CURRENT_TIMESTAMP()),
    CONSTRAINT uq_invitations_token UNIQUE (token)
);

-- ----------------------------------------------------------------------------
-- VALIDATION_LOG
-- Audit trail of every LLM validation decision made during post-export cleanup.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE VALIDATION_LOG (
    id                  INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value       VARCHAR         NOT NULL,
    run_id              INTEGER         NOT NULL
                                        REFERENCES RUNS(run_id),
    original_alias_name VARCHAR         NOT NULL,
    user_changed_to     VARCHAR,
    llm_decision        VARCHAR         NOT NULL,
    decided_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- ONE_TIME_STANDARDIZATIONS
-- Per-user archive of completed one-time standardization sessions. One row per
-- exported session. Fully decoupled from the domain lookup — these never touch
-- LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES. The working runs live in RUNS
-- (run_type = 'one_time'); this table is the durable record the archive reads.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- PIPELINE_FILE_ROWS
-- Stores the full row data for CSV/Excel file-sourced pipelines so the
-- standardized output can be reconstructed for download.  One row per source
-- file row.  Sheets pipelines do NOT populate this — they re-read the live
-- sheet on each standardization pass.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE PIPELINE_FILE_ROWS (
    row_id      INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    pipeline_id INTEGER         NOT NULL,
    row_num     INTEGER         NOT NULL,
    column_data VARIANT         NOT NULL,
    created_at  TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- ONE_TIME_STANDARDIZATIONS
CREATE OR REPLACE TABLE ONE_TIME_STANDARDIZATIONS (
    ots_id          INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    created_by      INTEGER,                       -- ACCOUNTS.account_id of the creator
    session_nonce   VARCHAR(200),                  -- ties together the working RUNS of this session
    source_relation VARCHAR(1000)   NOT NULL,
    columns         VARIANT,                       -- array of standardized column names
    export_target   VARCHAR(1000)   NOT NULL,      -- FQN of the table written
    export_mode     VARCHAR(20)     NOT NULL,      -- 'create' | 'overwrite'
    convention      VARIANT,                       -- naming convention(s) used (nullable)
    mappings        VARIANT,                       -- { column_name: [{ raw, standardized }] }
    created_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    exported_at     TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

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
CREATE ROLE IF NOT EXISTS STAND_ADMIN;       -- app service role (all writes)
CREATE ROLE IF NOT EXISTS STAND_DATA_ADMIN;  -- human-only: manual lookup-table maintenance
CREATE ROLE IF NOT EXISTS STAND_USER;        -- reserved for future human users (no write)
CREATE ROLE IF NOT EXISTS STAND_VIEWER;      -- reserved for read-only access

-- Role hierarchy
GRANT ROLE STAND_USER   TO ROLE STAND_ADMIN;
GRANT ROLE STAND_VIEWER TO ROLE STAND_USER;

-- ── Database-level access (all roles) ────────────────────────────────────────
-- STAND_USER and STAND_VIEWER get DB visibility only; STAND_INTERNAL is private.
GRANT USAGE ON DATABASE STAND_DB TO ROLE STAND_USER;
GRANT USAGE ON DATABASE STAND_DB TO ROLE STAND_VIEWER;

-- ── STAND_DB / STAND_INTERNAL access (service role) ──────────────────────────
GRANT USAGE          ON DATABASE STAND_DB                     TO ROLE STAND_ADMIN;
GRANT USAGE          ON SCHEMA   STAND_DB.STAND_INTERNAL      TO ROLE STAND_ADMIN;
GRANT ALL PRIVILEGES ON SCHEMA   STAND_DB.STAND_INTERNAL      TO ROLE STAND_ADMIN;

-- Explicit grants on every current table (CREATE OR REPLACE resets ownership;
-- FUTURE TABLES below only covers tables created AFTER this script runs).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.DOMAINS                    TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINES                  TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE             TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS         TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.RUNS                       TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES       TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES      TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.ACCOUNTS                   TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.INVITATIONS                TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.VALIDATION_LOG             TO ROLE STAND_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.ONE_TIME_STANDARDIZATIONS  TO ROLE STAND_ADMIN;

-- Future tables auto-inherit full access
GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA STAND_DB.STAND_INTERNAL TO ROLE STAND_ADMIN;

-- UDF access (PRISM_NORMALIZE was just created above; FUTURE covers later UDFs)
GRANT CREATE FUNCTION ON SCHEMA  STAND_DB.STAND_INTERNAL                                TO ROLE STAND_ADMIN;
GRANT ALL PRIVILEGES  ON FUTURE FUNCTIONS IN SCHEMA STAND_DB.STAND_INTERNAL             TO ROLE STAND_ADMIN;
GRANT USAGE ON ALL FUNCTIONS IN SCHEMA STAND_DB.STAND_INTERNAL                          TO ROLE STAND_ADMIN;
GRANT USAGE ON FUNCTION STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(VARCHAR)                TO ROLE STAND_ADMIN;

-- ── STAND_DATA_ADMIN (human maintenance role) ─────────────────────────────────
GRANT USAGE ON DATABASE STAND_DB                     TO ROLE STAND_DATA_ADMIN;
GRANT USAGE ON SCHEMA   STAND_DB.STAND_INTERNAL      TO ROLE STAND_DATA_ADMIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES      TO ROLE STAND_DATA_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES       TO ROLE STAND_DATA_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINES                  TO ROLE STAND_DATA_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.ONE_TIME_STANDARDIZATIONS  TO ROLE STAND_DATA_ADMIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS         TO ROLE STAND_DATA_ADMIN;
GRANT USAGE ON FUNCTION STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(VARCHAR)                         TO ROLE STAND_DATA_ADMIN;

-- ── Assign roles to users ────────────────────────────────────────────────────
-- The Snowflake user the Prism backend connects as must hold STAND_ADMIN.
-- Human admins who hand-edit lookup/config tables get STAND_DATA_ADMIN only.
-- Never give the service user STAND_DATA_ADMIN; never give human users STAND_ADMIN.
GRANT ROLE STAND_ADMIN      TO USER SANJIVP2703;
GRANT ROLE STAND_DATA_ADMIN TO USER SANJIVP2703;
-- Template for additional users:
-- GRANT ROLE STAND_ADMIN      TO USER <service_user>;
-- GRANT ROLE STAND_DATA_ADMIN TO USER <human_admin>;

-- ── Source / export database access ──────────────────────────────────────────
-- STAND_ADMIN needs USAGE on every database/schema that contains a source or
-- export table connected to a pipeline. Add one block per database.
-- GRANT USAGE        ON DATABASE <source_db>                         TO ROLE STAND_ADMIN;
-- GRANT USAGE        ON SCHEMA   <source_db>.<schema>                TO ROLE STAND_ADMIN;
-- GRANT SELECT       ON ALL TABLES IN SCHEMA <source_db>.<schema>    TO ROLE STAND_ADMIN;
-- GRANT CREATE TABLE ON SCHEMA   <export_db>.<schema>                TO ROLE STAND_ADMIN;

-- Development / test:
GRANT USAGE        ON DATABASE TEST_DB        TO ROLE STAND_ADMIN;
GRANT USAGE        ON SCHEMA   TEST_DB.PUBLIC TO ROLE STAND_ADMIN;
GRANT SELECT       ON ALL TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE STAND_ADMIN;
GRANT CREATE TABLE ON SCHEMA   TEST_DB.PUBLIC TO ROLE STAND_ADMIN;

-- ── Verification (run after setup to confirm) ─────────────────────────────────
-- SHOW GRANTS TO ROLE STAND_ADMIN;
-- SHOW GRANTS TO ROLE STAND_DATA_ADMIN;
