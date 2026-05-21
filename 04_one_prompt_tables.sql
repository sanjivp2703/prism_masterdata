USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

-- ============================================================================
-- ONE-PROMPT CLASSIFICATION TABLES
-- ONE_PROMPT_RUNS is the sole run table for this pipeline — it stores both run
-- metadata (source, concept, status) and the full grouping state blob.
-- The legacy RUNS, RUN_ITEMS, and RUN_GROUPS tables are no longer used.
-- ============================================================================

-- Drop dependent tables first (FK order), then the run table.
DROP TABLE IF EXISTS ONE_PROMPT_LITERAL_ALIAS_MATCHES;
DROP TABLE IF EXISTS ONE_PROMPT_VALIDATION_LOG;
DROP TABLE IF EXISTS ONE_PROMPT_RUN_STATE;   -- legacy; superseded by ONE_PROMPT_RUNS
DROP TABLE IF EXISTS ONE_PROMPT_RUNS;

-- ----------------------------------------------------------------------------
-- ONE_PROMPT_RUNS
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
CREATE OR REPLACE TABLE ONE_PROMPT_RUNS (
    run_id          INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_id      INTEGER         NOT NULL
                                    REFERENCES STAND_DB.STAND_INTERNAL.CONCEPTS(concept_id),
    source_relation VARCHAR(1000)   NOT NULL DEFAULT '__unknown__',
    source_column   VARCHAR(500)    NOT NULL DEFAULT '__unknown__',
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
-- ONE_PROMPT_APPROVED_ALIAS_NAMES
-- Catalog of alias names confirmed through at least one one-prompt export.
-- usage_count is incremented each time the name appears in an export.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_PROMPT_APPROVED_ALIAS_NAMES (
    alias_name    VARCHAR         PRIMARY KEY NOT NULL,
    usage_count   INTEGER         NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMP_NTZ
);

-- ----------------------------------------------------------------------------
-- ONE_PROMPT_LITERAL_ALIAS_MATCHES
-- Confirmed mappings from a raw literal value to a canonical alias name.
-- Used for fast exact-match lookup before any LLM call is made.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_PROMPT_LITERAL_ALIAS_MATCHES (
    literal_value   VARCHAR         PRIMARY KEY NOT NULL,
    alias_name      VARCHAR         NOT NULL,
    run_id          INTEGER         NOT NULL
                                    REFERENCES ONE_PROMPT_RUNS(run_id),
    confirmed_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- ONE_PROMPT_VALIDATION_LOG
-- Audit trail of every LLM validation decision made during post-export cleanup.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_PROMPT_VALIDATION_LOG (
    id                  INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value       VARCHAR         NOT NULL,
    run_id              INTEGER         NOT NULL
                                        REFERENCES ONE_PROMPT_RUNS(run_id),
    original_alias_name VARCHAR         NOT NULL,
    user_changed_to     VARCHAR,
    llm_decision        VARCHAR         NOT NULL,
    decided_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
