USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

-- ============================================================================
-- ONE-PROMPT CLASSIFICATION TABLES
-- Parallel system for simplified LLM-based literal-value standardisation.
-- Runs are tracked in the standard RUNS table (no separate one-prompt run
-- table).  These tables hold only the one-prompt-specific state and audit
-- data.
-- ============================================================================

-- Drop the old ONE_PROMPT_RUNS-dependent tables first (FK order), then the
-- parent table itself.  Safe to run repeatedly.
DROP TABLE IF EXISTS ONE_PROMPT_LITERAL_ALIAS_MATCHES;
DROP TABLE IF EXISTS ONE_PROMPT_VALIDATION_LOG;
DROP TABLE IF EXISTS ONE_PROMPT_RUN_STATE;
DROP TABLE IF EXISTS ONE_PROMPT_RUNS;

-- ----------------------------------------------------------------------------
-- ONE_PROMPT_RUN_STATE
-- Single JSON blob holding full UI state for a run (groups + ungrouped items).
-- run_id references the standard RUNS table.
--
-- state schema:
-- {
--   "status": "created" | "running" | "complete" | "failed",
--   "items": [
--     { "literal_value": "VZW", "source_frequency": 14, "matched_from_lookup": false }
--   ],
--   "groups": [
--     {
--       "group_id": 1,
--       "alias_name": "Verizon",
--       "alias_name_source": "lookup_validated" | "llm_proposed" | "user_override",
--       "confidence": "h" | "m" | "l",
--       "from_lookup_chunk": true | false,
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
CREATE OR REPLACE TABLE ONE_PROMPT_RUN_STATE (
    run_id      INTEGER         PRIMARY KEY NOT NULL
                                REFERENCES RUNS(run_id),
    state       VARIANT         NOT NULL,
    updated_at  TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
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
-- run_id references the standard RUNS table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_PROMPT_LITERAL_ALIAS_MATCHES (
    literal_value   VARCHAR         PRIMARY KEY NOT NULL,
    alias_name      VARCHAR         NOT NULL,
    run_id          INTEGER         NOT NULL
                                    REFERENCES RUNS(run_id),
    confirmed_at    TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ----------------------------------------------------------------------------
-- ONE_PROMPT_VALIDATION_LOG
-- Audit trail of every human review decision made during post-export cleanup.
-- run_id references the standard RUNS table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE TABLE ONE_PROMPT_VALIDATION_LOG (
    id                  INTEGER         AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value       VARCHAR         NOT NULL,
    run_id              INTEGER         NOT NULL
                                        REFERENCES RUNS(run_id),
    original_alias_name VARCHAR         NOT NULL,
    user_changed_to     VARCHAR,
    llm_decision        VARCHAR         NOT NULL,
    decided_at          TIMESTAMP_NTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- ============================================================================
-- PUBLIC API PROCEDURE
-- ============================================================================

USE SCHEMA STAND;

-- ----------------------------------------------------------------------------
-- CREATE_ONE_PROMPT_RUN
-- Initialises the ONE_PROMPT_RUN_STATE blob for an already-existing run.
-- Reads literal values from RUN_ITEMS (populated by CREATE_RUN) and writes
-- the initial skeleton state blob.  Also queries the source table for
-- per-value frequencies.
--
-- Returns:
--   'OK: run_id=<n>'  on success
--   'ERROR: ...'      on any failure
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE CREATE_ONE_PROMPT_RUN(p_run_id INTEGER)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_step            VARCHAR   DEFAULT 'init';
    v_source_relation VARCHAR;
    v_source_column   VARCHAR;
    v_run_exists      INTEGER   DEFAULT 0;
    v_src_query       VARCHAR;
BEGIN
    -------------------------------------------------------------------------
    -- 1) Verify run exists in standard RUNS table
    -------------------------------------------------------------------------
    v_step := 'validate_run';

    SELECT COUNT(*), MAX(source_relation), MAX(source_column)
      INTO v_run_exists, v_source_relation, v_source_column
    FROM STAND_DB.STAND_INTERNAL.RUNS
    WHERE run_id = :p_run_id;

    IF (v_run_exists = 0) THEN
        RETURN 'ERROR: run_id ' || p_run_id || ' not found in RUNS';
    END IF;

    -------------------------------------------------------------------------
    -- 2) Build frequency table from source (same query CREATE_ONE_PROMPT_RUN
    --    used before, now driven by RUNS metadata)
    -------------------------------------------------------------------------
    v_step := 'build_items_temp';

    v_src_query :=
        'CREATE OR REPLACE TEMP TABLE TMP_OP_ITEMS AS ' ||
        'SELECT TO_VARCHAR(' || v_source_column || ') AS literal_value, ' ||
               'COUNT(*) AS source_frequency ' ||
        'FROM ' || v_source_relation || ' ' ||
        'WHERE ' || v_source_column || ' IS NOT NULL ' ||
        'GROUP BY TO_VARCHAR(' || v_source_column || ')';

    EXECUTE IMMEDIATE v_src_query;

    -------------------------------------------------------------------------
    -- 3) Write initial state blob
    -------------------------------------------------------------------------
    v_step := 'write_initial_state';

    MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUN_STATE AS tgt
    USING (
        WITH items_arr AS (
            SELECT ARRAY_AGG(
                OBJECT_CONSTRUCT(
                    'literal_value',       literal_value,
                    'source_frequency',    source_frequency,
                    'matched_from_lookup', FALSE
                )
            ) AS arr
            FROM TMP_OP_ITEMS
        )
        SELECT
            :p_run_id AS run_id,
            OBJECT_CONSTRUCT(
                'status',    'created',
                'items',     arr,
                'groups',    PARSE_JSON('[]'),
                'ungrouped', PARSE_JSON('[]')
            ) AS state
        FROM items_arr
    ) AS src ON tgt.run_id = src.run_id
    WHEN MATCHED THEN UPDATE SET
        tgt.state      = src.state,
        tgt.updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (run_id, state, updated_at)
        VALUES (src.run_id, src.state, CURRENT_TIMESTAMP());

    DROP TABLE IF EXISTS TMP_OP_ITEMS;

    RETURN 'OK: run_id=' || p_run_id;

EXCEPTION
    WHEN OTHER THEN
        DROP TABLE IF EXISTS TMP_OP_ITEMS;
        RETURN 'ERROR: STEP=' || v_step || ' SQLCODE=' || SQLCODE || ' SQLERRM=' || SQLERRM;
END;
$$;
