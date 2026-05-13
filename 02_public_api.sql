-- Run these setup commands in your worksheet before creating the procedure:
USE DATABASE STAND_DB;
USE SCHEMA STAND;

-- Drop the previous 4-parameter signature so the new 6-parameter version
-- (with DEFAULT values) is the only overload. Without this, Snowflake rejects
-- the CREATE OR REPLACE as an ambiguous overload of the existing 4-param proc.
DROP PROCEDURE IF EXISTS CREATE_RUN(VARCHAR, VARCHAR, VARCHAR, VARCHAR);

CREATE OR REPLACE PROCEDURE CREATE_RUN(
    p_concept_key VARCHAR,
    table_fqn VARCHAR,
    column_name VARCHAR,
    mode VARCHAR,
    p_source_type VARCHAR DEFAULT 'snowflake',
    p_paste_values_json VARCHAR DEFAULT NULL
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

    -- Concept validation
    v_concept_exists INTEGER DEFAULT 0;
    v_concept_key VARCHAR;

    -- Resolved source relation (__pasted__ for paste source, table_fqn otherwise)
    v_source_relation VARCHAR;

    -- Dynamic SQL
    check_sql VARCHAR;
    v_source_values_query VARCHAR;

    result_msg VARCHAR;

    -- Per-step timing: one TIMESTAMP_NTZ boundary variable per step boundary.
    -- Captured with zero SQL overhead; a single UNION ALL INSERT writes them all at the end.
    v_t0  TIMESTAMP_NTZ;   -- run start / before validate_inputs
    v_t1  TIMESTAMP_NTZ;   -- after validate_inputs
    v_t2  TIMESTAMP_NTZ;   -- after validate_concept
    v_t3  TIMESTAMP_NTZ;   -- after resolve_user
    v_t4  TIMESTAMP_NTZ;   -- after probe_table_access  (NULL for paste source)
    v_t5  TIMESTAMP_NTZ;   -- after probe_column_access (NULL boundary skipped for paste)
    v_t6  TIMESTAMP_NTZ;   -- after insert_run
    v_t8  TIMESTAMP_NTZ;   -- after source_values_fill
    v_t10 TIMESTAMP_NTZ;   -- after insert_run_items
    v_t11 TIMESTAMP_NTZ;   -- reserved: after stats_row_count     (currently disabled)
    v_t12 TIMESTAMP_NTZ;   -- reserved: after stats_distinct_count (currently disabled)
    v_t13 TIMESTAMP_NTZ;   -- reserved: after stats_null_count    (currently disabled)
    v_t14 TIMESTAMP_NTZ;   -- reserved: after stats_most_common   (currently disabled)
    v_t15 TIMESTAMP_NTZ;   -- run end / TOTAL
BEGIN
    -------------------------------------------------------------------------
    -- Timing: capture the run-start boundary. All other boundaries are
    -- captured inline with free variable assignments (no SQL round-trips).
    -------------------------------------------------------------------------
    v_t0 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    -------------------------------------------------------------------------
    -- 1) Validate inputs
    -------------------------------------------------------------------------
    v_step := 'validate_inputs';

    IF (p_concept_key IS NULL OR TRIM(p_concept_key) = '') THEN
        RETURN 'ERROR: concept_key cannot be blank';
    END IF;

    -- table_fqn is only required for snowflake source; paste source sets it to __pasted__
    IF (p_source_type = 'snowflake' AND (table_fqn IS NULL OR TRIM(table_fqn) = '')) THEN
        RETURN 'ERROR: table_fqn cannot be blank';
    END IF;

    IF (column_name IS NULL OR TRIM(column_name) = '') THEN
        RETURN 'ERROR: column_name cannot be blank';
    END IF;

    IF (mode IS NULL OR TRIM(mode) = '') THEN
        RETURN 'ERROR: mode cannot be blank';
    END IF;

    IF (mode <> 'review') THEN
        RETURN 'ERROR: only mode=review is supported';
    END IF;

    IF (p_source_type <> 'snowflake' AND p_source_type <> 'paste') THEN
        RETURN 'ERROR: source_type must be snowflake or paste';
    END IF;

    IF (p_source_type = 'paste' AND (p_paste_values_json IS NULL OR TRIM(p_paste_values_json) = '')) THEN
        RETURN 'ERROR: paste_values_json cannot be blank when source_type=paste';
    END IF;

    v_t1 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

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

    v_t2 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

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

    v_t3 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    -------------------------------------------------------------------------
    -- 4) Probe table / column — skipped entirely for paste source
    -------------------------------------------------------------------------
    IF (p_source_type = 'snowflake') THEN

        v_step := 'probe_table_access';
        BEGIN
            check_sql := 'SELECT 1 FROM ' || table_fqn || ' LIMIT 1';
            EXECUTE IMMEDIATE check_sql;
        EXCEPTION
            WHEN OTHER THEN
                RETURN 'ERROR: Table ' || table_fqn || ' does not exist or you do not have access';
        END;
        v_t4 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

        v_step := 'probe_column_access';
        BEGIN
            check_sql := 'SELECT ' || column_name || ' FROM ' || table_fqn || ' LIMIT 0';
            EXECUTE IMMEDIATE check_sql;
        EXCEPTION
            WHEN OTHER THEN
                RETURN 'ERROR: Column "' || column_name || '" was not found in table ' || table_fqn || '. Please check the column name and try again.';
        END;
        v_t5 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    ELSE
        -- Paste source: no Snowflake table to probe. v_t4 stays NULL so the
        -- timing rows for probe steps are dropped by the WHERE clause below.
        v_t5 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;
    END IF;

    -------------------------------------------------------------------------
    -- Resolve source_relation
    -------------------------------------------------------------------------
    IF (p_source_type = 'paste') THEN
        v_source_relation := '__pasted__';
    ELSE
        v_source_relation := table_fqn;
    END IF;

    -------------------------------------------------------------------------
    -- 5) Insert RUNS (let AUTOINCREMENT generate run_id)
    -------------------------------------------------------------------------
    v_step := 'insert_run';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUNS (
        created_by, created_at, updated_at,
        concept_id, source_relation, source_column,
        mode, run_status
    )
    SELECT
        :v_user_id, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(),
        :v_concept_id, :v_source_relation, :column_name,
        :mode, 'created';

    -- Get the auto-generated run_id from the row we just inserted.
    -- v_t5 was captured immediately before the INSERT, so every row with
    -- created_at >= :v_t5 must be from this INSERT or a later one in this
    -- same session.  MAX(run_id) among those is always the new row.
    SELECT MAX(run_id) INTO v_run_id
    FROM STAND_DB.STAND_INTERNAL.RUNS
    WHERE created_by       = :v_user_id
      AND concept_id       = :v_concept_id
      AND source_relation  = :v_source_relation
      AND source_column    = :column_name
      AND created_at       >= :v_t5;

    v_t6 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    -------------------------------------------------------------------------
    -- 6) TMP_SOURCE_VALUES (distinct non-null values)
    -------------------------------------------------------------------------
    v_step := 'tmp_source_values_create';

    CREATE OR REPLACE TEMP TABLE TMP_SOURCE_VALUES (
        literal_value VARCHAR
    );

    v_step := 'tmp_source_values_fill';

    IF (p_source_type = 'paste') THEN
        -- Values were parsed and deduplicated by the API before being passed in.
        -- PARSE_JSON converts the JSON array string to a VARIANT for FLATTEN.
        INSERT INTO TMP_SOURCE_VALUES (literal_value)
        SELECT DISTINCT f.value::VARCHAR
        FROM TABLE(FLATTEN(input => PARSE_JSON(:p_paste_values_json))) f
        WHERE f.value IS NOT NULL
          AND TRIM(f.value::VARCHAR) <> '';
    ELSE
        -- NOTE: column_name + table_fqn are concatenated; assume caller is trusted.
        -- We normalize to VARCHAR for matching.
        v_source_values_query :=
            'INSERT INTO TMP_SOURCE_VALUES (literal_value) ' ||
            'SELECT DISTINCT TO_VARCHAR(' || column_name || ') ' ||
            'FROM ' || table_fqn || ' ' ||
            'WHERE ' || column_name || ' IS NOT NULL';
        EXECUTE IMMEDIATE v_source_values_query;
    END IF;

    v_t8 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    -------------------------------------------------------------------------
    -- 7) Insert RUN_ITEMS: one row per distinct source value, all ungrouped.
    --    Classification columns (cleaned_value, normalization_value, tokens, …)
    --    are left NULL here and populated later by CLASSIFY_RUN_ITEMS(run_id).
    -------------------------------------------------------------------------
    v_step := 'insert_run_items';

    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_ITEMS (
        run_id, group_id, literal_value, cleaned_value,
        normalization_value, tokens, tokens_count, normalized_tokens, normalized_tokens_count,
        confidence_score, decision_status, created_at, updated_at
    )
    SELECT
        :v_run_id,
        NULL,
        sv.literal_value,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        'pending',
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM TMP_SOURCE_VALUES sv;

    v_t10 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    -------------------------------------------------------------------------
    -- 8) Stats for review mode
    -------------------------------------------------------------------------
    -- Stats calculations temporarily disabled (not used by the app).
    -- Restore if the UI needs row count, distinct count, null %, most-common value.
    --   stats_row_count      => COUNT(*) on the source table
    --   stats_distinct_count => COUNT(DISTINCT source_column)
    --   stats_null_count     => COUNT(*) - COUNT(source_column)
    --   stats_most_common    => GROUP BY source_column ORDER BY COUNT(*) DESC LIMIT 1

    result_msg :=
