import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

function quoteIdent(ident: string) {
  // Quote as a Snowflake identifier (handles reserved words / mixed case).
  // Escapes quotes defensively.
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3) {
    throw new Error(
      `Expected fully-qualified table name <DB>.<SCHEMA>.<TABLE>, got: ${fqn}`
    );
  }
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
  // Conservative identifier check to prevent SQL injection in dynamic SQL.
  // Accepts common unquoted Snowflake identifier chars.
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    items: Array<{
      run_item_id: number;
      raw_value: string;
      confidence_score: number | null;
    }>;
  }
>;

const UNGROUPED_KEY = '__UNGROUPED__';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  try {
    return await withSnowflake(async (connection) => {
      // Optional: keep validation/approval runs up to date if the source table gains new distinct values.
      // Those values should start as ungrouped (group_id NULL) so reviewers can decide.
      const runMetaRows = await new Promise<
        Array<{
          SOURCE_RELATION: string;
          SOURCE_COLUMN: string;
          RUN_STATUS: string;
          REQUIRES_VALIDATION: boolean;
          CONCEPT_ID: number;
        }>
      >((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              source_relation,
              source_column,
              run_status,
              requires_validation,
              concept_id
            FROM STAND_DB.STAND_INTERNAL.RUNS
            WHERE run_id = ?
            LIMIT 1
          `,
          binds: [run_id],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve((rows || []) as any);
          },
        });
      });

      if (runMetaRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const runMeta = runMetaRows[0];
      const runStatus = String((runMeta as any).RUN_STATUS ?? '');
      const requiresValidation = Boolean((runMeta as any).REQUIRES_VALIDATION);
      const conceptId = Number((runMeta as any).CONCEPT_ID);

      // Sync only for the validation flow (either actively validating, or flagged for admin validation).
      const shouldSync = runStatus === 'validating' || requiresValidation === true;
      if (shouldSync) {
        const sourceRelation = String((runMeta as any).SOURCE_RELATION ?? '');
        const sourceColumn = String((runMeta as any).SOURCE_COLUMN ?? '');

        try {
          const { db, schema, table } = parseFqn(sourceRelation);
          if (
            isSimpleIdent(db) &&
            isSimpleIdent(schema) &&
            isSimpleIdent(table) &&
            isSimpleIdent(sourceColumn)
          ) {
            const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(
              table
            )}`;
            const colRef = quoteIdent(sourceColumn);

            await new Promise<void>((resolve, reject) => {
              connection.execute({
                sqlText: `
                  INSERT INTO STAND_DB.STAND_INTERNAL.RUN_ITEMS (
                    run_id, group_id, raw_value, profile_id,
                    normalization_value, tokens, tokens_count, normalized_tokens, normalized_tokens_count,
                    confidence_score, decision_status, created_at, updated_at
                  )
                  SELECT
                    ?,
                    NULL,
                    sv.raw_value,
                    c.profile_id,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.raw_value, p.ruleset):normalization_value::VARCHAR,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.raw_value, p.ruleset):tokens,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.raw_value, p.ruleset):tokens_count::NUMBER,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.raw_value, p.ruleset):normalized_tokens,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.raw_value, p.ruleset):normalized_tokens_count::NUMBER,
                    0,
                    'pending',
                    CURRENT_TIMESTAMP(),
                    CURRENT_TIMESTAMP()
                  FROM (
                    SELECT DISTINCT TO_VARCHAR(${colRef}) AS raw_value
                    FROM ${tableRef}
                    WHERE ${colRef} IS NOT NULL
                  ) sv
                  JOIN STAND_DB.STAND_INTERNAL.RUNS r
                    ON r.run_id = ?
                  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c
                    ON c.concept_id = r.concept_id
                  JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES p
                    ON p.profile_id = c.profile_id
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
                    WHERE ri.run_id = ?
                      AND ri.raw_value = sv.raw_value
                  )
                `,
                binds: [run_id, run_id, run_id],
                complete: (err) => {
                  if (err) reject(err);
                  else resolve();
                },
              });
            });
          } else {
            console.warn(
              'Skipping RUN_ITEMS sync due to non-simple identifiers in run metadata',
              { sourceRelation, sourceColumn }
            );
          }
        } catch (e) {
          // Don't break the UI load if sync fails; just fall back to existing run snapshot.
          console.warn('RUN_ITEMS sync failed; continuing without sync', e);
        }
      }

      const groups = await new Promise<Array<{ GROUP_ID: number; ALIAS_NAME: string }>>(
        (resolve, reject) => {
          connection.execute({
            sqlText: `
              SELECT
                group_id,
                COALESCE(alias_name, initial_alias_name) AS alias_name
              FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
              WHERE run_id = ?
              ORDER BY group_id
            `,
            binds: [run_id],
            complete: (err, stmt, rows) => {
              if (err) reject(err);
              else resolve((rows || []) as any);
            },
          });
        }
      );

      const items = await new Promise<
        Array<{
          RUN_ITEM_ID: number;
          GROUP_ID: number | null;
          RAW_VALUE: string;
          CONFIDENCE_SCORE: number | null;
        }>
      >(
        (resolve, reject) => {
          connection.execute({
            sqlText: shouldSync
              ? `
                -- Validation/approval flow:
                -- Hide items that have already been validated before, i.e. the exact mapping
                -- (raw_value, alias_id, alias_name) already exists in RAW_VALUES.
                SELECT
                  ri.run_item_id,
                  ri.group_id,
                  ri.raw_value,
                  ri.confidence_score
                FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
                WHERE ri.run_id = ?
                  AND NOT EXISTS (
                    SELECT 1
                    FROM STAND_DB.STAND_INTERNAL.RUNS r
                    JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
                      ON rg.run_id = r.run_id
                     AND rg.group_id = ri.group_id
                    JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv
                      ON rv.raw_value = ri.raw_value
                     AND rv.alias_id = rg.final_alias_id
                    JOIN STAND_DB.STAND_INTERNAL.ALIASES a
                      ON a.alias_id = rv.alias_id
                    WHERE r.run_id = ri.run_id
                      AND rg.final_alias_id IS NOT NULL
                      AND a.concept_id = r.concept_id
                      AND a.alias_name = COALESCE(rg.alias_name, rg.initial_alias_name)
                  )
                ORDER BY ri.group_id, ri.run_item_id
              `
              : `
                -- Review flow: show everything in the run snapshot.
                SELECT
                  run_item_id,
                  group_id,
                  raw_value,
                  confidence_score
                FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
                WHERE run_id = ?
                ORDER BY group_id, run_item_id
              `,
            binds: [run_id],
            complete: (err, stmt, rows) => {
              if (err) reject(err);
              else resolve((rows || []) as any);
            },
          });
        }
      );

      const confidenceRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            WITH run_items AS (
              SELECT
                run_item_id,
                run_id,
                raw_value,
                normalization_value,
                tokens,
                normalized_tokens,
                group_id
              FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
              WHERE run_id = ?
            ),
            /* Direct match: run_item raw string appears in ALIAS_SUMMARY as key_type='raw value' for this concept */
            direct_matches AS (
              SELECT
                ri.run_item_id,
                ri.raw_value,
                s_raw.alias_id,
                s_name.key_value AS alias_name
              FROM run_items ri
              INNER JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s_raw
                ON s_raw.concept_id = ?
               AND s_raw.key_type = 'raw value'
               AND s_raw.key_value = ri.raw_value
              INNER JOIN STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s_name
                ON s_name.concept_id = s_raw.concept_id
               AND s_name.alias_id = s_raw.alias_id
               AND s_name.key_type = 'alias name'
               AND s_name.key_value IS NOT NULL
              QUALIFY ROW_NUMBER() OVER (
                PARTITION BY ri.run_item_id
                ORDER BY s_raw.alias_id ASC, s_raw.alias_summary_id ASC
              ) = 1
            ),
            run_items_to_score AS (
              SELECT ri.*
              FROM run_items ri
              WHERE NOT EXISTS (
                SELECT 1
                FROM direct_matches d
                WHERE d.run_item_id = ri.run_item_id
              )
            ),
            flat_tokens AS (
              SELECT
                ri.run_item_id,
                t.value::VARCHAR AS token_val
              FROM run_items_to_score ri,
              LATERAL FLATTEN(input => ri.tokens) t
              WHERE ri.tokens IS NOT NULL
                AND IS_ARRAY(ri.tokens)
                AND t.value IS NOT NULL
            ),
            flat_norm_tokens AS (
              SELECT
                ri.run_item_id,
                nt.value::VARCHAR AS token_val
              FROM run_items_to_score ri,
              LATERAL FLATTEN(input => ri.normalized_tokens) nt
              WHERE ri.normalized_tokens IS NOT NULL
                AND IS_ARRAY(ri.normalized_tokens)
                AND nt.value IS NOT NULL
            ),
            alias_candidates AS (
              SELECT
                s.alias_id,
                s.concept_id,
                s.key_value AS alias_name
              FROM STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY s
              WHERE s.concept_id = ?
                AND s.key_type = 'alias name'
                AND s.key_value IS NOT NULL
              QUALIFY ROW_NUMBER() OVER (PARTITION BY s.alias_id ORDER BY s.alias_summary_id ASC) = 1
            ),
            scored AS (
              SELECT
                ri.run_item_id,
                ri.raw_value,
                ri.normalization_value,
                ri.tokens,
                ri.normalized_tokens,
                ri.group_id,
                ac.alias_id,
                ac.alias_name,
                (s1.alias_summary_id IS NOT NULL) AS step_1_raw_value_match,
                (s2.alias_summary_id IS NOT NULL) AS step_2_normalization_value_match,
                (s3.pipe_sig IS NOT NULL) AS step_3_token_signature_match,
                (s4.hit IS NOT NULL) AS step_4_any_token_match,
                (s5.pipe_sig IS NOT NULL) AS step_5_normalized_token_signature_match,
                (s6.hit IS NOT NULL) AS step_6_any_normalized_token_match,
                (
                  ac.alias_name = ri.raw_value
                  OR ac.alias_name = ri.normalization_value
                  OR ft7.run_item_id IS NOT NULL
                  OR fn7.run_item_id IS NOT NULL
                ) AS step_7_matches_alias_name
              FROM run_items_to_score ri
              CROSS JOIN alias_candidates ac
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
                FROM flat_tokens ft
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
                FROM flat_norm_tokens ft
                INNER JOIN STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
                  ON ts.token = ft.token_val
                 AND ts.token_type = 'alias'
                 AND ts.alias_id IS NOT NULL
              ) s6
                ON s6.run_item_id = ri.run_item_id
               AND s6.alias_id = ac.alias_id
              LEFT JOIN (
                SELECT DISTINCT run_item_id, token_val
                FROM flat_tokens
              ) ft7
                ON ft7.run_item_id = ri.run_item_id
               AND ft7.token_val = ac.alias_name
              LEFT JOIN (
                SELECT DISTINCT run_item_id, token_val
                FROM flat_norm_tokens
              ) fn7
                ON fn7.run_item_id = ri.run_item_id
               AND fn7.token_val = ac.alias_name
            ),
            direct_rows AS (
              SELECT
                d.run_item_id,
                d.raw_value,
                d.alias_id,
                d.alias_name,
                100 AS confidence_score,
                NULL::BOOLEAN AS step_1_raw_value_match,
                NULL::BOOLEAN AS step_2_normalization_value_match,
                NULL::BOOLEAN AS step_3_token_signature_match,
                NULL::BOOLEAN AS step_4_any_token_match,
                NULL::BOOLEAN AS step_5_normalized_token_signature_match,
                NULL::BOOLEAN AS step_6_any_normalized_token_match,
                NULL::BOOLEAN AS step_7_matches_alias_name,
                TRUE AS chosen_alias,
                'stored_raw_value' AS match_source
              FROM direct_matches d
            ),
            scored_rows AS (
              SELECT
                s.run_item_id,
                s.raw_value,
                s.alias_id,
                s.alias_name,
                (
                  IFF(s.step_1_raw_value_match, 1, 0)
                  + IFF(s.step_2_normalization_value_match, 1, 0)
                  + IFF(s.step_3_token_signature_match, 1, 0)
                  + IFF(s.step_4_any_token_match, 1, 0)
                  + IFF(s.step_5_normalized_token_signature_match, 1, 0)
                  + IFF(s.step_6_any_normalized_token_match, 1, 0)
                  + IFF(s.step_7_matches_alias_name, 1, 0)
                ) AS confidence_score,
                s.step_1_raw_value_match,
                s.step_2_normalization_value_match,
                s.step_3_token_signature_match,
                s.step_4_any_token_match,
                s.step_5_normalized_token_signature_match,
                s.step_6_any_normalized_token_match,
                s.step_7_matches_alias_name,
                IFF(
                  ROW_NUMBER() OVER (
                    PARTITION BY s.run_item_id
                    ORDER BY
                      (
                        IFF(s.step_1_raw_value_match, 1, 0)
                        + IFF(s.step_2_normalization_value_match, 1, 0)
                        + IFF(s.step_3_token_signature_match, 1, 0)
                        + IFF(s.step_4_any_token_match, 1, 0)
                        + IFF(s.step_5_normalized_token_signature_match, 1, 0)
                        + IFF(s.step_6_any_normalized_token_match, 1, 0)
                        + IFF(s.step_7_matches_alias_name, 1, 0)
                      ) DESC,
                      s.alias_id ASC
                  ) = 1,
                  TRUE,
                  FALSE
                ) AS chosen_alias,
                'alias_summary_scoring' AS match_source
              FROM scored s
            )
            SELECT
              q.run_item_id,
              q.raw_value,
              q.alias_id,
              q.alias_name,
              q.confidence_score,
              q.step_1_raw_value_match,
              q.step_2_normalization_value_match,
              q.step_3_token_signature_match,
              q.step_4_any_token_match,
              q.step_5_normalized_token_signature_match,
              q.step_6_any_normalized_token_match,
              q.step_7_matches_alias_name,
              q.chosen_alias,
              q.match_source
            FROM (
              SELECT * FROM direct_rows
              UNION ALL
              SELECT * FROM scored_rows
            ) q
            ORDER BY q.run_item_id ASC, q.confidence_score DESC NULLS LAST, q.alias_id ASC
          `,
          binds: [run_id, conceptId, conceptId],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const runItemTokenRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              run_item_id,
              normalization_value AS normalized_value,
              tokens,
              normalized_tokens,
              IFF(
                tokens IS NOT NULL AND IS_ARRAY(tokens) AND ARRAY_SIZE(tokens::ARRAY) > 0,
                ARRAY_TO_STRING(tokens::ARRAY, '|'),
                NULL
              ) AS new_token_signature,
              IFF(
                normalized_tokens IS NOT NULL AND IS_ARRAY(normalized_tokens) AND ARRAY_SIZE(normalized_tokens::ARRAY) > 0,
                ARRAY_TO_STRING(normalized_tokens::ARRAY, '|'),
                NULL
              ) AS new_normalized_token_signature
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
            WHERE run_id = ?
          `,
          binds: [run_id],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const aliasTokenRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              ts.alias_id,
              an.key_value AS alias_name,
              LISTAGG(ts.token, '|') WITHIN GROUP (ORDER BY ts.position_in_signature) AS token_signature_pipe,
              COUNT(*)::NUMBER AS token_count
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            INNER JOIN (
              SELECT alias_id, key_value
              FROM STAND_DB.STAND_INTERNAL.ALIAS_SUMMARY
              WHERE concept_id = ?
                AND key_type = 'alias name'
                AND key_value IS NOT NULL
              QUALIFY ROW_NUMBER() OVER (PARTITION BY alias_id ORDER BY alias_summary_id ASC) = 1
            ) an
              ON an.alias_id = ts.alias_id
            WHERE ts.token_type = 'alias'
              AND ts.alias_id IS NOT NULL
            GROUP BY ts.alias_id, an.key_value
          `,
          binds: [conceptId],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      // Per-alias raw-value token signatures (standard + normalized) for this concept
      const rawValueSigRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              rv.alias_id,
              ts.raw_value_id,
              rv.normalization_value AS normalized_value,
              ts.token_type,
              LISTAGG(ts.token, '|') WITHIN GROUP (ORDER BY ts.position_in_signature) AS token_signature_pipe
            FROM STAND_DB.STAND_INTERNAL.TOKENS_SUMMARY ts
            INNER JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv
              ON rv.raw_value_id = ts.raw_value_id
            INNER JOIN STAND_DB.STAND_INTERNAL.ALIASES a
              ON a.alias_id = rv.alias_id
            WHERE a.concept_id = ?
              AND ts.token_type IN ('standard', 'normalized')
              AND ts.raw_value_id IS NOT NULL
            GROUP BY rv.alias_id, ts.raw_value_id, rv.normalization_value, ts.token_type
          `,
          binds: [conceptId],
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const aliasValueRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              rv.alias_id,
              rv.raw_value_id,
              rv.normalization_value AS normalized_value
            FROM STAND_DB.STAND_INTERNAL.RAW_VALUES rv
            INNER JOIN STAND_DB.STAND_INTERNAL.ALIASES a
              ON a.alias_id = rv.alias_id
            WHERE a.concept_id = ?
          `,
          binds: [conceptId],
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const tokensFromVariant = (v: unknown): string[] => {
        if (v == null) return [];
        if (Array.isArray(v)) {
          return v.map((x) => String(x).trim()).filter((t) => t.length > 0);
        }
        if (typeof v === 'string') {
          try {
            const p = JSON.parse(v);
            if (Array.isArray(p)) {
              return p.map((x) => String(x).trim()).filter((t) => t.length > 0);
            }
          } catch {
            /* ignore */
          }
        }
        return [];
      };

      const runItemTokensById = new Map<
        number,
        {
          std: string[];
          norm: string[];
          normalized_value: string | null;
          new_token_signature: string | null;
          new_normalized_token_signature: string | null;
        }
      >();
      for (const row of runItemTokenRows) {
        const id = Number((row as any).RUN_ITEM_ID);
        const std = tokensFromVariant((row as any).TOKENS);
        const norm = tokensFromVariant((row as any).NORMALIZED_TOKENS);
        runItemTokensById.set(id, {
          std,
          norm,
          normalized_value:
            (row as any).NORMALIZED_VALUE === null || (row as any).NORMALIZED_VALUE === undefined
              ? null
              : String((row as any).NORMALIZED_VALUE),
          new_token_signature:
            (row as any).NEW_TOKEN_SIGNATURE === null || (row as any).NEW_TOKEN_SIGNATURE === undefined
              ? null
              : String((row as any).NEW_TOKEN_SIGNATURE),
          new_normalized_token_signature:
            (row as any).NEW_NORMALIZED_TOKEN_SIGNATURE === null ||
            (row as any).NEW_NORMALIZED_TOKEN_SIGNATURE === undefined
              ? null
              : String((row as any).NEW_NORMALIZED_TOKEN_SIGNATURE),
        });
      }

      const parsePipeTokens = (pipe: string | null | undefined): string[] =>
        String(pipe ?? '')
          .split('|')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

      const aliasTokensById = new Map<number, string[]>();
      for (const row of aliasTokenRows) {
        aliasTokensById.set(
          Number((row as any).ALIAS_ID),
          parsePipeTokens((row as any).TOKEN_SIGNATURE_PIPE as string)
        );
      }

      type RawSigEntry = { raw_value_id: number; tokens: string[] };
      const rawValueSigsById = new Map<
        number,
        { standard: RawSigEntry[]; normalized: RawSigEntry[] }
      >();
      const aliasNormalizedValuesById = new Map<number, Array<{ raw_value_id: number; normalized_value: string }>>();
      for (const row of aliasValueRows) {
        const aliasId = Number((row as any).ALIAS_ID);
        const rawValueId = Number((row as any).RAW_VALUE_ID);
        const normalizedValue =
          (row as any).NORMALIZED_VALUE === null || (row as any).NORMALIZED_VALUE === undefined
            ? ''
            : String((row as any).NORMALIZED_VALUE);
        if (!aliasNormalizedValuesById.has(aliasId)) {
          aliasNormalizedValuesById.set(aliasId, []);
        }
        aliasNormalizedValuesById.get(aliasId)!.push({
          raw_value_id: rawValueId,
          normalized_value: normalizedValue,
        });
      }
      for (const row of rawValueSigRows) {
        const aliasId = Number((row as any).ALIAS_ID);
        const rawValueId = Number((row as any).RAW_VALUE_ID);
        const tokenType = String((row as any).TOKEN_TYPE ?? '').toLowerCase();
        const tokens = parsePipeTokens((row as any).TOKEN_SIGNATURE_PIPE as string);
        if (!rawValueSigsById.has(aliasId)) {
          rawValueSigsById.set(aliasId, { standard: [], normalized: [] });
        }
        const entry = rawValueSigsById.get(aliasId)!;
        if (tokenType === 'standard') {
          entry.standard.push({ raw_value_id: rawValueId, tokens });
        } else if (tokenType === 'normalized') {
          entry.normalized.push({ raw_value_id: rawValueId, tokens });
        }
      }

      type AliasSigComparison = {
        comparison_kind: string;
        existing_signature: string;
        signature_length: number;
        overlap_score_signature: number;
        overlap_score_calculation: string;
        is_subset_new_to_old: boolean;
        is_subset_old_to_new: boolean;
        longest_matching_subsequence_length: number;
      };
      type ValueComparison = {
        comparison_kind: string;
        existing_raw_value_id: number;
        run_item_normalized_value: string;
        alias_value_normalized_value: string;
        jaro_winkler_score: number;
      };
      type TokenSimilarityResult = {
        overlap_score_alias: number;
        jaro_winkler_score_total: number;
        num_subsets: number;
        sum_subsequence_length: number;
        run_item_normalized_value: string | null;
        new_token_signature: string | null;
        new_normalized_token_signature: string | null;
        token_signature_comparisons: Array<
          AliasSigComparison & { existing_raw_value_id: number; jaro_winkler_score: number }
        >;
        normalized_token_signature_comparisons: Array<
          AliasSigComparison & { existing_raw_value_id: number; jaro_winkler_score: number }
        >;
        value_comparisons: ValueComparison[];
        alias_token_signature_comparison: {
          alias_id: number;
          alias_token_signature: string;
          standard_to_alias: AliasSigComparison;
          normalized_to_alias: AliasSigComparison;
        };
      };
      const tokenSimilarityByKey = new Map<string, TokenSimilarityResult>();

      const isSubset = (subsetTokens: string[], supersetTokens: string[]): boolean => {
        if (subsetTokens.length === 0) return false;
        const superset = new Set(supersetTokens);
        for (const token of subsetTokens) {
          if (!superset.has(token)) return false;
        }
        return true;
      };

      const longestCommonSubsequenceLength = (a: string[], b: string[]): number => {
        const m = a.length;
        const n = b.length;
        if (m === 0 || n === 0) return 0;
        const dp: number[][] = Array.from({ length: m + 1 }, () =>
          new Array<number>(n + 1).fill(0)
        );
        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
              dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
              dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
          }
        }
        return dp[m][n];
      };

      const jaroWinklerScore = (leftRaw: string | null | undefined, rightRaw: string | null | undefined): number => {
        const left = String(leftRaw ?? '').toLowerCase();
        const right = String(rightRaw ?? '').toLowerCase();
        if (left.length === 0 && right.length === 0) return 1;
        if (left.length === 0 || right.length === 0) return 0;
        if (left === right) return 1;

        const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
        const leftMatches = new Array<boolean>(left.length).fill(false);
        const rightMatches = new Array<boolean>(right.length).fill(false);

        let matches = 0;
        for (let i = 0; i < left.length; i++) {
          const start = Math.max(0, i - matchDistance);
          const end = Math.min(i + matchDistance + 1, right.length);
          for (let j = start; j < end; j++) {
            if (rightMatches[j]) continue;
            if (left[i] !== right[j]) continue;
            leftMatches[i] = true;
            rightMatches[j] = true;
            matches++;
            break;
          }
        }

        if (matches === 0) return 0;

        let transpositionsHalf = 0;
        let rightIndex = 0;
        for (let i = 0; i < left.length; i++) {
          if (!leftMatches[i]) continue;
          while (rightIndex < right.length && !rightMatches[rightIndex]) rightIndex++;
          if (rightIndex < right.length && left[i] !== right[rightIndex]) {
            transpositionsHalf++;
          }
          rightIndex++;
        }
        const transpositions = transpositionsHalf / 2;
        const m = matches;
        const jaro = (m / left.length + m / right.length + (m - transpositions) / m) / 3;

        let prefixLength = 0;
        const maxPrefix = 4;
        while (
          prefixLength < maxPrefix &&
          prefixLength < left.length &&
          prefixLength < right.length &&
          left[prefixLength] === right[prefixLength]
        ) {
          prefixLength++;
        }

        const scalingFactor = 0.1;
        return jaro + prefixLength * scalingFactor * (1 - jaro);
      };

      /** Overlap score: positions defined by the existing signature's token order; checks if run tokens contain each. */
      const overlapAgainstSignature = (
        existingTokensOrdered: string[],
        runSideTokens: string[]
      ): { overlap_score_signature: number; overlap_score_calculation: string; signature_length: number; existing_signature: string } => {
        const runSet = new Set(runSideTokens);
        let sum = 0;
        const parts: string[] = [];
        for (let i = 0; i < existingTokensOrdered.length; i++) {
          const position = i + 1;
          const tok = existingTokensOrdered[i];
          const tokenMatch = runSet.has(tok) ? 1 : 0;
          sum += tokenMatch * position;
          parts.push(`${tok}:${tokenMatch}*${position}=${tokenMatch * position}`);
        }
        return {
          overlap_score_signature: sum,
          overlap_score_calculation: parts.join(', '),
          signature_length: existingTokensOrdered.length,
          existing_signature: existingTokensOrdered.join('|'),
        };
      };

      const buildTokenSimilarity = (runItemId: number, aliasId: number): TokenSimilarityResult => {
        const ri = runItemTokensById.get(runItemId);
        const aliasToks = aliasTokensById.get(aliasId) ?? [];
        const std = ri?.std ?? [];
        const norm = ri?.norm ?? [];
        const runItemNormalizedValue = ri?.normalized_value ?? null;
        const rawSigs = rawValueSigsById.get(aliasId) ?? { standard: [], normalized: [] };
        const aliasNormalizedValues = aliasNormalizedValuesById.get(aliasId) ?? [];

        const jaroWinklerByRawValueId = new Map<number, number>();
        const value_comparisons = aliasNormalizedValues.map((entry) => {
          const score = jaroWinklerScore(runItemNormalizedValue, entry.normalized_value);
          jaroWinklerByRawValueId.set(entry.raw_value_id, score);
          return {
            comparison_kind: 'run_item_normalized_value_to_alias_value_normalized_value',
            existing_raw_value_id: entry.raw_value_id,
            run_item_normalized_value: String(runItemNormalizedValue ?? ''),
            alias_value_normalized_value: String(entry.normalized_value ?? ''),
            jaro_winkler_score: score,
          };
        });

        // --- Per-raw-value standard signature comparisons (run std tokens vs each existing std sig) ---
        const token_signature_comparisons = rawSigs.standard.map((entry) => {
          const overlap = overlapAgainstSignature(entry.tokens, std);
          const lcs = longestCommonSubsequenceLength(std, entry.tokens);
          return {
            comparison_kind: 'run_standard_tokens_to_raw_value_standard_tokens',
            existing_raw_value_id: entry.raw_value_id,
            ...overlap,
            is_subset_new_to_old: isSubset(std, entry.tokens),
            is_subset_old_to_new: isSubset(entry.tokens, std),
            longest_matching_subsequence_length: lcs,
            jaro_winkler_score: jaroWinklerByRawValueId.get(entry.raw_value_id) ?? 0,
          };
        });

        // --- Per-raw-value normalized signature comparisons (run norm tokens vs each existing norm sig) ---
        const normalized_token_signature_comparisons = rawSigs.normalized.map((entry) => {
          const overlap = overlapAgainstSignature(entry.tokens, norm);
          const lcs = longestCommonSubsequenceLength(norm, entry.tokens);
          return {
            comparison_kind: 'run_normalized_tokens_to_raw_value_normalized_tokens',
            existing_raw_value_id: entry.raw_value_id,
            ...overlap,
            is_subset_new_to_old: isSubset(norm, entry.tokens),
            is_subset_old_to_new: isSubset(entry.tokens, norm),
            longest_matching_subsequence_length: lcs,
            jaro_winkler_score: jaroWinklerByRawValueId.get(entry.raw_value_id) ?? 0,
          };
        });

        // --- Alias token signature comparison (run std + run norm vs the single alias token signature) ---
        const stdAliasOverlap = overlapAgainstSignature(aliasToks, std);
        const normAliasOverlap = overlapAgainstSignature(aliasToks, norm);
        const stdAliasLcs = longestCommonSubsequenceLength(std, aliasToks);
        const normAliasLcs = longestCommonSubsequenceLength(norm, aliasToks);

        const alias_token_signature_comparison = {
          alias_id: aliasId,
          alias_token_signature: aliasToks.join('|'),
          standard_to_alias: {
            comparison_kind: 'run_standard_tokens_to_alias_tokens',
            ...stdAliasOverlap,
            is_subset_new_to_old: isSubset(std, aliasToks),
            is_subset_old_to_new: isSubset(aliasToks, std),
            longest_matching_subsequence_length: stdAliasLcs,
          },
          normalized_to_alias: {
            comparison_kind: 'run_normalized_tokens_to_alias_tokens',
            ...normAliasOverlap,
            is_subset_new_to_old: isSubset(norm, aliasToks),
            is_subset_old_to_new: isSubset(aliasToks, norm),
            longest_matching_subsequence_length: normAliasLcs,
          },
        };

        // --- Aggregate scores across all three comparison sections ---
        const overlapScoreAlias =
          token_signature_comparisons.reduce((s, c) => s + c.overlap_score_signature, 0) +
          normalized_token_signature_comparisons.reduce((s, c) => s + c.overlap_score_signature, 0) +
          stdAliasOverlap.overlap_score_signature +
          normAliasOverlap.overlap_score_signature;
        const jaroWinklerScoreTotal = value_comparisons.reduce((sum, comparison) => {
          return sum + comparison.jaro_winkler_score;
        }, 0);

        const numSubsets =
          token_signature_comparisons.reduce(
            (s, c) => s + (c.is_subset_new_to_old ? 1 : 0) + (c.is_subset_old_to_new ? 1 : 0),
            0
          ) +
          normalized_token_signature_comparisons.reduce(
            (s, c) => s + (c.is_subset_new_to_old ? 1 : 0) + (c.is_subset_old_to_new ? 1 : 0),
            0
          ) +
          (alias_token_signature_comparison.standard_to_alias.is_subset_new_to_old ? 1 : 0) +
          (alias_token_signature_comparison.standard_to_alias.is_subset_old_to_new ? 1 : 0) +
          (alias_token_signature_comparison.normalized_to_alias.is_subset_new_to_old ? 1 : 0) +
          (alias_token_signature_comparison.normalized_to_alias.is_subset_old_to_new ? 1 : 0);

        const sumSubsequenceLength =
          token_signature_comparisons.reduce((s, c) => s + c.longest_matching_subsequence_length, 0) +
          normalized_token_signature_comparisons.reduce(
            (s, c) => s + c.longest_matching_subsequence_length,
            0
          ) +
          stdAliasLcs +
          normAliasLcs;

        return {
          overlap_score_alias: overlapScoreAlias,
          jaro_winkler_score_total: jaroWinklerScoreTotal,
          num_subsets: numSubsets,
          sum_subsequence_length: sumSubsequenceLength,
          run_item_normalized_value: runItemNormalizedValue,
          new_token_signature: ri?.new_token_signature ?? null,
          new_normalized_token_signature: ri?.new_normalized_token_signature ?? null,
          token_signature_comparisons,
          normalized_token_signature_comparisons,
          value_comparisons,
          alias_token_signature_comparison,
        };
      };

      const similarityKeySet = new Set<string>();
      for (const r of confidenceRows) {
        const ms = String((r as any).MATCH_SOURCE ?? 'alias_summary_scoring');
        if (ms === 'stored_raw_value') continue;
        const runItemId = Number((r as any).RUN_ITEM_ID);
        const aliasId = Number((r as any).ALIAS_ID);
        similarityKeySet.add(`${runItemId}::${aliasId}`);
      }
      for (const key of similarityKeySet) {
        const [runItemIdStr, aliasIdStr] = key.split('::');
        tokenSimilarityByKey.set(
          key,
          buildTokenSimilarity(Number(runItemIdStr), Number(aliasIdStr))
        );
      }

      const computedConfidenceRows = confidenceRows.map((r: any) => {
        const matchSource = String(r.MATCH_SOURCE ?? 'alias_summary_scoring');
        const runItemId = Number(r.RUN_ITEM_ID);
        const aliasId = Number(r.ALIAS_ID);
        const baseConfidence =
          r.CONFIDENCE_SCORE === null || r.CONFIDENCE_SCORE === undefined
            ? 0
            : Number(r.CONFIDENCE_SCORE);
        const similarity = tokenSimilarityByKey.get(`${runItemId}::${aliasId}`);
        const overlapScoreAlias = similarity?.overlap_score_alias ?? 0;
        const numSubsets = similarity?.num_subsets ?? 0;
        const sumSubsequenceLength = similarity?.sum_subsequence_length ?? 0;
        const finalConfidence =
          matchSource === 'stored_raw_value'
            ? 100
            : baseConfidence + overlapScoreAlias + numSubsets + sumSubsequenceLength;

        return {
          ...r,
          _matchSource: matchSource,
          _runItemId: runItemId,
          _aliasId: aliasId,
          _baseConfidence: baseConfidence,
          _overlapScoreAlias: overlapScoreAlias,
          _numSubsets: numSubsets,
          _sumSubsequenceLength: sumSubsequenceLength,
          _finalConfidence: finalConfidence,
          _tokenSimilarity: similarity ?? null,
        };
      });

      // Recompute chosen alias using final confidence (base + overlap_score_alias + num_subsets + sum_subsequence_length).
      const topByRunItem = new Map<number, { aliasId: number; score: number }>();
      for (const r of computedConfidenceRows) {
        const runItemId = (r as any)._runItemId as number;
        const aliasId = (r as any)._aliasId as number;
        const score = (r as any)._finalConfidence as number;
        const existing = topByRunItem.get(runItemId);
        if (!existing || score > existing.score || (score === existing.score && aliasId < existing.aliasId)) {
          topByRunItem.set(runItemId, { aliasId, score });
        }
      }

      const confidenceDetails = computedConfidenceRows.map((r: any) => {
        const matchSource = r._matchSource as 'stored_raw_value' | 'alias_summary_scoring';
        const runItemId = r._runItemId as number;
        const aliasId = r._aliasId as number;
        const similarity = r._tokenSimilarity as TokenSimilarityResult | null;
        const top = topByRunItem.get(runItemId);
        const isChosen = Boolean(top && top.aliasId === aliasId);

        const base = {
          run_item_id: runItemId,
          raw_value: String(r.RAW_VALUE ?? ''),
          alias_id: aliasId,
          alias_name: String(r.ALIAS_NAME ?? ''),
          confidence_score: Number(r._finalConfidence ?? 0),
          chosen_alias: isChosen,
          match_source: matchSource,
          value_to_alias_values_comparison: {
            overlap_score_alias: similarity?.overlap_score_alias ?? 0,
            jaro_winkler_score_total: similarity?.jaro_winkler_score_total ?? 0,
            num_subsets: similarity?.num_subsets ?? 0,
            sum_subsequence_length: similarity?.sum_subsequence_length ?? 0,
            run_item_normalized_value: similarity?.run_item_normalized_value ?? null,
            new_token_signature: similarity?.new_token_signature ?? null,
            new_normalized_token_signature: similarity?.new_normalized_token_signature ?? null,
            token_signature_comparisons: similarity?.token_signature_comparisons ?? [],
            normalized_token_signature_comparisons:
              similarity?.normalized_token_signature_comparisons ?? [],
            value_comparisons: similarity?.value_comparisons ?? [],
            alias_token_signature_comparison:
              similarity?.alias_token_signature_comparison ?? null,
          },
        };

        if (matchSource === 'stored_raw_value') {
          return {
            ...base,
            exact_match: null,
            value_to_alias_values_comparison: null,
            note: 'Matched from ALIAS_SUMMARY (key_type=raw value) for this concept; full step scoring skipped.',
          };
        }

        return {
          ...base,
          exact_match: {
            step_1_raw_value_match: Boolean(r.STEP_1_RAW_VALUE_MATCH),
            step_2_normalization_value_match: Boolean(r.STEP_2_NORMALIZATION_VALUE_MATCH),
            step_3_token_signature_match: Boolean(r.STEP_3_TOKEN_SIGNATURE_MATCH),
            step_4_any_token_match: Boolean(r.STEP_4_ANY_TOKEN_MATCH),
            step_5_normalized_token_signature_match: Boolean(
              r.STEP_5_NORMALIZED_TOKEN_SIGNATURE_MATCH
            ),
            step_6_any_normalized_token_match: Boolean(r.STEP_6_ANY_NORMALIZED_TOKEN_MATCH),
            step_7_matches_alias_name: Boolean(r.STEP_7_MATCHES_ALIAS_NAME),
          },
        };
      });

      /** Best chosen confidence per run_item (100 = ALIAS_SUMMARY direct match; else base + overlap + subsets + sum_subsequence_length) */
      const chosenConfidenceByRunItemId = new Map<number, number>();
      for (const detail of confidenceDetails) {
        if (detail.chosen_alias) {
          chosenConfidenceByRunItemId.set(detail.run_item_id, Number(detail.confidence_score ?? 0));
        }
      }

      const groupKeyById = new Map<number, string>();
      const aliasMap: AliasMap = {};

      for (const g of groups) {
        const key = g.ALIAS_NAME ?? `group_${g.GROUP_ID}`;
        groupKeyById.set(g.GROUP_ID, key);
        aliasMap[key] = { group_id: g.GROUP_ID, items: [] };
      }

      const itemPayload = (it: (typeof items)[0], chosenScore?: number) => {
        const resolvedConfidence =
          typeof chosenScore === 'number' && Number.isFinite(chosenScore)
            ? chosenScore
            : (it as any).CONFIDENCE_SCORE === null || (it as any).CONFIDENCE_SCORE === undefined
              ? null
              : Number((it as any).CONFIDENCE_SCORE);

        return {
          run_item_id: it.RUN_ITEM_ID,
          raw_value: it.RAW_VALUE,
          confidence_score: resolvedConfidence,
        };
      };

      for (const it of items) {
        const runItemId = Number((it as any).RUN_ITEM_ID);
        const chosenScore = chosenConfidenceByRunItemId.get(runItemId);
        const forceUngrouped = chosenScore === 0;

        if (forceUngrouped) {
          if (!aliasMap[UNGROUPED_KEY]) {
            aliasMap[UNGROUPED_KEY] = { group_id: null, items: [] };
          }
          aliasMap[UNGROUPED_KEY].items.push(itemPayload(it, chosenScore));
          continue;
        }

        const rawGroupId = (it as any).GROUP_ID;
        const groupIdNum =
          rawGroupId === null || rawGroupId === undefined
            ? null
            : Number(rawGroupId);

        if (typeof groupIdNum === 'number' && Number.isFinite(groupIdNum)) {
          const key = groupKeyById.get(groupIdNum) ?? `group_${groupIdNum}`;
          if (!aliasMap[key]) {
            aliasMap[key] = { group_id: groupIdNum, items: [] };
          }
          aliasMap[key].items.push(itemPayload(it, chosenScore));
          continue;
        }

        // Ungrouped (group_id NULL)
        if (!aliasMap[UNGROUPED_KEY]) {
          aliasMap[UNGROUPED_KEY] = { group_id: null, items: [] };
        }
        aliasMap[UNGROUPED_KEY].items.push(itemPayload(it, chosenScore));
      }

      // Always include the ungrouped bucket so the UI has a stable drop target.
      if (!aliasMap[UNGROUPED_KEY]) {
        aliasMap[UNGROUPED_KEY] = { group_id: null, items: [] };
      }

      return Response.json(
        { data: aliasMap, confidence_details: confidenceDetails },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      );
    });
  } catch (error) {
    console.error('Database error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch alias mapping');
  }
}


