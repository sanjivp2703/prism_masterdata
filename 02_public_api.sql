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
    WITH
    -- Sum of token_importance(t, p) for unique tokens per raw_value (standard token signatures).
    -- Deduplicates repeated tokens by taking MAX(importance_score) per token (highest weight =
    -- earliest position, since pos_weight decreases with p and rarity is position-independent).
    -- unique_token_count = n in the denominator 1 + β*(n-1).
    std_rv_scores AS (
        SELECT sub.raw_value_id,
               SUM(sub.token_importance)   AS score_sum,
               COUNT(*)                    AS unique_token_count
        FROM (
            SELECT ts.raw_value_id,
                   ts.token,
                   MAX(ts.importance_score) AS token_importance
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv ON rv.raw_value_id = ts.raw_value_id
            JOIN TMP_TARGET_ALIASES ta                  ON ta.alias_id     = rv.alias_id
            WHERE ts.token_type = 'standard'
            GROUP BY ts.raw_value_id, ts.token
        ) sub
        GROUP BY sub.raw_value_id
    ),
    -- Sum of token_importance(t, p) for unique tokens per raw_value (normalized token signatures).
    norm_rv_scores AS (
        SELECT sub.raw_value_id,
               SUM(sub.token_importance)   AS score_sum,
               COUNT(*)                    AS unique_token_count
        FROM (
            SELECT ts.raw_value_id,
                   ts.token,
                   MAX(ts.importance_score) AS token_importance
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv ON rv.raw_value_id = ts.raw_value_id
            JOIN TMP_TARGET_ALIASES ta                  ON ta.alias_id     = rv.alias_id
            WHERE ts.token_type = 'normalized'
            GROUP BY ts.raw_value_id, ts.token
        ) sub
        GROUP BY sub.raw_value_id
    ),
    -- alias name: no importance score (definitional, not token-weighted)
    SELECT
      a.alias_id, t.concept_id, 'alias name', a.alias_name, NULL, NULL,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    WHERE a.alias_name IS NOT NULL

    UNION ALL

    -- raw value (importance always 1)
    SELECT
      rv.alias_id, t.concept_id, 'raw value', rv.raw_value, COUNT(*)::NUMBER, 1,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    WHERE rv.raw_value IS NOT NULL
    GROUP BY rv.alias_id, t.concept_id, rv.raw_value

    UNION ALL

    -- normalized value (importance always 1)
    SELECT
      rv.alias_id, t.concept_id, 'normalized value', rv.normalization_value, COUNT(*)::NUMBER, 1,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    WHERE rv.normalization_value IS NOT NULL
    GROUP BY rv.alias_id, t.concept_id, rv.normalization_value

    UNION ALL

    -- token signature: one row per distinct signature per alias.
    -- raw  = sum(token_importance for unique tokens) / (1 + β*(n-1))   β=0.2
    -- importance = raw / (1 + raw)  =  s / (s + 1 + β*(n-1))
    -- All raw_values sharing the same signature have identical per-token scores
    -- (scores are alias-level), so MAX collapses duplicates safely.
    SELECT
      rv.alias_id, t.concept_id,
      'token signature',
      ARRAY_TO_STRING(rv.tokens::ARRAY, '|'),
      COUNT(*)::NUMBER,
      MAX(COALESCE(srs.score_sum, 0))
        / (MAX(COALESCE(srs.score_sum, 0))
           + 1.0 + 0.2 * (MAX(COALESCE(srs.unique_token_count, 1))::FLOAT - 1.0)),
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    LEFT JOIN std_rv_scores srs ON srs.raw_value_id = rv.raw_value_id
    WHERE rv.tokens IS NOT NULL
      AND IS_ARRAY(rv.tokens)
      AND ARRAY_SIZE(rv.tokens::ARRAY) > 0
    GROUP BY rv.alias_id, t.concept_id, ARRAY_TO_STRING(rv.tokens::ARRAY, '|')

    UNION ALL

    -- normalized token signature: one row per distinct normalized signature per alias.
    -- raw  = sum(token_importance for unique tokens) / (1 + β*(n-1))   β=0.2
    -- importance = raw / (1 + raw)  =  s / (s + 1 + β*(n-1))
    SELECT
      rv.alias_id, t.concept_id,
      'normalized token signature',
      ARRAY_TO_STRING(rv.normalized_tokens::ARRAY, '|'),
      COUNT(*)::NUMBER,
      MAX(COALESCE(nrs.score_sum, 0))
        / (MAX(COALESCE(nrs.score_sum, 0))
           + 1.0 + 0.2 * (MAX(COALESCE(nrs.unique_token_count, 1))::FLOAT - 1.0)),
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    LEFT JOIN norm_rv_scores nrs ON nrs.raw_value_id = rv.raw_value_id
    WHERE rv.normalized_tokens IS NOT NULL
      AND IS_ARRAY(rv.normalized_tokens)
      AND ARRAY_SIZE(rv.normalized_tokens::ARRAY) > 0
    GROUP BY rv.alias_id, t.concept_id, ARRAY_TO_STRING(rv.normalized_tokens::ARRAY, '|')

    UNION ALL

    -- alias token signature: no importance score (alias names are not TF-IDF weighted)
    SELECT
      a.alias_id, t.concept_id,
      'alias token signature',
      ARRAY_TO_STRING(a.tokens::ARRAY, '|'),
      NULL,
      NULL,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
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
    v_rows_deleted  INTEGER DEFAULT 0;
    v_rows_inserted INTEGER DEFAULT 0;
    v_loop_alias_id INTEGER DEFAULT 0;
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
      importance_score,
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
      0,
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
      0,
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
      NULL,
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

    -- -----------------------------------------------------------------------
    -- Determine the concepts affected by this refresh.
    -- IDF depends on all aliases in the concept, so rarity scores must be
    -- recomputed concept-wide even when only one alias was refreshed.
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE TMP_TS_AFFECTED_CONCEPTS AS
    SELECT DISTINCT a.concept_id
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES_TS t ON t.alias_id = a.alias_id;

    -- -----------------------------------------------------------------------
    -- Rebuild ALIAS_TOKEN_COUNT
    -- One row per (alias, normalized_token): COUNT(DISTINCT raw_value_id) = TF.
    -- Scoped to all aliases in the affected concepts.
    -- -----------------------------------------------------------------------
    DELETE FROM STAND_DB.STAND_INTERNAL.ALIAS_TOKEN_COUNT atc
    WHERE EXISTS (
        SELECT 1
        FROM STAND_DB.STAND_INTERNAL.ALIASES a
        JOIN TMP_TS_AFFECTED_CONCEPTS ac ON ac.concept_id = a.concept_id
        WHERE a.alias_id = atc.alias_id
    );

    INSERT INTO STAND_DB.STAND_INTERNAL.ALIAS_TOKEN_COUNT
        (alias_id, normalized_token, token_count, created_at, updated_at)
    SELECT
        rv.alias_id,
        ts.token                        AS normalized_token,
        COUNT(DISTINCT ts.raw_value_id) AS token_count,
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv ON rv.raw_value_id = ts.raw_value_id
    JOIN STAND_DB.STAND_INTERNAL.ALIASES a     ON a.alias_id      = rv.alias_id
    JOIN TMP_TS_AFFECTED_CONCEPTS ac            ON ac.concept_id   = a.concept_id
    WHERE ts.token_type = 'normalized'
    GROUP BY rv.alias_id, ts.token;

    -- -----------------------------------------------------------------------
    -- Rebuild GLOBAL_TOKEN_COUNT
    -- One row per (concept, normalized_token): COUNT(DISTINCT alias_id) = IDF denominator.
    -- -----------------------------------------------------------------------
    DELETE FROM STAND_DB.STAND_INTERNAL.GLOBAL_TOKEN_COUNT gtc
    WHERE EXISTS (
        SELECT 1 FROM TMP_TS_AFFECTED_CONCEPTS ac
        WHERE ac.concept_id = gtc.concept_id
    );

    INSERT INTO STAND_DB.STAND_INTERNAL.GLOBAL_TOKEN_COUNT
        (concept_id, normalized_token, alias_token_count, created_at, updated_at)
    SELECT
        a.concept_id,
        ts.token                    AS normalized_token,
        COUNT(DISTINCT rv.alias_id) AS alias_token_count,
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv ON rv.raw_value_id = ts.raw_value_id
    JOIN STAND_DB.STAND_INTERNAL.ALIASES a     ON a.alias_id      = rv.alias_id
    JOIN TMP_TS_AFFECTED_CONCEPTS ac            ON ac.concept_id   = a.concept_id
    WHERE ts.token_type = 'normalized'
    GROUP BY a.concept_id, ts.token;

    -- -----------------------------------------------------------------------
    -- rarity for normalized tokens
    --   = (token_count / alias_item_count)
    --     * (ln(N / df) / ln(N))
    -- where token_count      = distinct raw_values in this alias containing the token
    --       alias_item_count = total distinct raw_values in this alias
    --       N                = total distinct aliases in the concept
    --       df               = distinct aliases in the concept containing the token
    -- This is a fully normalized TF-IDF: both components are bounded [0, 1].
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET rarity     = scored.rarity,
        updated_at = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            ts2.tokens_summary_id,
            (atc.token_count::FLOAT / NULLIF(aic.item_count::FLOAT, 0))
              * (LN(GREATEST(
                      cac.total_aliases / NULLIF(gtc.alias_token_count::FLOAT, 0),
                      1.0
                  ))
                 / NULLIF(LN(cac.total_aliases::FLOAT), 0)
                ) AS rarity
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts2
        JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv
          ON rv.raw_value_id = ts2.raw_value_id
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a
          ON a.alias_id = rv.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac
          ON ac.concept_id = a.concept_id
        JOIN STAND_DB.STAND_INTERNAL.ALIAS_TOKEN_COUNT atc
          ON atc.alias_id         = rv.alias_id
         AND atc.normalized_token = ts2.token
        JOIN STAND_DB.STAND_INTERNAL.GLOBAL_TOKEN_COUNT gtc
          ON gtc.concept_id       = a.concept_id
         AND gtc.normalized_token = ts2.token
        JOIN (
            SELECT concept_id, COUNT(DISTINCT alias_id)::FLOAT AS total_aliases
            FROM STAND_DB.STAND_INTERNAL.ALIASES
            WHERE concept_id IN (SELECT concept_id FROM TMP_TS_AFFECTED_CONCEPTS)
            GROUP BY concept_id
        ) cac ON cac.concept_id = a.concept_id
        JOIN (
            SELECT rv2.alias_id, COUNT(DISTINCT rv2.raw_value_id)::FLOAT AS item_count
            FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv2
            JOIN STAND_DB.STAND_INTERNAL.ALIASES a2 ON a2.alias_id = rv2.alias_id
            WHERE a2.concept_id IN (SELECT concept_id FROM TMP_TS_AFFECTED_CONCEPTS)
            GROUP BY rv2.alias_id
        ) aic ON aic.alias_id = rv.alias_id
        WHERE ts2.token_type = 'normalized'
    ) scored
    WHERE ts.tokens_summary_id = scored.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- rarity for standard tokens
    --   = rarity of the normalized token at the same position in the
    --     same raw_value (0 when no normalized token exists at that position,
    --     e.g. a stopword that was stripped during normalization).
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET rarity     = COALESCE(mapped.norm_rarity, 0),
        updated_at = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            ts_std.tokens_summary_id,
            ts_norm.rarity AS norm_rarity
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts_std
        JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv
          ON rv.raw_value_id = ts_std.raw_value_id
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a
          ON a.alias_id = rv.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac
          ON ac.concept_id = a.concept_id
        LEFT JOIN STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts_norm
          ON ts_norm.raw_value_id          = ts_std.raw_value_id
         AND ts_norm.position_in_signature = ts_std.position_in_signature
         AND ts_norm.token_type            = 'normalized'
        WHERE ts_std.token_type = 'standard'
    ) mapped
    WHERE ts.tokens_summary_id = mapped.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- importance_score for standard and normalized tokens
    --   = rarity(t) * ((1 - λ) + λ * pos_weight(p))
    --   = rarity * (0.75 + 0.25 / p^0.4)
    -- where p = position_in_signature, λ = 0.25, α = 0.4
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET importance_score = scored.importance_score,
        updated_at       = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            ts2.tokens_summary_id,
            ts2.rarity * (0.75 + 0.25 / POWER(ts2.position_in_signature::FLOAT, 0.4))
              AS importance_score
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts2
        JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv ON rv.raw_value_id = ts2.raw_value_id
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a     ON a.alias_id      = rv.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac           ON ac.concept_id   = a.concept_id
        WHERE ts2.token_type IN ('standard', 'normalized')
    ) scored
    WHERE ts.tokens_summary_id = scored.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- Cascade: rebuild ALIAS_SUMMARY for every alias in the affected concepts
    -- so signature importance scores reflect the newly computed token scores.
    -- -----------------------------------------------------------------------
    FOR rec IN (
        SELECT a.alias_id
        FROM STAND_DB.STAND_INTERNAL.ALIASES a
        JOIN TMP_TS_AFFECTED_CONCEPTS ac ON ac.concept_id = a.concept_id
        ORDER BY a.alias_id
    ) DO
        v_loop_alias_id := rec.alias_id;
        CALL STAND_DB.STAND.REFRESH_ALIAS_SUMMARY(:v_loop_alias_id);
    END FOR;

    RETURN 'OK: refreshed tokens_summary rows. deleted=' || v_rows_deleted || ', inserted=' || v_rows_inserted;
END;
$$;
