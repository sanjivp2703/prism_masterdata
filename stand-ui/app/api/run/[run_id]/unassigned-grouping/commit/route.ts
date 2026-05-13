/**
 * POST /api/run/[run_id]/unassigned-grouping/commit
 *
 * Persists the Phase 0→4 grouping pipeline results for the set of items the
 * caller considers "ungrouped" back to RUN_GROUPS and RUN_ITEMS.
 *
 * Request body (JSON, optional fields):
 *   run_item_ids  number[]  Explicit list of run_item_ids to cluster.
 *                           When provided, those specific items are fetched
 *                           and processed regardless of their current group_id.
 *                           When omitted, falls back to items with group_id IS NULL.
 *
 * For each Phase 4 group:
 *   1. INSERT one RUN_GROUPS row (final_alias_id = NULL — awaiting human review).
 *      initial_alias_name and alias_name_literal_value are assigned as
 *      sequential labels: "Group 1", "Group 2", ...
 *   2. UPDATE RUN_ITEMS.group_id for every member of that group.
 *
 * The pipeline is always re-run fresh from the current DB state so the commit
 * reflects the latest state.  If there are no target items the call is a no-op.
 */

import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { computeAllPairScores, type RunItemForPairing, type PairScoreResult } from '@/app/api/_lib/pairscore';
import { pickBestAliasName } from '@/app/api/_lib/namescore';
import {
  buildPairscoreSystemBlock,
  buildPairscorePayload,
  scorePairWithPairscoreRetry,
  parallelPairscoreLLM,
  estimatePairscoreCostUSD,
  PAIRSCORE_LLM_CONCURRENCY,
  type PairscoreLLMUsage,
} from '@/app/api/_lib/llm-pairscore';
import {
  buildPairMap,
  runPhase1,
  runPhase2,
  runPhase3,
  runPhase4,
  runPhase6,
  type ScoredPair,
  type FinalGroup,
  type Phase1Result,
  type Phase2Result,
  type Phase3Result,
  type Phase4Result,
  type Phase6Result,
} from '@/app/api/_lib/clique-detection';
import { runOnePromptGrouping, writeOnePromptBreakdown } from '@/app/api/_lib/llm-one-prompt-grouping';

// ---------------------------------------------------------------------------
// Per-run grouping progress (in-memory, polled by the client via GET)
// ---------------------------------------------------------------------------

export type GroupingProgress = {
  phase: 'loading' | 'llm_scoring' | 'computing' | 'saving' | 'done';
  /** Human-readable label for the current pipeline step. */
  sub_phase: string;
  /** Total unassigned items being processed. */
  items_total: number;
  /** Candidate groups found so far (set after Phase 4 completes). */
  groups_found: number;
  /** 0–100 progress percentage for the progress bar. */
  progress_pct: number;
  /** Number of LLM pair-scoring calls made so far (advanced mode only). */
  llm_calls_made: number;
  /** Total LLM calls to make in the pre-pass (advanced mode only). */
  llm_calls_total: number;
  /** Estimated LLM cost in USD accumulated so far. */
  estimated_cost_usd: number;
  /**
   * Wall-clock milliseconds spent waiting on live LLM API calls.
   * Updated live during the llm_scoring phase.
   * Zero for basic mode (no LLM calls made).
   */
  llm_elapsed_ms: number;
  /**
   * Wall-clock milliseconds spent on deterministic work — Phase 0 pairscoring,
   * Phases 1–4 clustering, and DB writes.  Tracked independently of llm_elapsed_ms;
   * the two will not add up to total run time because they don't cover all phases.
   */
  deterministic_elapsed_ms: number;
};

// Keyed by run_id. Cleared when the POST completes (success or error).
const groupingProgress = new Map<number, GroupingProgress>();

/** GET /api/run/[run_id]/unassigned-grouping/commit — returns current progress. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;
  const progress = groupingProgress.get(Number(run_id)) ?? null;
  return Response.json({ progress }, { headers: { 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tokensFromVariant = (v: unknown): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed))
        return parsed.map((x) => String(x).trim()).filter((t) => t.length > 0);
    } catch {
      /* ignore */
    }
  }
  return [];
};

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

/**
 * Build NameScore-based display names for each group.
 * The member with the highest NameScore wins; its (properly-cased) literal
 * becomes the group name. Falls back to "Group N" if no members have tokens.
 */
function buildGroupDisplayNames(
  orderedGroups: FinalGroup[],
  runItemsById: Map<number, RunItemForPairing>,
): Map<number, string> {
  const names = new Map<number, string>();
  orderedGroups.forEach((g, idx) => {
    const members = g.member_ids
      .map((id) => runItemsById.get(id))
      .filter((m): m is RunItemForPairing => m != null);
    const best = pickBestAliasName(members);
    names.set(g.temp_group_id, best.literal_value || `Group ${idx + 1}`);
  });
  return names;
}

