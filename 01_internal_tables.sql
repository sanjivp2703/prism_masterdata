USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

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
    ('raw value'),
    ('normalized value'),
    ('token signature'),
    ('normalized token signature'),
    ('alias name'),
    ('alias token signature');

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

-- Seed: standard profile (v1)
INSERT INTO CLASSIFICATION_METADATA_PROFILES (profile_id, name, version, ruleset, is_active, created_at, updated_at)
SELECT
  1,
  'standard',
  1,
  PARSE_JSON('{
   "normalization": {
     "rules": [
       {"name": "unicode_nfkc", "enabled": false, "pre_tokenization": true},
       {"name": "remove_invisible_format", "enabled": false, "pre_tokenization": true},


       {"name": "lowercase", "enabled": true, "pre_tokenization": false},
       {"name": "diacritics_fold_latin", "enabled": false, "pre_tokenization": true},


       {"name": "deterministic_rewrites", "enabled": false, "pre_tokenization": true, "params": {"map": {}}},


       {"name": "strip_emojis_pictographs", "enabled": false, "pre_tokenization": true},
       {"name": "drop_ampersands", "enabled": true, "pre_tokenization": true},
       {"name": "drop_apostrophes", "enabled": true, "pre_tokenization": true, "params": {"mode": "remove"}},
       {"name": "drop_punctuation_runs_len_ge_2", "enabled": true, "pre_tokenization": true},


       {"name": "slash_to_space", "enabled": true, "pre_tokenization": true},
       {"name": "underscore_to_space", "enabled": true, "pre_tokenization": true},
       {"name": "collapse_internal_spaces", "enabled": false, "pre_tokenization": true},
       {"name": "normalize_whitespace_to_space", "enabled": true, "pre_tokenization": true},
       {"name": "normalize_ampersands", "enabled": true, "pre_tokenization": true},
       {"name": "normalize_at", "enabled": true, "pre_tokenization": true},
       {"name": "normalize_quotes", "enabled": true, "pre_tokenization": true},
       {"name": "brackets_to_space", "enabled": true, "pre_tokenization": true},
       {"name": "punctuation_to_space", "enabled": true, "pre_tokenization": true, "params": {"include_symbols": true, "protected_patterns": []}},


       {"name": "trim", "enabled": true, "pre_tokenization": true}
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
         "stopword_sets": {
           "enabled": ["carriers", "generic"],
           "sets": {
             "carriers": ["wireless", "cellular", "mobile"],
             "generic": ["the", "a", "an", "and", "of", "for", "to", "in", "on", "at", "by", "from"],
             "corporate_suffixes": ["inc", "llc", "ltd", "corp", "co", "company", "gmbh", "plc", "lp", "llp", "sa", "sarl", "bv", "nv", "ag", "kg", "pte", "pty"],
             "domain_suffixes": ["com", "net", "org", "io", "co"],
             "noise_words": ["unknown", "n/a", "na", "none", "null", "test", "sample"],
             "units": ["kg", "lbs", "lb", "oz", "g", "mg", "l", "ml", "cm", "mm", "m", "km", "ft", "in"]
           }
         },
         "token_deduplication": true,
         "max_token_frequency": 3
       }
     },
     "rules": [
       {"name": "deterministic_rewrites", "enabled": false, "params": {"map": {}}},
       {"name": "digit_grouping_normalization", "enabled": false},
       {"name": "number_word_digit_rewrite", "enabled": true, "params": {"words_to_numeric": false}},
       {"name": "lowercase", "enabled": true},
       {"name": "collapse_repeated_letters", "enabled": false},
       {"name": "join_tokens", "enabled": false, "params": {"separator": ""}}
     ]
   },
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
-- ALIASES
-- Stores standardized alias values for each concept
-- ============================================================================

