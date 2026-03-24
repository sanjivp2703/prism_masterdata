import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

async function exec(
  connection: any,
  sqlText: string,
  binds?: any[]
) {
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
    let aliasNameChanges: Array<{ group_id: number; alias_name: string }> = [];
    let newGroups: Array<{ temp_group_id: number; alias_name: string }> = [];

    try {
      const body = await request.json();
      if (Array.isArray(body?.new_groups)) {
        newGroups = body.new_groups
          .map((g: any) => ({
            temp_group_id: Number.parseInt(String(g?.temp_group_id), 10),
            alias_name: String(g?.alias_name ?? '').trim() || 'Unnamed Group',
          }))
          .filter(
            (g: { temp_group_id: number; alias_name: string }) =>
              Number.isFinite(g.temp_group_id) &&
              g.temp_group_id < 0 &&
              g.alias_name.length > 0
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
            alias_name: String(c?.alias_name ?? '').trim(),
          }))
          .filter(
            (c: { group_id: number; alias_name: string }) =>
              Number.isFinite(c.group_id) && c.alias_name.length > 0
          );
      }
    } catch {
      // ignore missing/invalid body
    }
    return await withSnowflake(async (connection) => {
      // Ensure the run exists and we know which concept it belongs to.
      const runRows = await exec(
        connection,
        `
          SELECT concept_id
          FROM STAND_DB.STAND_INTERNAL.RUNS
          WHERE run_id = ?
        `,
        [run_id]
      );
      const conceptId = Number(runRows?.[0]?.CONCEPT_ID ?? runRows?.[0]?.concept_id);
      if (!Number.isFinite(conceptId)) {
        throw new Error(`Run not found or missing concept_id for run_id=${run_id}`);
      }

      // Create any new UI-created groups (client temp ids) before applying moves.
      const tempToRealGroupId = new Map<number, number>();
      if (newGroups.length > 0) {
        for (const g of newGroups) {
          await exec(
            connection,
            `
              INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
                run_id,
                initial_alias_name,
                alias_name,
                is_user_created,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `,
            [run_id, g.alias_name, g.alias_name]
          );

          const rows = await exec(
            connection,
            `
              SELECT group_id
              FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
              WHERE run_id = ?
                AND alias_name = ?
            `,
            [run_id, g.alias_name]
          );
          const groupId = Number(rows?.[0]?.GROUP_ID ?? rows?.[0]?.group_id);
          if (!Number.isFinite(groupId)) {
            throw new Error(
              `Failed to resolve created group_id for alias_name=${g.alias_name}`
            );
          }
          tempToRealGroupId.set(g.temp_group_id, groupId);
        }

        // Rewrite any moves targeting temp ids to the newly-created group ids
        moves = moves.map((m) => {
          if (typeof m.group_id === 'number' && m.group_id < 0) {
            const real = tempToRealGroupId.get(m.group_id);
            if (!real) {
              throw new Error(`Unknown temp_group_id in moves: ${m.group_id}`);
            }
            return { ...m, group_id: real };
          }
          return m;
        });
      }

      if (aliasNameChanges.length > 0) {
        const pairs = aliasNameChanges.map(() => '(?, ?)').join(', ');
        const binds: any[] = [];
        for (const c of aliasNameChanges) {
          binds.push(c.group_id, c.alias_name);
        }
        binds.push(run_id);

        await exec(
          connection,
          `
            UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            SET alias_name = mv.alias_name
            FROM (
              SELECT column1::NUMBER AS group_id, column2::VARCHAR AS alias_name
              FROM VALUES ${pairs}
            ) mv
            WHERE rg.run_id = ?
              AND rg.group_id = mv.group_id
          `,
          binds
        );
      }

      if (moves.length > 0) {
        const toNullIds = moves
          .filter((m) => m.group_id === null)
          .map((m) => m.run_item_id);
        const toGroups = moves.filter(
          (m): m is { run_item_id: number; group_id: number } =>
            typeof m.group_id === 'number' && m.group_id > 0
        );

        if (toGroups.length > 0) {
          const pairs = toGroups.map(() => '(?, ?)').join(', ');
          const binds: any[] = [];
          for (const m of toGroups) {
            binds.push(m.run_item_id, m.group_id);
          }
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

      // =========================================================================
      // APPLY VALIDATION RESULTS TO MASTER TABLES
      // =========================================================================

      // 3) ALIASES + RUN_GROUPS.final_alias_id:
      // - If a group has no final_alias_id, ensure an alias exists for (concept_id, desired_alias_name) and link the group.
      // - If a group has an existing final_alias_id, rename it to match the desired name (and touch updated_at).
      //
      // "desired" name is the current user-edited alias_name, falling back to initial_alias_name.

      // Create missing aliases for this concept (for groups without final_alias_id).
      await exec(
        connection,
        `
          INSERT INTO STAND_DB.STAND_INTERNAL.ALIASES (
            concept_id, alias_name, alias_subgroup_id, status, created_at, updated_at
          )
          SELECT DISTINCT
            r.concept_id,
            COALESCE(rg.alias_name, rg.initial_alias_name) AS alias_name,
            rg.group_id AS alias_subgroup_id,
            'active' AS status,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            ON rg.run_id = r.run_id
          WHERE r.run_id = ?
            AND rg.final_alias_id IS NULL
            AND rg.is_user_created = TRUE
            AND COALESCE(rg.alias_name, rg.initial_alias_name) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM STAND_DB.STAND_INTERNAL.ALIASES a
              WHERE a.concept_id = r.concept_id
                AND a.alias_name = COALESCE(rg.alias_name, rg.initial_alias_name)
            )
        `,
        [run_id]
      );

      // Link any still-unlinked groups to the alias_id for their desired alias_name.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET final_alias_id = a.alias_id,
              updated_at = CURRENT_TIMESTAMP
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a
            ON a.concept_id = r.concept_id
          WHERE rg.run_id = r.run_id
            AND r.run_id = ?
            AND rg.final_alias_id IS NULL
            AND rg.is_user_created = TRUE
            AND a.alias_name = COALESCE(rg.alias_name, rg.initial_alias_name)
        `,
        [run_id]
      );

      // If a referenced alias is being renamed to a name that already exists for the same concept,
      // UNIQUE(concept_id, alias_name) would be violated. In that case, merge the two aliases:
      // - Keep the existing alias row that already has the desired name
      // - Re-point all references from the "from" alias_id -> "to" alias_id
      // - Delete the "from" alias row
      //
      // Note: we explicitly avoid treating "swap" renames as merges (A->B and B->A), by only
      // merging when the alias currently owning the desired name is not itself being renamed
      // away from that desired name in this run.
      await exec(
        connection,
        `
          CREATE OR REPLACE TEMP TABLE TMP_ALIAS_DESIRED AS
          SELECT
            rg.final_alias_id AS alias_id,
            MIN(COALESCE(rg.alias_name, rg.initial_alias_name)) AS desired_alias_name
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
            a_from.concept_id AS concept_id,
            d.desired_alias_name AS desired_alias_name
          FROM TMP_ALIAS_DESIRED d
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a_from
            ON a_from.alias_id = d.alias_id
          JOIN STAND_DB.STAND_INTERNAL.ALIASES a_keep
            ON a_keep.concept_id = a_from.concept_id
           AND a_keep.alias_name = d.desired_alias_name
           AND a_keep.alias_id <> d.alias_id
          LEFT JOIN TMP_ALIAS_DESIRED d_keep
            ON d_keep.alias_id = a_keep.alias_id
          WHERE d_keep.alias_id IS NULL
             OR d_keep.desired_alias_name = a_keep.alias_name
        `
      );

      // Re-point references: RUN_GROUPS.final_alias_id
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET final_alias_id = m.to_alias_id,
              updated_at = CURRENT_TIMESTAMP
          FROM TMP_ALIAS_MERGES m
          WHERE rg.final_alias_id = m.from_alias_id
        `
      );

      // Re-point references: RAW_VALUES.alias_id
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RAW_VALUES rv
          SET alias_id = m.to_alias_id,
              updated_at = CURRENT_TIMESTAMP
          FROM TMP_ALIAS_MERGES m
          WHERE rv.alias_id = m.from_alias_id
        `
      );

      // Touch the survivor aliases.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET updated_at = CURRENT_TIMESTAMP
          FROM (SELECT DISTINCT to_alias_id FROM TMP_ALIAS_MERGES) s
          WHERE a.alias_id = s.to_alias_id
        `
      );

      // Delete the merged-away aliases (now that all FK refs have been repointed).
      await exec(
        connection,
        `
          DELETE FROM STAND_DB.STAND_INTERNAL.ALIASES
          WHERE alias_id IN (SELECT DISTINCT from_alias_id FROM TMP_ALIAS_MERGES)
        `
      );

      // Rename existing aliases referenced by this run to match desired name (touch updated_at always).
      // Do the rename in 2 steps (temporary unique name -> desired name) so swaps don't violate uniqueness.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET alias_name = '__tmp__' || a.alias_id || '__' || TO_VARCHAR(CURRENT_TIMESTAMP, 'YYYYMMDDHH24MISSFF3'),
              updated_at = updated_at
          FROM (
            SELECT DISTINCT
              rg.final_alias_id AS alias_id,
              COALESCE(rg.alias_name, rg.initial_alias_name) AS desired_alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            WHERE rg.run_id = ?
              AND rg.final_alias_id IS NOT NULL
          ) rg_desired
          WHERE a.alias_id = rg_desired.alias_id
            AND a.alias_name <> rg_desired.desired_alias_name
        `,
        [run_id]
      );

      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET alias_name = rg_desired.desired_alias_name,
              updated_at = CURRENT_TIMESTAMP
          FROM (
            SELECT DISTINCT
              rg.final_alias_id AS alias_id,
              COALESCE(rg.alias_name, rg.initial_alias_name) AS desired_alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            WHERE rg.run_id = ?
              AND rg.final_alias_id IS NOT NULL
          ) rg_desired
          WHERE a.alias_id = rg_desired.alias_id
            AND a.alias_name <> rg_desired.desired_alias_name
        `,
        [run_id]
      );

      // 4) RAW_VALUES:
      // For every run item, ensure raw_value exists for the (profile_id, raw_value) pair.
      // If it exists, update alias_id if it changed, set confidence=99, approved=true, and touch updated_at.
      // If it doesn't exist, insert with confidence=99 + approved=true.
      //
      // NOTE:
      // - For items whose mapping is an *exact* already-known mapping for this concept, we do NOT
      //   treat it as a fresh manual validation: confidence is set to 100 (i.e. 1.0) instead of 99.
      await exec(
        connection,
        `
          MERGE INTO STAND_DB.STAND_INTERNAL.RAW_VALUES tgt
          USING (
            SELECT
              ri.raw_value,
              ri.profile_id,
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
                  FROM STAND_DB.STAND_INTERNAL.RAW_VALUES existing
                  JOIN STAND_DB.STAND_INTERNAL.ALIASES a
                    ON a.alias_id = existing.alias_id
                  WHERE existing.profile_id = ri.profile_id
                    AND existing.raw_value = ri.raw_value
                    AND existing.alias_id = rg.final_alias_id
                    AND a.concept_id = r.concept_id
                    AND a.alias_name = COALESCE(rg.alias_name, rg.initial_alias_name)
                ),
                100,
                99
              ) AS confidence_score
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
            JOIN STAND_DB.STAND_INTERNAL.RUNS r
              ON r.run_id = ri.run_id
            JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
              ON rg.run_id = ri.run_id
             AND rg.group_id = ri.group_id
            WHERE ri.run_id = ?
              AND ri.profile_id IS NOT NULL
              AND rg.final_alias_id IS NOT NULL
          ) src
          ON tgt.profile_id = src.profile_id
         AND tgt.raw_value = src.raw_value
          WHEN MATCHED THEN
            UPDATE SET
              alias_id = src.alias_id,
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
              alias_id,
              profile_id,
              raw_value,
              normalization_value,
              tokens,
              tokens_count,
              normalized_tokens,
              normalized_tokens_count,
              confidence,
              source,
              approved,
              created_at,
              updated_at
            )
            VALUES (
              src.alias_id,
              src.profile_id,
              src.raw_value,
              src.normalization_value,
              src.tokens,
              src.tokens_count,
              src.normalized_tokens,
              src.normalized_tokens_count,
              src.confidence_score,
              'manual_review',
              src.approved_flag,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
        `,
        [run_id]
      );

      // Mark as completed after validation approval
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUNS
          SET run_status = 'completed',
              requires_validation = TRUE,
              updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ?
        `,
        [run_id]
      );

      // 5) ALIAS_SUMMARY:
      // Rebuild summary entries for all aliases affected by this run.
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

      // Tokenize canonical alias names using the concept's classification ruleset (same as raw values).
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
          SET
            tokens = sub.pipeline:tokens,
            token_count = sub.pipeline:tokens_count::NUMBER,
            updated_at = CURRENT_TIMESTAMP()
          FROM (
            SELECT
              a2.alias_id,
              STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(a2.alias_name, prof.ruleset) AS pipeline
            FROM STAND_DB.STAND_INTERNAL.ALIASES a2
            JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
            JOIN STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES prof
              ON prof.profile_id = c.profile_id
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

      for (const row of affectedAliases) {
        const aliasId = Number((row as any).ALIAS_ID ?? (row as any).alias_id);
        if (!Number.isFinite(aliasId)) continue;
        await exec(
          connection,
          `CALL STAND_DB.STAND.REFRESH_ALIAS_SUMMARY(?)`,
          [aliasId]
        );
        await exec(
          connection,
          `CALL STAND_DB.STAND.REFRESH_TOKENS_SUMMARY(?)`,
          [aliasId]
        );
      }

      return Response.json(
        { data: { run_id: runIdNum, status: 'completed' } },
        { status: 200 }
      );
    });
  } catch (error) {
    console.error('Approve error:', error);
    return snowflakeErrorResponse(error, 'Approve failed');
  }
}


