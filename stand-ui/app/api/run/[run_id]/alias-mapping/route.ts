import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

function quoteIdent(ident: string) {
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
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    // Human-readable display name. For alias-backed groups this equals the key.
    // For cluster groups (final_alias_id IS NULL) the key is `g_${group_id}` so
    // display_name carries the sequential label ("Group 1", etc.).
    display_name: string;
    items: Array<{
      run_item_id: number;
      literal_value: string;
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
      // Load run metadata to determine if we need to sync new source values.
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

      // Sync only for the validation flow (either actively validating, or flagged for admin validation).
      // New source values are inserted as ungrouped so reviewers can decide.
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
            const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
            const colRef = quoteIdent(sourceColumn);

            await new Promise<void>((resolve, reject) => {
              connection.execute({
                sqlText: `
                  INSERT INTO STAND_DB.STAND_INTERNAL.RUN_ITEMS (
                    run_id, group_id, literal_value, cleaned_value, profile_id,
                    normalization_value, tokens, tokens_count, normalized_tokens, normalized_tokens_count,
                    confidence_score, decision_status, created_at, updated_at
                  )
                  SELECT
                    ?,
                    NULL,
                    sv.literal_value,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):cleaned_value::VARCHAR,
                    c.profile_id,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):normalization_value::VARCHAR,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):tokens,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):tokens_count::NUMBER,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):normalized_tokens,
                    STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(sv.literal_value, ecr.enriched_ruleset):normalized_tokens_count::NUMBER,
                    0,
                    'pending',
                    CURRENT_TIMESTAMP(),
                    CURRENT_TIMESTAMP()
                  FROM (
                    SELECT DISTINCT TO_VARCHAR(${colRef}) AS literal_value
                    FROM ${tableRef}
                    WHERE ${colRef} IS NOT NULL
                  ) sv
                  JOIN STAND_DB.STAND_INTERNAL.RUNS r
                    ON r.run_id = ?
                  JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c
                    ON c.concept_id = r.concept_id
                  JOIN STAND_DB.STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS ecr
                    ON ecr.concept_id = c.concept_id
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
                    WHERE ri.run_id = ?
                      AND ri.literal_value = sv.literal_value
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
          console.warn('RUN_ITEMS sync failed; continuing without sync', e);
        }
      }

      // ── Load persisted groups from DB ────────────────────────────────────────
      const groups = await new Promise<Array<{
        GROUP_ID: number;
        ALIAS_NAME_LITERAL_VALUE: string;
        FINAL_ALIAS_ID: number | null;
      }>>(
        (resolve, reject) => {
          connection.execute({
            sqlText: `
              SELECT
                group_id,
                COALESCE(alias_name_literal_value, initial_alias_name) AS alias_name_literal_value,
                final_alias_id
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

      // ── Load persisted items from DB ─────────────────────────────────────────
      const items = await new Promise<
        Array<{
          RUN_ITEM_ID: number;
          GROUP_ID: number | null;
          LITERAL_VALUE: string;
          CONFIDENCE_SCORE: number | null;
        }>
      >(
        (resolve, reject) => {
          connection.execute({
            sqlText: shouldSync
              ? `
                -- Validation flow: hide items already validated with the exact mapping.
                SELECT
                  ri.run_item_id,
                  ri.group_id,
                  ri.literal_value,
                  ri.confidence_score
                FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
                WHERE ri.run_id = ?
                  AND NOT EXISTS (
                    SELECT 1
                    FROM STAND_DB.STAND_INTERNAL.RUNS r
                    JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
                      ON rg.run_id = r.run_id
                     AND rg.group_id = ri.group_id
                    JOIN STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
                      ON rv.literal_value = ri.literal_value
                     AND rv.alias_id = rg.final_alias_id
                    JOIN STAND_DB.STAND_INTERNAL.ALIASES a
                      ON a.alias_id = rv.alias_id
                    WHERE r.run_id = ri.run_id
                      AND rg.final_alias_id IS NOT NULL
                      AND a.concept_id = r.concept_id
                      AND a.alias_name_literal_value = COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)
                  )
                ORDER BY ri.group_id, ri.run_item_id
              `
              : `
                -- Review flow: show the full run snapshot.
                SELECT
                  ri.run_item_id,
                  ri.group_id,
                  ri.literal_value,
                  ri.confidence_score
                FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
                WHERE ri.run_id = ?
                ORDER BY ri.group_id, ri.run_item_id
              `,
            binds: [run_id],
            complete: (err, stmt, rows) => {
              if (err) reject(err);
              else resolve((rows || []) as any);
            },
          });
        }
      );

      // ── Build aliasMap purely from DB state ──────────────────────────────────
      // No confidence scoring — only persisted RUN_GROUPS rows become buckets.
      // Items are placed by their DB group_id; ungrouped items go to __UNGROUPED__.
      const groupKeyById = new Map<number, string>();
      const aliasMap: AliasMap = {};

      for (const g of groups) {
        const humanName = String(g.ALIAS_NAME_LITERAL_VALUE ?? `group_${g.GROUP_ID}`);
        const isCluster = g.FINAL_ALIAS_ID == null;
        // Cluster groups keyed by unique DB id to prevent collisions.
        // Alias-backed groups keyed by alias name (unique by DB constraint).
        const key = isCluster ? `g_${g.GROUP_ID}` : humanName;
        groupKeyById.set(g.GROUP_ID, key);
        aliasMap[key] = { group_id: g.GROUP_ID, display_name: humanName, items: [] };
      }

      for (const it of items) {
        const dbGroupId = (it as any).GROUP_ID != null ? Number((it as any).GROUP_ID) : null;
        const key = dbGroupId != null ? groupKeyById.get(dbGroupId) : undefined;
        const payload = {
          run_item_id: Number(it.RUN_ITEM_ID),
          literal_value: String(it.LITERAL_VALUE),
          confidence_score: it.CONFIDENCE_SCORE != null ? Number(it.CONFIDENCE_SCORE) : null,
        };

        if (key != null) {
          aliasMap[key].items.push(payload);
        } else {
          if (!aliasMap[UNGROUPED_KEY]) {
            aliasMap[UNGROUPED_KEY] = { group_id: null, display_name: '', items: [] };
          }
          aliasMap[UNGROUPED_KEY].items.push(payload);
        }
      }

      // Always include the ungrouped bucket so the UI has a stable drop target.
      if (!aliasMap[UNGROUPED_KEY]) {
        aliasMap[UNGROUPED_KEY] = { group_id: null, display_name: '', items: [] };
      }

      return Response.json(
        { data: aliasMap },
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