'
✓  RUN CREATED - Review Required

Run ID: ' || v_run_id || '
Concept: ' || v_concept_key || ' (ID: ' || v_concept_id || ')
Target:  ' || v_source_relation || '.' || column_name || '

Review URL:
  http://localhost:8000/run/' || v_run_id || '
';

    DROP TABLE IF EXISTS TMP_SOURCE_VALUES;

    -- One-shot timing flush: all step boundaries are already in v_t0 … v_t15.
    -- Disabled timing rows have NULL boundaries and are dropped by the WHERE clause.
    -- probe_table_access and probe_column_access rows are also dropped when
    -- v_t4 is NULL (paste source), since started_at IS NOT NULL fails.
    v_t15 := CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

    INSERT INTO STAND_DB.STAND_INTERNAL.RUN_STEP_TIMINGS (run_id, step_name, started_at, ended_at, duration_ms)
    SELECT s.run_id, s.step_name, s.started_at, s.ended_at,
           DATEDIFF('millisecond', s.started_at, s.ended_at)
    FROM (
        SELECT :v_run_id AS run_id, 'validate_inputs'           AS step_name, :v_t0  AS started_at, :v_t1  AS ended_at
        UNION ALL SELECT :v_run_id, 'validate_concept',          :v_t1,  :v_t2
        UNION ALL SELECT :v_run_id, 'resolve_user',              :v_t2,  :v_t3
        UNION ALL SELECT :v_run_id, 'probe_table_access',        :v_t3,  :v_t4
        UNION ALL SELECT :v_run_id, 'probe_column_access',       :v_t4,  :v_t5
        UNION ALL SELECT :v_run_id, 'insert_run',                :v_t5,  :v_t6
        UNION ALL SELECT :v_run_id, 'source_values_fill',        :v_t6,  :v_t8
        UNION ALL SELECT :v_run_id, 'insert_run_items',          :v_t8,  :v_t10
        UNION ALL SELECT :v_run_id, 'stats_row_count',           :v_t10, :v_t11
        UNION ALL SELECT :v_run_id, 'stats_distinct_count',      :v_t11, :v_t12
        UNION ALL SELECT :v_run_id, 'stats_null_count',          :v_t12, :v_t13
        UNION ALL SELECT :v_run_id, 'stats_most_common',         :v_t13, :v_t14
        UNION ALL SELECT :v_run_id, 'TOTAL',                     :v_t0,  :v_t15
    ) s
    WHERE s.started_at IS NOT NULL AND s.ended_at IS NOT NULL;

    RETURN result_msg;

