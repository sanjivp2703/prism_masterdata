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
-- SEMANTIC_CONCEPTS
-- Stores semantic concepts used across runs and aliasing
-- ============================================================================

CREATE OR REPLACE TABLE SEMANTIC_CONCEPTS (
    concept_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_key VARCHAR NOT NULL,
    description VARCHAR,
    data_type VARCHAR NOT NULL,
    is_active BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT unique_concept_key UNIQUE (concept_key),
    CONSTRAINT fk_semantic_concepts_data_type FOREIGN KEY (data_type) REFERENCES LKP_DATA_TYPE(data_type)
);

-- ============================================================================
-- CONCEPT_ALIASES
-- Stores standardized alias values for each concept
-- ============================================================================

CREATE OR REPLACE TABLE CONCEPT_ALIASES (
    alias_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    concept_id INTEGER NOT NULL,
    alias_name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_concept_aliases_concept FOREIGN KEY (concept_id) REFERENCES SEMANTIC_CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_concept_aliases_status FOREIGN KEY (status) REFERENCES LKP_ALIAS_STATUS(status),
    CONSTRAINT unique_concept_alias UNIQUE (concept_id, alias_name)
);

-- ============================================================================
-- NORMALIZED_VALUES_ALIAS_VARIANTS
-- Stores canonical normalized values (not directly tied to an alias)
-- ============================================================================

CREATE OR REPLACE TABLE NORMALIZED_VALUES_ALIAS_VARIANTS (
    normalized_raw_value_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    normalized_raw_value VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT unique_normalized_raw_value UNIQUE (normalized_raw_value)
);

-- ============================================================================
-- RAW_VALUE_NORMALIZED_VARIANTS
-- Stores raw value variants that map to normalized values
-- Tracks all observed raw strings from source data
-- ============================================================================

