-- Run these setup commands in your worksheet before creating the procedure:
USE DATABASE STAND_DB;
USE SCHEMA STAND;

CREATE OR REPLACE PROCEDURE CREATE_RUN(
    p_concept_id INTEGER,
    table_fqn VARCHAR,
    column_name VARCHAR,
    mode VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_step VARCHAR DEFAULT 'init';

    -- IDs
    v_user_id INTEGER;
    v_user_cnt INTEGER DEFAULT 0;
    v_run_id INTEGER;

    -- Concept validation
    v_concept_exists INTEGER DEFAULT 0;
    v_concept_key VARCHAR;

    -- Dynamic SQL
    check_sql VARCHAR;
    v_source_values_query VARCHAR;
    stats_query VARCHAR;

    -- Stats
    v_row_count INTEGER DEFAULT 0;
    v_distinct_count INTEGER DEFAULT 0;
    v_null_count INTEGER DEFAULT 0;
    v_null_pct FLOAT DEFAULT 0.0;
    v_example_value VARCHAR;

    result_msg VARCHAR;
BEGIN
    -------------------------------------------------------------------------
    -- 1) Validate inputs
    -------------------------------------------------------------------------
    v_step := 'validate_inputs';

    IF (p_concept_id IS NULL) THEN
        RETURN 'ERROR: concept_id cannot be null';
    END IF;

    IF (table_fqn IS NULL OR TRIM(table_fqn) = '') THEN
        RETURN 'ERROR: table_fqn cannot be blank';
    END IF;

    IF (column_name IS NULL OR TRIM(column_name) = '') THEN
        RETURN 'ERROR: column_name cannot be blank';
    END IF;

    IF (mode IS NULL OR TRIM(mode) = '') THEN
        RETURN 'ERROR: mode cannot be blank';
    END IF;

    IF (mode NOT IN ('preview', 'review', 'auto')) THEN
        RETURN 'ERROR: mode must be one of: preview, review, auto';
    END IF;

    -------------------------------------------------------------------------
    -- 2) Validate concept exists
    -------------------------------------------------------------------------
    v_step := 'validate_concept';

    SELECT COUNT(*), MAX(concept_key)
      INTO v_concept_exists, v_concept_key
    FROM STAND_DB.STAND_INTERNAL.SEMANTIC_CONCEPTS
    WHERE concept_id = :p_concept_id
      AND is_active = TRUE;

    IF (v_concept_exists = 0) THEN
        RETURN 'ERROR: concept_id ' || p_concept_id || ' does not exist or is not active';
    END IF;

    -------------------------------------------------------------------------
    -- 3) Resolve current user (hard fail if duplicates)
    -------------------------------------------------------------------------
    v_step := 'resolve_user';

    SELECT COUNT(*), MAX(user_id)
      INTO v_user_cnt, v_user_id
    FROM STAND_DB.STAND_INTERNAL.USERS
    WHERE snowflake_user = CURRENT_USER()
      AND is_active = TRUE;

    IF (v_user_cnt = 0 OR v_user_id IS NULL) THEN
        RETURN 'ERROR: Current user ' || CURRENT_USER() || ' not found as active in USERS table';
    END IF;

    IF (v_user_cnt > 1) THEN
        RETURN 'ERROR: Multiple active USERS rows found for snowflake_user=' || CURRENT_USER()
             || '. Make only one row active.';
    END IF;

    -------------------------------------------------------------------------
    -- 4) Probe table exists / accessible (simple probe)
    -------------------------------------------------------------------------
    v_step := 'probe_table_access';

    BEGIN
        check_sql := 'SELECT 1 FROM ' || table_fqn || ' LIMIT 1';
        EXECUTE IMMEDIATE check_sql;
    EXCEPTION
        WHEN OTHER THEN
            RETURN 'ERROR: Table ' || table_fqn || ' does not exist or you do not have access';
    END;

    -------------------------------------------------------------------------
    -- 5) Insert RUNS (let AUTOINCREMENT generate run_id)
    -------------------------------------------------------------------------
    v_step := 'insert_run';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUNS (
        created_by, created_at, updated_at,
        concept_id, source_relation, source_column,
        mode, run_status, config_snapshot
    )
    
    SELECT
        :v_user_id, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(),
        :p_concept_id, :table_fqn, :column_name,
        :mode, 'created', 'v1';

    -- Get the auto-generated run_id from the row we just inserted
    -- Since this is in the same session and we just inserted it, MAX will give us the latest
    SELECT MAX(run_id) INTO v_run_id 
    FROM STAND_DB.STAND_INTERNAL.RUNS 
    WHERE created_by = :v_user_id
      AND concept_id = :p_concept_id
      AND source_relation = :table_fqn
      AND source_column = :column_name;
    
    -------------------------------------------------------------------------
    -- 6) TMP_SOURCE_VALUES (distinct non-null values)
    -------------------------------------------------------------------------
    v_step := 'tmp_source_values_create';

    CREATE OR REPLACE TEMP TABLE TMP_SOURCE_VALUES (
        raw_value VARCHAR
    );

    v_step := 'tmp_source_values_fill';

    -- NOTE: column_name + table_fqn are concatenated; assume caller is trusted.
    -- We normalize to VARCHAR for matching.
    v_source_values_query :=
        'INSERT INTO TMP_SOURCE_VALUES (raw_value) ' ||
        'SELECT DISTINCT TO_VARCHAR(' || column_name || ') ' ||
        'FROM ' || table_fqn || ' ' ||
        'WHERE ' || column_name || ' IS NOT NULL';

    EXECUTE IMMEDIATE v_source_values_query;

    -------------------------------------------------------------------------
    -- 7) TMP_MATCHES: values that map to an alias for this concept
    -------------------------------------------------------------------------
    v_step := 'tmp_matches_create';

    CREATE OR REPLACE TEMP TABLE TMP_MATCHES AS
    SELECT
        sv.raw_value                         AS raw_value,
        sv.raw_value                         AS normalized_raw_value,  -- placeholder normalization
        ca.alias_id                          AS alias_id,
        ca.alias_name                        AS alias_name
    FROM TMP_SOURCE_VALUES sv
    JOIN STAND_DB.STAND_INTERNAL.NORMALIZED_VALUES_ALIAS_VARIANTS nvav
      ON nvav.normalized_raw_value = sv.raw_value
    JOIN STAND_DB.STAND_INTERNAL.CONCEPT_ALIASES ca
      ON ca.alias_id = nvav.alias_id
    WHERE ca.concept_id = :p_concept_id
      AND ca.status = 'active';

    -------------------------------------------------------------------------
    -- 8) Insert RUN_GROUPS (one per alias in TMP_MATCHES)
    --    group_id is generated by table default (AUTOINCREMENT)
    -------------------------------------------------------------------------
    v_step := 'insert_run_groups';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
        run_id, initial_alias_name, alias_name,
        final_alias_id, is_user_created, created_at, updated_at
    )
    SELECT
        :v_run_id,
        m.alias_name,
        m.alias_name,
        m.alias_id,
        FALSE,
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM (
        SELECT DISTINCT alias_id, alias_name
        FROM TMP_MATCHES
    ) m;

    -------------------------------------------------------------------------
    -- 9) Insert RUN_ITEMS by joining TMP_MATCHES to RUN_GROUPS
    -------------------------------------------------------------------------
    v_step := 'insert_run_items';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_ITEMS (
        run_id, group_id, raw_value, normalized_raw_value,
        confidence_score, decision_status, created_at, updated_at
    )
    SELECT
        :v_run_id,
        rg.group_id,
        m.raw_value,
        m.normalized_raw_value,
        1.0,
        'pending',
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM TMP_MATCHES m
    JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
      ON rg.run_id = :v_run_id
     AND rg.final_alias_id = m.alias_id;

    -------------------------------------------------------------------------
    -- 10) Stats for review mode
    -------------------------------------------------------------------------
    IF (mode = 'review') THEN
        v_step := 'stats_create_tmp';

        CREATE OR REPLACE TEMP TABLE TMP_STATS (
            cnt NUMBER,
            val VARCHAR
        );

        -- row count
        v_step := 'stats_row_count';
        stats_query := 'INSERT INTO TMP_STATS (cnt) SELECT COUNT(*) FROM ' || table_fqn;
        EXECUTE IMMEDIATE stats_query;
        SELECT MAX(cnt) INTO v_row_count FROM TMP_STATS;
        TRUNCATE TABLE TMP_STATS;

        -- distinct count
        v_step := 'stats_distinct_count';
        stats_query := 'INSERT INTO TMP_STATS (cnt) SELECT COUNT(DISTINCT ' || column_name || ') FROM ' || table_fqn;
        EXECUTE IMMEDIATE stats_query;
        SELECT MAX(cnt) INTO v_distinct_count FROM TMP_STATS;
        TRUNCATE TABLE TMP_STATS;

        -- null count
        v_step := 'stats_null_count';
        stats_query := 'INSERT INTO TMP_STATS (cnt) SELECT (COUNT(*) - COUNT(' || column_name || ')) FROM ' || table_fqn;
        EXECUTE IMMEDIATE stats_query;
        SELECT MAX(cnt) INTO v_null_count FROM TMP_STATS;
        TRUNCATE TABLE TMP_STATS;

        IF (v_row_count > 0) THEN
            v_null_pct := (v_null_count::FLOAT / v_row_count::FLOAT) * 100;
        END IF;

        -- most common value
        v_step := 'stats_most_common';
        stats_query :=
            'INSERT INTO TMP_STATS (val) SELECT COALESCE(' ||
            '  (SELECT TO_VARCHAR(' || column_name || ') ' ||
            '   FROM ' || table_fqn ||
            '   WHERE ' || column_name || ' IS NOT NULL ' ||
            '   GROUP BY TO_VARCHAR(' || column_name || ') ' ||
            '   ORDER BY COUNT(*) DESC LIMIT 1), ' ||
            '  ''[null]'')';
        EXECUTE IMMEDIATE stats_query;
        SELECT MAX(val) INTO v_example_value FROM TMP_STATS;
        TRUNCATE TABLE TMP_STATS;

        IF (v_example_value IS NULL) THEN
            v_example_value := '[null]';
        END IF;

        result_msg :=
'
✓  RUN CREATED - Review Required

Run ID: ' || v_run_id || '
Concept: ' || v_concept_key || ' (ID: ' || p_concept_id || ')
Target:  ' || table_fqn || '.' || column_name || '

Rows:     ' || v_row_count || '
Distinct: ' || v_distinct_count || '
Nulls:    ' || v_null_count || ' (' || ROUND(v_null_pct, 1) || '%)
Top:      ' || v_example_value || '

Review URL:
  http://localhost:8000/run/' || v_run_id || '
';
    ELSE
        result_msg :=
'
✓  RUN CREATED SUCCESSFULLY

Run ID: ' || v_run_id || '
Concept: ' || v_concept_key || ' (ID: ' || p_concept_id || ')
Target:  ' || table_fqn || '.' || column_name || '
';
    END IF;

    DROP TABLE IF EXISTS TMP_SOURCE_VALUES;
    DROP TABLE IF EXISTS TMP_MATCHES;
    DROP TABLE IF EXISTS TMP_STATS;

    RETURN result_msg;

EXCEPTION
    WHEN OTHER THEN
        RETURN 'ERROR: STEP=' || v_step || ' SQLCODE=' || SQLCODE || ' SQLERRM=' || SQLERRM;
END;
$$;