EXCEPTION
    WHEN OTHER THEN
        RETURN 'ERROR: STEP=' || v_step || ' SQLCODE=' || SQLCODE || ' SQLERRM=' || SQLERRM;
END;
$$;

-------------------------------------------------------------------------
-- CLASSIFY_RUN_ITEMS
-- Runs the deterministic classification pipeline (tokenisation, normalisation,
-- stopword removal) on every RUN_ITEM in the given run whose tokens column is
-- still NULL.  Called by the "Apply confident assignments" API route before
-- confidence scoring begins.
-- Safe to call multiple times — the WHERE tokens IS NULL filter makes it
-- idempotent.
-------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE CLASSIFY_RUN_ITEMS(p_run_id INTEGER)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_concept_id       INTEGER;
    v_ruleset          VARIANT;
    v_enriched_ruleset VARIANT;
    v_generic_words    ARRAY;
    v_concept_words    ARRAY;
    v_updated          INTEGER DEFAULT 0;
BEGIN
    -- Resolve concept + ruleset for this run
    SELECT r.concept_id, p.ruleset
      INTO v_concept_id, v_ruleset
    FROM STAND_DB.STAND_INTERNAL.RUNS r
    JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
    JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p
      ON p.profile_id = c.profile_id
    WHERE r.run_id = :p_run_id
    LIMIT 1;

    -- Build enriched ruleset (generic + concept-specific stopwords)
    SELECT COALESCE(ARRAY_AGG(word), ARRAY_CONSTRUCT())
      INTO v_generic_words
    FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS
    WHERE concept_id IS NULL;

    SELECT COALESCE(ARRAY_AGG(word), ARRAY_CONSTRUCT())
      INTO v_concept_words
    FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS
    WHERE concept_id = :v_concept_id;

    SELECT STAND_DB.STAND_INTERNAL.ENRICH_RULESET_STOPWORDS(
        :v_ruleset,
        :v_generic_words,
        :v_concept_words
    ) INTO v_enriched_ruleset;

    -- Apply pipeline and write results back into RUN_ITEMS
    UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS
    SET
        cleaned_value             = c.pipeline:cleaned_value::VARCHAR,
        normalization_value       = c.pipeline:normalization_value::VARCHAR,
        tokens                    = c.pipeline:tokens,
        tokens_count              = c.pipeline:tokens_count::NUMBER,
        normalized_tokens         = c.pipeline:normalized_tokens,
        normalized_tokens_count   = c.pipeline:normalized_tokens_count::NUMBER,
        updated_at                = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            run_item_id,
            STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
                literal_value, :v_enriched_ruleset
            ) AS pipeline
        FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
        WHERE run_id   = :p_run_id
          AND tokens IS NULL
    ) c
    WHERE STAND_DB.STAND_INTERNAL.RUN_ITEMS.run_item_id = c.run_item_id;

    v_updated := SQLROWCOUNT;

    RETURN 'OK: classified ' || v_updated || ' items for run_id=' || p_run_id;