// ---------------------------------------------------------------------------
// Breakdown JSON writer
// ---------------------------------------------------------------------------

/**
 * Writes a full diagnostic JSON for the grouping pipeline to the project root,
 * mirroring the `confidence_breakdown_run_<id>.json` pattern.
 *
 * File: `grouping_breakdown_run_<run_id>.json`
 *
 * The write is best-effort: any filesystem error is only logged, never thrown.
 */
function writeGroupingBreakdown(
  runId: number,
  groupingMode: 'basic' | 'advanced' | 'one_prompt',
  items: RunItemForPairing[],
  pairScores: PairScoreResult[],
  llmRefinedOriginals: Map<string, number>,
  phase1: Phase1Result,
  phase2: Phase2Result,
  phase3: Phase3Result,
  phase4: Phase4Result,
  phase6: Phase6Result
): void {
  try {
    const literalById = new Map(items.map((i) => [i.run_item_id, i.literal_value]));
    const normById    = new Map(items.map((i) => [i.run_item_id, i.normalization_value]));

    const breakdown = {
      meta: {
        run_id:               runId,
        generated_at:         new Date().toISOString(),
        grouping_mode:        groupingMode,
        llm_pairs_refined:    llmRefinedOriginals.size,
        unassigned_item_count: items.length,
        thresholds: {
          strong_edge:              0.12,
          two_node_clique:          0.15,
          external_sep_multiplier:  0.5,
          absorption_max:           0.18,
          absorption_min:           0.12,
          merge_max:                0.18,
          merge_min:                0.12,
        },
      },

      // ── Items ────────────────────────────────────────────────────────────
      items: items.map((ri) => ({
        run_item_id:         ri.run_item_id,
        literal_value:       ri.literal_value,
        cleaned_value:       ri.cleaned_value,
        normalization_value: ri.normalization_value,
        std_tokens:          ri.std_tokens,
        norm_tokens:         ri.norm_tokens,
      })),

      // ── Phase 0 — Pairscore calculations ─────────────────────────────────
      phase0_pairscores: pairScores.map((p) => {
        const llmKey = `${p.run_item_id_a}:${p.run_item_id_b}`;
        const originalScore = llmRefinedOriginals.get(llmKey);
        const llmRefined = originalScore !== undefined;
        return {
          run_item_id_a:              p.run_item_id_a,
          literal_value_a:            literalById.get(p.run_item_id_a) ?? null,
          norm_value_a:               normById.get(p.run_item_id_a) ?? null,
          run_item_id_b:              p.run_item_id_b,
          literal_value_b:            literalById.get(p.run_item_id_b) ?? null,
          norm_value_b:               normById.get(p.run_item_id_b) ?? null,
          pair_score:                 p.pair_score,
          llm_refined:                llmRefined,
          ...(llmRefined && { deterministic_score_original: originalScore }),
          details:                    p.details,
        };
      }),

      // ── Phase 1 — Clique-based anchor detection ───────────────────────────
      phase1: {
        raw_clique_count:   phase1.raw_clique_count,
        valid_clique_count: phase1.valid_clique_count,
        total_items:        phase1.total_items,
        anchor_groups: phase1.tentative_groups.map((g) => ({
          temp_group_id:      g.temp_group_id,
          member_ids:         g.member_ids,
          member_literals:    g.member_ids.map((id) => literalById.get(id) ?? null),
          internal_scores:    g.internal_scores,
          avg_internal_score: g.avg_internal_score,
          min_internal_score: g.min_internal_score,
        })),
        unanchored_ids:      phase1.unanchored_ids,
        unanchored_literals: phase1.unanchored_ids.map((id) => literalById.get(id) ?? null),
      },

      // ── Phase 2 — Absorption ─────────────────────────────────────────────
      phase2: {
        passes_run: phase2.passes_run,
        passes:     phase2.passes,
        groups: phase2.groups.map((g) => ({
          temp_group_id:           g.temp_group_id,
          anchor_member_ids:       g.anchor_member_ids,
          anchor_literals:         g.anchor_member_ids.map((id) => literalById.get(id) ?? null),
          absorbed_member_ids:     g.absorbed_member_ids,
          absorbed_literals:       g.absorbed_member_ids.map((id) => literalById.get(id) ?? null),
          member_ids:              g.member_ids,
          avg_internal_score:      g.avg_internal_score,
          min_internal_score:      g.min_internal_score,
        })),
        still_unassigned_ids:      phase2.still_unassigned_ids,
        still_unassigned_literals: phase2.still_unassigned_ids.map((id) => literalById.get(id) ?? null),
      },

      // ── Phase 3 — Group merging ───────────────────────────────────────────
      phase3: {
        passes_run: phase3.passes_run,
        merges:     phase3.merges,
        groups: phase3.groups.map((g) => ({
          temp_group_id:         g.temp_group_id,
          member_ids:            g.member_ids,
          member_literals:       g.member_ids.map((id) => literalById.get(id) ?? null),
          anchor_member_ids:     g.anchor_member_ids,
          absorbed_member_ids:   g.absorbed_member_ids,
          merged_from_group_ids: g.merged_from_group_ids,
          avg_internal_score:    g.avg_internal_score,
          min_internal_score:    g.min_internal_score,
        })),
        still_unassigned_ids:      phase3.still_unassigned_ids,
        still_unassigned_literals: phase3.still_unassigned_ids.map((id) => literalById.get(id) ?? null),
      },

      // ── Phase 4 — Singletons ─────────────────────────────────────────────
      phase4: {
        total_groups:        phase4.total_groups,
        multi_member_count:  phase4.multi_member_count,
        singleton_count:     phase4.singleton_count,
        groups: phase4.groups.map((g) => ({
          temp_group_id:         g.temp_group_id,
          is_singleton:          g.is_singleton,
          member_ids:            g.member_ids,
          member_literals:       g.member_ids.map((id) => literalById.get(id) ?? null),
          member_norm_values:    g.member_ids.map((id) => normById.get(id) ?? null),
          member_confidence_scores: g.member_ids.map((id) =>
            Number((phase4.confidence_scores.get(id) ?? 0).toFixed(6))
          ),
          anchor_member_ids:     g.anchor_member_ids,
          absorbed_member_ids:   g.absorbed_member_ids,
          merged_from_group_ids: g.merged_from_group_ids,
          avg_internal_score:    g.avg_internal_score,
          min_internal_score:    g.min_internal_score,
        })),
      },

      // ── Phase 6 — Validation ─────────────────────────────────────────────
      phase6_validation: {
        passed:          phase6.passed,
        violation_count: phase6.violation_count,
        check_summary:   phase6.check_summary,
        violations:      phase6.violations,
      },
    };

    const projectRoot = path.resolve(process.cwd(), '..');
    const outPath = path.join(projectRoot, `grouping_breakdown_run_${runId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(breakdown, null, 2), 'utf8');
    console.log(`[grouping] Breakdown written → ${outPath}`);
  } catch (writeErr) {
    console.warn('[grouping] Breakdown write skipped:', writeErr);
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;
  const runIdNum = Number(run_id);

  // Parse optional run_item_ids and mode from request body.
  let requestedIds: number[] | null = null;
  let groupingMode: 'basic' | 'advanced' | 'one_prompt' = 'basic';
  try {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body?.run_item_ids) && body.run_item_ids.length > 0) {
      requestedIds = (body.run_item_ids as unknown[])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    if (body?.mode === 'advanced')   groupingMode = 'advanced';
    if (body?.mode === 'one_prompt') groupingMode = 'one_prompt';
  } catch {
    // ignore parse errors — fall back to group_id IS NULL, basic mode
  }

  // Seed progress so the client can start polling immediately.
  groupingProgress.set(runIdNum, {
    phase: 'loading',
    sub_phase: 'Fetching items…',
    items_total: 0,
    groups_found: 0,
    progress_pct: 3,
    llm_calls_made: 0,
    llm_calls_total: 0,
    estimated_cost_usd: 0,
    llm_elapsed_ms: 0,
    deterministic_elapsed_ms: 0,
  });

  try {
    return await withSnowflake(async (connection) => {
      // ── 1. Verify run exists ─────────────────────────────────────────────
      const runRows = await exec(
        connection,
        `SELECT run_id, run_status FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ? LIMIT 1`,
        [run_id]
      );
      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      // ── 2. Ensure classification has run for all items in this run ─────────
      // CREATE_RUN inserts items with tokens = NULL for speed. CLASSIFY_RUN_ITEMS
      // is idempotent — it only touches rows where tokens IS NULL — so this is a
      // no-op when apply-confident-assignments has already run.
      const classifyResult = await exec(
        connection,
        `CALL STAND_DB.STAND.CLASSIFY_RUN_ITEMS(?)`,
        [runIdNum]
      );
      const classifyMsg = String(
        (classifyResult[0] as any)?.CLASSIFY_RUN_ITEMS ??
        (classifyResult[0] as any)?.classify_run_items ?? ''
      );
      if (classifyMsg.startsWith('ERROR:')) {
        console.error('[unassigned-grouping] CLASSIFY_RUN_ITEMS failed:', classifyMsg);
        return Response.json({ error: `Classification failed: ${classifyMsg}` }, { status: 500 });
      }
      console.log('[unassigned-grouping] CLASSIFY_RUN_ITEMS:', classifyMsg);

      // ── 3. Fetch target run items ────────────────────────────────────────
      // When the caller supplies explicit run_item_ids (from the ungrouped UI
      // bucket), fetch exactly those items regardless of their current group_id.
      // These items may already have a group_id in the DB if they were scored
      // against aliases but fell below the confidence threshold — in that case
      // group_id IS NULL would miss them entirely.
      // Fallback: if no ids were supplied, process everything with group_id IS NULL.
      let itemRows: any[];
      if (requestedIds && requestedIds.length > 0) {
        const placeholders = requestedIds.map(() => '?').join(', ');
        itemRows = await exec(
          connection,
          `
            SELECT
              run_item_id,
              literal_value,
              cleaned_value,
              normalization_value,
              tokens,
              normalized_tokens
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
            WHERE run_id = ?
              AND run_item_id IN (${placeholders})
            ORDER BY run_item_id ASC
          `,
          [run_id, ...requestedIds]
        );
      } else {
        itemRows = await exec(
          connection,
          `
            SELECT
              run_item_id,
              literal_value,
              cleaned_value,
              normalization_value,
              tokens,
              normalized_tokens
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
            WHERE run_id = ?
              AND group_id IS NULL
            ORDER BY run_item_id ASC
          `,
          [run_id]
        );
      }

      if (itemRows.length === 0) {
        groupingProgress.delete(runIdNum);
        return Response.json({
          data: {
            run_id:          Number(run_id),
            message:         'No target items found — nothing to commit.',
            groups_created:  0,
            items_committed: 0,
          },
        });
      }

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Computing pair scores…',
        items_total: itemRows.length,
        groups_found: 0,
        progress_pct: 15,
        llm_calls_made: 0,
        llm_calls_total: 0,
        estimated_cost_usd: 0,
        llm_elapsed_ms: 0,
        deterministic_elapsed_ms: 0,
      });

      // ── 3. Map DB rows → RunItemForPairing ───────────────────────────────
      const runItems: RunItemForPairing[] = itemRows.map((row) => ({
        run_item_id:         Number((row as any).RUN_ITEM_ID),
        literal_value:       String((row as any).LITERAL_VALUE ?? ''),
        cleaned_value:       (row as any).CLEANED_VALUE == null
                               ? null : String((row as any).CLEANED_VALUE),
        normalization_value: (row as any).NORMALIZATION_VALUE == null
                               ? null : String((row as any).NORMALIZATION_VALUE),
        std_tokens:  tokensFromVariant((row as any).TOKENS),
        norm_tokens: tokensFromVariant((row as any).NORMALIZED_TOKENS),
      }));

      const allIds = runItems.map((ri) => ri.run_item_id);

      // ── 4. Run pipeline ──────────────────────────────────────────────────
      // ── 4-A. One-prompt mode: single LLM call, no deterministic clustering ─
      if (groupingMode === 'one_prompt') {
        // Fetch concept name + definition.
        const conceptRows = await exec(
          connection,
          `SELECT c.concept_key, COALESCE(c.description, '') AS concept_description
           FROM STAND_DB.STAND_INTERNAL.RUNS r
           JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
           WHERE r.run_id = ?`,
          [runIdNum]
        );
        const onePromptConceptName = conceptRows.length > 0
          ? String((conceptRows[0] as any).CONCEPT_KEY ?? (conceptRows[0] as any).concept_key ?? '')
          : '';
        const onePromptConceptDef = conceptRows.length > 0
          ? String((conceptRows[0] as any).CONCEPT_DESCRIPTION ?? (conceptRows[0] as any).concept_description ?? '')
          : '';

        groupingProgress.set(runIdNum, {
          phase:               'llm_scoring',
          sub_phase:           `1-Prompt LLM grouping (${runItems.length} items)…`,
          items_total:         runItems.length,
          groups_found:        0,
          progress_pct:        25,
          llm_calls_made:      0,
          llm_calls_total:     1,
          estimated_cost_usd:  0,
          llm_elapsed_ms:      0,
          deterministic_elapsed_ms: 0,
        });

        const onePromptResult = await runOnePromptGrouping(
          runItems,
          onePromptConceptName,
          onePromptConceptDef,
        );

        // Write diagnostic breakdown JSON (best-effort, non-fatal).
        onePromptResult.breakdown.meta.run_id = runIdNum;
        writeOnePromptBreakdown(runIdNum, onePromptResult.breakdown);

        groupingProgress.set(runIdNum, {
          phase:               'saving',
          sub_phase:           'Writing groups to database…',
          items_total:         runItems.length,
          groups_found:        onePromptResult.groups.length,
          progress_pct:        85,
          llm_calls_made:      1,
          llm_calls_total:     1,
          estimated_cost_usd:  onePromptResult.estimated_cost_usd,
          llm_elapsed_ms:      onePromptResult.llm_elapsed_ms,
          deterministic_elapsed_ms: 0,
        });

        // ── Write RUN_GROUPS + RUN_ITEMS (one_prompt) ──────────────────────
        const orderedGroupsOP = [
          ...onePromptResult.groups.filter((g) => !g.is_singleton),
          ...onePromptResult.groups.filter((g) =>  g.is_singleton),
        ];
        const runItemsByIdOP  = new Map(runItems.map((ri) => [ri.run_item_id, ri]));
        const groupNamesOP    = buildGroupDisplayNames(orderedGroupsOP, runItemsByIdOP);
        const itemToGroupIdOP = new Map<number, number>();
        const commitNonceOP   = Date.now().toString(36);

        for (const group of orderedGroupsOP) {
          const displayName = groupNamesOP.get(group.temp_group_id) ?? `Group ${group.temp_group_id}`;
          const tempName    = `__commit_${commitNonceOP}_${group.temp_group_id}`;

          await exec(
            connection,
            `INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
               run_id, initial_alias_name, alias_name_literal_value,
               final_alias_id, is_user_created, created_at, updated_at
             ) VALUES (?, ?, ?, NULL, FALSE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
            [run_id, tempName, tempName]
          );

          const rows = await exec(
            connection,
            `SELECT group_id FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
             WHERE run_id = ? AND initial_alias_name = ?
             ORDER BY group_id DESC LIMIT 1`,
            [run_id, tempName]
          );
          const newGroupId = Number((rows[0] as any).GROUP_ID ?? (rows[0] as any).group_id);
          if (!Number.isFinite(newGroupId)) {
            throw new Error(
              `Failed to retrieve group_id after inserting group "${displayName}" for run ${run_id}`
            );
          }

          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS
             SET initial_alias_name      = ?,
                 alias_name_literal_value = ?,
                 updated_at              = CURRENT_TIMESTAMP()
             WHERE run_id = ? AND group_id = ?`,
            [displayName, displayName, run_id, newGroupId]
          );

          for (const memberId of group.member_ids) {
            itemToGroupIdOP.set(memberId, newGroupId);
          }
        }

        if (itemToGroupIdOP.size > 0) {
          const pairs   = [...itemToGroupIdOP.entries()];
          const clauses = pairs.map(() => '(?, ?)').join(', ');
          const binds: any[] = [];
          for (const [itemId, groupId] of pairs) binds.push(itemId, groupId);
          binds.push(run_id, run_id);

          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
             SET group_id = mv.group_id
             FROM (
               SELECT column1::NUMBER AS run_item_id, column2::NUMBER AS group_id
               FROM VALUES ${clauses}
             ) mv
             JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
               ON rg.run_id = ?
              AND rg.group_id = mv.group_id
             WHERE ri.run_id = ?
               AND ri.run_item_id = mv.run_item_id`,
            binds
          );
        }

        // Write confidence scores.
        const confEntriesOP = [...onePromptResult.confidence_scores.entries()].filter(
          ([, s]) => s > 0
        );
        if (confEntriesOP.length > 0) {
          const confClauses = confEntriesOP.map(() => '(?, ?)').join(', ');
          const confBinds: any[] = [];
          for (const [itemId, score] of confEntriesOP) confBinds.push(itemId, score);
          confBinds.push(run_id);

          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
             SET confidence_score = mv.confidence_score,
                 updated_at       = CURRENT_TIMESTAMP()
             FROM (
               SELECT column1::NUMBER AS run_item_id,
                      column2::FLOAT  AS confidence_score
               FROM VALUES ${confClauses}
             ) mv
             WHERE ri.run_id = ?
               AND ri.run_item_id = mv.run_item_id`,
            confBinds
          );
        }

        groupingProgress.delete(runIdNum);
        return Response.json({
          data: {
            run_id:              Number(run_id),
            mode:                'one_prompt',
            groups_created:      orderedGroupsOP.length,
            items_committed:     itemToGroupIdOP.size,
            multi_member_groups: orderedGroupsOP.filter((g) => !g.is_singleton).length,
            singleton_groups:    orderedGroupsOP.filter((g) =>  g.is_singleton).length,
            llm_elapsed_ms:      onePromptResult.llm_elapsed_ms,
            estimated_cost_usd:  onePromptResult.estimated_cost_usd,
            chunk_count:         onePromptResult.chunk_count,
          },
        });
      }

      // ── 4-B. Basic / Advanced: deterministic clustering (Phase 0 → 4) ────
      // Time Phase 0 deterministic pairscoring.
      const phase0Start = Date.now();
      const pairResults = computeAllPairScores(runItems);
      let deterministicElapsedMs = Date.now() - phase0Start;

      // ── 4a. Advanced mode: LLM pre-pass to refine pair scores ────────────
      // For pairs where 0.01 < pair_score < 0.30, ask the LLM to estimate
      // the probability the two items represent the same entity.  The LLM
      // confidence replaces the deterministic score for those pairs only.
      // All other pair scores are left unchanged.  The rest of the clustering
      // algorithm (Phase 1–4) then runs identically to basic mode.
      let llmPairsScored = 0;
      let cumulativeLLMCost = 0;
      let llmElapsedMs = 0;
      const cumulativeLLMUsage: PairscoreLLMUsage = {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      };
      // key = "idA:idB" (same format as llmScores), value = original deterministic score
      const llmRefinedOriginals = new Map<string, number>();

      if (groupingMode === 'advanced') {
        // Fetch concept info for system prompt (mirrors apply-confident-assignments).
        const conceptRows = await exec(
          connection,
          `SELECT c.concept_key, COALESCE(c.description, '') AS concept_description
           FROM STAND_DB.STAND_INTERNAL.RUNS r
           JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
           WHERE r.run_id = ?`,
          [runIdNum]
        );
        const conceptKey = conceptRows.length > 0
          ? String((conceptRows[0] as any).CONCEPT_KEY ?? (conceptRows[0] as any).concept_key ?? '')
          : '';
        const conceptDescription = conceptRows.length > 0
          ? String((conceptRows[0] as any).CONCEPT_DESCRIPTION ?? (conceptRows[0] as any).concept_description ?? '')
          : '';

        const systemBlock = buildPairscoreSystemBlock(conceptKey, conceptDescription);
        const itemById = new Map(runItems.map((r) => [r.run_item_id, r]));

        // Only pairs in the (0.01, 0.30) band need LLM refinement.
        const qualifyingPairs = pairResults.filter(
          (p) => p.pair_score > 0.01 && p.pair_score < 0.30
        );

        groupingProgress.set(runIdNum, {
          phase: 'llm_scoring',
          sub_phase: `LLM pair scoring (0 / ${qualifyingPairs.length})…`,
          items_total: runItems.length,
          groups_found: 0,
          progress_pct: 20,
          llm_calls_made: 0,
          llm_calls_total: qualifyingPairs.length,
          estimated_cost_usd: 0,
          llm_elapsed_ms: 0,
          deterministic_elapsed_ms: deterministicElapsedMs,
        });

        // Map from "id_a:id_b" → updated confidence from LLM.
        const llmScores = new Map<string, number>();

        const llmBatchStart = Date.now();
        await parallelPairscoreLLM(
          qualifyingPairs,
          async (p) => {
            const itemA = itemById.get(p.run_item_id_a);
            const itemB = itemById.get(p.run_item_id_b);
            if (!itemA || !itemB) return;

            const payload = buildPairscorePayload(itemA, itemB, p.pair_score, p.details);
            const result  = await scorePairWithPairscoreRetry(systemBlock, payload);

            if (result !== null) {
              const key = `${p.run_item_id_a}:${p.run_item_id_b}`;
              // Clamp to [0, 1] for safety.
              llmScores.set(key, Math.min(1, Math.max(0, result.parsed.confidence)));

              cumulativeLLMUsage.input_tokens                += result.usage.input_tokens;
              cumulativeLLMUsage.output_tokens               += result.usage.output_tokens;
              cumulativeLLMUsage.cache_read_input_tokens     += result.usage.cache_read_input_tokens;
              cumulativeLLMUsage.cache_creation_input_tokens += result.usage.cache_creation_input_tokens;
              cumulativeLLMCost = estimatePairscoreCostUSD(cumulativeLLMUsage);
              llmElapsedMs = Date.now() - llmBatchStart;
            }

            llmPairsScored += 1;
            // Throttle progress writes: update every 5 completions or on the last pair.
            if (llmPairsScored % 5 === 0 || llmPairsScored === qualifyingPairs.length) {
              const pct = 20 + Math.round((llmPairsScored / Math.max(qualifyingPairs.length, 1)) * 20);
              groupingProgress.set(runIdNum, {
                phase: 'llm_scoring',
                sub_phase: `LLM pair scoring (${llmPairsScored} / ${qualifyingPairs.length})…`,
                items_total: runItems.length,
                groups_found: 0,
                progress_pct: Math.min(pct, 40),
                llm_calls_made: llmPairsScored,
                llm_calls_total: qualifyingPairs.length,
                estimated_cost_usd: cumulativeLLMCost,
                llm_elapsed_ms: llmElapsedMs,
                deterministic_elapsed_ms: deterministicElapsedMs,
              });
            }
          },
          PAIRSCORE_LLM_CONCURRENCY,
        );
        llmElapsedMs = Date.now() - llmBatchStart;

        // Apply LLM scores back onto pairResults, capturing original scores.
        for (const p of pairResults) {
          const key = `${p.run_item_id_a}:${p.run_item_id_b}`;
          const updated = llmScores.get(key);
          if (updated !== undefined) {
            llmRefinedOriginals.set(key, p.pair_score);
            p.pair_score = updated;
          }
        }
      }

      const candidatePairs: ScoredPair[] = pairResults.map((p) => ({
        run_item_id_a: p.run_item_id_a,
        run_item_id_b: p.run_item_id_b,
        pair_score:    p.pair_score,
      }));
      const pairMap = buildPairMap(candidatePairs);

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Phase 1 — Anchor detection…',
        items_total: runItems.length,
        groups_found: 0,
        progress_pct: groupingMode === 'advanced' ? 45 : 30,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs,
      });
      const phases14Start = Date.now();
      const phase1 = runPhase1(allIds, candidatePairs);

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Phase 2 — Absorption…',
        items_total: runItems.length,
        groups_found: phase1.tentative_groups.length,
        progress_pct: groupingMode === 'advanced' ? 58 : 50,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs + (Date.now() - phases14Start),
      });
      const phase2 = runPhase2(phase1, pairMap);

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Phase 3 — Group merging…',
        items_total: runItems.length,
        groups_found: phase2.groups.length,
        progress_pct: groupingMode === 'advanced' ? 68 : 65,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs + (Date.now() - phases14Start),
      });
      const phase3 = runPhase3(phase2, pairMap);

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Phase 4 — Singleton confirmation…',
        items_total: runItems.length,
        groups_found: phase3.groups.length,
        progress_pct: groupingMode === 'advanced' ? 78 : 78,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs + (Date.now() - phases14Start),
      });
      const phase4 = runPhase4(phase3, pairMap);

      groupingProgress.set(runIdNum, {
        phase: 'computing',
        sub_phase: 'Validating output…',
        items_total: runItems.length,
        groups_found: phase4.total_groups,
        progress_pct: 88,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs + (Date.now() - phases14Start),
      });

      // Phase 6: validate the grouping output before persisting.
      const phase6: Phase6Result = runPhase6(phase4, pairMap);
      deterministicElapsedMs += Date.now() - phases14Start;

      const finalGroups = phase4.groups;

      groupingProgress.set(runIdNum, {
        phase: 'saving',
        sub_phase: 'Writing groups to database…',
        items_total: runItems.length,
        groups_found: phase4.total_groups,
        progress_pct: 92,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs,
      });

      // ── 5. Write RUN_GROUPS + collect (item → group_id) mappings ─────────
      // Multi-member groups first (pipeline order), then singletons.
      // Each group is named using NameScore: the member with the highest score
      // (most representative, clean, and token-rich literal) becomes the name.
      const orderedGroups = [
        ...finalGroups.filter((g) => !g.is_singleton),
        ...finalGroups.filter((g) =>  g.is_singleton),
      ];
      const runItemsById = new Map(runItems.map((ri) => [ri.run_item_id, ri]));
      const groupNames = buildGroupDisplayNames(orderedGroups, runItemsById);

      // item_id → real group_id (to be filled as we insert groups)
      const itemToGroupId = new Map<number, number>();

      // Use a per-commit nonce embedded in the alias name so we can retrieve
      // the exact group_id just inserted without relying on MAX(group_id) across
      // all groups for this run (which breaks when commit is run more than once).
      const commitNonce = Date.now().toString(36);

      for (const group of orderedGroups) {
        const displayName = groupNames.get(group.temp_group_id) ?? `Group ${group.temp_group_id}`;
        // Temporary internal name used only during this commit to identify the row.
        // It gets overwritten back to displayName immediately after retrieval.
        const tempName = `__commit_${commitNonce}_${group.temp_group_id}`;

        await exec(
          connection,
          `
            INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
              run_id,
              initial_alias_name,
              alias_name_literal_value,
              final_alias_id,
              is_user_created,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, NULL, FALSE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
          `,
          [run_id, tempName, tempName]
        );

        // Retrieve the group_id by the unique temp name — immune to concurrent inserts.
        const rows = await exec(
          connection,
          `SELECT group_id FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
           WHERE run_id = ? AND initial_alias_name = ?
           ORDER BY group_id DESC LIMIT 1`,
          [run_id, tempName]
        );
        const newGroupId = Number((rows[0] as any).GROUP_ID ?? (rows[0] as any).group_id);
        if (!Number.isFinite(newGroupId)) {
          throw new Error(
            `Failed to retrieve group_id after inserting group "${displayName}" for run ${run_id}`
          );
        }

        // Overwrite temp name with the real display name.
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS
           SET initial_alias_name      = ?,
               alias_name_literal_value = ?,
               updated_at              = CURRENT_TIMESTAMP()
           WHERE run_id = ? AND group_id = ?`,
          [displayName, displayName, run_id, newGroupId]
        );

        for (const memberId of group.member_ids) {
          itemToGroupId.set(memberId, newGroupId);
        }
      }

      // ── 6. Batch-update RUN_ITEMS.group_id ───────────────────────────────
      // Build a VALUES clause with all (run_item_id, group_id) pairs and apply
      // in a single UPDATE — same pattern as the approve route.
      if (itemToGroupId.size > 0) {
        const pairs   = [...itemToGroupId.entries()]; // [run_item_id, group_id]
        const clauses = pairs.map(() => '(?, ?)').join(', ');
        const binds: any[] = [];
        for (const [itemId, groupId] of pairs) {
          binds.push(itemId, groupId);
        }
        binds.push(run_id, run_id);

        await exec(
          connection,
          `
            UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
            SET group_id = mv.group_id
            FROM (
              SELECT column1::NUMBER AS run_item_id, column2::NUMBER AS group_id
              FROM VALUES ${clauses}
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

      // ── 6b. Batch-update RUN_ITEMS.confidence_score ──────────────────────
      // Write the grouping confidence scores computed by Phase 4 back to the
      // DB so the UI can read them.  Covers all items that were placed into a
      // group; items left in still_unassigned stay at their existing value.
      const confidenceEntries = [...phase4.confidence_scores.entries()].filter(
        ([, score]) => score > 0   // 0-scored items (unassigned) don't need updating
      );

      if (confidenceEntries.length > 0) {
        const confClauses = confidenceEntries.map(() => '(?, ?)').join(', ');
        const confBinds: any[] = [];
        for (const [itemId, score] of confidenceEntries) {
          confBinds.push(itemId, score);
        }
        confBinds.push(run_id);

        await exec(
          connection,
          `
            UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
            SET confidence_score = mv.confidence_score,
                updated_at       = CURRENT_TIMESTAMP()
            FROM (
              SELECT column1::NUMBER AS run_item_id,
                     column2::FLOAT  AS confidence_score
              FROM VALUES ${confClauses}
            ) mv
            WHERE ri.run_id = ?
              AND ri.run_item_id = mv.run_item_id
          `,
          confBinds
        );
      }

      groupingProgress.set(runIdNum, {
        phase: 'saving',
        sub_phase: 'Updating item assignments…',
        items_total: runItems.length,
        groups_found: orderedGroups.length,
        progress_pct: 97,
        llm_calls_made: llmPairsScored,
        llm_calls_total: llmPairsScored,
        estimated_cost_usd: cumulativeLLMCost,
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs,
      });

      // ── 7. Write grouping breakdown JSON (best-effort, never blocks commit) ─
      writeGroupingBreakdown(
        Number(run_id),
        groupingMode,
        runItems,
        pairResults,
        llmRefinedOriginals,
        phase1,
        phase2,
        phase3,
        phase4,
        phase6
      );

      // ── 8. Respond ────────────────────────────────────────────────────────
      groupingProgress.delete(runIdNum);
      return Response.json({
        data: {
          run_id:              Number(run_id),
          mode:                groupingMode,
          groups_created:      orderedGroups.length,
          items_committed:     itemToGroupId.size,
          multi_member_groups: phase4.multi_member_count,
          singleton_groups:    phase4.singleton_count,
          llm_pairs_scored:    llmPairsScored,
          estimated_cost_usd:  cumulativeLLMCost,
          llm_elapsed_ms:      llmElapsedMs,
          deterministic_elapsed_ms: deterministicElapsedMs,
          pipeline_diagnostics: {
            phase1: {
              anchor_count:   phase1.tentative_groups.length,
              unanchored:     phase1.unanchored_ids.length,
            },
            phase2: {
              passes_run:       phase2.passes_run,
              total_absorbed:   phase2.groups.reduce((s, g) => s + g.absorbed_member_ids.length, 0),
              still_unassigned: phase2.still_unassigned_ids.length,
            },
            phase3: {
              merges_performed:   phase3.merges.length,
              groups_after_merge: phase3.groups.length,
            },
            phase4: {
              total_groups:        phase4.total_groups,
              still_unassigned:    phase4.still_unassigned_count,
            },
          },
          phase6_validation: {
            passed:          phase6.passed,
            violation_count: phase6.violation_count,
            check_summary:   phase6.check_summary,
            // Full violation list included so callers can inspect without
            // having to read the server terminal.
            violations:      phase6.violations,
          },
        },
      });
    });
  } catch (error) {
    groupingProgress.delete(runIdNum);
    console.error('[unassigned-grouping/commit] error:', error);
    return snowflakeErrorResponse(error, 'Failed to commit grouping results');
  }
}
