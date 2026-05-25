USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

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
    domain_id    INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    name         VARCHAR(500)    NOT NULL,
    usage_count  INTEGER         NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP_NTZ,
    created_at   TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at   TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_domains_name UNIQUE (name)
);

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
    domain_id           INTEGER         REFERENCES DOMAINS(domain_id),
    status              VARCHAR(50)     NOT NULL DEFAULT 'active',              -- active | paused | pending_baseline
    mode                VARCHAR(20)     NOT NULL DEFAULT 'auto',                -- auto | manual
    queue_size          INTEGER         NOT NULL DEFAULT 0,
    total_new_values    INTEGER         NOT NULL DEFAULT 0,
    total_mapped        INTEGER         NOT NULL DEFAULT 0,              -- source rows with a confirmed mapping (non-distinct)
    last_polled_at      TIMESTAMP_NTZ,
    last_queue_empty_at TIMESTAMP_NTZ,                                          -- last time the queue was fully drained
    created_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipelines_source UNIQUE (table_fqn, column_name, domain_id)
);

-- Migrations: run these if you already have data and do not want to DROP/RECREATE:
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS export_table_fqn VARCHAR(1000);
-- ALTER TABLE PIPELINES ADD COLUMN IF NOT EXISTS total_mapped INTEGER NOT NULL DEFAULT 0;

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
    literal_value   VARCHAR         NOT NULL,
    detected_at     TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipeline_queue UNIQUE (pipeline_id, literal_value)
);

CREATE OR REPLACE TABLE RUNS (
    run_id          INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_key     VARCHAR(500)    NOT NULL DEFAULT 'mobile_carrier',
    source_relation VARCHAR(1000)   NOT NULL DEFAULT '__unknown__',
    source_column   VARCHAR(500)    NOT NULL DEFAULT '__unknown__',
    domain_id       INTEGER         REFERENCES DOMAINS(domain_id),
    mode            VARCHAR(50)     NOT NULL DEFAULT 'review',
    run_status      VARCHAR(50)     NOT NULL DEFAULT 'created',
    state           VARIANT,
    stats_snapshot  VARIANT,
    -- Used to retrieve the auto-assigned run_id immediately after INSERT.
    creation_nonce  VARCHAR(200),
    created_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at      TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

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
    alias_id        INTEGER         NOT NULL
                                    REFERENCES APPROVED_ALIAS_NAMES(alias_id)
                                    ON DELETE RESTRICT,
    domain_id       INTEGER         REFERENCES DOMAINS(domain_id),  -- denormalized copy from alias
    run_id          INTEGER         NOT NULL
                                    REFERENCES RUNS(run_id),
    confirmed_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

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
