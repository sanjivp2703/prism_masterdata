-- Run these setup commands in your worksheet before creating the procedure:
USE DATABASE STAND_DB;
USE SCHEMA STAND;

CREATE OR REPLACE PROCEDURE CREATE_RUN(
    p_concept_key VARCHAR,
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
    v_concept_id INTEGER;
    v_profile_id INTEGER;
    v_ruleset VARIANT;

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

    IF (p_concept_key IS NULL OR TRIM(p_concept_key) = '') THEN
        RETURN 'ERROR: concept_key cannot be blank';
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

    -- concept_key is UNIQUE (enforced by CONCEPTS.unique_concept_key)
    SELECT COUNT(*), MAX(concept_id), MAX(concept_key)
      INTO v_concept_exists, v_concept_id, v_concept_key
    FROM STAND_DB.STAND_INTERNAL.CONCEPTS
    WHERE concept_key = :p_concept_key
      AND is_active = TRUE;

    IF (v_concept_exists = 0) THEN
        RETURN 'ERROR: concept_key ' || p_concept_key || ' does not exist or is not active';
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
        :v_concept_id, :table_fqn, :column_name,
        :mode, 'created', 'v1';

    -- Get the auto-generated run_id from the row we just inserted
    -- Since this is in the same session and we just inserted it, MAX will give us the latest
    SELECT MAX(run_id) INTO v_run_id 
    FROM STAND_DB.STAND_INTERNAL.RUNS 
    WHERE created_by = :v_user_id
      AND concept_id = :v_concept_id
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
    -- 6b) Classification metadata step (v1)
    --     Compute metadata from the concept profile ruleset and keep it at the value-level.
    --     No separate CLASSIFICATION_METADATA table is used.
    -------------------------------------------------------------------------
    v_step := 'profile_ruleset_load';

    SELECT c.profile_id, p.ruleset
      INTO v_profile_id, v_ruleset
    FROM STAND_DB.STAND_INTERNAL.CONCEPTS c
    JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p
      ON p.profile_id = c.profile_id
    WHERE c.concept_id = :v_concept_id
    LIMIT 1;

    v_step := 'tmp_source_values_meta_create';

    CREATE OR REPLACE TEMP TABLE TMP_SOURCE_VALUES_META AS
    WITH d AS (
        SELECT
            raw_value,
            STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(raw_value, :v_ruleset):normalization_value::VARCHAR AS normalization_value
        FROM TMP_SOURCE_VALUES
    )
    SELECT
        d.raw_value AS raw_value,
        :v_profile_id AS profile_id,
        d.normalization_value AS normalization_value,
        STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(d.raw_value, :v_ruleset):tokens AS tokens,
        STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(d.raw_value, :v_ruleset):tokens_count::NUMBER AS tokens_count,
        STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(d.raw_value, :v_ruleset):normalized_tokens AS normalized_tokens,
        STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(d.raw_value, :v_ruleset):normalized_tokens_count::NUMBER AS normalized_tokens_count
    FROM d
    ;

    -------------------------------------------------------------------------
    -- 7) TMP_MATCHES: values that map to an alias for this concept
    -------------------------------------------------------------------------
    v_step := 'tmp_matches_create';

    -- Algorithm:
    --  - If raw value is known for this concept (exact match in ALIAS_SUMMARY key_type='raw value'), assign a direct alias match.
    --  - Else leave it ungrouped for the alias_summary-based classification step below.
    --  Scoring / matching uses only ALIAS_SUMMARY + TOKENS_SUMMARY (not RAW_VALUES / ALIASES).
    CREATE OR REPLACE TEMP TABLE TMP_MATCHES AS
    WITH
    direct_candidates AS (
        SELECT
            svm.raw_value AS raw_value,
            svm.profile_id AS profile_id,
            svm.normalization_value AS normalization_value,
            svm.tokens AS tokens,
            svm.tokens_count AS tokens_count,
            svm.normalized_tokens AS normalized_tokens,
            svm.normalized_tokens_count AS normalized_tokens_count,
            s_raw.alias_id AS alias_id,
            s_name.key_value AS alias_name,
            0 AS confidence_score,
            'direct' AS match_type,
            ROW_NUMBER() OVER (
                PARTITION BY svm.raw_value
                ORDER BY
                  s_raw.alias_id ASC,
                  s_raw.alias_summary_id ASC
            ) AS rn
        FROM TMP_SOURCE_VALUES_META svm
        INNER JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s_raw
          ON s_raw.concept_id = :v_concept_id
         AND s_raw.key_type = 'raw value'
         AND s_raw.key_value = svm.raw_value
        INNER JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s_name
          ON s_name.concept_id = s_raw.concept_id
         AND s_name.alias_id = s_raw.alias_id
         AND s_name.key_type = 'alias name'
         AND s_name.key_value IS NOT NULL
    )
    SELECT
        raw_value,
        profile_id,
        normalization_value,
        tokens,
        tokens_count,
        normalized_tokens,
        normalized_tokens_count,
        alias_id,
        alias_name,
        confidence_score,
        match_type
    FROM direct_candidates
    WHERE rn = 1;

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

    -- Always insert one RUN_ITEMS row per source value. Unmatched values remain ungrouped (group_id NULL).
    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_ITEMS (
        run_id, group_id, raw_value, profile_id,
        normalization_value, tokens, tokens_count, normalized_tokens, normalized_tokens_count,
        confidence_score, decision_status, created_at, updated_at
    )
    SELECT
        :v_run_id,
        NULL,
        svm.raw_value,
        svm.profile_id,
        svm.normalization_value,
        svm.tokens,
        svm.tokens_count,
        svm.normalized_tokens,
        svm.normalized_tokens_count,
        0,
        'pending',
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM TMP_SOURCE_VALUES_META svm;

    -- Assign group_id to directly matched values.
    UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
    SET
        group_id = rg.group_id,
        confidence_score = 0
    FROM TMP_MATCHES m
    JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
      ON rg.run_id = :v_run_id
     AND rg.final_alias_id = m.alias_id
    WHERE ri.run_id = :v_run_id
      AND ri.raw_value = m.raw_value;

    -------------------------------------------------------------------------
    -- 9b) Classification algorithm for still-unclassified run items.
    --     Uses only RUN_ITEMS + ALIAS_SUMMARY + TOKENS_SUMMARY for scoring (no ALIASES / RAW_VALUES).
    --     Highest confidence score wins per run_item.
    -------------------------------------------------------------------------
    v_step := 'classification_unclassified_build_inputs';

    CREATE OR REPLACE TEMP TABLE TMP_UNGROUPED_RUN_ITEMS AS
    SELECT
      ri.run_item_id,
      ri.run_id,
      ri.raw_value,
      ri.normalization_value,
      ri.tokens,
      ri.normalized_tokens
    FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
    WHERE ri.run_id = :v_run_id
      AND ri.group_id IS NULL;

    CREATE OR REPLACE TEMP TABLE TMP_ALIAS_CANDIDATES AS
    SELECT
      s.alias_id,
      s.concept_id,
      s.key_value AS alias_name
    FROM STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s
    WHERE s.concept_id = :v_concept_id
      AND s.key_type = 'alias name'
      AND s.key_value IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY s.alias_id ORDER BY s.alias_summary_id ASC) = 1;

    -- Pre-flatten tokens (do not use LATERAL FLATTEN inside EXISTS / SELECT-list subqueries:
    -- Snowflake raises SQL 2031 "Unsupported subquery type".)
    CREATE OR REPLACE TEMP TABLE TMP_UNGROUPED_FLAT_TOKENS AS
    SELECT
      ri.run_item_id,
      t.value::VARCHAR AS token_val
    FROM TMP_UNGROUPED_RUN_ITEMS ri,
    LATERAL FLATTEN(input => ri.tokens) t
    WHERE ri.tokens IS NOT NULL
      AND IS_ARRAY(ri.tokens)
      AND t.value IS NOT NULL;

    CREATE OR REPLACE TEMP TABLE TMP_UNGROUPED_FLAT_NORM_TOKENS AS
    SELECT
      ri.run_item_id,
      nt.value::VARCHAR AS token_val
    FROM TMP_UNGROUPED_RUN_ITEMS ri,
    LATERAL FLATTEN(input => ri.normalized_tokens) nt
    WHERE ri.normalized_tokens IS NOT NULL
      AND IS_ARRAY(ri.normalized_tokens)
      AND nt.value IS NOT NULL;

    v_step := 'classification_unclassified_score';

    CREATE OR REPLACE TEMP TABLE TMP_UNCLASSIFIED_SCORES AS
    WITH scored AS (
      SELECT
        ri.run_item_id,
        ri.run_id,
        ri.raw_value,
        ri.normalization_value,
        ri.tokens,
        ri.normalized_tokens,
        ac.alias_id,
        ac.alias_name,

        /* 1) raw_value exact match */
        (s1.alias_summary_id IS NOT NULL) AS step_1_raw_value_match,

        /* 2) normalization_value exact match */
        (s2.alias_summary_id IS NOT NULL) AS step_2_normalization_value_match,

        /* 3) token signature (pipe-joined) */
        (s3.pipe_sig IS NOT NULL) AS step_3_token_signature_match,

        /* 4) any token matches key_type='token' */
        (s4.hit IS NOT NULL) AS step_4_any_token_match,

        /* 5) normalized token signature */
        (s5.pipe_sig IS NOT NULL) AS step_5_normalized_token_signature_match,

        /* 6) any normalized token matches key_type='normalized token' */
        (s6.hit IS NOT NULL) AS step_6_any_normalized_token_match,

        /* 7) alias name vs raw / norm / any token */
        (
          ac.alias_name = ri.raw_value
          OR ac.alias_name = ri.normalization_value
          OR ft7.run_item_id IS NOT NULL
          OR fn7.run_item_id IS NOT NULL
        ) AS step_7_matches_alias_name
      FROM TMP_UNGROUPED_RUN_ITEMS ri
      CROSS JOIN TMP_ALIAS_CANDIDATES ac
      LEFT JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s1
        ON s1.concept_id = ac.concept_id
       AND s1.alias_id = ac.alias_id
       AND s1.key_type = 'raw value'
       AND s1.key_value = ri.raw_value
      LEFT JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s2
        ON s2.concept_id = ac.concept_id
       AND s2.alias_id = ac.alias_id
       AND s2.key_type = 'normalized value'
       AND s2.key_value = ri.normalization_value
      LEFT JOIN (
        SELECT
          ts.alias_id,
          LISTAGG(ts.token, '|') WITHIN GROUP (ORDER BY ts.position_in_signature) AS pipe_sig
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
        WHERE ts.token_type = 'alias'
          AND ts.alias_id IS NOT NULL
        GROUP BY ts.alias_id
      ) s3
        ON s3.alias_id = ac.alias_id
       AND s3.pipe_sig = IFF(
            ri.tokens IS NOT NULL AND IS_ARRAY(ri.tokens) AND ARRAY_SIZE(ri.tokens::ARRAY) > 0,
            ARRAY_TO_STRING(ri.tokens::ARRAY, '|'),
            NULL
          )
      LEFT JOIN (
        SELECT DISTINCT
          ft.run_item_id,
          ts.alias_id,
          1 AS hit
        FROM TMP_UNGROUPED_FLAT_TOKENS ft
        INNER JOIN STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
          ON ts.token = ft.token_val
         AND ts.token_type = 'alias'
         AND ts.alias_id IS NOT NULL
      ) s4
        ON s4.run_item_id = ri.run_item_id
       AND s4.alias_id = ac.alias_id
      LEFT JOIN (
        SELECT
          ts.alias_id,
          LISTAGG(ts.token, '|') WITHIN GROUP (ORDER BY ts.position_in_signature) AS pipe_sig
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
        WHERE ts.token_type = 'alias'
          AND ts.alias_id IS NOT NULL
        GROUP BY ts.alias_id
      ) s5
        ON s5.alias_id = ac.alias_id
       AND s5.pipe_sig = IFF(
            ri.normalized_tokens IS NOT NULL
            AND IS_ARRAY(ri.normalized_tokens)
            AND ARRAY_SIZE(ri.normalized_tokens::ARRAY) > 0,
            ARRAY_TO_STRING(ri.normalized_tokens::ARRAY, '|'),
            NULL
          )
      LEFT JOIN (
        SELECT DISTINCT
          ft.run_item_id,
          ts.alias_id,
          1 AS hit
        FROM TMP_UNGROUPED_FLAT_NORM_TOKENS ft
        INNER JOIN STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
          ON ts.token = ft.token_val
         AND ts.token_type = 'alias'
         AND ts.alias_id IS NOT NULL
      ) s6
        ON s6.run_item_id = ri.run_item_id
       AND s6.alias_id = ac.alias_id
      LEFT JOIN (
        SELECT DISTINCT run_item_id, token_val
        FROM TMP_UNGROUPED_FLAT_TOKENS
      ) ft7
        ON ft7.run_item_id = ri.run_item_id
       AND ft7.token_val = ac.alias_name
      LEFT JOIN (
        SELECT DISTINCT run_item_id, token_val
        FROM TMP_UNGROUPED_FLAT_NORM_TOKENS
      ) fn7
        ON fn7.run_item_id = ri.run_item_id
       AND fn7.token_val = ac.alias_name
    )
    SELECT
      run_item_id,
      run_id,
      raw_value,
      normalization_value,
      tokens,
      normalized_tokens,
      alias_id,
      alias_name,
      step_1_raw_value_match,
      step_2_normalization_value_match,
      step_3_token_signature_match,
      step_4_any_token_match,
      step_5_normalized_token_signature_match,
      step_6_any_normalized_token_match,
      step_7_matches_alias_name,
      (
        IFF(step_1_raw_value_match, 1, 0)
        + IFF(step_2_normalization_value_match, 1, 0)
        + IFF(step_3_token_signature_match, 1, 0)
        + IFF(step_4_any_token_match, 1, 0)
        + IFF(step_5_normalized_token_signature_match, 1, 0)
        + IFF(step_6_any_normalized_token_match, 1, 0)
        + IFF(step_7_matches_alias_name, 1, 0)
      ) AS confidence_score,
      ROW_NUMBER() OVER (
        PARTITION BY run_item_id
        ORDER BY
          (
            IFF(step_1_raw_value_match, 1, 0)
            + IFF(step_2_normalization_value_match, 1, 0)
            + IFF(step_3_token_signature_match, 1, 0)
            + IFF(step_4_any_token_match, 1, 0)
            + IFF(step_5_normalized_token_signature_match, 1, 0)
            + IFF(step_6_any_normalized_token_match, 1, 0)
            + IFF(step_7_matches_alias_name, 1, 0)
          ) DESC,
          alias_id ASC
      ) AS rn
    FROM scored;

    CREATE OR REPLACE TEMP TABLE TMP_UNCLASSIFIED_BEST AS
    SELECT
      run_item_id,
      run_id,
      alias_id,
      alias_name,
      confidence_score
    FROM TMP_UNCLASSIFIED_SCORES
    WHERE rn = 1;

    v_step := 'classification_unclassified_create_groups';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
      run_id, initial_alias_name, alias_name, final_alias_id, is_user_created, created_at, updated_at
    )
    SELECT
      :v_run_id,
      b.alias_name,
      b.alias_name,
      b.alias_id,
      FALSE,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM (
      SELECT DISTINCT alias_id, alias_name
      FROM TMP_UNCLASSIFIED_BEST
    ) b
    WHERE NOT EXISTS (
      SELECT 1
      FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
      WHERE rg.run_id = :v_run_id
        AND rg.final_alias_id = b.alias_id
    );

    v_step := 'classification_unclassified_apply';

    UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
    SET
      group_id = rg.group_id,
      confidence_score = b.confidence_score
    FROM TMP_UNCLASSIFIED_BEST b
    JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
      ON rg.run_id = :v_run_id
     AND rg.final_alias_id = b.alias_id
    WHERE ri.run_id = :v_run_id
      AND ri.group_id IS NULL
      AND ri.run_item_id = b.run_item_id;

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
Concept: ' || v_concept_key || ' (ID: ' || v_concept_id || ')
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
Concept: ' || v_concept_key || ' (ID: ' || v_concept_id || ')
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

