import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { invalidateAliasCacheEntries } from '@/app/api/_lib/redis-cache';
import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
  type OpStateItem,
  type OpGroupItem,
} from '@/app/api/_lib/op-auto-group';
import { runOpExport } from '@/app/api/_lib/op-export';

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
      complete: (err: any, stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Apply UI mutations (new groups, renames, item moves) to the state blob.
// This replaces the old SQL UPDATE statements on RUN_GROUPS / RUN_ITEMS.
// ---------------------------------------------------------------------------
interface StateMutation {
  newGroups:        Array<{ temp_group_id: number; alias_name_literal_value: string }>;
  moves:            Array<{ run_item_id: number; group_id: number | null }>;
  aliasNameChanges: Array<{ group_id: number; alias_name_literal_value: string }>;
}

function applyStateMutations(
  state:    OpRunState,
  mutation: StateMutation,
): { state: OpRunState; tempToReal: Map<number, number> } {
  // Assign stable positive group_ids to new UI-created groups.
  const maxGroupId  = Math.max(0, ...state.groups.map((g) => g.group_id));
  let   nextGroupId = maxGroupId + 1;
  const tempToReal  = new Map<number, number>();

  const groups = [...state.groups];

  for (const ng of mutation.newGroups) {
    const realId = nextGroupId++;
    tempToReal.set(ng.temp_group_id, realId);
    groups.push({
      group_id:          realId,
      alias_name:        ng.alias_name_literal_value,
      alias_name_source: 'user_override',
      confidence:        'h',
      from_lookup_chunk: false,
      items:             [],
    });
  }

  // Apply alias renames.
  const renamedGroups = groups.map((g) => {
    const change = mutation.aliasNameChanges.find((c) => c.group_id === g.group_id);
    return change
      ? { ...g, alias_name: change.alias_name_literal_value, alias_name_source: 'user_override' as const }
      : g;
  });

  // Resolve temp → real in moves.
  const resolvedMoves = mutation.moves.map((m) => ({
    ...m,
    group_id:
      m.group_id !== null && m.group_id < 0
        ? (tempToReal.get(m.group_id) ?? null)
        : m.group_id,
  }));

  // Build run_item_id → literal_value index.
  const idToLiteral = new Map<number, string>();
  state.items.forEach((item, idx) => {
    idToLiteral.set(item.run_item_id ?? (idx + 1), item.literal_value);
  });

  // Build literal_value → target group_id (null = ungrouped).
  const literalToTarget = new Map<string, number | null>();
  for (const move of resolvedMoves) {
    const lv = idToLiteral.get(move.run_item_id);
    if (lv !== undefined) literalToTarget.set(lv, move.group_id);
  }

  // Rebuild groups: remove moved-out items, add moved-in items.
  const finalGroups = renamedGroups.map((g) => {
    const stayItems = g.items.filter((it) => {
      const target = literalToTarget.get(it.literal_value);
      return target === undefined || target === g.group_id;
    });
    const comeItems: OpGroupItem[] = resolvedMoves
      .filter((m) => m.group_id === g.group_id)
      .flatMap((m) => {
        const lv = idToLiteral.get(m.run_item_id);
        if (!lv) return [];
        if (stayItems.some((it) => it.literal_value === lv)) return [];
        const stateItem = state.items.find((it) => it.literal_value === lv);
        return [{ literal_value: lv, matched_from_lookup: stateItem?.matched_from_lookup ?? false }];
      });
    return { ...g, items: [...stayItems, ...comeItems] };
  });

  // Rebuild ungrouped.
  const newUngrouped = [
    ...state.ungrouped.filter((u) => {
      const target = literalToTarget.get(u.literal_value);
      return target === undefined || target === null;
    }),
  ];
  for (const move of resolvedMoves.filter((m) => m.group_id === null)) {
    const lv = idToLiteral.get(move.run_item_id);
    if (lv && !newUngrouped.some((u) => u.literal_value === lv)) {
      const stateItem = state.items.find((it) => it.literal_value === lv);
      newUngrouped.push({ literal_value: lv, matched_from_lookup: stateItem?.matched_from_lookup ?? false });
    }
  }

  return {
    state: { ...state, groups: finalGroups, ungrouped: newUngrouped },
    tempToReal,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

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

    let moves:            Array<{ run_item_id: number; group_id: number | null }> = [];
    let aliasNameChanges: Array<{ group_id: number; alias_name_literal_value: string }> = [];
    let newGroups:        Array<{ temp_group_id: number; alias_name_literal_value: string }> = [];
    let includeOriginalCol = true;

    try {
      const body = await request.json();
      if (body?.include_original_col === false) includeOriginalCol = false;
      if (Array.isArray(body?.new_groups)) {
        newGroups = body.new_groups
          .map((g: any) => ({
            temp_group_id:           Number.parseInt(String(g?.temp_group_id), 10),
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
            group_id:                Number.parseInt(String(c?.group_id), 10),
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
          FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS r
          JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
          WHERE r.run_id = ?
        `,
        [run_id]
      );

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const sourceRelation = runRows[0].SOURCE_RELATION as string;
      const sourceColumn   = runRows[0].SOURCE_COLUMN   as string;
      const conceptId      = Number(runRows[0].CONCEPT_ID  ?? runRows[0].concept_id);
      const runStatus      = String(runRows[0].RUN_STATUS  ?? runRows[0].run_status ?? '');
      const profileId      = Number(runRows[0].PROFILE_ID  ?? runRows[0].profile_id);

      if (!Number.isFinite(conceptId)) {
        throw new Error(`Run missing concept_id for run_id=${run_id}`);
      }

      const { db, schema, table } = parseFqn(sourceRelation);
      const standardizedCol   = includeOriginalCol ? `${sourceColumn}_STANDARDIZED` : sourceColumn;
      const viewName          = `${table}_STANDARDIZED_RUN_${run_id}`;
      const tableFqn          = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const viewFqn           = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(viewName)}`;
      const colIdent          = quoteIdent(sourceColumn);
      const standardizedIdent = quoteIdent(standardizedCol);

      // The VIEW maps literal_value → alias_name using ONE_PROMPT_LITERAL_ALIAS_MATCHES
      // (populated during export). This replaces the old RUN_ITEMS/RUN_GROUPS join.
      const mappingSubquery = `
        SELECT literal_value, alias_name AS alias_value
        FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
        WHERE run_id = ${runIdNum}`;

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
      if (runStatus === 'completed') {
        await exec(connection, viewSql);

        const cntRows = await exec(
          connection,
          `SELECT COUNT(*) AS cnt
           FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
           WHERE run_id = ?`,
          [run_id]
        );

        return Response.json({
          data: {
            run_id,
            source_relation:     sourceRelation,
            source_column:       sourceColumn,
            view_fqn:            `${db}.${schema}.${viewName}`,
            standardized_column: standardizedCol,
            mapped_values_count: Number(cntRows?.[0]?.CNT ?? 0),
          },
        });
      }

      // ── FIRST EXPORT ─────────────────────────────────────────────────────────

      // Load state — the single source of truth for items and groupings.
      const existingState = await loadOpRunState(connection, runIdNum);
      if (!existingState) {
        return Response.json(
          { error: 'Run state not found. Re-create the run to initialize state.' },
          { status: 400 }
        );
      }

      // Apply UI mutations (new groups, alias renames, item moves) to state.
      const { state: mutatedState } = applyStateMutations(existingState, {
        newGroups,
        moves,
        aliasNameChanges,
      });
      const finalState: OpRunState = { ...mutatedState, status: 'complete' };
      await saveOpRunState(connection, runIdNum, finalState);

      // Build temp tables for use in this connection's synchronous steps.
      const tmpGroupsSql = `
        CREATE OR REPLACE TEMP TABLE TMP_VIRTUAL_RUN_GROUPS AS
        SELECT
          g.value:group_id::NUMBER       AS group_id,
          g.value:alias_name::VARCHAR    AS initial_alias_name,
          g.value:alias_name::VARCHAR    AS alias_name_literal_value,
          NULL::NUMBER                    AS final_alias_id,
          (g.value:alias_name_source::VARCHAR = 'user_override')::BOOLEAN AS is_user_created
        FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS s,
        LATERAL FLATTEN(input => s.state:groups) g
        WHERE s.run_id = ?`;

      const tmpItemsSql = `
        CREATE OR REPLACE TEMP TABLE TMP_VIRTUAL_RUN_ITEMS AS
        SELECT
          g.value:group_id::NUMBER           AS group_id,
          i.value:literal_value::VARCHAR     AS literal_value
        FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS s,
        LATERAL FLATTEN(input => s.state:groups) g,
        LATERAL FLATTEN(input => g.value:items) i
        WHERE s.run_id = ?`;

      await exec(connection, tmpGroupsSql, [runIdNum]);
      await exec(connection, tmpItemsSql,  [runIdNum]);

      // ── SYNCHRONOUS: create the view and populate the mapping table ──────────
      // These are all that the user needs right now — everything else is deferred.

      console.log(`[export run ${runIdNum}] creating view and literal alias matches`);

      // Create/replace the standardized view.
      await exec(connection, viewSql);

      // Populate ONE_PROMPT_LITERAL_ALIAS_MATCHES (the view depends on this).
      await exec(
        connection,
        `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES AS t
         USING (
           SELECT
             vri.literal_value,
             vrg.alias_name_literal_value AS alias_name
           FROM TMP_VIRTUAL_RUN_ITEMS vri
           JOIN TMP_VIRTUAL_RUN_GROUPS vrg ON vrg.group_id = vri.group_id
           WHERE vrg.alias_name_literal_value IS NOT NULL
         ) AS s
         ON t.literal_value = s.literal_value AND t.run_id = ?
         WHEN MATCHED THEN UPDATE SET
           t.alias_name   = s.alias_name,
           t.confirmed_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (literal_value, alias_name, run_id, confirmed_at)
           VALUES (s.literal_value, s.alias_name, ?, CURRENT_TIMESTAMP())`,
        [runIdNum, runIdNum]
      );

      const cntRows = await exec(
        connection,
        `SELECT COUNT(*) AS cnt
         FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
         WHERE run_id = ?`,
        [runIdNum]
      );

      // Mark run completed so the UI reflects it immediately.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS
         SET run_status = 'completed', updated_at = CURRENT_TIMESTAMP
         WHERE run_id = ?`,
        [runIdNum]
      );

      // ── BACKGROUND: populate ALIASES, ALIAS_ITEMS, and refresh summaries ────
      // Opens a fresh Snowflake connection so we can return the HTTP response now.
      console.log(`[export run ${runIdNum}] kicking off background alias population`);
      withSnowflake(async (bgConn) => {
        const bgExec = (sql: string, binds?: any[]) =>
          exec(bgConn, sql, binds);

        // Recreate temp tables in the new session (TEMP tables are session-scoped).
        await bgExec(tmpGroupsSql, [runIdNum]);
        await bgExec(tmpItemsSql,  [runIdNum]);

        // 6. Classify grouped literals via APPLY_CLASSIFICATION_PIPELINE.
        console.log(`[export run ${runIdNum}] bg step 6: TMP_CLASSIFIED`);
        await bgExec(
          `CREATE OR REPLACE TEMP TABLE TMP_CLASSIFIED AS
           SELECT
             lv.literal_value,
             STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
               lv.literal_value, ecr.enriched_ruleset
             ) AS pipeline,
             c.profile_id
           FROM (SELECT DISTINCT literal_value FROM TMP_VIRTUAL_RUN_ITEMS) lv
           JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = ?
           JOIN STAND_DB.STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS ecr
             ON ecr.concept_id = c.concept_id`,
          [conceptId]
        );

        // 7. Link virtual groups to existing aliases by name.
        console.log(`[export run ${runIdNum}] bg step 7: link groups → existing aliases`);
        await bgExec(
          `UPDATE TMP_VIRTUAL_RUN_GROUPS rg
           SET final_alias_id = a.alias_id
           FROM STAND_DB.STAND_INTERNAL.ALIASES a
           WHERE rg.final_alias_id IS NULL
             AND a.concept_id = ?
             AND a.alias_name_literal_value = rg.alias_name_literal_value`,
          [conceptId]
        );

        // 8. Insert new ALIASES for unmatched groups.
        console.log(`[export run ${runIdNum}] bg step 8: INSERT new ALIASES`);
        await bgExec(
          `INSERT INTO STAND_DB.STAND_INTERNAL.ALIASES (
             concept_id, alias_name_literal_value, alias_subgroup_id, status, created_at, updated_at
           )
           SELECT DISTINCT ?, rg.alias_name_literal_value, rg.group_id, 'active',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM TMP_VIRTUAL_RUN_GROUPS rg
           WHERE rg.final_alias_id IS NULL
             AND rg.alias_name_literal_value IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM STAND_DB.STAND_INTERNAL.ALIASES a
               WHERE a.concept_id = ?
                 AND a.alias_name_literal_value = rg.alias_name_literal_value
                 AND a.alias_subgroup_id = rg.group_id
             )`,
          [conceptId, conceptId]
        );

        // 9. Link newly created aliases back to groups.
        console.log(`[export run ${runIdNum}] bg step 9: link new aliases → groups`);
        await bgExec(
          `UPDATE TMP_VIRTUAL_RUN_GROUPS rg
           SET final_alias_id = a.alias_id
           FROM STAND_DB.STAND_INTERNAL.ALIASES a
           WHERE rg.final_alias_id IS NULL
             AND a.concept_id = ?
             AND a.alias_name_literal_value = rg.alias_name_literal_value
             AND a.alias_subgroup_id = rg.group_id`,
          [conceptId]
        );

        // 10. Detect alias rename collisions.
        console.log(`[export run ${runIdNum}] bg step 10: alias merge tables`);
        await bgExec(
          `CREATE OR REPLACE TEMP TABLE TMP_ALIAS_DESIRED AS
           SELECT rg.final_alias_id AS alias_id, MIN(rg.alias_name_literal_value) AS desired_alias_name
           FROM TMP_VIRTUAL_RUN_GROUPS rg
           WHERE rg.final_alias_id IS NOT NULL
           GROUP BY rg.final_alias_id`
        );
        await bgExec(
          `CREATE OR REPLACE TEMP TABLE TMP_ALIAS_MERGES AS
           SELECT
             d.alias_id AS from_alias_id, a_keep.alias_id AS to_alias_id,
             a_from.concept_id, d.desired_alias_name
           FROM TMP_ALIAS_DESIRED d
           JOIN STAND_DB.STAND_INTERNAL.ALIASES a_from ON a_from.alias_id = d.alias_id
           JOIN STAND_DB.STAND_INTERNAL.ALIASES a_keep
             ON a_keep.concept_id               = a_from.concept_id
            AND a_keep.alias_name_literal_value = d.desired_alias_name
            AND a_keep.alias_subgroup_id        = a_from.alias_subgroup_id
            AND a_keep.alias_id                <> d.alias_id
           LEFT JOIN TMP_ALIAS_DESIRED d_keep ON d_keep.alias_id = a_keep.alias_id
           WHERE d_keep.alias_id IS NULL OR d_keep.desired_alias_name = a_keep.alias_name_literal_value`
        );
        await bgExec(
          `UPDATE TMP_VIRTUAL_RUN_GROUPS rg
           SET final_alias_id = m.to_alias_id
           FROM TMP_ALIAS_MERGES m WHERE rg.final_alias_id = m.from_alias_id`
        );
        await bgExec(
          `UPDATE STAND_DB.STAND_INTERNAL.ALIAS_ITEMS rv
           SET alias_id = m.to_alias_id, updated_at = CURRENT_TIMESTAMP
           FROM TMP_ALIAS_MERGES m WHERE rv.alias_id = m.from_alias_id`
        );
        await bgExec(
          `UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
           SET updated_at = CURRENT_TIMESTAMP
           FROM (SELECT DISTINCT to_alias_id FROM TMP_ALIAS_MERGES) s
           WHERE a.alias_id = s.to_alias_id`
        );
        await bgExec(
          `DELETE FROM STAND_DB.STAND_INTERNAL.ALIASES
           WHERE alias_id IN (SELECT DISTINCT from_alias_id FROM TMP_ALIAS_MERGES)`
        );

        // 11. Rename aliases in two passes to avoid unique-constraint swap violations.
        console.log(`[export run ${runIdNum}] bg step 11: rename aliases`);
        await bgExec(
          `UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
           SET alias_name_literal_value =
                 '__tmp__' || a.alias_id || '__' || TO_VARCHAR(CURRENT_TIMESTAMP, 'YYYYMMDDHH24MISSFF3'),
               updated_at = updated_at
           FROM (SELECT DISTINCT rg.final_alias_id AS alias_id, rg.alias_name_literal_value AS desired
                 FROM TMP_VIRTUAL_RUN_GROUPS rg WHERE rg.final_alias_id IS NOT NULL) rg_desired
           WHERE a.alias_id = rg_desired.alias_id
             AND a.alias_name_literal_value <> rg_desired.desired`
        );
        await bgExec(
          `UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
           SET alias_name_literal_value = rg_desired.desired, updated_at = CURRENT_TIMESTAMP
           FROM (SELECT DISTINCT rg.final_alias_id AS alias_id, rg.alias_name_literal_value AS desired
                 FROM TMP_VIRTUAL_RUN_GROUPS rg WHERE rg.final_alias_id IS NOT NULL) rg_desired
           WHERE a.alias_id = rg_desired.alias_id
             AND a.alias_name_literal_value <> rg_desired.desired`
        );

        // 12. MERGE items into ALIAS_ITEMS.
        console.log(`[export run ${runIdNum}] bg step 12: MERGE into ALIAS_ITEMS`);
        await bgExec(
          `MERGE INTO STAND_DB.STAND_INTERNAL.ALIAS_ITEMS tgt
           USING (
             SELECT
               vri.literal_value,
               tc.pipeline:cleaned_value::VARCHAR           AS cleaned_value,
               tc.profile_id,
               tc.pipeline:normalization_value::VARCHAR     AS normalization_value,
               tc.pipeline:tokens                           AS tokens,
               tc.pipeline:tokens_count::NUMBER             AS tokens_count,
               tc.pipeline:normalized_tokens               AS normalized_tokens,
               tc.pipeline:normalized_tokens_count::NUMBER AS normalized_tokens_count,
               vrg.final_alias_id                           AS alias_id,
               TRUE                                         AS approved_flag,
               IFF(
                 EXISTS (
                   SELECT 1 FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS existing
                   JOIN STAND_DB.STAND_INTERNAL.ALIASES a ON a.alias_id = existing.alias_id
                   WHERE existing.profile_id = tc.profile_id
                     AND existing.literal_value = vri.literal_value
                     AND existing.alias_id = vrg.final_alias_id
                     AND a.concept_id = ${conceptId}
                     AND a.alias_name_literal_value = vrg.alias_name_literal_value
                 ), 100, 99
               ) AS confidence_score
             FROM TMP_VIRTUAL_RUN_ITEMS vri
             JOIN TMP_VIRTUAL_RUN_GROUPS vrg ON vrg.group_id = vri.group_id
             JOIN TMP_CLASSIFIED tc ON tc.literal_value = vri.literal_value
             WHERE vrg.final_alias_id IS NOT NULL
           ) src
           ON tgt.profile_id = src.profile_id AND tgt.literal_value = src.literal_value
           WHEN MATCHED THEN UPDATE SET
             alias_id = src.alias_id,
             cleaned_value = COALESCE(tgt.cleaned_value, src.cleaned_value),
             normalization_value = src.normalization_value,
             tokens = src.tokens, tokens_count = src.tokens_count,
             normalized_tokens = src.normalized_tokens,
             normalized_tokens_count = src.normalized_tokens_count,
             confidence = src.confidence_score,
             source = 'manual_review', approved = src.approved_flag,
             updated_at = CURRENT_TIMESTAMP
           WHEN NOT MATCHED THEN INSERT (
             alias_id, profile_id, literal_value, cleaned_value,
             normalization_value, tokens, tokens_count, normalized_tokens,
             normalized_tokens_count, confidence, source, approved, created_at, updated_at
           ) VALUES (
             src.alias_id, src.profile_id, src.literal_value, src.cleaned_value,
             src.normalization_value, src.tokens, src.tokens_count, src.normalized_tokens,
             src.normalized_tokens_count, src.confidence_score, 'manual_review',
             src.approved_flag, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           )`
        );

        // 13. Populate ONE_PROMPT_APPROVED_ALIAS_NAMES.
        console.log(`[export run ${runIdNum}] bg step 13: ONE_PROMPT_APPROVED_ALIAS_NAMES`);
        await bgExec(
          `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES AS t
           USING (
             SELECT DISTINCT alias_name_literal_value AS alias_name
             FROM TMP_VIRTUAL_RUN_GROUPS WHERE alias_name_literal_value IS NOT NULL
           ) AS s ON t.alias_name = s.alias_name
           WHEN MATCHED THEN UPDATE SET t.usage_count = t.usage_count + 1, t.last_used_at = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN INSERT (alias_name, usage_count, last_used_at)
             VALUES (s.alias_name, 1, CURRENT_TIMESTAMP())`
        );

        // 14. Tokenize canonical alias names.
        console.log(`[export run ${runIdNum}] bg step 14: tokenize alias names`);
        await bgExec(
          `UPDATE STAND_DB.STAND_INTERNAL.ALIASES a
           SET alias_name_tokens       = sub.pipeline:tokens,
               alias_name_tokens_count = sub.pipeline:tokens_count::NUMBER,
               updated_at              = CURRENT_TIMESTAMP()
           FROM (
             SELECT a2.alias_id,
               STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
                 a2.alias_name_literal_value, ecr.enriched_ruleset
               ) AS pipeline
             FROM STAND_DB.STAND_INTERNAL.ALIASES a2
             JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = a2.concept_id
             JOIN STAND_DB.STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS ecr
               ON ecr.concept_id = c.concept_id
             WHERE a2.alias_id IN (
               SELECT DISTINCT final_alias_id FROM TMP_VIRTUAL_RUN_GROUPS
               WHERE final_alias_id IS NOT NULL
             )
           ) sub
           WHERE a.alias_id = sub.alias_id`
        );

        // 15. Refresh summaries and invalidate caches.
        console.log(`[export run ${runIdNum}] bg step 15: refresh alias summaries`);
        const affectedAliases = await bgExec(
          `SELECT DISTINCT final_alias_id AS alias_id
           FROM TMP_VIRTUAL_RUN_GROUPS WHERE final_alias_id IS NOT NULL`
        );
        console.log(`[export run ${runIdNum}] bg step 15: ${affectedAliases.length} affected aliases`);

        for (const row of affectedAliases) {
          const aliasId = Number((row as any).ALIAS_ID ?? (row as any).alias_id);
          if (!Number.isFinite(aliasId)) continue;
          try {
            await bgExec(`CALL STAND_DB.STAND.REFRESH_ALIAS_SUMMARY(?)`,  [aliasId]);
            await bgExec(`CALL STAND_DB.STAND.REFRESH_TOKENS_SUMMARY(?)`, [aliasId]);
          } catch (refreshErr) {
            console.error(`[export run ${runIdNum}] bg step 15: REFRESH failed alias_id=${aliasId}:`, refreshErr);
          }
          await invalidateAliasCacheEntries(conceptId, aliasId);
        }

        // 16. Background validation pass.
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          try {
            await runOpExport(bgConn, runIdNum, apiKey);
          } catch (valErr) {
            console.error(`[export run ${runIdNum}] bg step 16: validation pass failed:`, valErr);
          }
        }

        console.log(`[export run ${runIdNum}] background alias population complete`);
      }).catch((err) => {
        console.error(`[export run ${runIdNum}] background alias population failed:`, err);
      });

      return Response.json({
        data: {
          run_id,
          source_relation:     sourceRelation,
          source_column:       sourceColumn,
          view_fqn:            `${db}.${schema}.${viewName}`,
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
