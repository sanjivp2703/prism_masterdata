import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { invalidateAliasCacheEntries } from '@/app/api/_lib/redis-cache';

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

async function exec(connection: any, sqlText: string, binds?: any[]) {
  return await new Promise<any[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  try {
    const runIdNum = Number.parseInt(String(run_id), 10);
    if (!Number.isFinite(runIdNum)) {
      return Response.json({ error: 'Invalid run_id' }, { status: 400 });
    }

    let moves: Array<{ run_item_id: number; group_id: number | null }> = [];
    let aliasNameChanges: Array<{ group_id: number; alias_name_literal_value: string }> = [];
    let newGroups: Array<{ temp_group_id: number; alias_name_literal_value: string }> = [];
    let includeOriginalCol = true;

    try {
      const body = await request.json();
      if (body?.include_original_col === false) includeOriginalCol = false;
      if (Array.isArray(body?.new_groups)) {
        newGroups = body.new_groups
          .map((g: any) => ({
            temp_group_id: Number.parseInt(String(g?.temp_group_id), 10),
            alias_name_literal_value: String(g?.alias_name_literal_value ?? '').trim() || 'Unnamed Group',
          }))
          .filter(
            (g: { temp_group_id: number; alias_name_literal_value: string }) =>
              Number.isFinite(g.temp_group_id) &&
              g.temp_group_id < 0 &&
              g.alias_name_literal_value.length > 0
          );
      }
      if (Array.isArray(body?.moves)) {
        moves = body.moves
          .map((m: any) => ({
            run_item_id: Number.parseInt(String(m?.run_item_id), 10),
            group_id:
              m?.group_id === null || m?.group_id === undefined
                ? null
                : Number.parseInt(String(m?.group_id), 10),
          }))
          .filter(
            (m: { run_item_id: number; group_id: number | null }) =>
              Number.isFinite(m.run_item_id) &&
              (m.group_id === null || Number.isFinite(m.group_id))
          );
      }
      if (Array.isArray(body?.alias_name_changes)) {
        aliasNameChanges = body.alias_name_changes
          .map((c: any) => ({
            group_id: Number.parseInt(String(c?.group_id), 10),
            alias_name_literal_value: String(c?.alias_name_literal_value ?? '').trim(),
          }))
          .filter(
            (c: { group_id: number; alias_name_literal_value: string }) =>
              Number.isFinite(c.group_id) && c.alias_name_literal_value.length > 0
          );
      }
    } catch {
      // ignore missing/invalid body
    }

    return await withSnowflake(async (connection) => {
      const runRows = await exec(
        connection,
        `
          SELECT r.source_relation, r.source_column, r.concept_id, r.run_status,
                 c.profile_id
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
          WHERE r.run_id = ?
        `,
        [run_id]
      );

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const sourceRelation = runRows[0].SOURCE_RELATION as string;
      const sourceColumn = runRows[0].SOURCE_COLUMN as string;
      const conceptId = Number(runRows[0].CONCEPT_ID ?? runRows[0].concept_id);
      const runStatus = String(runRows[0].RUN_STATUS ?? runRows[0].run_status ?? '');
      const profileId = Number(runRows[0].PROFILE_ID ?? runRows[0].profile_id);

      if (!Number.isFinite(conceptId)) {
        throw new Error(`Run missing concept_id for run_id=${run_id}`);
      }

      const { db, schema, table } = parseFqn(sourceRelation);
      // When includeOriginalCol=false the standardized value replaces the source column
      // (same position, same name) using Snowflake's SELECT * REPLACE syntax.
      const standardizedCol   = includeOriginalCol ? `${sourceColumn}_STANDARDIZED` : sourceColumn;
      const viewName          = `${table}_STANDARDIZED_RUN_${run_id}`;
      const tableFqn          = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const viewFqn           = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(viewName)}`;
      const colIdent          = quoteIdent(sourceColumn);
      const standardizedIdent = quoteIdent(standardizedCol);

      const mappingSubquery = `
        SELECT
          ri.literal_value AS literal_value,
          COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS alias_value
        FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
        JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          ON rg.run_id = ri.run_id
         AND rg.group_id = ri.group_id
        WHERE ri.run_id = ${runIdNum}`;

      const viewSql = includeOriginalCol
        ? `
        CREATE OR REPLACE VIEW ${viewFqn} AS
        SELECT
          t.*,
          COALESCE(m.alias_value, TO_VARCHAR(t.${colIdent})) AS ${standardizedIdent}
        FROM ${tableFqn} t
        LEFT JOIN (${mappingSubquery}) m ON TO_VARCHAR(t.${colIdent}) = m.literal_value`
        : `
        CREATE OR REPLACE VIEW ${viewFqn} AS
        SELECT t.* REPLACE (COALESCE(m.alias_value, TO_VARCHAR(t.${colIdent})) AS ${standardizedIdent})
        FROM ${tableFqn} t
        LEFT JOIN (${mappingSubquery}) m ON TO_VARCHAR(t.${colIdent}) = m.literal_value`;

      // ── RE-EXPORT (already completed) ───────────────────────────────────────
      // The run was already exported and its data committed to the master tables.
      // Only rebuild the view — don't re-apply any moves or re-run promotion.
      if (runStatus === 'completed') {
        await exec(connection, viewSql);

        const cntRows = await exec(
          connection,
          `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS WHERE run_id = ?`,
          [run_id]
        );

        return Response.json({
          data: {
            run_id,
            source_relation: sourceRelation,
            source_column: sourceColumn,
            view_fqn: `${db}.${schema}.${viewName}`,
            standardized_column: standardizedCol,
            mapped_values_count: Number(cntRows?.[0]?.CNT ?? 0),
          },
        });
      }

      // ── FIRST EXPORT ─────────────────────────────────────────────────────────

      // 1. Create any new UI-created groups (resolve client temp ids to real ids).
      const tempToRealGroupId = new Map<number, number>();
      if (newGroups.length > 0) {
        for (const g of newGroups) {
          await exec(
            connection,
            `
              INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
                run_id, initial_alias_name, alias_name_literal_value,
                is_user_created, created_at, updated_at
              )
              VALUES (?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `,
            [run_id, g.alias_name_literal_value, g.alias_name_literal_value]
          );

          const rows = await exec(
            connection,
            `
              SELECT MAX(group_id) AS group_id
              FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
              WHERE run_id = ?
                AND alias_name_literal_value = ?
                AND is_user_created = TRUE
            `,
            [run_id, g.alias_name_literal_value]
          );
          const groupId = Number(rows?.[0]?.GROUP_ID ?? rows?.[0]?.group_id);
          if (!Number.isFinite(groupId)) {
            throw new Error(
              `Failed to resolve created group_id for alias_name_literal_value=${g.alias_name_literal_value}`
            );
          }
          tempToRealGroupId.set(g.temp_group_id, groupId);
        }

        moves = moves.map((m) => {
          if (typeof m.group_id === 'number' && m.group_id < 0) {
            const real = tempToRealGroupId.get(m.group_id);
            if (!real) throw new Error(`Unknown temp_group_id in moves: ${m.group_id}`);
            return { ...m, group_id: real };
          }
          return m;
        });
      }

      // 2. Apply alias name changes.
      if (aliasNameChanges.length > 0) {
        const pairs = aliasNameChanges.map(() => '(?, ?)').join(', ');
        const binds: any[] = [];
        for (const c of aliasNameChanges) binds.push(c.group_id, c.alias_name_literal_value);
        binds.push(run_id);

        await exec(
          connection,
          `
            UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            SET alias_name_literal_value = mv.alias_name_literal_value
            FROM (
              SELECT column1::NUMBER AS group_id, column2::VARCHAR AS alias_name_literal_value
              FROM VALUES ${pairs}
            ) mv
            WHERE rg.run_id = ?
              AND rg.group_id = mv.group_id
          `,
          binds
        );
      }

      // 3. Apply item moves.
      if (moves.length > 0) {
        const toNullIds = moves.filter((m) => m.group_id === null).map((m) => m.run_item_id);
        const toGroups = moves.filter(
          (m): m is { run_item_id: number; group_id: number } =>
            typeof m.group_id === 'number' && m.group_id > 0
        );

        if (toGroups.length > 0) {
          const pairs = toGroups.map(() => '(?, ?)').join(', ');
          const binds: any[] = [];
          for (const m of toGroups) binds.push(m.run_item_id, m.group_id);
          binds.push(run_id, run_id);

          await exec(
            connection,
            `
              UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
              SET group_id = mv.group_id
              FROM (
                SELECT column1::NUMBER AS run_item_id, column2::NUMBER AS group_id
                FROM VALUES ${pairs}
              ) mv
              JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
                ON rg.run_id = ?
               AND rg.group_id = mv.group_id
              WHERE ri.run_id = ?
                AND ri.run_item_id = mv.run_item_id
            `,
            binds
          );
        }

        if (toNullIds.length > 0) {
          const placeholders = toNullIds.map(() => '?').join(', ');
          await exec(
            connection,
            `
              UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS
              SET group_id = NULL
              WHERE run_id = ?
                AND run_item_id IN (${placeholders})
            `,
            [run_id, ...toNullIds]
          );
        }
      }

      // 4. Link groups to existing aliases by name match.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET final_alias_id = a.alias_id,
              updated_at = CURRENT_TIMESTAMP
          FROM STAND_DB.STAND_INTERNAL.ALIASES a
          WHERE rg.run_id = ?
            AND rg.final_alias_id IS NULL
            AND a.concept_id = ?
            AND a.alias_name_literal_value = COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)
        `,
        [run_id, conceptId]
      );

      // 5. Create new ALIASES for user-created groups that don't match any existing alias.
      await exec(
        connection,
        `
          INSERT INTO STAND_DB.STAND_INTERNAL.ALIASES (
            concept_id, alias_name_literal_value, alias_subgroup_id, status, created_at, updated_at
          )
          SELECT DISTINCT
            r.concept_id,
            COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS alias_name_literal_value,
            rg.group_id AS alias_subgroup_id,
            'active' AS status,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg ON rg.run_id = r.run_id
          WHERE r.run_id = ?
            AND rg.final_alias_id IS NULL
            AND rg.is_user_created = TRUE
            AND COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM STAND_DB.STAND_INTERNAL.ALIASES a
              WHERE a.concept_id = r.concept_id
                AND a.alias_name_literal_value = COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)
                AND a.alias_subgroup_id = rg.group_id
            )
        `,
        [run_id]
      );

      // 6. Link newly created aliases back to RUN_GROUPS.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET final_alias_id = a.alias_id,
              updated_at = CURRENT_TIMESTAMP
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a ON a.concept_id = r.concept_id
          WHERE rg.run_id = r.run_id
            AND r.run_id = ?
            AND rg.final_alias_id IS NULL
            AND rg.is_user_created = TRUE
            AND a.alias_name_literal_value = COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)
            AND a.alias_subgroup_id = rg.group_id
        `,
        [run_id]
      );

      // 7. Detect alias rename collisions — build merge tables.
      await exec(
        connection,
        `
          CREATE OR REPLACE TEMP TABLE TMP_ALIAS_DESIRED AS
          SELECT
            rg.final_alias_id AS alias_id,
            MIN(COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)) AS desired_alias_name
          FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          WHERE rg.run_id = ?
            AND rg.final_alias_id IS NOT NULL
          GROUP BY rg.final_alias_id
        `,
        [run_id]
      );

      await exec(
        connection,
        `
          CREATE OR REPLACE TEMP TABLE TMP_ALIAS_MERGES AS
          SELECT
            d.alias_id AS from_alias_id,
            a_keep.alias_id AS to_alias_id,
            a_from.concept_id,
            d.desired_alias_name
          FROM TMP_ALIAS_DESIRED d
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a_from ON a_from.alias_id = d.alias_id
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a_keep
            ON a_keep.concept_id = a_from.concept_id
           AND a_keep.alias_name_literal_value = d.desired_alias_name
           AND a_keep.alias_subgroup_id = a_from.alias_subgroup_id
           AND a_keep.alias_id <> d.alias_id
          LEFT JOIN TMP_ALIAS_DESIRED d_keep ON d_keep.alias_id = a_keep.alias_id
          WHERE d_keep.alias_id IS NULL
             OR d_keep.desired_alias_name = a_keep.alias_name_literal_value
        `
      );

      // Re-point RUN_GROUPS and ALIAS_ITEMS from merged-away aliases to surviving aliases.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET final_alias_id = m.to_alias_id, updated_at = CURRENT_TIMESTAMP
          FROM TMP_ALIAS_MERGES m
          WHERE rg.final_alias_id = m.from_alias_id
        `
      );

      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
          SET alias_id = m.to_alias_id, updated_at = CURRENT_TIMESTAMP
          FROM TMP_ALIAS_MERGES m
          WHERE rv.alias_id = m.from_alias_id
        `
      );

      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET updated_at = CURRENT_TIMESTAMP
          FROM (SELECT DISTINCT to_alias_id FROM TMP_ALIAS_MERGES) s
          WHERE a.alias_id = s.to_alias_id
        `
      );

      await exec(
        connection,
        `
          DELETE FROM STAND_DB.STAND_INTERNAL.ALIASES
          WHERE alias_id IN (SELECT DISTINCT from_alias_id FROM TMP_ALIAS_MERGES)
        `
      );

      // 8. Rename aliases in two steps to avoid uniqueness violations on swaps.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET alias_name_literal_value = '__tmp__' || a.alias_id || '__' || TO_VARCHAR(CURRENT_TIMESTAMP, 'YYYYMMDDHH24MISSFF3'),
              updated_at = updated_at
          FROM (
            SELECT DISTINCT
              rg.final_alias_id AS alias_id,
              COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS desired_alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            WHERE rg.run_id = ?
              AND rg.final_alias_id IS NOT NULL
          ) rg_desired
          WHERE a.alias_id = rg_desired.alias_id
            AND a.alias_name_literal_value <> rg_desired.desired_alias_name
        `,
        [run_id]
      );

      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET alias_name_literal_value = rg_desired.desired_alias_name,
              updated_at = CURRENT_TIMESTAMP
          FROM (
            SELECT DISTINCT
              rg.final_alias_id AS alias_id,
              COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS desired_alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            WHERE rg.run_id = ?
              AND rg.final_alias_id IS NOT NULL
          ) rg_desired
          WHERE a.alias_id = rg_desired.alias_id
            AND a.alias_name_literal_value <> rg_desired.desired_alias_name
        `,
        [run_id]
      );

      // 9. MERGE run items into ALIAS_ITEMS.
      // profile_id lives on CONCEPTS, not RUN_ITEMS; bind it as a constant.
      await exec(
        connection,
        `
          MERGE INTO STAND_DB.STAND_INTERNAL.ALIAS_ITEMS tgt
          USING (
            SELECT
              ri.literal_value,
              ri.cleaned_value,
              ${profileId}                            AS profile_id,
              ri.normalization_value,
              ri.tokens,
              ri.tokens_count,
              ri.normalized_tokens,
              ri.normalized_tokens_count,
              rg.final_alias_id AS alias_id,
              TRUE AS approved_flag,
              IFF(
                EXISTS (
                  SELECT 1
                  FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS existing
                  JOIN STAND_DB.STAND_INTERNAL.ALIASES a
                    ON a.alias_id = existing.alias_id
                  WHERE existing.profile_id = ${profileId}
                    AND existing.literal_value = ri.literal_value
                    AND existing.alias_id = rg.final_alias_id
                    AND a.concept_id = ${conceptId}
                    AND a.alias_name_literal_value = COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)
                ),
                100,
                99
              ) AS confidence_score
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
            JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
              ON rg.run_id = ri.run_id
             AND rg.group_id = ri.group_id
            WHERE ri.run_id = ?
              AND rg.final_alias_id IS NOT NULL
          ) src
          ON tgt.profile_id = src.profile_id
         AND tgt.literal_value = src.literal_value
          WHEN MATCHED THEN
            UPDATE SET
              alias_id = src.alias_id,
              cleaned_value = COALESCE(tgt.cleaned_value, src.cleaned_value),
              normalization_value = src.normalization_value,
              tokens = src.tokens,
              tokens_count = src.tokens_count,
              normalized_tokens = src.normalized_tokens,
              normalized_tokens_count = src.normalized_tokens_count,
              confidence = src.confidence_score,
              source = 'manual_review',
              approved = src.approved_flag,
              updated_at = CURRENT_TIMESTAMP
          WHEN NOT MATCHED THEN
            INSERT (
              alias_id, profile_id, literal_value, cleaned_value,
              normalization_value, tokens, tokens_count, normalized_tokens,
              normalized_tokens_count, confidence, source, approved,
              created_at, updated_at
            )
            VALUES (
              src.alias_id, src.profile_id, src.literal_value, src.cleaned_value,
              src.normalization_value, src.tokens, src.tokens_count, src.normalized_tokens,
              src.normalized_tokens_count, src.confidence_score, 'manual_review',
              src.approved_flag, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `,
        [run_id]
      );

      // 10. Create/replace the standardized view.
      await exec(connection, viewSql);

      const cntRows = await exec(
        connection,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS WHERE run_id = ?`,
        [run_id]
      );

      // 11. Tokenize canonical alias names using the concept's classification ruleset.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET
            alias_name_tokens = sub.pipeline:tokens,
            alias_name_tokens_count = sub.pipeline:tokens_count::NUMBER,
            updated_at = CURRENT_TIMESTAMP()
          FROM (
            SELECT
              a2.alias_id,
              STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(a2.alias_name_literal_value, ecr.enriched_ruleset) AS pipeline
            FROM STAND_DB.STAND_INTERNAL.ALIASES a2
            JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
            JOIN STAND_DB.STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS ecr
              ON ecr.concept_id = c.concept_id
            WHERE a2.alias_id IN (
              SELECT DISTINCT rg.final_alias_id
              FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
              WHERE rg.run_id = ?
                AND rg.final_alias_id IS NOT NULL
            )
          ) sub
          WHERE a.alias_id = sub.alias_id
        `,
        [run_id]
      );

      // 12. Mark run completed.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUNS
          SET run_status = 'completed',
              updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ?
        `,
        [run_id]
      );

      // 13. Refresh summaries and invalidate caches for all affected aliases.
      const affectedAliases = await exec(
        connection,
        `
          SELECT DISTINCT rg.final_alias_id AS alias_id
          FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          WHERE rg.run_id = ?
            AND rg.final_alias_id IS NOT NULL
        `,
        [run_id]
      );

      for (const row of affectedAliases) {
        const aliasId = Number((row as any).ALIAS_ID ?? (row as any).alias_id);
        if (!Number.isFinite(aliasId)) continue;
        await exec(connection, `CALL STAND_DB.STAND.REFRESH_ALIAS_SUMMARY(?)`, [aliasId]);
        await exec(connection, `CALL STAND_DB.STAND.REFRESH_TOKENS_SUMMARY(?)`, [aliasId]);
        await invalidateAliasCacheEntries(conceptId, aliasId);
      }

      // 14. Populate one-prompt lookup tables from the finalised run state.
      // ONE_PROMPT_LITERAL_ALIAS_MATCHES records every confirmed literal→alias
      // mapping so future one-prompt runs can skip LLM calls for known values.
      // ONE_PROMPT_APPROVED_ALIAS_NAMES tracks which canonical names have been
      // confirmed through at least one export.
      await exec(
        connection,
        `
          MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES AS t
          USING (
            SELECT
              ri.literal_value,
              COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
            JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
              ON rg.run_id = ri.run_id
             AND rg.group_id = ri.group_id
            WHERE ri.run_id = ?
              AND ri.group_id IS NOT NULL
              AND COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) IS NOT NULL
          ) AS s
          ON t.literal_value = s.literal_value
          WHEN MATCHED THEN UPDATE SET
            t.alias_name   = s.alias_name,
            t.run_id       = ?,
            t.confirmed_at = CURRENT_TIMESTAMP()
          WHEN NOT MATCHED THEN INSERT (literal_value, alias_name, run_id, confirmed_at)
            VALUES (s.literal_value, s.alias_name, ?, CURRENT_TIMESTAMP())
        `,
        [runIdNum, runIdNum, runIdNum]
      );

      await exec(
        connection,
        `
          MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES AS t
          USING (
            SELECT DISTINCT COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            WHERE rg.run_id = ?
              AND COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) IS NOT NULL
          ) AS s
          ON t.alias_name = s.alias_name
          WHEN MATCHED THEN UPDATE SET
            t.usage_count  = t.usage_count + 1,
            t.last_used_at = CURRENT_TIMESTAMP()
          WHEN NOT MATCHED THEN INSERT (alias_name, usage_count, last_used_at)
            VALUES (s.alias_name, 1, CURRENT_TIMESTAMP())
        `,
        [runIdNum]
      );

      // Build a state blob for ONE_PROMPT_RUN_STATE from the finalised run so
      // that GET /api/one-prompt/runs/[run_id]/state returns meaningful data
      // for retrospective inspection and future lookup-seeding.
      const finalItemRows = await exec(
        connection,
        `
          SELECT
            ri.literal_value,
            COALESCE(rg.alias_name_literal_value, rg.initial_alias_name) AS alias_name,
            rg.group_id
          FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
          LEFT JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            ON rg.run_id = ri.run_id
           AND rg.group_id = ri.group_id
          WHERE ri.run_id = ?
          ORDER BY rg.group_id NULLS LAST, ri.literal_value
        `,
        [runIdNum]
      );

      // Build group map and ungrouped list from the query results.
      const groupMap = new Map<number, { alias_name: string; items: Array<{ literal_value: string; matched_from_lookup: boolean }> }>();
      const ungroupedItems: Array<{ literal_value: string; matched_from_lookup: boolean }> = [];

      for (const row of finalItemRows) {
        const lv      = String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? '');
        const gid     = (row as any).GROUP_ID   ?? (row as any).group_id;
        const an      = (row as any).ALIAS_NAME  ?? (row as any).alias_name;
        if (gid == null || an == null) {
          ungroupedItems.push({ literal_value: lv, matched_from_lookup: false });
        } else {
          const numGid = Number(gid);
          if (!groupMap.has(numGid)) {
            groupMap.set(numGid, { alias_name: String(an), items: [] });
          }
          groupMap.get(numGid)!.items.push({ literal_value: lv, matched_from_lookup: false });
        }
      }

      const stateGroups = [...groupMap.entries()].map(([gid, g], idx) => ({
        group_id:          gid,
        alias_name:        g.alias_name,
        alias_name_source: 'llm_proposed' as const,
        confidence:        'h'            as const,
        from_lookup_chunk: false,
        items:             g.items,
      }));

      const opStateJson = JSON.stringify({
        status:    'complete',
        items:     finalItemRows.map((row) => ({
          literal_value:       String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? ''),
          matched_from_lookup: false,
        })),
        groups:    stateGroups,
        ungrouped: ungroupedItems,
      });

      await exec(
        connection,
        `
          MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUN_STATE AS t
          USING (SELECT ? AS run_id, PARSE_JSON(?) AS state) AS s
            ON t.run_id = s.run_id
          WHEN MATCHED THEN UPDATE SET
            t.state      = s.state,
            t.updated_at = CURRENT_TIMESTAMP()
          WHEN NOT MATCHED THEN INSERT (run_id, state, updated_at)
            VALUES (s.run_id, s.state, CURRENT_TIMESTAMP())
        `,
        [runIdNum, opStateJson]
      );

      return Response.json({
        data: {
          run_id,
          source_relation: sourceRelation,
          source_column: sourceColumn,
          view_fqn: `${db}.${schema}.${viewName}`,
          standardized_column: standardizedCol,
          mapped_values_count: Number(cntRows?.[0]?.CNT ?? 0),
        },
      });
    });
  } catch (error) {
    console.error('Export error:', error);
    return snowflakeErrorResponse(error, 'Failed to export to Snowflake');
  }
}