CREATE OR REPLACE TABLE RAW_VALUE_NORMALIZED_VARIANTS (
    raw_value_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_id INTEGER NOT NULL,
    normalized_raw_value_id INTEGER NOT NULL,
    raw_value VARCHAR NOT NULL,
    confidence FLOAT,
    source VARCHAR NOT NULL,
    approved BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_raw_value_normalized_variants_alias FOREIGN KEY (alias_id) REFERENCES CONCEPT_ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_raw_value_normalized_variants_normalized FOREIGN KEY (normalized_raw_value_id) REFERENCES NORMALIZED_VALUES_ALIAS_VARIANTS(normalized_raw_value_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_raw_value_normalized_variants_source FOREIGN KEY (source) REFERENCES LKP_ALIAS_VALUE_SOURCE(source),
    CONSTRAINT unique_normalized_raw_value_raw UNIQUE (normalized_raw_value_id, raw_value)
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
    config_snapshot VARCHAR NOT NULL,
    stats_snapshot VARIANT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message VARCHAR,
    CONSTRAINT fk_runs_created_by FOREIGN KEY (created_by) REFERENCES USERS(user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_runs_concept FOREIGN KEY (concept_id) REFERENCES SEMANTIC_CONCEPTS(concept_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
    CONSTRAINT fk_run_groups_final_alias FOREIGN KEY (final_alias_id) REFERENCES CONCEPT_ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE SET NULL,
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
    normalized_raw_value VARCHAR NOT NULL,
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
    CONSTRAINT unique_run_item UNIQUE (run_id, normalized_raw_value)
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
-- SAMPLE DATA: Mobile Carrier Semantic Concept
-- ============================================================================

-- Insert semantic concept for mobile carriers
INSERT INTO SEMANTIC_CONCEPTS (concept_id, concept_key, description, data_type, is_active, created_at, updated_at)
VALUES (1, 'mobile_carrier', 'Mobile carrier/service provider names', 'string', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert concept aliases for mobile carriers
-- NOTE: Using explicit alias_id values for sample data to ensure referential integrity
-- The sequence will be synchronized after all sample data is inserted
INSERT INTO CONCEPT_ALIASES (alias_id, concept_id, alias_name, status, created_at, updated_at)
VALUES 
    (1, 1, 'AT&T', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (2, 1, 'Verizon', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 1, 'T-Mobile', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (4, 1, 'Sprint', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (5, 1, 'Boost Mobile', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (6, 1, 'Cricket Wireless', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (7, 1, 'Metro by T-Mobile', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 1, 'US Cellular', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (9, 1, 'MetroPCS', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for AT&T (alias_id = 1)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (1, 'AT&T', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (2, 'ATT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 'A T & T', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (4, 'American Telephone and Telegraph', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (5, 'American Telephone & Telegraph Company', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (6, 'AT and T', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for Verizon (alias_id = 2)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (7, 'Verizon', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 'Verizon Wireless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (9, 'Verizon Wirless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (10, 'VZW', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (11, 'Verizon Communications', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for T-Mobile (alias_id = 3)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (12, 'T-Mobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (13, 'T Mobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (14, 'TMobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (15, 'T-Mobile USA', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for Sprint (alias_id = 4)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (16, 'Sprint', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (17, 'Sprint PCS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for Boost Mobile (alias_id = 5)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (18, 'Boost Mobile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (19, 'Boost', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for Cricket Wireless (alias_id = 6)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (20, 'Cricket', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (21, 'Cricket Wireless', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for Metro by T-Mobile (alias_id = 7)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    -- All Metro variants normalize to the same canonical value
    (22, 'MetroPCS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert alias values for US Cellular (alias_id = 8)
INSERT INTO NORMALIZED_VALUES_ALIAS_VARIANTS (normalized_raw_value_id, normalized_raw_value, created_at, updated_at)
VALUES 
    (25, 'US Cellular', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);


-- ============================================================================
-- SAMPLE RAW VALUE VARIANTS
-- Maps raw observed values to their normalized counterparts
-- Each raw value maps to its own normalized value (1:1 mapping)
-- ============================================================================

-- Insert raw value variants for AT&T (mapping to normalized_raw_value_id 1-6)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (1, 1, 1, 'AT&T', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (2, 1, 2, 'ATT', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (3, 1, 3, 'A T & T', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (4, 1, 4, 'American Telephone and Telegraph', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (5, 1, 5, 'American Telephone & Telegraph Company', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (6, 1, 6, 'AT and T', 80, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for Verizon (mapping to normalized_raw_value_id 7-11)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (7, 2, 7, 'Verizon', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (8, 2, 8, 'Verizon Wireless', 93, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (9, 2, 9, 'Verizon Wirless', 70, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (10, 2, 10, 'VZW', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (11, 2, 11, 'Verizon Communications', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for T-Mobile (mapping to normalized_raw_value_id 12-15)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (12, 3, 12, 'T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (13, 3, 13, 'T Mobile', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (14, 3, 14, 'TMobile', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (15, 3, 15, 'T-Mobile USA', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for Sprint (mapping to normalized_raw_value_id 16-17)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (16, 4, 16, 'Sprint', 94, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (17, 4, 17, 'Sprint PCS', 88, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for Boost Mobile (mapping to normalized_raw_value_id 18-19)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (18, 5, 18, 'Boost Mobile', 96, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (19, 5, 19, 'Boost', 85, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for Cricket Wireless (mapping to normalized_raw_value_id 20-21)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    (20, 6, 20, 'Cricket', 87, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (21, 6, 21, 'Cricket Wireless', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for Metro (all normalize to normalized_raw_value_id 22 = 'MetroPCS')
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES 
    -- MetroPCS raw value maps to alias 'MetroPCS'
    (22, 9, 22, 'MetroPCS', 90, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    -- Metro by T-Mobile raw value maps to alias 'Metro by T-Mobile'
    (24, 7, 22, 'Metro by T-Mobile', 95, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert raw value variants for US Cellular (mapping to normalized_raw_value_id 25)
INSERT INTO RAW_VALUE_NORMALIZED_VARIANTS (raw_value_id, alias_id, normalized_raw_value_id, raw_value, confidence, source, approved, created_at, updated_at)
VALUES
    (25, 8, 25, 'US Cellular', 92, 'manual_review', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ============================================================================
-- SAMPLE RUN DATA
-- Simulates a completed run that processed the mobile carrier values
-- ============================================================================

-- Insert a sample run
INSERT INTO RUNS (run_id, created_by, created_at, updated_at, concept_id, source_relation, source_column, mode, run_status, config_snapshot, started_at, completed_at)
VALUES (1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'RAW_DATA.PUBLIC.MOBILE_CARRIERS', 'CARRIER_NAME', 'review', 'completed', 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run groups (one group per alias)
INSERT INTO RUN_GROUPS (run_id, group_id, initial_alias_name, alias_name, final_alias_id, is_user_created, created_at, updated_at)
VALUES 
    (1, 1, 'AT&T', 'AT&T', 1, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 2, 'Verizon', 'Verizon', 2, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 3, 'T-Mobile', 'T-Mobile', 3, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 4, 'Sprint', 'Sprint', 4, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 5, 'Boost Mobile', 'Boost Mobile', 5, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 6, 'Cricket Wireless', 'Cricket Wireless', 6, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 7, 'Metro by T-Mobile', 'Metro by T-Mobile', 7, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 8, 'US Cellular', 'US Cellular', 8, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 9, 'MetroPCS', 'MetroPCS', 9, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for AT&T (group_id = 1)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 1, 'AT&T', 'AT&T', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 1, 'ATT', 'ATT', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 1, 'A T & T', 'A T & T', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 1, 'American Telephone and Telegraph', 'American Telephone and Telegraph', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 1, 'American Telephone & Telegraph Company', 'American Telephone & Telegraph Company', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 1, 'AT and T', 'AT and T', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for Verizon (group_id = 2)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 2, 'Verizon', 'Verizon', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 2, 'Verizon Wireless', 'Verizon Wireless', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 2, 'Verizon Wirless', 'Verizon Wirless', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 2, 'VZW', 'VZW', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 2, 'Verizon Communications', 'Verizon Communications', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for T-Mobile (group_id = 3)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 3, 'T-Mobile', 'T-Mobile', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 3, 'T Mobile', 'T Mobile', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 3, 'TMobile', 'TMobile', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 3, 'T-Mobile USA', 'T-Mobile USA', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for Sprint (group_id = 4)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 4, 'Sprint', 'Sprint', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 4, 'Sprint PCS', 'Sprint PCS', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for Boost Mobile (group_id = 5)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 5, 'Boost Mobile', 'Boost Mobile', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 5, 'Boost', 'Boost', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for Cricket Wireless (group_id = 6)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 6, 'Cricket', 'Cricket', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (1, 6, 'Cricket Wireless', 'Cricket Wireless', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for Metro by T-Mobile (group_id = 7)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 7, 'Metro by T-Mobile', 'MetroPCS', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for MetroPCS (group_id = 9)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES 
    (1, 9, 'MetroPCS', 'MetroPCS', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run items for US Cellular (group_id = 8)
INSERT INTO RUN_ITEMS (run_id, group_id, raw_value, normalized_raw_value, confidence_score, decision_status, decided_by, decided_at, created_at, updated_at)
VALUES
    (1, 8, 'US Cellular', 'US Cellular', 1.0, 'approved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert run applied target (simulates the run being applied to create a standardized view)
INSERT INTO RUN_APPLIED_TARGETS (apply_id, run_id, applied_by, apply_started_at, apply_completed_at, apply_mode, target_relation, apply_status, rows_affected, cols_affected)
VALUES (1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'view', 'RAW_DATA.PUBLIC.MOBILE_CARRIERS_STANDARDIZED', 'success', 25, 1);