CREATE OR REPLACE PROCEDURE REFRESH_ALIAS_SUMMARY(
    p_alias_id INTEGER
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_rows_deleted INTEGER DEFAULT 0;
    v_rows_inserted INTEGER DEFAULT 0;
BEGIN
    -- If p_alias_id is NULL, refresh all aliases.
    CREATE OR REPLACE TEMP TABLE TMP_TARGET_ALIASES AS
    SELECT a.alias_id, a.concept_id
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    WHERE :p_alias_id IS NULL OR a.alias_id = :p_alias_id;

    DELETE FROM STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s
    WHERE EXISTS (
      SELECT 1
      FROM TMP_TARGET_ALIASES t
      WHERE t.alias_id = s.alias_id
    );
    v_rows_deleted := SQLROWCOUNT;

    INSERT INTO STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY (
      alias_id, concept_id, key_type, key_value, count, importance_score, created_at, updated_at
    )
    -- alias name
    SELECT
      a.alias_id,
      t.concept_id,
      'alias name',
      a.alias_name,
      NULL,
      1,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t
      ON t.alias_id = a.alias_id
    WHERE a.alias_name IS NOT NULL

    UNION ALL

    -- raw value
    SELECT
      rv.alias_id,
      t.concept_id,
      'raw value',
      rv.raw_value,
      COUNT(*)::NUMBER,
      1,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t
      ON t.alias_id = rv.alias_id
    WHERE rv.raw_value IS NOT NULL
    GROUP BY rv.alias_id, rv.raw_value

    UNION ALL

    -- normalized value
    SELECT
      rv.alias_id,
      t.concept_id,
      'normalized value',
      rv.normalization_value,
      COUNT(*)::NUMBER,
      1,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t
      ON t.alias_id = rv.alias_id
    WHERE rv.normalization_value IS NOT NULL
    GROUP BY rv.alias_id, rv.normalization_value

    UNION ALL

    -- alias token signature (from tokenized ALIASES.tokens)
    SELECT
      a.alias_id,
      t.concept_id,
      'alias token signature',
      ARRAY_TO_STRING(a.tokens::ARRAY, '|'),
      NULL,
      1,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t
      ON t.alias_id = a.alias_id
    WHERE a.tokens IS NOT NULL
      AND IS_ARRAY(a.tokens)
      AND ARRAY_SIZE(a.tokens::ARRAY) > 0
    ;
    v_rows_inserted := SQLROWCOUNT;

    RETURN 'OK: refreshed alias_summary rows. deleted=' || v_rows_deleted || ', inserted=' || v_rows_inserted;
END;
$$;

CREATE OR REPLACE PROCEDURE REFRESH_TOKENS_SUMMARY(
    p_alias_id INTEGER
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_rows_deleted INTEGER DEFAULT 0;
    v_rows_inserted INTEGER DEFAULT 0;
BEGIN
    CREATE OR REPLACE TEMP TABLE TMP_TARGET_ALIASES_TS AS
    SELECT a.alias_id
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    WHERE :p_alias_id IS NULL OR a.alias_id = :p_alias_id;

    DELETE FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    WHERE (
      ts.raw_value_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
        JOIN TMP_TARGET_ALIASES_TS t
          ON t.alias_id = rv.alias_id
        WHERE rv.raw_value_id = ts.raw_value_id
      )
    )
    OR (
      ts.token_type = 'alias'
      AND ts.alias_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM TMP_TARGET_ALIASES_TS t WHERE t.alias_id = ts.alias_id
      )
    );
    v_rows_deleted := SQLROWCOUNT;

    INSERT INTO STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY (
      token,
      position_in_signature,
      raw_value_id,
      alias_id,
      signature_length,
      rarity,
      token_type,
      created_at,
      updated_at
    )
    SELECT
      f.value::VARCHAR,
      (f.index::INTEGER + 1),
      rv.raw_value_id,
      NULL,
      ARRAY_SIZE(rv.tokens::ARRAY)::INTEGER,
      0,
      'standard',
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES_TS t
      ON t.alias_id = rv.alias_id,
    LATERAL FLATTEN(input => rv.tokens) f
    WHERE rv.tokens IS NOT NULL
      AND IS_ARRAY(rv.tokens)
      AND ARRAY_SIZE(rv.tokens::ARRAY) > 0
      AND f.value IS NOT NULL

    UNION ALL

    SELECT
      f.value::VARCHAR,
      (f.index::INTEGER + 1),
      rv.raw_value_id,
      NULL,
      ARRAY_SIZE(rv.normalized_tokens::ARRAY)::INTEGER,
      0,
      'normalized',
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES_TS t
      ON t.alias_id = rv.alias_id,
    LATERAL FLATTEN(input => rv.normalized_tokens) f
    WHERE rv.normalized_tokens IS NOT NULL
      AND IS_ARRAY(rv.normalized_tokens)
      AND ARRAY_SIZE(rv.normalized_tokens::ARRAY) > 0
      AND f.value IS NOT NULL

    UNION ALL

    SELECT
      f.value::VARCHAR,
      (f.index::INTEGER + 1),
      NULL,
      a.alias_id,
      ARRAY_SIZE(a.tokens::ARRAY)::INTEGER,
      0,
      'alias',
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES_TS t
      ON t.alias_id = a.alias_id,
    LATERAL FLATTEN(input => a.tokens) f
    WHERE a.tokens IS NOT NULL
      AND IS_ARRAY(a.tokens)
      AND ARRAY_SIZE(a.tokens::ARRAY) > 0
      AND f.value IS NOT NULL
    ;
    v_rows_inserted := SQLROWCOUNT;

    RETURN 'OK: refreshed tokens_summary rows. deleted=' || v_rows_deleted || ', inserted=' || v_rows_inserted;
END;
$$;