CREATE OR REPLACE TABLE ALIASES (
    alias_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_id INTEGER NOT NULL,
    alias_name VARCHAR NOT NULL,
    alias_subgroup_id INTEGER NOT NULL,
    status VARCHAR NOT NULL,
    -- Tokenization of alias_name via the concept's classification ruleset (same pipeline as raw values).
    tokens VARIANT,
    token_count NUMBER,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_aliases_concept FOREIGN KEY (concept_id) REFERENCES CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_aliases_status FOREIGN KEY (status) REFERENCES LKP_ALIAS_STATUS(status),
    CONSTRAINT unique_concept_alias UNIQUE (concept_id, alias_name)
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
    importance_score FLOAT NOT NULL,
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
-- RAW_VALUES
-- Stores observed raw values and their validated alias mapping + derived classification metadata
-- Classification metadata is embedded directly in each raw value row.
-- ============================================================================

CREATE OR REPLACE TABLE RAW_VALUES (
    raw_value_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    -- Always associated to an alias (validation UI ensures every item is grouped before approval).
    alias_id INTEGER NOT NULL,
    profile_id INTEGER NOT NULL,
    raw_value VARCHAR NOT NULL,
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
    CONSTRAINT fk_raw_values_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_raw_values_profile FOREIGN KEY (profile_id) REFERENCES CLASSIFICATION_METADATA_PROFILES(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_raw_values_source FOREIGN KEY (source) REFERENCES LKP_ALIAS_VALUE_SOURCE(source),
    CONSTRAINT unique_profile_raw_value UNIQUE (profile_id, raw_value)
);

-- ============================================================================
-- TOKENS_SUMMARY
-- Per-token rows: token_type = standard | normalized (from RAW_VALUES) or alias (from ALIASES.tokens).
-- Refreshed by REFRESH_TOKENS_SUMMARY (same targeting pattern as REFRESH_ALIAS_SUMMARY).
-- ============================================================================

CREATE OR REPLACE TABLE TOKENS_SUMMARY (
    tokens_summary_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    token VARCHAR NOT NULL,
    position_in_signature INTEGER NOT NULL,
    -- standard / normalized: from RAW_VALUES; alias: from ALIASES.tokens (raw_value_id NULL).
    raw_value_id INTEGER,
    alias_id INTEGER,
    signature_length INTEGER NOT NULL,
    rarity FLOAT NOT NULL DEFAULT 0,
    token_type VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_tokens_summary_raw_value FOREIGN KEY (raw_value_id) REFERENCES RAW_VALUES(raw_value_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_tokens_summary_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE CASCADE
    -- token_type values: 'standard' | 'normalized' (raw_value_id set, alias_id NULL)
    --                    'alias'                   (alias_id set, raw_value_id NULL)
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
    config_snapshot VARCHAR NOT NULL,
    stats_snapshot VARIANT,
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
    alias_name VARCHAR,
    final_alias_id INTEGER,
    is_user_created BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT pk_run_groups PRIMARY KEY (run_id, group_id),
    CONSTRAINT fk_run_groups_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_groups_final_alias FOREIGN KEY (final_alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT unique_run_alias_name UNIQUE (run_id, alias_name)
);

-- ============================================================================
-- RUN_ITEMS
-- Stores decision items for each run
-- ============================================================================

CREATE OR REPLACE TABLE RUN_ITEMS (
    run_item_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    run_id INTEGER NOT NULL,
    group_id INTEGER,
    raw_value VARCHAR NOT NULL,
    -- Classification metadata is embedded directly in each run item row.
    profile_id INTEGER NOT NULL,
    normalization_value VARCHAR,
    tokens VARIANT,
    tokens_count NUMBER,
    normalized_tokens VARIANT,
    normalized_tokens_count NUMBER,
    confidence_score FLOAT,
    decision_status VARCHAR NOT NULL,
    decided_by INTEGER,
    decided_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_run_items_run FOREIGN KEY (run_id) REFERENCES RUNS(run_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_items_group FOREIGN KEY (run_id, group_id) REFERENCES RUN_GROUPS(run_id, group_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_run_items_decided_by FOREIGN KEY (decided_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_run_items_decision_status FOREIGN KEY (decision_status) REFERENCES LKP_DECISION_STATUS(decision_status),
    CONSTRAINT fk_run_items_profile FOREIGN KEY (profile_id) REFERENCES CLASSIFICATION_METADATA_PROFILES(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- One row per observed source string for a run.
    CONSTRAINT unique_run_item UNIQUE (run_id, raw_value)
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
VALUES (1, 'mobile_carrier', 'Mobile carrier/service provider names', 'string', 1, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert concept aliases for mobile carriers
-- -- NOTE: Using explicit alias_id values for sample data to ensure referential integrity
-- -- The sequence will be synchronized after all sample data is inserted
INSERT INTO ALIASES (alias_id, concept_id, alias_name, alias_subgroup_id, status, created_at, updated_at)
VALUES 
    (1, 1, 'AT&T', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (2, 1, 'Verizon', 2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 1, 'T-Mobile', 3, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (4, 1, 'Sprint', 4, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (5, 1, 'Boost Mobile', 5, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (6, 1, 'Cricket Wireless', 6, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (7, 1, 'Metro by T-Mobile', 7, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 1, 'US Cellular', 8, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (9, 1, 'MetroPCS', 9, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

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
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (1, 1, 1, 'AT&T', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (2, 1, 1, 'ATT', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 1, 1, 'A T & T', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (4, 1, 1, 'American Telephone and Telegraph', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (5, 1, 1, 'American Telephone & Telegraph Company', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (6, 1, 1, 'AT and T', 80, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Verizon (mapping to classification_metadata_id 7-11)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (7, 2, 1, 'Verizon', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 2, 1, 'Verizon Wireless', 93, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (9, 2, 1, 'Verizon Wirless', 70, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (10, 2, 1, 'VZW', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (11, 2, 1, 'Verizon Communications', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for T-Mobile (mapping to classification_metadata_id 12-15)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (12, 3, 1, 'T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (13, 3, 1, 'T Mobile', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (14, 3, 1, 'TMobile', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (15, 3, 1, 'T-Mobile USA', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Sprint (mapping to classification_metadata_id 16-17)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (16, 4, 1, 'Sprint', 94, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (17, 4, 1, 'Sprint PCS', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Boost Mobile (mapping to classification_metadata_id 18-19)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (18, 5, 1, 'Boost Mobile', 96, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (19, 5, 1, 'Boost', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Cricket Wireless (mapping to classification_metadata_id 20-21)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (20, 6, 1, 'Cricket', 87, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     (21, 6, 1, 'Cricket Wireless', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for Metro
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    -- MetroPCS raw value maps to alias 'MetroPCS'
    (22, 9, 1, 'MetroPCS', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    -- "Metro PCS" (space) normalizes to "MetroPCS"
    (23, 9, 1, 'Metro PCS', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--     -- Metro by T-Mobile raw value maps to alias 'Metro by T-Mobile'
--     (24, 7, 1, 'Metro by T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert raw values for US Cellular (mapping to classification_metadata_id 25)
INSERT INTO RAW_VALUES (
    raw_value_id, alias_id, profile_id, raw_value, confidence, source, approved, created_at, updated_at
)
VALUES
    (25, 8, 1, 'US Cellular', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Populate classification fields on sample RAW_VALUES so ALIAS_SUMMARY can include
-- normalized value, tokens, token signatures, normalized tokens, and normalized token signatures.
UPDATE RAW_VALUES rv
SET
  normalization_value = sub.pipeline:normalization_value::VARCHAR,
  tokens = sub.pipeline:tokens,
  tokens_count = sub.pipeline:tokens_count::NUMBER,
  normalized_tokens = sub.pipeline:normalized_tokens,
  normalized_tokens_count = sub.pipeline:normalized_tokens_count::NUMBER,
  updated_at = CURRENT_TIMESTAMP()
FROM (
  SELECT
    rv2.raw_value_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(rv2.raw_value, prof.ruleset) AS pipeline
  FROM RAW_VALUES rv2
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof
    ON prof.profile_id = rv2.profile_id
  WHERE rv2.raw_value_id BETWEEN 1 AND 25
) sub
WHERE rv.raw_value_id = sub.raw_value_id;

-- Tokenize canonical alias names (same ruleset as RAW_VALUES for this concept).
UPDATE ALIASES a
SET
  tokens = sub.pipeline:tokens,
  token_count = sub.pipeline:tokens_count::NUMBER,
  updated_at = CURRENT_TIMESTAMP()
FROM (
  SELECT
    a2.alias_id,
    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(a2.alias_name, prof.ruleset) AS pipeline
  FROM ALIASES a2
  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof ON prof.profile_id = c.profile_id
  WHERE a2.concept_id = 1
) sub
WHERE a.alias_id = sub.alias_id;

-- ============================================================================
-- SAMPLE ALIAS_SUMMARY DATA (manual seed — matches UI / worksheet snapshot)
-- Not derived from RAW_VALUES. Re-run safe: clears concept_id = 1 summary rows first.
-- ============================================================================

DELETE FROM ALIAS_SUMMARY WHERE concept_id = 1;


INSERT INTO ALIAS_SUMMARY (
  alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at
)
VALUES
  -- alias name
  (1, 1, 'alias name', 'AT&T', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'alias name', 'Verizon', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'alias name', 'Boost Mobile', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'alias name', 'T-Mobile', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'alias name', 'Sprint', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'alias name', 'Cricket Wireless', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'alias name', 'MetroPCS', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'alias name', 'US Cellular', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw value
  (2, 1, 'raw value', 'Verizon Wirless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'raw value', 'ATT', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'raw value', 'Verizon', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'raw value', 'US Cellular', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'raw value', 'T Mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'raw value', 'Cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'raw value', 'AT&T', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'raw value', 'Verizon Wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'raw value', 'T-Mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'raw value', 'Sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'raw value', 'Metro PCS', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'raw value', 'Boost Mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'raw value', 'A T & T', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'raw value', 'MetroPCS', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- normalized value
  (1, 1, 'normalized value', 'a t t', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'normalized value', 't mobile', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'normalized value', 'us cellular', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'normalized value', 'verizon wirless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'normalized value', 'metropcs', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'normalized value', 'metro pcs', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'normalized value', 'verizon wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'normalized value', 'cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'normalized value', 'boost mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'normalized value', 'verizon', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized value', 'att', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'normalized value', 'sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- token signature (pipe-separated; aligned with classification pipeline on sample RAW_VALUES)
  (2, 1, 'token signature', 'Verizon', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'token signature', 'Verizon|Wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'token signature', 'Boost|Mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'token signature', 'Verizon|Wirless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'token signature', 'Metro|PCS', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'token signature', 'US|Cellular', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'token signature', 'Sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'token signature', 'Cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'token signature', 'A|T|T', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'token signature', 'ATT', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'token signature', 'T|Mobile', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- normalized token signature
  (2, 1, 'normalized token signature', 'verizon', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'normalized token signature', 'verizon|wirless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 1, 'normalized token signature', 'verizon|wireless', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, 'normalized token signature', 't|mobile', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 1, 'normalized token signature', 'boost|mobile', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'normalized token signature', 'metropcs', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 1, 'normalized token signature', 'metro|pcs', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized token signature', 'att', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (1, 1, 'normalized token signature', 't', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 1, 'normalized token signature', 'cricket', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, 'normalized token signature', 'sprint', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8, 1, 'normalized token signature', 'us|cellular', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Alias token signatures (pipe-joined tokens of canonical alias names; must match ALIASES.tokens after pipeline update).
INSERT INTO ALIAS_SUMMARY (alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at)
SELECT
  a.alias_id,
  1,
  'alias token signature',
  ARRAY_TO_STRING(a.tokens::ARRAY, '|'),
  NULL,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM ALIASES a
WHERE a.concept_id = 1
  AND a.tokens IS NOT NULL
  AND IS_ARRAY(a.tokens)
  AND ARRAY_SIZE(a.tokens::ARRAY) > 0;

-- ============================================================================
-- SAMPLE TOKENS_SUMMARY (manual — one row per token position per RAW_VALUES row)
-- token_type: 'standard' and 'normalized' from pipeline tokens on each raw_value row.
-- Derived by splitting the token / normalized token signatures above for each raw_value_id.
-- ============================================================================

DELETE FROM TOKENS_SUMMARY
WHERE raw_value_id IN (1, 2, 3, 7, 8, 9, 12, 13, 16, 18, 20, 22, 23, 25)
   OR alias_id IN (1, 2, 3, 4, 5, 6, 7, 8, 9);

INSERT INTO TOKENS_SUMMARY (
  token, position_in_signature, raw_value_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
)
VALUES
  -- raw_value_id=1 'AT&T'  token sig A|T|T  /  norm att
  ('A', 1, 1, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 2, 1, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 3, 1, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 1, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=2 'ATT'
  ('ATT', 1, 2, NULL, 1, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 2, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=3 'A T & T'
  ('A', 1, 3, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 2, 3, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 3, 3, NULL, 3, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 3, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=7 'Verizon'
  ('Verizon', 1, 7, NULL, 1, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon', 1, 7, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=8 'Verizon Wireless'
  ('Verizon', 1, 8, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wireless', 2, 8, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon', 1, 8, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wireless', 2, 8, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=9 'Verizon Wirless'
  ('Verizon', 1, 9, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wirless', 2, 9, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon', 1, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wirless', 2, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=12 'T-Mobile'
  ('T', 1, 12, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 12, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('t', 1, 12, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 12, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=13 'T Mobile'
  ('T', 1, 13, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 13, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('t', 1, 13, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 13, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=16 'Sprint'
  ('Sprint', 1, 16, NULL, 1, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sprint', 1, 16, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=18 'Boost Mobile'
  ('Boost', 1, 18, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 18, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('boost', 1, 18, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 18, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=20 'Cricket'
  ('Cricket', 1, 20, NULL, 1, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cricket', 1, 20, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=22 'MetroPCS'
  ('Metro', 1, 22, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS', 2, 22, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metropcs', 1, 22, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=23 'Metro PCS'
  ('Metro', 1, 23, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS', 2, 23, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metropcs', 1, 23, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=25 'US Cellular'
  ('US', 1, 25, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Cellular', 2, 25, NULL, 2, 0, 'standard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('us', 1, 25, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cellular', 2, 25, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- token_type = 'alias': one row per token for each canonical alias name (alias_id set; raw_value_id NULL).
-- Populated from ALIASES.tokens after APPLY_CLASSIFICATION_PIPELINE; matches REFRESH_TOKENS_SUMMARY alias branch.
INSERT INTO TOKENS_SUMMARY (
  token, position_in_signature, raw_value_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
)
VALUES
  -- alias_id=1  ATT
  ('ATT', 1, NULL, 1, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=2  Verizon
  ('Verizon', 1, NULL, 2, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=3  T|Mobile
  ('T', 1, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=4  Sprint
  ('Sprint', 1, NULL, 4, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=5  Boost|Mobile
  ('Boost', 1, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=6  Cricket|Wireless
  ('Cricket', 1, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wireless', 2, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=7  Metro|by|T|Mobile
  ('Metro', 1, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('by', 2, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T', 3, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 4, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=8  US|Cellular
  ('US', 1, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Cellular', 2, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=9  Metro|PCS
  ('Metro', 1, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS', 2, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Optional: keep TOKENS_SUMMARY in sync after pipeline edits via CALL STAND_DB.STAND.REFRESH_TOKENS_SUMMARY(NULL);

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
-- INSERT INTO RUN_GROUPS (run_id, group_id, initial_alias_name, alias_name, final_alias_id, is_user_created, created_at, updated_at)
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
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 1, 'AT&T', 1, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'ATT', 2, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'A T & T', 1, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'American Telephone and Telegraph', 4, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'American Telephone & Telegraph Company', 5, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 1, 'AT and T', 6, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Verizon (group_id = 2)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 2, 'Verizon', 7, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Wireless', 8, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Wirless', 9, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'VZW', 10, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 2, 'Verizon Communications', 11, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for T-Mobile (group_id = 3)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 3, 'T-Mobile', 12, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'T Mobile', 14, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'TMobile', 14, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 3, 'T-Mobile USA', 15, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Sprint (group_id = 4)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 4, 'Sprint', 16, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 4, 'Sprint PCS', 17, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Boost Mobile (group_id = 5)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 5, 'Boost Mobile', 18, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 5, 'Boost', 19, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Cricket Wireless (group_id = 6)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 6, 'Cricket', 20, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
--     (1, 6, 'Cricket Wireless', 21, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for Metro by T-Mobile (group_id = 7)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 7, 'Metro by T-Mobile', 23, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for MetroPCS (group_id = 9)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES 
--     (1, 9, 'Metro PCS', 22, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run items for US Cellular (group_id = 8)
-- INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, classification_metadata_id, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
-- VALUES
--     (1, 8, 'US Cellular', 25, 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -- Insert run applied target (simulates the run being applied to create a standardized view)
-- INSERT INTO RUN_APPLIED_TARGETS (apply_id, run_id, applied_by, apply_started_at, apply_completed_at, apply_mode, target_relation, apply_status, rows_affected, cols_affected)
-- VALUES (1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'view', 'RAW_DATA.PUBLIC.MOBILE_CARRIERS_STANDARDIZED', 'success', 25, 1);