EXCEPTION
    WHEN OTHER THEN
        RETURN 'ERROR: ' || SQLERRM;
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
    -- Sum of token_importance(t, p) for unique tokens per literal_value (standard token signatures).
    -- Deduplicates repeated tokens by taking MAX(importance_score) per token (highest weight =
    -- earliest position, since pos_weight decreases with p and rarity is position-independent).
    -- unique_token_count = n in the denominator 1 + β*(n-1).
    std_rv_scores AS (
        SELECT sub.alias_item_id,
               SUM(sub.token_importance)   AS score_sum,
               COUNT(*)                    AS unique_token_count
        FROM (
            SELECT ts.alias_item_id,
                   ts.token,
                   MAX(ts.importance_score) AS token_importance
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv ON rv.alias_item_id = ts.alias_item_id
            JOIN TMP_TARGET_ALIASES ta                  ON ta.alias_id     = rv.alias_id
            WHERE ts.token_type = 'standard'
            GROUP BY ts.alias_item_id, ts.token
        ) sub
        GROUP BY sub.alias_item_id
    ),
    -- Sum of token_importance(t, p) for unique tokens per literal_value (normalized token signatures).
    norm_rv_scores AS (
        SELECT sub.alias_item_id,
               SUM(sub.token_importance)   AS score_sum,
               COUNT(*)                    AS unique_token_count
        FROM (
            SELECT ts.alias_item_id,
                   ts.token,
                   MAX(ts.importance_score) AS token_importance
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv ON rv.alias_item_id = ts.alias_item_id
            JOIN TMP_TARGET_ALIASES ta                  ON ta.alias_id     = rv.alias_id
            WHERE ts.token_type = 'normalized'
            GROUP BY ts.alias_item_id, ts.token
        ) sub
        GROUP BY sub.alias_item_id
    ),
    -- Sum of token_importance(t, p) for unique alias tokens per alias (alias token signatures).
    -- Uses position-weight-only importance (rarity = 1.0 for all alias tokens).
    alias_tok_scores AS (
        SELECT sub.alias_id,
               SUM(sub.token_importance)   AS score_sum,
               COUNT(*)                    AS unique_token_count
        FROM (
            SELECT ts.alias_id,
                   ts.token,
                   MAX(ts.importance_score) AS token_importance
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            JOIN TMP_TARGET_ALIASES ta ON ta.alias_id = ts.alias_id
            WHERE ts.token_type = 'alias'
            GROUP BY ts.alias_id, ts.token
        ) sub
        GROUP BY sub.alias_id
    )
    -- alias name: no importance score (definitional, not token-weighted).
    -- Stored as the canonical (lowercase) alias_name_literal_value for display/lookup.
    SELECT
      a.alias_id, t.concept_id, 'alias name', a.alias_name_literal_value, NULL, NULL,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    WHERE a.alias_name_literal_value IS NOT NULL

    UNION ALL

    -- alias clean value: cleaned_value from pipeline applied to alias_name_literal_value (pre-normalization pass).
    -- Mirrors cleaned_value on ALIAS_ITEMS; enables clean-value matching against alias names.
    SELECT
      a.alias_id, t.concept_id, 'alias clean value', a.alias_name_clean_value, NULL, NULL,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    WHERE a.alias_name_clean_value IS NOT NULL

    UNION ALL

    -- alias normalized value: normalization_value from pipeline applied to alias_name_literal_value.
    -- Mirrors normalization_value on ALIAS_ITEMS; stored in alias_name_normalization_value for historical reasons.
    SELECT
      a.alias_id, t.concept_id, 'alias normalized value', a.alias_name_normalization_value, NULL, NULL,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    WHERE a.alias_name_normalization_value IS NOT NULL

    UNION ALL

    -- clean value: stores the cleaned_value (output of pre-tokenization normalization rules) of
    -- each catalog alias item so that step_1 comparisons match on the pre-tokenization-normalized
    -- string, consistent with the cleaned_value stored on RUN_ITEMS.
    SELECT
      rv.alias_id, t.concept_id, 'clean value', rv.cleaned_value, COUNT(*)::NUMBER, 1,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    WHERE rv.cleaned_value IS NOT NULL
    GROUP BY rv.alias_id, t.concept_id, rv.cleaned_value

    UNION ALL

    -- normalized value (importance always 1)
    SELECT
      rv.alias_id, t.concept_id, 'normalized value', rv.normalization_value, COUNT(*)::NUMBER, 1,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    WHERE rv.normalization_value IS NOT NULL
    GROUP BY rv.alias_id, t.concept_id, rv.normalization_value

    UNION ALL

    -- token signature: one row per distinct signature per alias.
    -- raw  = sum(token_importance for unique tokens) / (1 + β*(n-1))   β=0.2
    -- importance = raw / (1 + raw)  =  s / (s + 1 + β*(n-1))
    -- All alias items sharing the same signature have identical per-token scores
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
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    LEFT JOIN std_rv_scores srs ON srs.alias_item_id = rv.alias_item_id
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
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = rv.alias_id
    LEFT JOIN norm_rv_scores nrs ON nrs.alias_item_id = rv.alias_item_id
    WHERE rv.normalized_tokens IS NOT NULL
      AND IS_ARRAY(rv.normalized_tokens)
      AND ARRAY_SIZE(rv.normalized_tokens::ARRAY) > 0
    GROUP BY rv.alias_id, t.concept_id, ARRAY_TO_STRING(rv.normalized_tokens::ARRAY, '|')

    UNION ALL

    -- alias token signature: importance from position-weighted alias token scores.
    -- raw  = sum(token_importance for unique alias tokens) / (1 + β*(n-1))   β=0.2
    -- importance = raw / (1 + raw)  =  s / (s + 1 + β*(n-1))
    SELECT
      a.alias_id, t.concept_id,
      'alias token signature',
      ARRAY_TO_STRING(a.alias_name_tokens::ARRAY, '|'),
      NULL,
      COALESCE(ats.score_sum, 0)
        / (COALESCE(ats.score_sum, 0)
           + 1.0 + 0.2 * (COALESCE(ats.unique_token_count, 1)::FLOAT - 1.0)),
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    LEFT JOIN alias_tok_scores ats ON ats.alias_id = a.alias_id
    WHERE a.alias_name_tokens IS NOT NULL
      AND IS_ARRAY(a.alias_name_tokens)
      AND ARRAY_SIZE(a.alias_name_tokens::ARRAY) > 0

    UNION ALL

    -- alias normalized token signature: pipe-joined normalized tokens from pipeline on alias_name_literal_value.
    -- Mirrors normalized token signature for alias items but applied to the alias name itself.
    -- Importance reuses the alias token score (positional, rarity=1.0 for all alias tokens).
    SELECT
      a.alias_id, t.concept_id,
      'alias normalized token signature',
      ARRAY_TO_STRING(a.alias_name_normalized_tokens::ARRAY, '|'),
      NULL,
      COALESCE(ats.score_sum, 0)
        / (COALESCE(ats.score_sum, 0)
           + 1.0 + 0.2 * (COALESCE(ats.unique_token_count, 1)::FLOAT - 1.0)),
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES t ON t.alias_id = a.alias_id
    LEFT JOIN alias_tok_scores ats ON ats.alias_id = a.alias_id
    WHERE a.alias_name_normalized_tokens IS NOT NULL
      AND IS_ARRAY(a.alias_name_normalized_tokens)
      AND ARRAY_SIZE(a.alias_name_normalized_tokens::ARRAY) > 0
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
    v_max_rn        INTEGER DEFAULT 0;
    v_cur_rn        INTEGER DEFAULT 1;
