USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

-- Deploy order: run 01a_classification_pipeline_functions.sql first (JavaScript
-- UDFs including ENRICH_RULESET_STOPWORDS), then this file (tables, seeds, view
-- ENRICHED_CONCEPT_RULESETS, seed SQL that calls those UDFs).

-- ============================================================================
-- LOOKUP TABLES
-- Reference tables for enumerated values to replace CHECK constraints
-- ============================================================================

-- Data types for semantic concepts
CREATE OR REPLACE TABLE LKP_DATA_TYPE (
    data_type VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_DATA_TYPE (data_type) VALUES
    ('string'),
    ('enum'),
    ('numeric'),
    ('date');

-- Status values for concept aliases
CREATE OR REPLACE TABLE LKP_ALIAS_STATUS (
    status VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_ALIAS_STATUS (status) VALUES
    ('active'),
    ('deprecated'),
    ('inactive');

-- Source types for alias values
CREATE OR REPLACE TABLE LKP_ALIAS_VALUE_SOURCE (
    source VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_ALIAS_VALUE_SOURCE (source) VALUES
    ('run_auto'),
    ('manual_review'),
    ('import');

-- Key types for alias summary entries
CREATE OR REPLACE TABLE LKP_ALIAS_SUMMARY_KEY_TYPE (
    key_type VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_ALIAS_SUMMARY_KEY_TYPE (key_type) VALUES
    ('clean value'),
    ('normalized value'),
    ('token signature'),
    ('normalized token signature'),
    ('alias name'),
    ('alias token signature'),
    ('alias clean value'),
    ('alias normalized value'),
    ('alias normalized token signature');

-- User types
CREATE OR REPLACE TABLE LKP_USER_TYPE (
    user_type VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_USER_TYPE (user_type) VALUES
    ('human'),
    ('service');

-- Run modes
CREATE OR REPLACE TABLE LKP_RUN_MODE (
    mode VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_RUN_MODE (mode) VALUES
    ('preview'),
    ('review'),
    ('auto');

-- Run status values
CREATE OR REPLACE TABLE LKP_RUN_STATUS (
    run_status VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_RUN_STATUS (run_status) VALUES
    ('created'),
    ('running'),
    ('validating'),
    ('completed'),
    ('failed');

-- Decision status values
CREATE OR REPLACE TABLE LKP_DECISION_STATUS (
    decision_status VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_DECISION_STATUS (decision_status) VALUES
    ('pending'),
    ('auto_approved'),
    ('approved'),
    ('overridden'),
    ('rejected');

-- Apply mode values
CREATE OR REPLACE TABLE LKP_APPLY_MODE (
    apply_mode VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_APPLY_MODE (apply_mode) VALUES
    ('new_column'),
    ('overwrite_column'),
    ('view'),
    ('table');

-- Apply status values
CREATE OR REPLACE TABLE LKP_APPLY_STATUS (
    apply_status VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_APPLY_STATUS (apply_status) VALUES
    ('started'),
    ('success'),
    ('partial'),
    ('failed');

-- Entity types for audit log
CREATE OR REPLACE TABLE LKP_ENTITY_TYPE (
    entity_type VARCHAR PRIMARY KEY NOT NULL
);

INSERT INTO LKP_ENTITY_TYPE (entity_type) VALUES
    ('run'),
    ('run_item'),
    ('apply'),
    ('alias'),
    ('alias_value');

-- ============================================================================
-- CLASSIFICATION_METADATA_PROFILES
-- Stores ordered rule pipelines for generating classification metadata.
-- ============================================================================

CREATE OR REPLACE TABLE CLASSIFICATION_METADATA_PROFILES (
    profile_id INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    name VARCHAR NOT NULL,
    version NUMBER NOT NULL,
    ruleset VARIANT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at TIMESTAMP_NTZ NOT NULL,
    CONSTRAINT unique_profile_name_version UNIQUE (name, version)
);

-- Seed: standard profile (v2)
-- Ruleset uses the v2 structure:
--   cleaning.rules    — text-hygiene applied before tokenization while preserving
--                       original casing in cleaned_value and standard tokens.
--   normalization.rules — deterministic rewrites applied after cleaning + tokenization.
--                         cleaned_value is captured before this pass.
--   tokenization      — unchanged; splits the cleaned string into tokens.
--   token_normalization — token-level transforms (number rewrites, stopwords, etc.).
INSERT INTO CLASSIFICATION_METADATA_PROFILES (profile_id, name, version, ruleset, is_active, created_at, updated_at)
SELECT
  1,
  'standard',
  2,
  PARSE_JSON('{
   "cleaning": {
     "rules": [
       {"name": "unicode_nfkc", "enabled": false},
       {"name": "remove_invisible_format", "enabled": false},
       {"name": "diacritics_fold_latin", "enabled": false},

       {"name": "strip_emojis_pictographs", "enabled": false},
       {"name": "drop_ampersands", "enabled": false},
       {"name": "drop_apostrophes", "enabled": true, "params": {"mode": "remove"}},
       {"name": "drop_punctuation_runs_len_ge_2", "enabled": true},

       {"name": "slash_to_space", "enabled": false},
       {"name": "underscore_to_space", "enabled": false},
       {"name": "normalize_whitespace_to_space", "enabled": false},
       {"name": "normalize_ampersands", "enabled": false},
       {"name": "normalize_at", "enabled": false},
       {"name": "normalize_quotes", "enabled": false},
       {"name": "brackets_to_space", "enabled": false},
       {"name": "punctuation_to_space", "enabled": true, "params": {"include_symbols": true, "protected_patterns": []}},
       {"name": "collapse_internal_spaces", "enabled": true},

       {"name": "trim", "enabled": true}
     ]
   },
   "normalization": {
     "rules": [
       {"name": "deterministic_rewrites", "enabled": false, "params": {"map": {}}},
       {"name": "number_word_digit_rewrite", "enabled": true, "params": {"words_to_numeric": false}},
       {"name": "stopword_removal", "enabled": true, "params": {
         "enabled": [],
         "sets": {
           "carriers":          ["wireless", "cellular", "mobile", "communications", "telecom"],
           "generic":           ["the", "a", "an", "and", "of", "for", "to", "in", "on", "by", "from"],
           "corporate_suffixes":["inc", "llc", "ltd", "corp", "co", "company", "gmbh", "plc", "lp", "llp", "sa", "sarl", "bv", "nv", "ag", "kg", "pte", "pty", "incorporated", "corporation", "limited"],
           "domain_suffixes":   ["com", "net", "org", "io", "co"],
           "noise_words":       ["unknown", "n/a", "na", "none", "null", "test", "sample"],
           "units":             ["kg", "lbs", "lb", "oz", "g", "mg", "l", "ml", "cm", "mm", "m", "km", "ft", "in"]
         }
       }}
     ]
   },
   "tokenization": {
     "config": {
       "parallel": {},
       "post": {
         "token_deduplication": false,
         "max_token_frequency": null
       }
     },
     "rules": [
       {"name": "word_tokenize", "enabled": true},
       {"name": "split_alpha_numeric_boundary", "enabled": true},
       {"name": "split_camel_pascal", "enabled": true},
       {"name": "preserve_important_separators", "enabled": false, "params": {"patterns": ["[A-Za-z]{2,}-\\\\d+"], "flags": "giu"}}
     ]
   },
   "token_normalization": {
     "config": {
       "parallel": {
         "do_not_touch": {
           "enabled": [],
           "sets": {
             "default": ["sample do not touch"]
           }
         }
       },
       "post": {
         "token_deduplication": true,
         "max_token_frequency": 3
       }
     },
     "rules": [
       {"name": "digit_grouping_normalization", "enabled": false},
       {"name": "number_word_digit_rewrite", "enabled": true, "params": {"words_to_numeric": false}},
       {"name": "collapse_repeated_letters", "enabled": false},
       {"name": "join_tokens", "enabled": false, "params": {"separator": ""}}
     ]
   }
 }'),
  TRUE,
  CURRENT_TIMESTAMP(),
  CURRENT_TIMESTAMP()
WHERE NOT EXISTS (
  SELECT 1
  FROM CLASSIFICATION_METADATA_PROFILES p
  WHERE p.profile_id = 1
);

-- ============================================================================
-- CONCEPTS
-- Stores semantic concepts used across runs and aliasing
-- ============================================================================

CREATE OR REPLACE TABLE CONCEPTS (
    concept_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_key VARCHAR NOT NULL,
    description VARCHAR,
    data_type VARCHAR NOT NULL,
    profile_id INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT unique_concept_key UNIQUE (concept_key),
    CONSTRAINT fk_concepts_data_type FOREIGN KEY (data_type) REFERENCES LKP_DATA_TYPE(data_type),
    CONSTRAINT fk_concepts_profile FOREIGN KEY (profile_id) REFERENCES CLASSIFICATION_METADATA_PROFILES(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- ============================================================================
-- LKP_STOPWORDS
-- Table-driven stopword lists with two-tier scoping:
--
--   concept_id IS NULL  →  generic stopwords  (applied to every run/concept)
--   concept_id = N      →  concept-specific   (applied only when the run
--                           belongs to concept N)
--
-- Words are merged into the pipeline ruleset at run time via
-- ENRICH_RULESET_STOPWORDS (01a) and view ENRICHED_CONCEPT_RULESETS (below).
-- The inline word lists that remain in CLASSIFICATION_METADATA_PROFILES.ruleset.params.sets
-- are fallback when LKP_STOPWORDS is empty (see ENRICH_RULESET_STOPWORDS JS).
-- ============================================================================

CREATE OR REPLACE TABLE LKP_STOPWORDS (
    stopword_id INTEGER AUTOINCREMENT PRIMARY KEY,
    word        VARCHAR NOT NULL,
    concept_id  INTEGER,   -- NULL = generic; set = concept-specific
    created_at  TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT unique_stopword UNIQUE (word, concept_id)
);

-- ============================================================================
-- CONCEPT_COMPATIBILITY
-- Pairwise similarity score between two concepts, in [0, 1].
-- concept_low_id must be strictly less than concept_high_id so each pair
-- has exactly one canonical row (no duplicates, no self-joins).
-- ============================================================================

CREATE OR REPLACE TABLE CONCEPT_COMPATIBILITY (
    concept_compatibility_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_low_id           INTEGER NOT NULL,
    concept_high_id          INTEGER NOT NULL,
    compatibility_score      FLOAT   NOT NULL,
    created_at               TIMESTAMP NOT NULL,
    updated_at               TIMESTAMP NOT NULL,
    CONSTRAINT chk_concept_compatibility_order  CHECK (concept_low_id < concept_high_id),
    CONSTRAINT chk_concept_compatibility_score  CHECK (compatibility_score >= 0 AND compatibility_score <= 1),
    CONSTRAINT unique_concept_compatibility_pair UNIQUE (concept_low_id, concept_high_id),
    CONSTRAINT fk_concept_compatibility_low  FOREIGN KEY (concept_low_id)  REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_concept_compatibility_high FOREIGN KEY (concept_high_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Seed: mobile_carrier (1) ↔ company_name (2) — moderately similar concepts.
INSERT INTO CONCEPT_COMPATIBILITY (concept_low_id, concept_high_id, compatibility_score, created_at, updated_at)
SELECT 1, 2, 0.75, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
WHERE NOT EXISTS (
    SELECT 1 FROM CONCEPT_COMPATIBILITY WHERE concept_low_id = 1 AND concept_high_id = 2
);

-- ============================================================================
-- ALIASES
-- Stores standardized alias values for each concept
-- ============================================================================

CREATE OR REPLACE TABLE ALIASES (
    alias_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_id INTEGER NOT NULL,
    -- alias_name_literal_value is the canonical human-readable name; preserve source capitalization.
    alias_name_literal_value VARCHAR NOT NULL,
    -- alias_name_normalization_value is alias_name_literal_value after pretokenization normalization
    -- (normalization_value from pipeline). Comparisons are case-insensitive in the scoring layer;
    -- this value preserves pipeline casing.
    alias_name_normalization_value VARCHAR,
    -- alias_name_clean_value is alias_name_literal_value after the cleaning pass only
    -- (cleaned_value from pipeline), before normalization rules (stopword removal, etc.).
    -- Mirrors cleaned_value on ALIAS_ITEMS.
    alias_name_clean_value VARCHAR,
    -- alias_name_normalized_tokens / alias_name_normalized_tokens_count: normalized token array
    -- from the pipeline applied to alias_name_literal_value (same token_normalization rules as
    -- ALIAS_ITEMS.normalized_tokens).
    alias_name_normalized_tokens VARIANT,
    alias_name_normalized_tokens_count NUMBER,
    alias_subgroup_id INTEGER NOT NULL,
    status VARCHAR NOT NULL,
    -- Tokenization of alias_name_literal_value via the concept's classification ruleset
    -- (same pipeline as alias items).
    alias_name_tokens VARIANT,
    alias_name_tokens_count NUMBER,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_aliases_concept FOREIGN KEY (concept_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_aliases_status FOREIGN KEY (status) REFERENCES LKP_ALIAS_STATUS(status),
    CONSTRAINT unique_concept_alias UNIQUE (concept_id, alias_name_literal_value, alias_subgroup_id)
);

-- ============================================================================
-- ALIAS_SUMMARY
-- Stores summary keys for an alias across value/metadata representations.
-- ============================================================================

CREATE OR REPLACE TABLE ALIAS_SUMMARY (
    alias_summary_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_id INTEGER NOT NULL,
    concept_id INTEGER NOT NULL,
    key_type VARCHAR NOT NULL,
    key_value VARCHAR NOT NULL,
    count NUMBER,
    importance_score FLOAT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_alias_summary_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_alias_summary_concept FOREIGN KEY (concept_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_alias_summary_key_type FOREIGN KEY (key_type) REFERENCES LKP_ALIAS_SUMMARY_KEY_TYPE(key_type),
    CONSTRAINT unique_alias_summary_key UNIQUE (alias_id, key_type, key_value)
);

-- ============================================================================
-- CLASSIFICATION METADATA GENERATION (UDF)
-- Moved out to keep this file readable.
-- Running `snowsql -f 01_internal_tables.sql` still works because SnowSQL executes !source inline.
-- ============================================================================

!source 01a_classification_pipeline_functions.sql

-- ============================================================================
-- ALIAS_ITEMS
-- Stores observed literal values and their validated alias mapping + derived classification metadata
-- Classification metadata is embedded directly in each alias item row.
-- ============================================================================

CREATE OR REPLACE TABLE ALIAS_ITEMS (
    alias_item_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    -- Always associated to an alias (validation UI ensures every item is grouped before approval).
    alias_id INTEGER NOT NULL,
    profile_id INTEGER NOT NULL,
    literal_value VARCHAR NOT NULL,
    -- cleaned_value: output of the pre-tokenization normalization pass only (before tokenization
    -- and post-tokenization rules). Used for 'clean value' alias summary entries and step-1 matching.
    cleaned_value VARCHAR,
    normalization_value VARCHAR,
    tokens VARIANT,
    tokens_count NUMBER,
    normalized_tokens VARIANT,
    normalized_tokens_count NUMBER,
    confidence FLOAT,
    source VARCHAR NOT NULL,
    approved BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_alias_items_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_alias_items_profile FOREIGN KEY (profile_id) REFERENCES CLASSIFICATION_METADATA_PROFILES(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_alias_items_source FOREIGN KEY (source) REFERENCES LKP_ALIAS_VALUE_SOURCE(source),
    CONSTRAINT unique_profile_literal_value UNIQUE (profile_id, literal_value)
);

-- ============================================================================
-- TOKENS_SUMMARY
-- Per-token rows: token_type = standard | normalized (from ALIAS_ITEMS) or alias (from ALIASES.alias_name_tokens).
-- Refreshed by REFRESH_TOKENS_SUMMARY (same targeting pattern as REFRESH_ALIAS_SUMMARY).
-- ============================================================================

CREATE OR REPLACE TABLE TOKENS_SUMMARY (
    tokens_summary_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    token VARCHAR NOT NULL,
    position_in_signature INTEGER NOT NULL,
    -- standard / normalized: from ALIAS_ITEMS; alias: from ALIASES.alias_name_tokens (alias_item_id NULL).
    alias_item_id INTEGER,
    alias_id INTEGER,
    signature_length INTEGER NOT NULL,
    rarity FLOAT NOT NULL DEFAULT 0,
    token_type VARCHAR NOT NULL,
    importance_score FLOAT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_tokens_summary_alias_item FOREIGN KEY (alias_item_id) REFERENCES ALIAS_ITEMS(alias_item_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_tokens_summary_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE CASCADE
    -- token_type values: 'standard' | 'normalized' (alias_item_id set, alias_id NULL)
    --                    'alias'                   (alias_id set, alias_item_id NULL)
);

-- ============================================================================
-- ALIAS_TOKEN_COUNT
-- One row per unique normalized token across all aliases.
-- global_count = number of distinct aliases that contain this token,
-- used as the IDF denominator when computing token importance scores.
-- ============================================================================

CREATE OR REPLACE TABLE ALIAS_TOKEN_COUNT (
    alias_token_count_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_id             INTEGER NOT NULL,
    normalized_token     VARCHAR NOT NULL,
    -- Number of distinct alias items in this alias that contain this normalized token (TF component).
    token_count          INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at           TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT unique_alias_token_count_alias_token UNIQUE (alias_id, normalized_token),
    CONSTRAINT fk_alias_token_count_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE CASCADE
);

-- ============================================================================
-- GLOBAL_TOKEN_COUNT
-- One row per unique normalized token across the entire system.
-- alias_count = number of distinct aliases that contain this token.
-- ============================================================================

CREATE OR REPLACE TABLE GLOBAL_TOKEN_COUNT (
    global_token_count_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_id            INTEGER NOT NULL,
    normalized_token      VARCHAR NOT NULL,
    -- Number of distinct aliases in this concept that contain this normalized token (IDF component).
    alias_token_count     INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at            TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT unique_global_token_count_concept_token UNIQUE (concept_id, normalized_token),
    CONSTRAINT fk_global_token_count_concept FOREIGN KEY (concept_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- ============================================================================
-- USERS
-- Stores user and service account information
-- ============================================================================

CREATE OR REPLACE TABLE USERS (
    user_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    snowflake_user VARCHAR,
    display_name VARCHAR NOT NULL,
    user_type VARCHAR NOT NULL,
    is_active BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_users_user_type FOREIGN KEY (user_type) REFERENCES LKP_USER_TYPE(user_type),
    CONSTRAINT unique_snowflake_user UNIQUE (snowflake_user)
);

-- ============================================================================
-- RUNS
-- Stores run lifecycle information
-- ============================================================================

CREATE OR REPLACE TABLE RUNS (
    run_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    concept_id INTEGER NOT NULL,
    source_relation VARCHAR NOT NULL,
    source_column VARCHAR NOT NULL,
    mode VARCHAR NOT NULL,
    run_status VARCHAR NOT NULL,
    -- If TRUE, this run should appear in the Admin "Run Validation" list even after completion.
    -- (Used when a reviewer exports with "Send for approval".)
    requires_validation BOOLEAN NOT NULL DEFAULT FALSE,
    stats_snapshot VARIANT,
    -- Snapshot of concept compatibility weights at the moment this run was created.
    -- Maps concept_id (as string key) → compatibility_score [0,1].
    -- The run's own concept is always included with weight 1.0.
    -- Populated by CREATE_RUN and lives only for the lifespan of the run row.
    concept_weights VARIANT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message VARCHAR,
    CONSTRAINT fk_runs_created_by FOREIGN KEY (created_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_runs_concept FOREIGN KEY (concept_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_runs_mode FOREIGN KEY (mode) REFERENCES LKP_RUN_MODE(mode),
    CONSTRAINT fk_runs_status FOREIGN KEY (run_status) REFERENCES LKP_RUN_STATUS(run_status)
);

-- ============================================================================
-- RUN_GROUPS
-- Stores groupings of items within a run
-- ============================================================================

CREATE OR REPLACE TABLE RUN_GROUPS (
    run_id INTEGER NOT NULL,
    group_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 NOT NULL,
    initial_alias_name VARCHAR NOT NULL,
    alias_name_literal_value VARCHAR,
    final_alias_id INTEGER,
    is_user_created BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT pk_run_groups PRIMARY KEY (run_id, group_id),
    CONSTRAINT fk_run_groups_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_groups_final_alias FOREIGN KEY (final_alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    -- alias_name_literal_value is no longer unique per run because multiple subgroups of the same alias may
    -- appear as separate groups within a single run (same alias_name_literal_value, different final_alias_id).
    CONSTRAINT unique_run_final_alias UNIQUE (run_id, final_alias_id)
);

-- ============================================================================
-- RUN_ITEMS
-- Stores decision items for each run
-- ============================================================================

CREATE OR REPLACE TABLE RUN_ITEMS (
    run_item_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    run_id INTEGER NOT NULL,
    group_id INTEGER,
    -- literal_value is the exact string as submitted from the source (displayed in the UI
    -- and used as the key for de-duplication / matching).
    literal_value VARCHAR NOT NULL,
    -- cleaned_value: output of the pre-tokenization normalization pass only (before tokenization
    -- and post-tokenization rules). Used for 'clean value' alias summary entries and step-1 matching.
    cleaned_value VARCHAR,
    -- Classification metadata is embedded directly in each run item row.
    -- normalization_value: cleaned_value after the post-tokenization normalization rules
    -- (stopword removal, etc.). Populated by APPLY_CLASSIFICATION_PIPELINE.
    normalization_value VARCHAR,
    tokens VARIANT,
    tokens_count NUMBER,
    normalized_tokens VARIANT,
    normalized_tokens_count NUMBER,
    confidence_score FLOAT,
    -- LLM-produced confidence fields (populated by apply-confident-assignments when model scoring is enabled).
    -- confidence_reasoning: one-sentence explanation from the LLM; NULL when confidence < 0.05.
    confidence_reasoning VARCHAR,
    -- confidence_flags: controlled-vocabulary flags describing what drove the decision (VARIANT array of strings).
    confidence_flags VARIANT,
    -- model_used: identifier of the model that produced confidence_score (e.g. 'claude-sonnet-4-6').
    --             Stored for traceability across future model migrations.
    model_used VARCHAR,
    -- deterministic_score_baseline: original formula score (0.51*M + 0.20*TS + 0.12*SS + 0.17*AC)
    --                                stored alongside the LLM score for monitoring / disagreement tracking.
    --                                Never sent to the LLM.
    deterministic_score_baseline FLOAT,
    decision_status VARCHAR NOT NULL,
    decided_by INTEGER,
    decided_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_run_items_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_items_group FOREIGN KEY (run_id, group_id) REFERENCES RUN_GROUPS(run_id, group_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_items_decided_by FOREIGN KEY (decided_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_run_items_decision_status FOREIGN KEY (decision_status) REFERENCES LKP_DECISION_STATUS(decision_status),
    -- One row per observed source string for a run (keyed on literal_value).
    CONSTRAINT unique_run_item UNIQUE (run_id, literal_value)
);

-- ============================================================================
-- RUN_STEP_TIMINGS
-- Wall-clock duration of every named step inside CREATE_RUN.
-- Used to identify performance bottlenecks across runs.
-- ============================================================================

CREATE OR REPLACE TABLE RUN_STEP_TIMINGS (
    timing_id   INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    run_id      INTEGER NOT NULL,
    step_name   VARCHAR NOT NULL,
    started_at  TIMESTAMP_NTZ NOT NULL,
    ended_at    TIMESTAMP_NTZ NOT NULL,
    duration_ms NUMBER NOT NULL,
    CONSTRAINT fk_step_timings_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id)
        ON UPDATE RESTRICT ON DELETE CASCADE
);

-- ============================================================================
-- RUN_APPLIED_TARGETS
-- Stores information about applying run results
-- ============================================================================

CREATE OR REPLACE TABLE RUN_APPLIED_TARGETS (
    apply_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    run_id INTEGER NOT NULL,
    applied_by INTEGER NOT NULL,
    apply_started_at TIMESTAMP NOT NULL,
    apply_completed_at TIMESTAMP,
    apply_mode VARCHAR NOT NULL,
    target_relation VARCHAR NOT NULL,
    apply_status VARCHAR NOT NULL,
    apply_config_snapshot VARIANT,
    error_message VARCHAR,
    rows_affected INTEGER,
    cols_affected INTEGER,
    CONSTRAINT fk_applied_targets_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_applied_targets_applied_by FOREIGN KEY (applied_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_applied_targets_apply_mode FOREIGN KEY (apply_mode) REFERENCES LKP_APPLY_MODE(apply_mode),
    CONSTRAINT fk_applied_targets_apply_status FOREIGN KEY (apply_status) REFERENCES LKP_APPLY_STATUS(apply_status)
);

-- ============================================================================
-- AUDIT_LOG
-- Stores audit trail of all system actions
-- ============================================================================

CREATE OR REPLACE TABLE AUDIT_LOG (
    audit_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    entity_type VARCHAR NOT NULL,
    entity_id VARCHAR NOT NULL,
    action VARCHAR NOT NULL,
    performed_by INTEGER NOT NULL,
    performed_at TIMESTAMP NOT NULL,
    run_id INTEGER,
    details VARIANT,
    CONSTRAINT fk_audit_log_performed_by FOREIGN KEY (performed_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_audit_log_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_audit_log_entity_type FOREIGN KEY (entity_type) REFERENCES LKP_ENTITY_TYPE(entity_type)
);

-- Insert a sample user
INSERT INTO STAND_DB.STAND_INTERNAL.USERS (
  user_id, snowflake_user, display_name, user_type, is_active, created_at, updated_at
) VALUES (
  1,
  'SANJIVP2703',
  'Sanjiv Parthasarathy',
  'human',
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- ============================================================================
-- -- SAMPLE DATA: Mobile Carrier Semantic Concept
-- -- ============================================================================

-- Insert semantic concept for mobile carriers
INSERT INTO CONCEPTS (concept_id, concept_key, description, data_type, profile_id, is_active, created_at, updated_at)
VALUES (1, 'mobile_carrier', 'Names of mobile carriers and wireless service providers.', 'string', 1, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ── LKP_STOPWORDS seed ────────────────────────────────────────────────────────
-- Generic words (concept_id IS NULL) apply to every run regardless of concept.
INSERT INTO LKP_STOPWORDS (word, concept_id)
SELECT word, NULL FROM (VALUES
  ('the'), ('a'), ('an'), ('and'), ('of'),
  ('for'), ('to'), ('in'), ('on'), ('by'), ('from')
) AS v (word)
WHERE NOT EXISTS (SELECT 1 FROM LKP_STOPWORDS WHERE word = v.word AND concept_id IS NULL);

-- Concept 1 (mobile_carrier) specific stopwords.
INSERT INTO LKP_STOPWORDS (word, concept_id)
SELECT word, 1 FROM (VALUES
  ('wireless'), ('cellular'), ('mobile'), ('communications'), ('telecom')
) AS v (word)
WHERE NOT EXISTS (SELECT 1 FROM LKP_STOPWORDS WHERE word = v.word AND concept_id = 1);

-- ============================================================================
-- ENRICHED_CONCEPT_RULESETS (view)
-- One row per concept with enriched_ruleset VARIANT (LKP_STOPWORDS merged into
-- the profile ruleset). Requires ENRICH_RULESET_STOPWORDS UDF from
-- 01a_classification_pipeline_functions.sql — deploy functions before this file.
--
-- COALESCE on generic words matches CREATE_RUN when LKP_STOPWORDS has no
-- generic rows (ARRAY_AGG returns NULL).
-- ============================================================================
CREATE OR REPLACE VIEW STAND_DB.STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS AS
SELECT
    c.concept_id,
    c.profile_id,
    STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
        p.ruleset,
        g.generic_words,
        COALESCE(cs.concept_words, ARRAY_CONSTRUCT())
    ) AS enriched_ruleset
FROM STAND_DB.STAND_INTERNAL.CONCEPTS c
JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p
  ON p.profile_id = c.profile_id
CROSS JOIN (
    SELECT COALESCE(
        (SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL),
        ARRAY_CONSTRUCT()
    ) AS generic_words
) g
LEFT JOIN (
    SELECT concept_id, ARRAY_AGG(word) AS concept_words
    FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS
    WHERE concept_id IS NOT NULL
    GROUP BY concept_id
) cs ON cs.concept_id = c.concept_id;

-- -- Insert concept aliases for mobile carriers
-- -- NOTE: Using explicit alias_id values for sample data to ensure referential integrity
-- -- The sequence will be synchronized after all sample data is inserted
-- alias_name_normalization_value computed via the standard normalization pipeline; comparisons are case-insensitive.
INSERT INTO ALIASES (alias_id, concept_id, alias_name_literal_value, alias_name_normalization_value, alias_subgroup_id, status, created_at, updated_at)
SELECT v.alias_id, v.concept_id, v.alias_name_literal_value,
       STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
           v.alias_name_literal_value,
           STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
               p.ruleset,
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = v.concept_id), ARRAY_CONSTRUCT())
           )
       ):normalization_value::VARCHAR,
       v.alias_subgroup_id, v.status, v.created_at, v.updated_at
FROM (VALUES
    (1, 1, 'AT&T',              1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (2, 1, 'Verizon',           1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 1, 'T-Mobile',          1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (4, 1, 'Sprint',            1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (5, 1, 'Boost Mobile',      1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (6, 1, 'Cricket Wireless',  1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (7, 1, 'Metro by T-Mobile', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 1, 'US Cellular',       1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
--     (9, 1, 'MetroPCS',          1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
) AS v (alias_id, concept_id, alias_name_literal_value, alias_subgroup_id, status, created_at, updated_at)
JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = v.concept_id
JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p ON p.profile_id = c.profile_id;

-- -- Insert classification metadata for AT&T (alias_id = 1)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (1, 1, 'AT&T', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (2, 1, 'ATT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (4, 1, 'AmericanTelephoneandTelegraph', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (5, 1, 'AmericanTelephone&TelegraphCompany', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (6, 1, 'ATandT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for Verizon (alias_id = 2)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (7, 1, 'Verizon', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (8, 1, 'VerizonWireless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (9, 1, 'VerizonWirless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (10, 1, 'VZW', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (11, 1, 'VerizonCommunications', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for T-Mobile (alias_id = 3)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (12, 1, 'T-Mobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (14, 1, 'TMobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (15, 1, 'T-MobileUSA', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for Sprint (alias_id = 4)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (16, 1, 'Sprint', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (17, 1, 'SprintPCS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for Boost Mobile (alias_id = 5)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (18, 1, 'BoostMobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (19, 1, 'Boost', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for Cricket Wireless (alias_id = 6)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (20, 1, 'Cricket', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (21, 1, 'CricketWireless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for Metro by T-Mobile (alias_id = 7)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     -- All Metro variants normalize to the same canonical value
--     (22, 1, 'MetroPCS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (23, 1, 'MetrobyT-Mobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert classification metadata for US Cellular (alias_id = 8)
--  INSERT INTO CLASSIFICATION_METADATA (classification_metadata_id, profile_id, normalization_value, created_at, updated_at)
-- VALUES 
--     (25, 1, 'USCellular', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);


-- -- ============================================================================
-- -- SAMPLE RAW VALUE VARIANTS
-- -- Maps raw observed values to their normalized counterparts
-- -- Each raw value maps to its own normalized value (1:1 mapping)
-- -- ============================================================================

-- -- Insert raw values for AT&T (mapping to classification_metadata_id 1-6)
-- TEMPORARILY DISABLED: manual ALIAS_ITEMS sample seeds
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (1, 1, 1, 'AT&T', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (2, 1, 1, 'ATT', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (3, 1, 1, 'A T & T', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (4, 1, 1, 'American Telephone and Telegraph', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (5, 1, 1, 'American Telephone & Telegraph Company', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (6, 1, 1, 'AT and T', 80, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Verizon (mapping to classification_metadata_id 7-11)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (7, 2, 1, 'Verizon', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (8, 2, 1, 'Verizon Wireless', 93, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (9, 2, 1, 'Verizon Wirless', 70, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (10, 2, 1, 'VZW', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (11, 2, 1, 'Verizon Communications', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for T-Mobile (mapping to classification_metadata_id 12-15)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (12, 3, 1, 'T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (13, 3, 1, 'T Mobile', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (14, 3, 1, 'TMobile', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (15, 3, 1, 'T-Mobile USA', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Sprint (mapping to classification_metadata_id 16-17)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (16, 4, 1, 'Sprint', 94, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (17, 4, 1, 'Sprint PCS', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Boost Mobile (mapping to classification_metadata_id 18-19)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (18, 5, 1, 'Boost Mobile', 96, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (19, 5, 1, 'Boost', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Cricket Wireless (mapping to classification_metadata_id 20-21)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (20, 6, 1, 'Cricket', 87, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (21, 6, 1, 'Cricket Wireless', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Metro
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     -- MetroPCS raw value maps to alias 'MetroPCS'
--     (22, 9, 1, 'MetroPCS', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     -- "Metro PCS" (space) normalizes to "MetroPCS"
--     (23, 9, 1, 'Metro PCS', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     -- Metro by T-Mobile raw value maps to alias 'Metro by T-Mobile'
--     (24, 7, 1, 'Metro by T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for US Cellular (mapping to classification_metadata_id 25)
-- INSERT INTO ALIAS_ITEMS (
--     alias_item_id, alias_id, profile_id, literal_value, confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--     (25, 8, 1, 'US Cellular', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Populate classification fields on sample ALIAS_ITEMS so ALIAS_SUMMARY can include
-- normalized value, tokens, token signatures, normalized tokens, and normalized token signatures.
UPDATE ALIAS_ITEMS rv
SET
  cleaned_value = sub.pipeline:cleaned_value::VARCHAR,
  normalization_value = sub.pipeline:normalization_value::VARCHAR,
  tokens = sub.pipeline:tokens,
  tokens_count = sub.pipeline:tokens_count::NUMBER,
  normalized_tokens = sub.pipeline:normalized_tokens,
  normalized_tokens_count = sub.pipeline:normalized_tokens_count::NUMBER,
  updated_at = CURRENT_TIMESTAMP()
FROM (
  SELECT
    rv2.alias_item_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
        rv2.literal_value,
        STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
            prof.ruleset,
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = a.concept_id), ARRAY_CONSTRUCT())
        )
    ) AS pipeline
  FROM ALIAS_ITEMS rv2
  JOIN STAND_DB.STAND_INTERNAL.ALIASES a ON a.alias_id = rv2.alias_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof
    ON prof.profile_id = rv2.profile_id
  WHERE rv2.alias_item_id BETWEEN 1 AND 25
) sub
WHERE rv.alias_item_id = sub.alias_item_id;

-- Populate all pipeline-derived fields on canonical alias names (concept_id = 1).
-- alias_name_normalization_value = normalization_value; alias_name_clean_value = cleaned_value (pre-normalization);
-- alias_name_normalized_tokens = post-token-normalization token array (mirrors ALIAS_ITEMS pattern).
UPDATE ALIASES a
SET
  alias_name_normalization_value     = sub.pipeline:normalization_value::VARCHAR,
  alias_name_clean_value             = sub.pipeline:cleaned_value::VARCHAR,
  alias_name_normalized_tokens       = sub.pipeline:normalized_tokens,
  alias_name_normalized_tokens_count = sub.pipeline:normalized_tokens_count::NUMBER,
  alias_name_tokens                  = sub.pipeline:tokens,
  alias_name_tokens_count            = sub.pipeline:tokens_count::NUMBER,
  updated_at                         = CURRENT_TIMESTAMP()
FROM (
  SELECT
    a2.alias_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
        a2.alias_name_literal_value,
        STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
            prof.ruleset,
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = c.concept_id), ARRAY_CONSTRUCT())
        )
    ) AS pipeline
  FROM ALIASES a2
  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof ON prof.profile_id = c.profile_id
  WHERE a2.concept_id = 1
) sub
WHERE a.alias_id = sub.alias_id;

-- ============================================================================
-- SAMPLE ALIAS_SUMMARY DATA (manual seed — matches UI / worksheet snapshot)
-- Not derived from ALIAS_ITEMS. Re-run safe: clears concept_id = 1 summary rows first.
-- ============================================================================

-- TEMPORARILY DISABLED: manual ALIAS_SUMMARY sample seed reset
-- DELETE FROM ALIAS_SUMMARY WHERE concept_id = 1;


-- INSERT INTO ALIAS_SUMMARY (
--   alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at
-- )
-- VALUES
/*
  -- alias name
  (1, 1, 'alias name', 'AT&T', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'alias name', 'Verizon', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'alias name', 'Boost Mobile', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'alias name', 'T-Mobile', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'alias name', 'Sprint', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'alias name', 'Cricket Wireless', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (9, 1, 'alias name', 'MetroPCS', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'alias name', 'US Cellular', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- clean value (cleaned_value: output of the cleaning pass, pre-tokenization and pre-normalization)
--   (2, 1, 'clean value', 'Verizon Wirless',  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'clean value', 'ATT',              1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'clean value', 'Verizon',          1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'clean value', 'US Cellular',      1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 'T Mobile' and 'T-Mobile' both clean to 'T Mobile'; merged into one row (count=2)
  (3, 1, 'clean value', 'T Mobile',         2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'clean value', 'Cricket',          1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'clean value', 'AT T',             1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'clean value', 'Verizon Wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'clean value', 'Sprint',           1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 'MetroPCS' and 'Metro PCS' clean equivalently; comparisons are case-insensitive.
--   (9, 1, 'clean value', 'Metro PCS',        2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'clean value', 'Boost Mobile',     1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'clean value', 'A T T',            1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- normalized value (normalization_value: string after stopword_removal on cleaned_value)
  -- alias 1 AT&T:
--   rv1 "AT&T"    cleaned="AT T"  → stopword removes "AT"  → normalization_value="T"
--   rv2 "ATT"     cleaned="ATT"   → no stopwords           → normalization_value="ATT"
--   rv3 "A T & T" cleaned="A T T" → stopword removes "A"   → normalization_value="T T"
  (1, 1, 'normalized value', 'T',   1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized value', 'ATT', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized value', 'T T', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 2 Verizon:
  --   rv7 "Verizon"          → "verizon"
  --   rv8 "Verizon Wireless" → stopword removes "wireless" → "verizon"
  --   rv9 "Verizon Wirless"  → "wirless" not a stopword    → "verizon wirless"
--   (2, 1, 'normalized value', 'Verizon',         2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'normalized value', 'Verizon Wirless',  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 3 T-Mobile:
  --   rv12 "T-Mobile"  cleaned="t mobile" → stopword removes "mobile" → "t"
  --   rv13 "T Mobile"  cleaned="t mobile" → stopword removes "mobile" → "t"
  (3, 1, 'normalized value', 'T', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 4 Sprint
  (4, 1, 'normalized value', 'Sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 5 Boost Mobile:
  --   rv18 "Boost Mobile" cleaned="boost mobile" → stopword removes "mobile" → "boost"
  (5, 1, 'normalized value', 'Boost', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 6 Cricket
  (6, 1, 'normalized value', 'Cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 8 US Cellular:
  --   rv25 "US Cellular" cleaned="us cellular" → stopword removes "cellular" → "us"
  (8, 1, 'normalized value', 'US', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 9 MetroPCS:
  --   rv22 "MetroPCS"  split_camel_pascal → "Metro PCS" cleaned="metro pcs" → no stopwords → "metro pcs"
  --   rv23 "Metro PCS" cleaned="metro pcs" → no stopwords → "metro pcs"
--   (9, 1, 'normalized value', 'Metro PCS', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- token signature (pipe-joined standard tokens per alias item; aligned with pipeline)
  -- alias 1 AT&T:  rv1→"AT|T"  rv2→"ATT"  rv3→"A|T|T"
  (1, 1, 'token signature', 'AT|T', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'token signature', 'ATT',  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'token signature', 'A|T|T',1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 2 Verizon: rv7→"verizon"  rv8→"verizon|wireless"  rv9→"verizon|wirless"
--   (2, 1, 'token signature', 'Verizon',          1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'token signature', 'Verizon|Wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'token signature', 'Verizon|Wirless',  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 3 T-Mobile: rv12→"T|Mobile"  rv13→"T|Mobile"
  (3, 1, 'token signature', 'T|Mobile', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 4 Sprint: rv16→"sprint"
  (4, 1, 'token signature', 'Sprint',   1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 5 Boost Mobile: rv18→"boost|mobile"
  (5, 1, 'token signature', 'Boost|Mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 6 Cricket: rv20→"cricket"
  (6, 1, 'token signature', 'Cricket',  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 8 US Cellular: rv25→"us|cellular"
  (8, 1, 'token signature', 'US|Cellular', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 9 MetroPCS: rv22→"metro|pcs"  rv23→"metro|pcs"
--   (9, 1, 'token signature', 'Metro|PCS', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- normalized token signature (pipe-joined normalized tokens; stopwords removed)
  -- alias 1 AT&T:  rv1→"t"  rv2→"att"  rv3→"t"
  (1, 1, 'normalized token signature', 'T',   2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized token signature', 'ATT', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 2 Verizon: rv7→"verizon"  rv8→"verizon" (wireless removed)  rv9→"verizon|wirless"
--   (2, 1, 'normalized token signature', 'Verizon',         2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (2, 1, 'normalized token signature', 'Verizon|Wirless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 3 T-Mobile: rv12→"t"  rv13→"t"  (mobile removed)
  (3, 1, 'normalized token signature', 'T', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 4 Sprint: rv16→"sprint"
  (4, 1, 'normalized token signature', 'Sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 5 Boost Mobile: rv18→"boost"  (mobile removed)
  (5, 1, 'normalized token signature', 'Boost', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 6 Cricket: rv20→"cricket"
  (6, 1, 'normalized token signature', 'Cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias 8 US Cellular: rv25→"us"  (cellular removed)
--   (8, 1, 'normalized token signature', 'US', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  -- alias 9 MetroPCS: rv22→"metro|pcs"  rv23→"metro|pcs"  (no stopwords)
--   (9, 1, 'normalized token signature', 'Metro|PCS', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
*/

-- Alias name pipeline entries (derived from ALIASES after the UPDATE populates pipeline fields).
-- alias token signature, alias clean value, alias normalized value, alias normalized token signature.
-- INSERT INTO ALIAS_SUMMARY (alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at)
-- SELECT a.alias_id, 1, 'alias token signature',
--   ARRAY_TO_STRING(a.alias_name_tokens::ARRAY, '|'),
--   NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
-- FROM ALIASES a
-- WHERE a.concept_id = 1
--   AND a.alias_name_tokens IS NOT NULL
--   AND IS_ARRAY(a.alias_name_tokens)
--   AND ARRAY_SIZE(a.alias_name_tokens::ARRAY) > 0
--
-- UNION ALL
--
-- SELECT a.alias_id, 1, 'alias clean value',
--   a.alias_name_clean_value,
--   NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
-- FROM ALIASES a
-- WHERE a.concept_id = 1
--   AND a.alias_name_clean_value IS NOT NULL
--
-- UNION ALL
--
-- SELECT a.alias_id, 1, 'alias normalized value',
--   a.alias_name_normalization_value,
--   NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
-- FROM ALIASES a
-- WHERE a.concept_id = 1
--   AND a.alias_name_normalization_value IS NOT NULL
--
-- UNION ALL
--
-- SELECT a.alias_id, 1, 'alias normalized token signature',
--   ARRAY_TO_STRING(a.alias_name_normalized_tokens::ARRAY, '|'),
--   NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
-- FROM ALIASES a
-- WHERE a.concept_id = 1
--   AND a.alias_name_normalized_tokens IS NOT NULL
--   AND IS_ARRAY(a.alias_name_normalized_tokens)
--   AND ARRAY_SIZE(a.alias_name_normalized_tokens::ARRAY) > 0;

-- ============================================================================
-- SAMPLE TOKENS_SUMMARY (manual — one row per token position per ALIAS_ITEMS row)
-- token_type: 'standard' and 'normalized' from pipeline tokens on each literal_value row.
-- Derived by splitting the token / normalized token signatures above for each alias_item_id.
-- ============================================================================

-- TEMPORARILY DISABLED: manual TOKENS_SUMMARY sample seed reset
-- DELETE FROM TOKENS_SUMMARY
-- WHERE alias_item_id IN (1, 2, 3, 7, 8, 9, 12, 13, 16, 18, 20, 22, 23, 25)
--    OR alias_id IN (1, 2, 3, 4, 5, 6, 7, 8, 9);

-- INSERT INTO TOKENS_SUMMARY (
--   token, position_in_signature, alias_item_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
-- )
-- VALUES
/*
  -- alias_item_id=1 'AT&T'
  -- clean/std sig preserve pipeline casing; comparisons are case-insensitive.
  -- norm sig: T    (stopword_removal removes "AT" from generic set → only "T" remains)
  ('AT', 1, 1, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',  2, 1, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',  1, 1, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=2 'ATT'
  -- clean: 'ATT'  |  std sig: ATT  |  norm sig: ATT  (no punctuation, no stopwords)
  ('ATT', 1, 2, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ATT', 1, 2, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=3 'A T & T'
  -- clean: 'A T T'  |  std sig: a|t|t  (punctuation_to_space gives "A T   T"; collapse → "A T T"; word_tokenize → ["A","T","T"])
  -- norm sig: T     (stopword_removal removes "A" from generic → ["T","T"]; token_deduplication → ["T"])
  ('A', 1, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 2, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 3, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 1, 3, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=7 'Verizon'
  -- std sig: verizon  |  norm sig: verizon  (no stopwords)
--   ('Verizon', 1, 7, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Verizon', 1, 7, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=8 'Verizon Wireless'
  -- std sig: verizon|wireless  |  norm sig: verizon  ("wireless" is a carriers stopword → removed)
--   ('Verizon',  1, 8, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Wireless', 2, 8, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Verizon',  1, 8, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=9 'Verizon Wirless'  (typo — not in stopword list, so kept)
  -- std sig: verizon|wirless  |  norm sig: verizon|wirless
--   ('Verizon', 1, 9, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Wirless', 2, 9, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Verizon', 1, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Wirless', 2, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=12 'T-Mobile'
  -- clean: 'T Mobile'  |  std sig: t|mobile  |  norm sig: t  ("mobile" is a carriers stopword → removed)
  ('T',      1, 12, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 12, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',      1, 12, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=13 'T Mobile'
  -- clean: 'T Mobile'  |  std sig: t|mobile  |  norm sig: t  ("mobile" removed)
  ('T',      1, 13, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 13, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',      1, 13, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=16 'Sprint'
  -- std sig: sprint  |  norm sig: sprint
  ('Sprint', 1, 16, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Sprint', 1, 16, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=18 'Boost Mobile'
  -- std sig: boost|mobile  |  norm sig: boost  ("mobile" is a carriers stopword → removed)
  ('Boost',  1, 18, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 18, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Boost',  1, 18, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=20 'Cricket'
  -- std sig: cricket  |  norm sig: cricket
  ('Cricket', 1, 20, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Cricket', 1, 20, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=22 'MetroPCS'
  -- split_camel_pascal splits "MetroPCS" at lowercase→uppercase boundary: "Metro PCS"
  -- std sig: metro|pcs  |  norm sig: metro|pcs  (neither token is a stopword)
--   ('Metro', 1, 22, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('PCS',   2, 22, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Metro', 1, 22, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('PCS',   2, 22, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=23 'Metro PCS'
  -- std sig: metro|pcs  |  norm sig: metro|pcs
--   ('Metro', 1, 23, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('PCS',   2, 23, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Metro', 1, 23, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('PCS',   2, 23, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=25 'US Cellular'
  -- std sig: us|cellular  |  norm sig: us  ("cellular" is a carriers stopword → removed)
--   ('US',       1, 25, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Cellular', 2, 25, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('US',       1, 25, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- token_type = 'alias': one row per token for each canonical alias name (alias_id set; alias_item_id NULL).
-- Populated from ALIASES.alias_name_tokens after APPLY_CLASSIFICATION_PIPELINE; matches REFRESH_TOKENS_SUMMARY alias branch.
-- INSERT INTO TOKENS_SUMMARY (
--   token, position_in_signature, alias_item_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
-- )
-- VALUES
  -- alias_id=1  AT|T  (AT&T → punctuation_to_space → "AT T" → ["AT","T"])
  ('AT', 1, NULL, 1, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',  2, NULL, 1, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=2  verizon
--   ('Verizon', 1, NULL, 2, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=3  t|mobile
  ('T',      1, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=4  sprint
  ('Sprint', 1, NULL, 4, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=5  boost|mobile
  ('Boost',  1, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=6  cricket|wireless
  ('Cricket',  1, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wireless', 2, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=7  metro|by|t|mobile
  ('Metro',  1, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('by',     2, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',      3, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 4, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=8  us|cellular
--   ('US',       1, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('Cellular', 2, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

  -- alias_id=9  metro|pcs
--   ('Metro', 1, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   ('PCS',   2, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
*/

-- Optional: keep TOKENS_SUMMARY in sync after pipeline edits via CALL STAND_DB.STAND.REFRESH_TOKENS_SUMMARY(NULL);

-- ============================================================================
-- GOOGLE / ALPHABET SUBGROUP EXAMPLE
-- Demonstrates two alias_ids sharing the same alias_name_literal_value ('Google') under
-- concept_id=1 (mobile_carrier), separated by alias_subgroup_id:
--   alias_id=10  alias_subgroup_id=1  representative literal value: 'Google'
--   alias_id=11  alias_subgroup_id=2  representative literal value: 'Alphabet'
-- A new item like 'Alphabet Inc' will score strongly against alias_id=11 and
-- be correctly renamed to 'Google' via that subgroup.
-- All data is fully manually specified — no SELECT-based inserts.
-- ============================================================================

-- ALIASES -----------------------------------------------------------------
-- Two rows, same alias_name_literal_value, different alias_subgroup_id (allowed by the new
-- UNIQUE (concept_id, alias_name_literal_value, alias_subgroup_id) constraint).
INSERT INTO ALIASES (alias_id, concept_id, alias_name_literal_value, alias_name_normalization_value, alias_subgroup_id, status, created_at, updated_at)
SELECT v.alias_id, v.concept_id, v.alias_name_literal_value,
       STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
           v.alias_name_literal_value,
           STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
               p.ruleset,
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = v.concept_id), ARRAY_CONSTRUCT())
           )
       ):normalization_value::VARCHAR,
       v.alias_subgroup_id, v.status, v.created_at, v.updated_at
FROM (VALUES
  (10, 1, 'Google', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'Google', 2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
) AS v (alias_id, concept_id, alias_name_literal_value, alias_subgroup_id, status, created_at, updated_at)
JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = v.concept_id
JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p ON p.profile_id = c.profile_id;

-- ALIAS_ITEMS --------------------------------------------------------------
-- One representative alias item per subgroup, all pipeline fields included.
--   alias_item_id=30  alias_id=10  literal_value='Google'
--   alias_item_id=31  alias_id=11  literal_value='Alphabet'
-- normalization_value: pipeline-normalized single word; comparisons are case-insensitive.
-- tokens / normalized_tokens: single-element arrays stored as pipe-joined strings
--   in ALIAS_SUMMARY and split into rows in TOKENS_SUMMARY below.
-- TEMPORARILY DISABLED: manual ALIAS_ITEMS subgroup sample
-- INSERT INTO ALIAS_ITEMS (
--   alias_item_id, alias_id, profile_id,
--   literal_value,   cleaned_value, normalization_value,
--   tokens_count, normalized_tokens_count,
--   confidence, source, approved, created_at, updated_at
-- )
-- VALUES
--   (30, 10, 1, 'Google',   'Google',   'Google',   1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (31, 11, 1, 'Alphabet', 'Alphabet', 'Alphabet', 1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Populate all pipeline-derived fields for alias_ids 10 & 11 (no concept-level UPDATE covers these).
UPDATE ALIASES a
SET
  alias_name_normalization_value     = sub.pipeline:normalization_value::VARCHAR,
  alias_name_clean_value             = sub.pipeline:cleaned_value::VARCHAR,
  alias_name_normalized_tokens       = sub.pipeline:normalized_tokens,
  alias_name_normalized_tokens_count = sub.pipeline:normalized_tokens_count::NUMBER,
  alias_name_tokens                  = sub.pipeline:tokens,
  alias_name_tokens_count            = sub.pipeline:tokens_count::NUMBER,
  updated_at                         = CURRENT_TIMESTAMP()
FROM (
  SELECT
    a2.alias_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
        a2.alias_name_literal_value,
        STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
            prof.ruleset,
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = c.concept_id), ARRAY_CONSTRUCT())
        )
    ) AS pipeline
  FROM ALIASES a2
  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof ON prof.profile_id = c.profile_id
  WHERE a2.alias_id IN (10, 11)
) sub
WHERE a.alias_id = sub.alias_id;

-- ALIAS_SUMMARY -----------------------------------------------------------
-- The existing DELETE FROM ALIAS_SUMMARY WHERE concept_id = 1 above already
-- cleared concept_id=1 rows before inserting the carrier entries, so these
-- must be inserted in a separate statement after that block.
-- TEMPORARILY DISABLED: manual ALIAS_SUMMARY subgroup sample
-- INSERT INTO ALIAS_SUMMARY (
--   alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at
-- )
-- VALUES
/*
  -- alias_id=10  (Google subgroup — 'Google'-like literal values)
  (10, 1, 'alias name',                    'Google',  NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'clean value',                   'Google',  1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'normalized value',              'Google',  1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'token signature',               'Google',  1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'normalized token signature',    'Google',  1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias name pipeline: 'Google' → clean='Google', norm='Google', tokens=['Google'], norm_tokens=['Google']
  (10, 1, 'alias token signature',         'Google',  NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'alias clean value',             'Google',  NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'alias normalized value',        'Google',  NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 1, 'alias normalized token signature','Google',NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=11  (Google subgroup — 'Alphabet'-like literal values)
  (11, 1, 'alias name',                    'Google',   NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'clean value',                   'Alphabet', 1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'normalized value',              'Alphabet', 1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'token signature',               'Alphabet', 1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'normalized token signature',    'Alphabet', 1,    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias name pipeline: 'Google' → clean='Google', norm='Google', tokens=['Google'], norm_tokens=['Google']
  (11, 1, 'alias token signature',         'Google',   NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'alias clean value',             'Google',   NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 1, 'alias normalized value',        'Google',   NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--   (11, 1, 'alias normalized token signature','Google', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
*/

-- TOKENS_SUMMARY ----------------------------------------------------------
-- The existing DELETE covers alias_item_ids 1-25 and alias_ids 1-9, so
-- ids 10, 11, 30, 31 are untouched. Add a targeted guard for idempotency.
-- TEMPORARILY DISABLED: manual TOKENS_SUMMARY subgroup sample reset
-- DELETE FROM TOKENS_SUMMARY
-- WHERE alias_item_id IN (30, 31)
--    OR alias_id IN (10, 11);

-- INSERT INTO TOKENS_SUMMARY (
--   token, position_in_signature, alias_item_id, alias_id,
--   signature_length, rarity, token_type, created_at, updated_at
-- )
-- VALUES
/*
  -- alias_item_id=30  'Google'  standard tokens
  ('Google',   1, 30, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias_item_id=30  'Google'  normalized tokens
  ('Google',   1, 30, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_item_id=31  'Alphabet'  standard tokens
  ('Alphabet', 1, 31, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- alias_item_id=31  'Alphabet'  normalized tokens
  ('Alphabet', 1, 31, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=10  alias_name_literal_value='Google'  alias tokens (token_type='alias')
  ('Google',   1, NULL, 10, 1, 0, 'alias',      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=11  alias_name_literal_value='Google'  alias tokens (token_type='alias')
  -- Both subgroups share the same alias_name_literal_value, so their alias tokens are identical.
  -- The scoring algorithm distinguishes them via their alias item tokens above.
--   ('Google',   1, NULL, 11, 1, 0, 'alias',      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
*/

-- ============================================================================
-- ONE-TIME SEED SCORES  (concept_id = 1, N = 11 aliases)
--
-- rarity (normalized-token formula):
--   (token_count / alias_item_count) × (ln(N / df) / ln(N))
-- where token_count      = distinct alias items in the alias containing the token
--       alias_item_count = total distinct alias items in the alias
--       N                = total distinct aliases in the concept  (= 11)
--       df               = distinct aliases containing the token
-- Standard-token rarity: mirror the normalized token at the same position
--
-- token importance_score formula (pure — char_weight applied separately):
--   importance_score = rarity × ((1 − λ) + λ × pos_weight(p))
--                    = rarity × (0.75 + 0.25 / p^0.4)
-- where p = position_in_signature,  λ = 0.25,  α = 0.4
-- char_weight = min(1, (len/6)^3) is stored separately and applied at scoring time as sqrt(LF).
-- Alias tokens use rarity = 1.0 (alias names are definitional).
--
-- signature importance_score formula (pure — char_weight stripped):
--   s_pure = Σ rarity × pos_weight(t,p) for unique tokens
--   score  = s_pure / (s_pure + 1 + β × (n − 1))
-- where n = number of unique tokens,  β = 0.2
-- Length factor applied separately by the application layer.
--
-- Key constants (N = 11)
--   ln(11/1) / ln(11) = 1.000000   (df=1,  token unique to one alias)
--   ln(11/2) / ln(11) = 0.710935   (df=2,  'Mobile' shared by aliases 3 & 5)
--   pos_weight(1) = 1.0 / 1^0.4  = 1.000000
--   pos_weight(2) = 1.0 / 2^0.4  = 0.757858  →  (0.75 + 0.25×0.757858) = 0.939548
-- ============================================================================

-- ── ALIAS_SUMMARY: null out alias-name rows (alias names are definitional) ───
UPDATE ALIAS_SUMMARY
SET    importance_score = NULL,
       updated_at       = CURRENT_TIMESTAMP
WHERE  concept_id = 1
  AND  key_type = 'alias name';

-- ── TOKENS_SUMMARY: normalized token rarity ──────────────────────────────────
-- Formula: (token_count / alias_item_count) × (ln(N/df) / ln(N))
-- alias 1: item_count=3   alias 2: item_count=3   alias 3: item_count=2
-- alias 4: item_count=1   alias 5: item_count=1   alias 6: item_count=1
-- alias 8: item_count=1   alias 9: item_count=2   alias 10/11: item_count=1
--
-- After pipeline-consistent fix:
--   alias 1 normalized tokens: rv1→["t"]  rv2→["att"]  rv3→["t"]
--   alias 2 normalized tokens: rv7→["verizon"]  rv8→["verizon"]  rv9→["verizon","wirless"]
--   alias 3 normalized tokens: rv12→["t"]  rv13→["t"]   (mobile removed by carriers stopwords)
--   alias 5 normalized tokens: rv18→["boost"]            (mobile removed)
--   alias 8 normalized tokens: rv25→["us"]               (cellular removed)
--   alias 9 normalized tokens: rv22→["metro","pcs"]  rv23→["metro","pcs"]
--
-- Key rarity values (N=11 aliases; ln(11/df)/ln(11)):
--   df=1  → 1.000000    df=2  → 0.710935
--
-- 'ATT'  alias 1  tc=1  items=3  df=1  → (1/3)×1.0 = 0.333333
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'ATT' AND alias_item_id = 2;
-- 'T'    alias 1  tc=2  items=3  df=2  → (2/3)×0.710935 = 0.473957
--        (rv1 and rv3 both normalize to "t"; "t" also appears in alias 3 → df=2)
UPDATE TOKENS_SUMMARY SET rarity = 0.473957, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'T' AND alias_item_id IN (1, 3);
-- 'Verizon'  alias 2  tc=3  items=3  df=1  → (3/3)×1.0 = 1.000000
--            (rv7, rv8 both normalize to "verizon"; rv8 wireless is removed)
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'Verizon';
-- 'Wirless'  alias 2  tc=1  items=3  df=1  → (1/3)×1.0 = 0.333333
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'Wirless';
-- 'T'  alias 3  tc=2  items=2  df=2  → (2/2)×0.710935 = 0.710935
--      (mobile removed; "t" now shared across alias 1 and alias 3 → df=2)
UPDATE TOKENS_SUMMARY SET rarity = 0.710935, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'T' AND alias_item_id IN (12, 13);
-- 'Sprint'   alias 4  tc=1  items=1  df=1  → 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND alias_item_id = 16;
-- 'Boost'    alias 5  tc=1  items=1  df=1  → 1.000000  (mobile removed from normalized)
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'Boost';
-- 'Cricket'  alias 6  tc=1  items=1  df=1  → 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND alias_item_id = 20;
-- 'US'       alias 8  tc=1  items=1  df=1  → 1.000000  (cellular removed from normalized)
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND alias_item_id = 25;
-- 'Metro'    alias 9  tc=2  items=2  df=1  → (2/2)×1.0 = 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'Metro' AND alias_item_id IN (22, 23);
-- 'PCS'      alias 9  tc=2  items=2  df=1  → (2/2)×1.0 = 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND token = 'PCS' AND alias_item_id IN (22, 23);
-- 'Google'   alias 10  → 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND alias_item_id = 30;
-- 'Alphabet' alias 11  → 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'normalized' AND alias_item_id = 31;

-- ── TOKENS_SUMMARY: standard token rarity (mirror normalized rarity at same position) ─
-- alias_item_id=1  'AT&T'  std tokens: [at(p1), t(p2)]
--   'AT'  only in rv1 (alias 1); tc=1/3, df=1 → (1/3)×1.0 = 0.333333
--   'T'   in rv1(p2) and rv3(p2,p3) for alias 1 AND rv12,rv13 for alias 3 → df=2
--         tc=2/3 for alias 1 → (2/3)×0.710935 = 0.473957
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 1 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.473957, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 1 AND position_in_signature = 2;
-- alias_item_id=2  'ATT'  std token: [att(p1)] → 'ATT' unique to alias 1; tc=1/3, df=1 → 0.333333
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 2;
-- alias_item_id=3  'A T & T'  std tokens: [a(p1), t(p2), t(p3)]
--   'A'   unique to rv3 now (rv1 has 'AT' not 'A'); tc=1/3, df=1 → 0.333333
--   'T'   pos=2,3 → rarity=0 (position weight penalises repeated tokens; leave at 0)
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 3 AND position_in_signature = 1;
-- alias_item_id=7  'Verizon'   → Verizon(pos1)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 7;
-- alias_item_id=8  'Verizon Wireless' → Verizon(pos1)→1.0 ; Wireless(pos2)→0.333333
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 8 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 8 AND position_in_signature = 2;
-- alias_item_id=9  'Verizon Wirless'  → Verizon(pos1)→1.0 ; Wirless(pos2)→0.333333
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 9 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.333333, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 9 AND position_in_signature = 2;
-- alias_item_id=12 'T-Mobile'  → T(pos1)→1.0 ; Mobile(pos2)→0.710935
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 12 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.710935, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 12 AND position_in_signature = 2;
-- alias_item_id=13 'T Mobile'  → T(pos1)→1.0 ; Mobile(pos2)→0.710935
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 13 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.710935, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 13 AND position_in_signature = 2;
-- alias_item_id=16 'Sprint'    → Sprint(pos1)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 16;
-- alias_item_id=18 'Boost Mobile' → Boost(pos1)→1.0 ; Mobile(pos2)→0.710935
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 18 AND position_in_signature = 1;
UPDATE TOKENS_SUMMARY SET rarity = 0.710935, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 18 AND position_in_signature = 2;
-- alias_item_id=20 'Cricket'   → Cricket(pos1)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 20;
-- alias_item_id=22 'MetroPCS'  → Metro(pos1)→1.0 ; PCS(pos2)→0 (no norm match)
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 22 AND position_in_signature = 1;
-- alias_item_id=23 'Metro PCS' → Metro(pos1)→1.0 ; PCS(pos2)→0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 23 AND position_in_signature = 1;
-- alias_item_id=25 'US Cellular' → US(pos1)→1.0 ; Cellular(pos2)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 25;
-- alias_item_id=30 'Google'    → Google(pos1)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 30;
-- alias_item_id=31 'Alphabet'  → Alphabet(pos1)→1.0
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP
WHERE token_type = 'standard' AND alias_item_id = 31;

-- ── TOKENS_SUMMARY: importance_score = rarity × (0.75 + 0.25 / p^0.4)  [pure, no char_weight] ──
-- char_weight = min(1,(len/6)^3) is decoupled and applied separately at scoring time.
UPDATE TOKENS_SUMMARY ts
SET    importance_score = ts.rarity * (0.75 + 0.25 / POWER(ts.position_in_signature::FLOAT, 0.4)),
       updated_at       = CURRENT_TIMESTAMP
WHERE  ts.token_type IN ('standard', 'normalized')
  AND  ts.alias_item_id IN (
           SELECT rv.alias_item_id
           FROM   ALIAS_ITEMS rv
           JOIN   ALIASES    a  ON a.alias_id = rv.alias_id
           WHERE  a.concept_id = 1
       );

-- ── TOKENS_SUMMARY: alias token importance_score = 0.75 + 0.25 / p^0.4  [pure, no char_weight] ──
-- Alias tokens use rarity = 1.0 (definitional); pure importance = pos_weight only.
UPDATE TOKENS_SUMMARY
SET    importance_score = 0.75 + 0.25 / POWER(position_in_signature::FLOAT, 0.4),
       updated_at       = CURRENT_TIMESTAMP
WHERE  token_type = 'alias'
  AND  alias_id IN (SELECT alias_id FROM ALIASES WHERE concept_id = 1);

-- ── ALIAS_SUMMARY: token signatures ──────────────────────────────────────────
-- Formula (pure, no char_weight): s_pure / (s_pure + 1 + 0.2×(n−1))
--   s_pure = Σ rarity × pos_weight   pos_weight: p=1→1.000000, p=2→0.939482
--
-- alias 1  'AT|T'    : at(p1,r=0.333333)→0.333333, t(p2,r=0.473957)→0.445236
--                      n=2, s=0.778569 → 0.778569/1.978569 = 0.393515
UPDATE ALIAS_SUMMARY SET importance_score = 0.393515, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 1  AND key_type = 'token signature' AND key_value = 'AT|T';
-- alias 1  'ATT'     : att(p1,r=0.333333)→0.333333 ; n=1, s=0.333333 → 0.333333/1.333333 = 0.250000
UPDATE ALIAS_SUMMARY SET importance_score = 0.250000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 1  AND key_type = 'token signature' AND key_value = 'ATT';
-- alias 1  'A|T|T'   : a(p1,r=0.333333)→0.333333, t(p2,r=0)→0 ; n=2, s=0.333333 → 0.333333/1.533333 = 0.217391
UPDATE ALIAS_SUMMARY SET importance_score = 0.217391, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 1  AND key_type = 'token signature' AND key_value = 'A|T|T';
-- alias 2  'Verizon'          : verizon(p1,r=1.0)→1.0 ; n=1, s=1.0 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 2  AND key_type = 'token signature' AND key_value = 'Verizon';
-- alias 2  'Verizon|Wireless' : verizon(p1,r=1.0)→1.0, wireless(p2,r=0.333333)→0.313160 ; n=2, s=1.313160 → 0.522398
UPDATE ALIAS_SUMMARY SET importance_score = 0.522398, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 2  AND key_type = 'token signature' AND key_value = 'Verizon|Wireless';
-- alias 2  'Verizon|Wirless'  : verizon(p1,r=1.0)→1.0, wirless(p2,r=0.333333)→0.313160 ; n=2 → 0.522398
UPDATE ALIAS_SUMMARY SET importance_score = 0.522398, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 2  AND key_type = 'token signature' AND key_value = 'Verizon|Wirless';
-- alias 3  'T|Mobile' : t(p1,r=1.0)→1.0, mobile(p2,r=0.710935)→0.667882 ; n=2, s=1.667882 → 1.667882/2.867882 = 0.581669
UPDATE ALIAS_SUMMARY SET importance_score = 0.581669, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 3  AND key_type = 'token signature' AND key_value = 'T|Mobile';
-- alias 4  'Sprint'   : sprint(p1,r=1.0)→1.0 ; n=1, s=1.0 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 4  AND key_type = 'token signature' AND key_value = 'Sprint';
-- alias 5  'Boost|Mobile' : boost(p1,r=1.0)→1.0, mobile(p2,r=0.710935)→0.667882 ; n=2, s=1.667882 → 0.581669
UPDATE ALIAS_SUMMARY SET importance_score = 0.581669, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 5  AND key_type = 'token signature' AND key_value = 'Boost|Mobile';
-- alias 6  'Cricket'  : cricket(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 6  AND key_type = 'token signature' AND key_value = 'Cricket';
-- alias 8  'US|Cellular' : us(p1,r=1.0)→1.0, cellular(p2,r=1.0)→0.939482 ; n=2, s=1.939482 → 1.939482/3.139482 = 0.617779
UPDATE ALIAS_SUMMARY SET importance_score = 0.617779, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 8  AND key_type = 'token signature' AND key_value = 'US|Cellular';
-- alias 9  'Metro|PCS' : metro(p1,r=1.0)→1.0, pcs(p2,r=1.0)→0.939482 ; n=2, s=1.939482 → 0.617779
UPDATE ALIAS_SUMMARY SET importance_score = 0.617779, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 9  AND key_type = 'token signature' AND key_value = 'Metro|PCS';
-- alias 10 'Google'   : google(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 10 AND key_type = 'token signature' AND key_value = 'Google';
-- alias 11 'Alphabet' : alphabet(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 11 AND key_type = 'token signature' AND key_value = 'Alphabet';

-- ── ALIAS_SUMMARY: normalized token signatures ───────────────────────────────
-- Same formula (pure): s_pure = Σ rarity × pos_weight
--
-- alias 1  'T'   : t(p1,r=0.473957)→0.473957 ; n=1, s=0.473957 → 0.473957/1.473957 = 0.321551
UPDATE ALIAS_SUMMARY SET importance_score = 0.321551, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 1  AND key_type = 'normalized token signature' AND key_value = 'T';
-- alias 1  'ATT' : att(p1,r=0.333333)→0.333333 ; n=1 → 0.250000
UPDATE ALIAS_SUMMARY SET importance_score = 0.250000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 1  AND key_type = 'normalized token signature' AND key_value = 'ATT';
-- alias 2  'Verizon'         : verizon(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 2  AND key_type = 'normalized token signature' AND key_value = 'Verizon';
-- alias 2  'Verizon|Wirless' : verizon(p1,r=1.0)→1.0, wirless(p2,r=0.333333)→0.313160 ; n=2 → 0.522398
UPDATE ALIAS_SUMMARY SET importance_score = 0.522398, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 2  AND key_type = 'normalized token signature' AND key_value = 'Verizon|Wirless';
-- alias 3  'T'   : t(p1,r=0.710935)→0.710935 ; n=1, s=0.710935 → 0.710935/1.710935 = 0.415522
UPDATE ALIAS_SUMMARY SET importance_score = 0.415522, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 3  AND key_type = 'normalized token signature' AND key_value = 'T';
-- alias 4  'Sprint' : sprint(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 4  AND key_type = 'normalized token signature' AND key_value = 'Sprint';
-- alias 5  'Boost' : boost(p1,r=1.0)→1.0 ; n=1, s=1.0 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 5  AND key_type = 'normalized token signature' AND key_value = 'Boost';
-- alias 6  'Cricket' : cricket(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 6  AND key_type = 'normalized token signature' AND key_value = 'Cricket';
-- alias 8  'US' : us(p1,r=1.0)→1.0 ; n=1, s=1.0 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 8  AND key_type = 'normalized token signature' AND key_value = 'US';
-- alias 9  'Metro|PCS' : metro(p1,r=1.0)→1.0, pcs(p2,r=1.0)→0.939482 ; n=2, s=1.939482 → 0.617779
UPDATE ALIAS_SUMMARY SET importance_score = 0.617779, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 9  AND key_type = 'normalized token signature' AND key_value = 'Metro|PCS';
-- alias 10 'Google'   : google(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 10 AND key_type = 'normalized token signature' AND key_value = 'Google';
-- alias 11 'Alphabet' : alphabet(p1,r=1.0)→1.0 ; n=1 → 0.500000
UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP
WHERE alias_id = 11 AND key_type = 'normalized token signature' AND key_value = 'Alphabet';

-- ── ALIAS_SUMMARY: alias token signature importance (concept 1) ──────────────
-- Computed dynamically from TOKENS_SUMMARY (token_type='alias') importance_scores.
-- Formula (pure): s_pure / (s_pure + 1 + 0.2*(n-1))  where s_pure = Σ pos_weight per unique alias token.
-- Alias tokens have rarity = 1.0; pure importance = pos_weight only (char_weight decoupled).
-- Selected examples (pure):
--   alias1  at|t:         at(p1)→1.000000, t(p2)→0.939482; s_pure=1.939482 → 0.617779
--   alias3  t|mobile:     t(p1)→1.000000, mobile(p2)→0.939482;  s_pure=1.939482 → 0.617779
--   alias5  boost|mobile: boost(p1)→1.000000, mobile(p2)→0.939482; s_pure=1.939482 → 0.617779
--   alias7  metro|by|t|mobile: metro(p1)→1.0, by(p2)→0.939482, t(p3)→0.911100, mobile(p4)→0.893590; s_pure=3.744172 → 0.700701
--   alias8  us|cellular:  us(p1)→1.000000, cellular(p2)→0.939482; s_pure=1.939482 → 0.617779
UPDATE ALIAS_SUMMARY asm
SET    importance_score = scored.score,
       updated_at       = CURRENT_TIMESTAMP
FROM (
    SELECT ts_grp.alias_id,
           SUM(ts_grp.max_importance) / (SUM(ts_grp.max_importance) + 1.0 + 0.2 * (COUNT(*)::FLOAT - 1.0)) AS score
    FROM (
        SELECT alias_id, token, MAX(importance_score) AS max_importance
        FROM   TOKENS_SUMMARY
        WHERE  token_type = 'alias'
          AND  alias_id IN (SELECT alias_id FROM ALIASES WHERE concept_id = 1)
        GROUP BY alias_id, token
    ) ts_grp
    GROUP BY ts_grp.alias_id
) scored
WHERE asm.alias_id   = scored.alias_id
  AND asm.key_type   = 'alias token signature'
  AND asm.concept_id = 1;

-- ============================================================================
-- END OF ONE-TIME IMPORTANCE SCORE SEEDS
-- ============================================================================

-- ============================================================================
-- COMPANY NAMES CONCEPT  (concept_id = 2)
-- 10 well-known companies unrelated to mobile carriers.
-- Includes Capital One and Google as required entries.
-- alias_ids 12–21  |  alias_item_ids 32–41
-- N = 10 aliases; all tokens unique to one alias → rarity = 1.0 for all tokens.
-- ============================================================================

-- ── CONCEPT ──────────────────────────────────────────────────────────────────
INSERT INTO CONCEPTS (concept_id, concept_key, description, data_type, profile_id, is_active, created_at, updated_at)
SELECT 2, 'company_name', 'Names of well-known companies across various industries.', 'enum', 1, TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
WHERE NOT EXISTS (SELECT 1 FROM CONCEPTS WHERE concept_id = 2);

-- ── ALIASES ───────────────────────────────────────────────────────────────────
-- Tokens will be populated by APPLY_CLASSIFICATION_PIPELINE UPDATE below.
DELETE FROM ALIASES WHERE concept_id = 2;

INSERT INTO ALIASES (alias_id, concept_id, alias_name_literal_value, alias_name_normalization_value, alias_subgroup_id, status, created_at, updated_at)
SELECT v.alias_id, v.concept_id, v.alias_name_literal_value,
       STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
           v.alias_name_literal_value,
           STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
               p.ruleset,
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
               COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = v.concept_id), ARRAY_CONSTRUCT())
           )
       ):normalization_value::VARCHAR,
       v.alias_subgroup_id, v.status, v.created_at, v.updated_at
FROM (VALUES
  (12, 2, 'Capital One', 1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'Google',      1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'Amazon',      1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'Microsoft',   1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'Apple',       1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'Walmart',     1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'Nike',        1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'Starbucks',   1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'Netflix',     1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'Boeing',      1, 'active', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
) AS v (alias_id, concept_id, alias_name_literal_value, alias_subgroup_id, status, created_at, updated_at)
JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = v.concept_id
JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p ON p.profile_id = c.profile_id;

-- ── ALIAS_ITEMS (one canonical literal value per alias) ────────────────────────────
-- normalization_value: pipeline-normalized form; comparisons are case-insensitive.
-- tokens / normalized_tokens populated by UPDATE below.
DELETE FROM ALIAS_ITEMS WHERE alias_id BETWEEN 12 AND 21;

INSERT INTO ALIAS_ITEMS (
  alias_item_id, alias_id, profile_id,
  literal_value,       cleaned_value, normalization_value,
  tokens_count,    normalized_tokens_count,
  confidence, source, approved, created_at, updated_at
)
VALUES
  (32, 12, 1, 'Capital One', 'Capital One', 'Capital One', 2, 2, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (33, 13, 1, 'Google',      'Google',      'Google',      1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (34, 14, 1, 'Amazon',      'Amazon',      'Amazon',      1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (35, 15, 1, 'Microsoft',   'Microsoft',   'Microsoft',   1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (36, 16, 1, 'Apple',       'Apple',       'Apple',       1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (37, 17, 1, 'Walmart',     'Walmart',     'Walmart',     1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (38, 18, 1, 'Nike',        'Nike',        'Nike',        1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (39, 19, 1, 'Starbucks',   'Starbucks',   'Starbucks',   1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (40, 20, 1, 'Netflix',     'Netflix',     'Netflix',     1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (41, 21, 1, 'Boeing',      'Boeing',      'Boeing',      1, 1, 95, 'manual_review', TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

-- Populate tokens / normalized_tokens VARIANT fields on the new alias items.
UPDATE ALIAS_ITEMS rv
SET
  cleaned_value                = sub.pipeline:cleaned_value::VARCHAR,
  normalization_value          = sub.pipeline:normalization_value::VARCHAR,
  tokens                       = sub.pipeline:tokens,
  tokens_count                 = sub.pipeline:tokens_count::NUMBER,
  normalized_tokens            = sub.pipeline:normalized_tokens,
  normalized_tokens_count      = sub.pipeline:normalized_tokens_count::NUMBER,
  updated_at                   = CURRENT_TIMESTAMP()
FROM (
  SELECT
    rv2.alias_item_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
        rv2.literal_value,
        STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
            prof.ruleset,
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = a.concept_id), ARRAY_CONSTRUCT())
        )
    ) AS pipeline
  FROM ALIAS_ITEMS rv2
  JOIN STAND_DB.STAND_INTERNAL.ALIASES a ON a.alias_id = rv2.alias_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof
    ON prof.profile_id = rv2.profile_id
  WHERE rv2.alias_item_id BETWEEN 32 AND 41
) sub
WHERE rv.alias_item_id = sub.alias_item_id;

-- Populate all pipeline-derived fields on canonical alias names (concept_id = 2).
UPDATE ALIASES a
SET
  alias_name_normalization_value     = sub.pipeline:normalization_value::VARCHAR,
  alias_name_clean_value             = sub.pipeline:cleaned_value::VARCHAR,
  alias_name_normalized_tokens       = sub.pipeline:normalized_tokens,
  alias_name_normalized_tokens_count = sub.pipeline:normalized_tokens_count::NUMBER,
  alias_name_tokens                  = sub.pipeline:tokens,
  alias_name_tokens_count            = sub.pipeline:tokens_count::NUMBER,
  updated_at                         = CURRENT_TIMESTAMP()
FROM (
  SELECT
    a2.alias_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
        a2.alias_name_literal_value,
        STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
            prof.ruleset,
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id IS NULL), ARRAY_CONSTRUCT()),
            COALESCE((SELECT ARRAY_AGG(word) FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS WHERE concept_id = c.concept_id), ARRAY_CONSTRUCT())
        )
    ) AS pipeline
  FROM ALIASES a2
  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c   ON c.concept_id  = a2.concept_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof ON prof.profile_id = c.profile_id
  WHERE a2.concept_id = 2
) sub
WHERE a.alias_id = sub.alias_id;

-- ── ALIAS_SUMMARY ─────────────────────────────────────────────────────────────
DELETE FROM ALIAS_SUMMARY WHERE concept_id = 2;

INSERT INTO ALIAS_SUMMARY (
  alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at
)
VALUES
  -- ── alias name ──────────────────────────────────────────────────────────────
  (12, 2, 'alias name', 'Capital One', NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'alias name', 'Google',      NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'alias name', 'Amazon',      NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'alias name', 'Microsoft',   NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'alias name', 'Apple',       NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'alias name', 'Walmart',     NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'alias name', 'Nike',        NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'alias name', 'Starbucks',   NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'alias name', 'Netflix',     NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'alias name', 'Boeing',      NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- ── clean value ──────────────────────────────────────────────────────────────
  (12, 2, 'clean value', 'Capital One', 1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'clean value', 'Google',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'clean value', 'Amazon',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'clean value', 'Microsoft',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'clean value', 'Apple',       1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'clean value', 'Walmart',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'clean value', 'Nike',        1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'clean value', 'Starbucks',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'clean value', 'Netflix',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'clean value', 'Boeing',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- ── normalized value ────────────────────────────────────────────────────────
  (12, 2, 'normalized value', 'Capital One', 1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'normalized value', 'Google',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'normalized value', 'Amazon',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'normalized value', 'Microsoft',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'normalized value', 'Apple',       1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'normalized value', 'Walmart',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'normalized value', 'Nike',        1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'normalized value', 'Starbucks',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'normalized value', 'Netflix',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'normalized value', 'Boeing',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- ── token signature (standard, pipe-joined) ──────────────────────────────────
  (12, 2, 'token signature', 'Capital|One', 1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'token signature', 'Google',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'token signature', 'Amazon',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'token signature', 'Microsoft',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'token signature', 'Apple',       1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'token signature', 'Walmart',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'token signature', 'Nike',        1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'token signature', 'Starbucks',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'token signature', 'Netflix',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'token signature', 'Boeing',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- ── normalized token signature (case-preserved, pipe-joined) ─────────────────
  (12, 2, 'normalized token signature', 'Capital|One', 1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (13, 2, 'normalized token signature', 'Google',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 2, 'normalized token signature', 'Amazon',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 2, 'normalized token signature', 'Microsoft',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 2, 'normalized token signature', 'Apple',       1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 2, 'normalized token signature', 'Walmart',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 2, 'normalized token signature', 'Nike',        1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 2, 'normalized token signature', 'Starbucks',   1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 2, 'normalized token signature', 'Netflix',     1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 2, 'normalized token signature', 'Boeing',      1, 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

-- Alias name pipeline entries (derived from ALIASES after UPDATE populates pipeline fields).
INSERT INTO ALIAS_SUMMARY (alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at)
SELECT a.alias_id, 2, 'alias token signature',
  ARRAY_TO_STRING(a.alias_name_tokens::ARRAY, '|'),
  NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
FROM ALIASES a
WHERE a.concept_id = 2
  AND a.alias_name_tokens IS NOT NULL
  AND IS_ARRAY(a.alias_name_tokens)
  AND ARRAY_SIZE(a.alias_name_tokens::ARRAY) > 0

UNION ALL

SELECT a.alias_id, 2, 'alias clean value',
  a.alias_name_clean_value,
  NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
FROM ALIASES a
WHERE a.concept_id = 2
  AND a.alias_name_clean_value IS NOT NULL

UNION ALL

SELECT a.alias_id, 2, 'alias normalized value',
  a.alias_name_normalization_value,
  NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
FROM ALIASES a
WHERE a.concept_id = 2
  AND a.alias_name_normalization_value IS NOT NULL

UNION ALL

SELECT a.alias_id, 2, 'alias normalized token signature',
  ARRAY_TO_STRING(a.alias_name_normalized_tokens::ARRAY, '|'),
  NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
FROM ALIASES a
WHERE a.concept_id = 2
  AND a.alias_name_normalized_tokens IS NOT NULL
  AND IS_ARRAY(a.alias_name_normalized_tokens)
  AND ARRAY_SIZE(a.alias_name_normalized_tokens::ARRAY) > 0;

-- ── TOKENS_SUMMARY ─────────────────────────────────────────────────────────────
-- standard / normalized rows: one row per token position per literal_value.
-- alias rows: one row per token position per alias_name_literal_value.
DELETE FROM TOKENS_SUMMARY
WHERE alias_item_id BETWEEN 32 AND 41
   OR alias_id BETWEEN 12 AND 21;

INSERT INTO TOKENS_SUMMARY (
  token, position_in_signature, alias_item_id, alias_id,
  signature_length, rarity, token_type, created_at, updated_at
)
VALUES
  -- alias_item_id=32  'Capital One'  →  capital|one  /  capital|one
  ('Capital', 1, 32, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('One',     2, 32, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Capital', 1, 32, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('One',     2, 32, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=33  'Google'
  ('Google', 1, 33, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Google', 1, 33, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=34  'Amazon'
  ('Amazon', 1, 34, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Amazon', 1, 34, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=35  'Microsoft'
  ('Microsoft', 1, 35, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Microsoft', 1, 35, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=36  'Apple'
  ('Apple', 1, 36, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Apple', 1, 36, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=37  'Walmart'
  ('Walmart', 1, 37, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Walmart', 1, 37, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=38  'Nike'
  ('Nike', 1, 38, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Nike', 1, 38, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=39  'Starbucks'
  ('Starbucks', 1, 39, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Starbucks', 1, 39, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=40  'Netflix'
  ('Netflix', 1, 40, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Netflix', 1, 40, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_item_id=41  'Boeing'
  ('Boeing', 1, 41, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('Boeing', 1, 41, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- ── alias tokens (token_type='alias') ──────────────────────────────────────
  -- alias_id=12  capital|one
  ('Capital', 1, NULL, 12, 2, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  ('One',     2, NULL, 12, 2, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),

  -- alias_id=13  google
  ('Google',    1, NULL, 13, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=14  amazon
  ('Amazon',    1, NULL, 14, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=15  microsoft
  ('Microsoft', 1, NULL, 15, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=16  apple
  ('Apple',     1, NULL, 16, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=17  walmart
  ('Walmart',   1, NULL, 17, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=18  nike
  ('Nike',      1, NULL, 18, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=19  starbucks
  ('Starbucks', 1, NULL, 19, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=20  netflix
  ('Netflix',   1, NULL, 20, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- alias_id=21  boeing
  ('Boeing',    1, NULL, 21, 1, 0, 'alias', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

-- ── TOKENS_SUMMARY: rarity ────────────────────────────────────────────────────
-- N = 10 aliases, all tokens unique to one alias → df = 1 for every token.
-- rarity = (token_count / alias_item_count) × (ln(N/df) / ln(N))
--        = (1/1) × (ln(10/1) / ln(10)) = 1.000000
UPDATE TOKENS_SUMMARY SET rarity = 1.000000, updated_at = CURRENT_TIMESTAMP()
WHERE token_type IN ('standard', 'normalized')
  AND alias_item_id BETWEEN 32 AND 41;

-- ── TOKENS_SUMMARY: importance_score = rarity × (0.75 + 0.25 / p^0.4)  [pure, no char_weight] ──
-- pos 1: 1.0 × (0.75 + 0.25/1^0.4) = 1.000000
-- pos 2: 1.0 × (0.75 + 0.25/2^0.4) = 0.939464
UPDATE TOKENS_SUMMARY ts
SET    importance_score = ts.rarity * (0.75 + 0.25 / POWER(ts.position_in_signature::FLOAT, 0.4)),
       updated_at       = CURRENT_TIMESTAMP()
WHERE  ts.token_type IN ('standard', 'normalized')
  AND  ts.alias_item_id BETWEEN 32 AND 41;

-- ── TOKENS_SUMMARY: alias token importance_score (concept 2) — pure, no char_weight ──
-- Alias tokens use rarity = 1.0; pure importance = pos_weight only.
UPDATE TOKENS_SUMMARY
SET    importance_score = 0.75 + 0.25 / POWER(position_in_signature::FLOAT, 0.4),
       updated_at       = CURRENT_TIMESTAMP()
WHERE  token_type = 'alias'
  AND  alias_id IN (SELECT alias_id FROM ALIASES WHERE concept_id = 2);

-- ── ALIAS_SUMMARY: importance scores ──────────────────────────────────────────
-- alias name rows: NULL (definitional, not token-weighted).
UPDATE ALIAS_SUMMARY
SET    importance_score = NULL, updated_at = CURRENT_TIMESTAMP()
WHERE  concept_id = 2
  AND  key_type = 'alias name';

-- Signature importance scores (pure, no char_weight).
-- Formula: score = s_pure / (s_pure + 1 + 0.2×(n−1))  where s_pure = Σ rarity × pos_weight per token.
-- All concept 2 tokens have rarity = 1.0.
--
-- Capital One  'Capital|One'  (n=2):
--   capital(p1) → 1.000000
--   one(p2)     → 0.939482
--   s_pure = 1.939482  →  1.939482 / (1.939482 + 1.0 + 0.2) = 1.939482 / 3.139482 = 0.617779
-- Apple  'Apple'  (n=1):
--   apple(p1) → 1.000000
--   s_pure = 1.0  →  1.0 / 2.0 = 0.500000
-- Nike  'Nike'  (n=1):
--   nike(p1) → 1.000000
--   s_pure = 1.0  →  0.500000
-- All others (single token): s_pure=1.0 → 0.500000

UPDATE ALIAS_SUMMARY SET importance_score = 0.617779, updated_at = CURRENT_TIMESTAMP()
WHERE alias_id = 12 AND key_type IN ('token signature', 'normalized token signature') AND key_value IN ('Capital|One');

UPDATE ALIAS_SUMMARY SET importance_score = 0.500000, updated_at = CURRENT_TIMESTAMP()
WHERE alias_id IN (13,14,15,16,17,18,19,20,21) AND key_type IN ('token signature', 'normalized token signature');

-- literal value and normalization value rows: keep importance_score = 1 (already set on INSERT).

-- ── ALIAS_SUMMARY: alias token signature importance (concept 2) ───────────────
-- Computed dynamically from TOKENS_SUMMARY (token_type='alias') importance_scores.
-- Formula (pure): s_pure / (s_pure + 1 + 0.2*(n-1))  where s_pure = Σ pos_weight per unique token.
-- Alias tokens have rarity = 1.0; pure importance = pos_weight only (char_weight decoupled).
--   Capital One: capital(p1)→1.0, one(p2)→0.939482; s_pure=1.939482 → 0.617779
--   Apple:  apple(p1)→1.0; s_pure=1.0 → 0.500000
--   Nike:   nike(p1)→1.0;  s_pure=1.0 → 0.500000
--   All other aliases (single token): s_pure=1.0 → 0.500000
UPDATE ALIAS_SUMMARY asm
SET    importance_score = scored.score,
       updated_at       = CURRENT_TIMESTAMP()
FROM (
    SELECT ts_grp.alias_id,
           SUM(ts_grp.max_importance) / (SUM(ts_grp.max_importance) + 1.0 + 0.2 * (COUNT(*)::FLOAT - 1.0)) AS score
    FROM (
        SELECT alias_id, token, MAX(importance_score) AS max_importance
        FROM   TOKENS_SUMMARY
        WHERE  token_type = 'alias'
          AND  alias_id IN (SELECT alias_id FROM ALIASES WHERE concept_id = 2)
        GROUP BY alias_id, token
    ) ts_grp
    GROUP BY ts_grp.alias_id
) scored
WHERE asm.alias_id   = scored.alias_id
  AND asm.key_type   = 'alias token signature'
  AND asm.concept_id = 2;

-- ── ALIAS_TOKEN_COUNT ─────────────────────────────────────────────────────────
-- One row per (alias_id, normalized_token).
-- token_count = number of distinct alias items in the alias containing the token.
-- Each alias has exactly one alias item here, so token_count = 1 throughout.
DELETE FROM ALIAS_TOKEN_COUNT WHERE alias_id BETWEEN 12 AND 21;

INSERT INTO ALIAS_TOKEN_COUNT (alias_id, normalized_token, token_count, created_at, updated_at)
VALUES
  -- alias_id=12  Capital One: two normalized tokens
  (12, 'Capital',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (12, 'One',       1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  -- single-token aliases
  (13, 'Google',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (14, 'Amazon',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (15, 'Microsoft', 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (16, 'Apple',     1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (17, 'Walmart',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (18, 'Nike',      1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (19, 'Starbucks', 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (20, 'Netflix',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (21, 'Boeing',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

-- ── GLOBAL_TOKEN_COUNT ────────────────────────────────────────────────────────
-- One row per (concept_id, normalized_token).
-- alias_token_count = number of distinct aliases containing the token.
-- All tokens are unique to their alias → alias_token_count = 1 for all.
DELETE FROM GLOBAL_TOKEN_COUNT WHERE concept_id = 2;

INSERT INTO GLOBAL_TOKEN_COUNT (concept_id, normalized_token, alias_token_count, created_at, updated_at)
VALUES
  (2, 'Capital',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'One',       1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Google',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Amazon',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Microsoft', 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Apple',     1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Walmart',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Nike',      1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Starbucks', 1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Netflix',   1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
  (2, 'Boeing',    1, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

-- ============================================================================
-- END OF COMPANY NAMES CONCEPT SEED
-- ============================================================================

-- -- ============================================================================
-- -- SAMPLE RUN DATA
-- -- Simulates a completed run that processed the mobile carrier values
-- -- ============================================================================


-- -- SAMPLE RUN DATA (temporarily disabled)
-- -- Simulates a completed run that processed the mobile carrier values

-- -- Insert a sample run
-- INSERT INTO RUNS (run_id, created_by, created_at, updated_at, concept_id, source_relation, source_column, mode, run_status, config_snapshot, started_at, completed_at)
-- VALUES (1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'RAW_DATA.PUBLIC.MOBILE_CARRIERS', 'CARRIER_NAME', 'review', 'completed', 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run groups (one group per alias)
-- INSERT INTO RUN_GROUPS (run_id, group_id, initial_alias_name, alias_name_literal_value, final_alias_id, is_user_created, created_at, updated_at)
-- VALUES 
--     (1, 1, 'AT&T', 'AT&T', 1, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon', 'Verizon', 2, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'T-Mobile', 'T-Mobile', 3, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 4, 'Sprint', 'Sprint', 4, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 5, 'Boost Mobile', 'Boost Mobile', 5, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 6, 'Cricket Wireless', 'Cricket Wireless', 6, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 7, 'Metro by T-Mobile', 'Metro by T-Mobile', 7, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 8, 'US Cellular', 'US Cellular', 8, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 9, 'MetroPCS', 'MetroPCS', 9, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for AT&T (group_id = 1)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 1, 'AT&T', 1, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'ATT', 2, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'A T & T', 1, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'American Telephone and Telegraph', 4, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'American Telephone & Telegraph Company', 5, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'AT and T', 6, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Verizon (group_id = 2)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 2, 'Verizon', 7, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Wireless', 8, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Wirless', 9, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'VZW', 10, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Communications', 11, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for T-Mobile (group_id = 3)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 3, 'T-Mobile', 12, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'T Mobile', 14, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'TMobile', 14, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'T-Mobile USA', 15, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Sprint (group_id = 4)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 4, 'Sprint', 16, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 4, 'Sprint PCS', 17, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Boost Mobile (group_id = 5)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 5, 'Boost Mobile', 18, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 5, 'Boost', 19, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Cricket Wireless (group_id = 6)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 6, 'Cricket', 20, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 6, 'Cricket Wireless', 21, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Metro by T-Mobile (group_id = 7)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 7, 'Metro by T-Mobile', 23, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for MetroPCS (group_id = 9)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 9, 'Metro PCS', 22, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for US Cellular (group_id = 8)
-- INSERT INTO RUN_ITEMS (run_id, group_id, literal_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES
--     (1, 8, 'US Cellular', 25, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run applied target (simulates the run being applied to create a standardized view)
-- INSERT INTO RUN_APPLIED_TARGETS (apply_id, run_id, applied_by, apply_started_at, apply_completed_at, apply_mode, target_relation, apply_status, rows_affected, cols_affected)
-- VALUES (1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'view', 'RAW_DATA.PUBLIC.MOBILE_CARRIERS_STANDARDIZED', 'success', 25, 1);