BEGIN
    CREATE OR REPLACE TEMP TABLE TMP_TARGET_ALIASES_TS AS
    SELECT a.alias_id
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    WHERE :p_alias_id IS NULL OR a.alias_id = :p_alias_id;

    DELETE FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    WHERE (
      ts.alias_item_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
        JOIN TMP_TARGET_ALIASES_TS t
          ON t.alias_id = rv.alias_id
        WHERE rv.alias_item_id = ts.alias_item_id
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
      alias_item_id,
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
      rv.alias_item_id,
      NULL,
      ARRAY_SIZE(rv.tokens::ARRAY)::INTEGER,
      0,
      'standard',
      0,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
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
      rv.alias_item_id,
      NULL,
      ARRAY_SIZE(rv.normalized_tokens::ARRAY)::INTEGER,
      0,
      'normalized',
      0,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
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
      ARRAY_SIZE(a.alias_name_tokens::ARRAY)::INTEGER,
      0,
      'alias',
      0,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TARGET_ALIASES_TS t
      ON t.alias_id = a.alias_id,
    LATERAL FLATTEN(input => a.alias_name_tokens) f
    WHERE a.alias_name_tokens IS NOT NULL
      AND IS_ARRAY(a.alias_name_tokens)
      AND ARRAY_SIZE(a.alias_name_tokens::ARRAY) > 0
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
    -- One row per (alias, normalized_token): COUNT(DISTINCT alias_item_id) = TF.
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
        COUNT(DISTINCT ts.alias_item_id) AS token_count,
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP()
    FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv ON rv.alias_item_id = ts.alias_item_id
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
    JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv ON rv.alias_item_id = ts.alias_item_id
    JOIN STAND_DB.STAND_INTERNAL.ALIASES a     ON a.alias_id      = rv.alias_id
    JOIN TMP_TS_AFFECTED_CONCEPTS ac            ON ac.concept_id   = a.concept_id
    WHERE ts.token_type = 'normalized'
    GROUP BY a.concept_id, ts.token;

    -- -----------------------------------------------------------------------
    -- Per-concept "local pool" for rarity cold-start / blending:
    -- one row per (concept, alias_item, normalized token) from ALIAS_ITEMS.
    -- Pool size = COUNT(DISTINCT alias_item_id) per concept.
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE TMP_ITEM_NORM_TOK AS
    SELECT
        a.concept_id,
        rv.alias_item_id,
        LOWER(f.value::VARCHAR) AS norm_tok
    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
    JOIN STAND_DB.STAND_INTERNAL.ALIASES a
      ON a.alias_id = rv.alias_id
    JOIN TMP_TS_AFFECTED_CONCEPTS ac
      ON ac.concept_id = a.concept_id
    , LATERAL FLATTEN(input => rv.normalized_tokens) f
    WHERE rv.normalized_tokens IS NOT NULL
      AND IS_ARRAY(rv.normalized_tokens)
      AND ARRAY_SIZE(rv.normalized_tokens::ARRAY) > 0
      AND f.value IS NOT NULL;

    CREATE OR REPLACE TEMP TABLE TMP_POOL_SIZE AS
    SELECT concept_id, COUNT(DISTINCT alias_item_id)::INTEGER AS pool_size
    FROM TMP_ITEM_NORM_TOK
    GROUP BY concept_id;

    CREATE OR REPLACE TEMP TABLE TMP_TOKEN_ITEM_COUNTS AS
    SELECT
        concept_id,
        norm_tok AS token,
        COUNT(DISTINCT alias_item_id)::INTEGER AS n_items
    FROM TMP_ITEM_NORM_TOK
    GROUP BY concept_id, norm_tok;

    -- -----------------------------------------------------------------------
    -- Stopword prior (0.1 if token is a stopword for the concept; else 1.0).
    -- Source: LKP_STOPWORDS — two tiers:
    --   generic        (concept_id IS NULL) → apply to every concept
    --   concept-specific (concept_id = N)   → apply only to that concept
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE TMP_PROFILE_STOPWORDS AS
    SELECT DISTINCT x.concept_id, LOWER(x.word) AS stopword
    FROM (
        -- Generic stopwords apply to every affected concept.
        SELECT ac.concept_id, s.word
        FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS s
        CROSS JOIN TMP_TS_AFFECTED_CONCEPTS ac
        WHERE s.concept_id IS NULL

        UNION ALL

        -- Concept-specific stopwords apply only to their own concept.
        SELECT s.concept_id, s.word
        FROM STAND_DB.STAND_INTERNAL.LKP_STOPWORDS s
        JOIN TMP_TS_AFFECTED_CONCEPTS ac ON ac.concept_id = s.concept_id
        WHERE s.concept_id IS NOT NULL
    ) x
    WHERE x.word IS NOT NULL
      AND x.word != '';

    -- -----------------------------------------------------------------------
    -- rarity for normalized tokens (three-regime blend by alias count N in concept)
    --
    -- concept_global_rarity (unchanged formula when mature):
    --   (token_count / alias_item_count) * (ln(N / df) / ln(N))
    --
    -- N = total_aliases; df = aliases in concept containing this normalized token.
    -- local_pool_idf (only when pool_size > 15 and pool_size > 1):
    --   ln(pool_size / n_items_with_token) / ln(pool_size)
    --   n_items_with_token = alias items in concept whose normalized_tokens contain token.
    -- stopword_prior: 0.1 if token in any stopword set on concept profile else 1.0.
    --
    -- N >= 20: concept_global_rarity only (legacy behavior).
    -- 1 <= N <= 19: GREATEST(0.5*global + 0.5*local_idf, stopword_prior*0.8) when pool_size > 15;
    --              when pool_size <= 15 skip local_idf → GREATEST(global, stopword_prior*0.8).
    -- N = 0: cold start — pool_size > 15 → GREATEST(local_idf, stopword_prior);
    --         pool_size <= 15 → stopword_prior only (skip local_idf).
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET rarity     = scored.rarity,
        updated_at = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            si.tokens_summary_id,
            CASE
                WHEN si.total_aliases >= 20 THEN si.concept_global_rarity
                WHEN si.total_aliases >= 1 THEN
                    CASE
                        WHEN COALESCE(si.pool_size, 0) <= 15 THEN
                            GREATEST(
                                COALESCE(si.concept_global_rarity, 0),
                                si.stopword_prior * 0.8
                            )
                        ELSE
                            GREATEST(
                                  0.5 * COALESCE(si.concept_global_rarity, 0)
                                + 0.5 * COALESCE(
                                      si.local_pool_idf,
                                      COALESCE(si.concept_global_rarity, 0)
                                  ),
                                si.stopword_prior * 0.8
                            )
                    END
                ELSE
                    CASE
                        WHEN COALESCE(si.pool_size, 0) > 15 THEN
                            GREATEST(
                                COALESCE(si.local_pool_idf, si.stopword_prior),
                                si.stopword_prior
                            )
                        ELSE
                            si.stopword_prior
                    END
            END AS rarity
        FROM (
            SELECT
                base.tokens_summary_id,
                base.ts2_concept_id,
                base.total_aliases,
                base.concept_global_rarity,
                pool_ps.pool_size AS pool_size,
                tok_n.n_items,
                IFF(
                    EXISTS (
                        SELECT 1
                        FROM TMP_PROFILE_STOPWORDS sw
                        WHERE sw.concept_id = base.ts2_concept_id
                          AND sw.stopword = LOWER(base.ts2_token)
                    ),
                    0.1,
                    1.0
                ) AS stopword_prior,
                CASE
                    WHEN COALESCE(pool_ps.pool_size, 0) > 15
                     AND COALESCE(pool_ps.pool_size, 0) > 1
                     AND tok_n.n_items IS NOT NULL
                     AND tok_n.n_items > 0
                        THEN LN(pool_ps.pool_size::FLOAT / tok_n.n_items::FLOAT)
                             / NULLIF(LN(pool_ps.pool_size::FLOAT), 0)
                    ELSE NULL
                END AS local_pool_idf
            FROM (
                SELECT
                    ts2.tokens_summary_id,
                    a.concept_id AS ts2_concept_id,
                    ts2.token AS ts2_token,
                    cac.total_aliases,
                    (atc.token_count::FLOAT / NULLIF(aic.item_count::FLOAT, 0))
                      * (LN(GREATEST(
                              cac.total_aliases
                              / NULLIF(gtc.alias_token_count::FLOAT, 0),
                              1.0
                          ))
                         / NULLIF(LN(cac.total_aliases::FLOAT), 0)
                        ) AS concept_global_rarity
                FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts2
                JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
                  ON rv.alias_item_id = ts2.alias_item_id
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
                    SELECT rv2.alias_id, COUNT(DISTINCT rv2.alias_item_id)::FLOAT AS item_count
                    FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv2
                    JOIN STAND_DB.STAND_INTERNAL.ALIASES a2
                      ON a2.alias_id = rv2.alias_id
                    WHERE a2.concept_id IN (SELECT concept_id FROM TMP_TS_AFFECTED_CONCEPTS)
                    GROUP BY rv2.alias_id
                ) aic ON aic.alias_id = rv.alias_id
                WHERE ts2.token_type = 'normalized'
            ) base
            LEFT JOIN TMP_POOL_SIZE pool_ps
              ON pool_ps.concept_id = base.ts2_concept_id
            LEFT JOIN TMP_TOKEN_ITEM_COUNTS tok_n
              ON tok_n.concept_id = base.ts2_concept_id
             AND tok_n.token = LOWER(base.ts2_token)
        ) si
    ) scored
    WHERE ts.tokens_summary_id = scored.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- rarity for standard tokens
    --   = rarity of the normalized token at the same position in the
    --     same literal_value (0 when no normalized token exists at that position,
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
        JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
          ON rv.alias_item_id = ts_std.alias_item_id
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a
          ON a.alias_id = rv.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac
          ON ac.concept_id = a.concept_id
        LEFT JOIN STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts_norm
          ON ts_norm.alias_item_id          = ts_std.alias_item_id
         AND ts_norm.position_in_signature = ts_std.position_in_signature
         AND ts_norm.token_type            = 'normalized'
        WHERE ts_std.token_type = 'standard'
    ) mapped
    WHERE ts.tokens_summary_id = mapped.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- importance_score for standard and normalized tokens
    --   char_weight(token) = min(1, len(token) / L)   L = 6
    --   = rarity(t) * char_weight(token) * ((1 - λ) + λ * pos_weight(p))
    --   = rarity * min(1, len/6) * (0.75 + 0.25 / p^0.4)
    -- where p = position_in_signature, λ = 0.25, α = 0.4, L = 6
    -- rarity follows three-regime concept maturity / local-pool IDF (see normalized-token UPDATE above).
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET importance_score = scored.importance_score,
        updated_at       = CURRENT_TIMESTAMP()
    FROM (
        SELECT
            ts2.tokens_summary_id,
            ts2.rarity * LEAST(1.0, LENGTH(ts2.token) / 6.0) * (0.75 + 0.25 / POWER(ts2.position_in_signature::FLOAT, 0.4))
              AS importance_score
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts2
        JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv ON rv.alias_item_id = ts2.alias_item_id
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a     ON a.alias_id      = rv.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac           ON ac.concept_id   = a.concept_id
        WHERE ts2.token_type IN ('standard', 'normalized')
    ) scored
    WHERE ts.tokens_summary_id = scored.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- importance_score for alias tokens
    --   = min(1, len/6) * (0.75 + 0.25 / p^0.4)
    --   (rarity = 1.0 because alias names are definitional; char_weight still applies)
    -- -----------------------------------------------------------------------
    UPDATE STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
    SET importance_score = LEAST(1.0, LENGTH(ts.token) / 6.0) * (0.75 + 0.25 / POWER(ts.position_in_signature::FLOAT, 0.4)),
        updated_at       = CURRENT_TIMESTAMP()
    FROM (
        SELECT ts2.tokens_summary_id
        FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts2
        JOIN STAND_DB.STAND_INTERNAL.ALIASES a ON a.alias_id = ts2.alias_id
        JOIN TMP_TS_AFFECTED_CONCEPTS ac        ON ac.concept_id = a.concept_id
        WHERE ts2.token_type = 'alias'
    ) targeted
    WHERE ts.tokens_summary_id = targeted.tokens_summary_id;

    -- -----------------------------------------------------------------------
    -- Cascade: rebuild ALIAS_SUMMARY for every alias in the affected concepts
    -- so signature importance scores reflect the newly computed token scores.
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE TEMP TABLE TMP_CASCADE_ALIAS_IDS AS
    SELECT a.alias_id, ROW_NUMBER() OVER (ORDER BY a.alias_id) AS rn
    FROM STAND_DB.STAND_INTERNAL.ALIASES a
    JOIN TMP_TS_AFFECTED_CONCEPTS ac ON ac.concept_id = a.concept_id;

    SELECT COUNT(*) INTO v_max_rn FROM TMP_CASCADE_ALIAS_IDS;
    v_cur_rn := 1;
    WHILE (v_cur_rn <= v_max_rn) DO
        SELECT alias_id INTO v_loop_alias_id
        FROM TMP_CASCADE_ALIAS_IDS
        WHERE rn = :v_cur_rn;
        CALL STAND_DB.STAND.REFRESH_ALIAS_SUMMARY(:v_loop_alias_id);
        v_cur_rn := v_cur_rn + 1;
    END WHILE;

    RETURN 'OK: refreshed tokens_summary rows. deleted=' || v_rows_deleted || ', inserted=' || v_rows_inserted;
END;
$$;
