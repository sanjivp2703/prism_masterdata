/**
 * LLM-enhanced grouping pipeline orchestrator.
 *
 * Calls Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 in sequence,
 * threading shared state (pairscoreMatrix, itemMetadataMap, systemPrompt,
 * nextTempId) correctly between phases.
 *
 * Entry point: runGroupingPipeline(unassignedItems, concept)
 *
 * Temp group ID contract:
 *   - IDs <= 0 are temporary (created by this pipeline)
 *   - IDs >  0 are real Snowflake-assigned IDs
 *   - Phases 1 and 4 allocate negative IDs via a shared counter threaded
 *     through this orchestrator; IDs never collide.
 */

import { buildGroupingSystemPrompt, type GroupingConcept, type GroupingRunItem } from './grouping-utils';
import { computePairscoreMatrix } from './grouping-phase0';
import { runPhase1 } from './grouping-phase1';
import { runPhase2 } from './grouping-phase2';
import { runPhase3 } from './grouping-phase3';
import { runPhase4, type Phase4Group, type Phase4Item } from './grouping-phase4';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupingPipelineResult {
  /** All groups produced by the pipeline (anchor groups + absorbed members + singletons). */
  allGroups: Phase4Group[];
  /** Items left in __UNGROUPED__ for human review. */
  unassignedItems: Phase4Item[];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full LLM-enhanced grouping pipeline for a pool of unassigned items.
 *
 * @param unassignedItems  Items that failed Step 1 confident assignment.
 *                         token_rarities / token_char_weights / token_importances
 *                         must be pre-populated (IDF computed over this pool)
 *                         before calling.
 * @param concept          The concept being standardised (name + definition).
 *
 * @returns { allGroups, unassignedItems } — every input item in exactly one.
 */
export async function runGroupingPipeline(
  unassignedItems: GroupingRunItem[],
  concept: GroupingConcept,
): Promise<GroupingPipelineResult> {
  // ── Shared state built once ──────────────────────────────────────────────

  // System prompt: constant for all LLM calls within this run.
  const systemPrompt = buildGroupingSystemPrompt(concept);

  // Phase 0: full deterministic pairscore matrix + item metadata map.
  const { pairscoreMatrix, itemMetadataMap } = computePairscoreMatrix(
    unassignedItems,
    concept,
  );

  // ── Phase 1: clique-based anchor detection ───────────────────────────────
  const phase1 = await runPhase1(
    unassignedItems,
    pairscoreMatrix,
    itemMetadataMap,
    systemPrompt,
  );
  const { anchorGroups, nextTempId: tempIdAfterPhase1 } = phase1;
  let { remainingUnassigned } = phase1;

  // ── Phase 2: absorption of remaining items into anchor groups ────────────
  const phase2 = await runPhase2(
    anchorGroups,
    remainingUnassigned,
    pairscoreMatrix,
    itemMetadataMap,
    systemPrompt,
  );
  const { updatedGroups } = phase2;
  remainingUnassigned = phase2.remainingUnassigned;

  // ── Phase 3: merging groups that refer to the same entity ────────────────
  const phase3 = await runPhase3(
    updatedGroups,
    remainingUnassigned,
    pairscoreMatrix,
    itemMetadataMap,
    systemPrompt,
  );
  const { finalGroups } = phase3;
  remainingUnassigned = phase3.remainingUnassigned;

  // ── Phase 4: singleton confirmation + unassigned audit ───────────────────
  // Thread nextTempId from Phase 1 so singleton IDs never collide with
  // anchor group IDs created in Phase 1.
  const phase4 = await runPhase4(
    finalGroups,
    remainingUnassigned,
    pairscoreMatrix,
    itemMetadataMap,
    systemPrompt,
    tempIdAfterPhase1,
  );
  const { allGroups, unassignedItems: finalUnassigned } = phase4;

  // ── End-to-end invariant ─────────────────────────────────────────────────
  // Every item that entered the pipeline must appear in exactly one output bucket.
  const inputIds   = new Set<number>(unassignedItems.map((it) => it.run_item_id));
  const outputGroupIds = new Set<number>(allGroups.flatMap((g) => g.member_ids));
  const outputUnassignedIds = new Set<number>(finalUnassigned.map((it) => it.run_item_id));

  for (const item of unassignedItems) {
    const inGroups     = outputGroupIds.has(item.run_item_id);
    const inUnassigned = outputUnassignedIds.has(item.run_item_id);
    if (!inGroups && !inUnassigned) {
      throw new Error(
        `[pipeline] end-to-end invariant violation: item ${item.run_item_id} ` +
        `('${item.raw_value}') is missing from both allGroups and unassignedItems.`,
      );
    }
    if (inGroups && inUnassigned) {
      throw new Error(
        `[pipeline] end-to-end invariant violation: item ${item.run_item_id} ` +
        `('${item.raw_value}') appears in both allGroups and unassignedItems.`,
      );
    }
  }

  // Verify no items from outside the input set appeared in the output.
  for (const id of outputGroupIds) {
    if (!inputIds.has(id)) {
      throw new Error(
        `[pipeline] end-to-end invariant violation: item ID ${id} in allGroups ` +
        `was not in the original unassigned input.`,
      );
    }
  }
  for (const id of outputUnassignedIds) {
    if (!inputIds.has(id)) {
      throw new Error(
        `[pipeline] end-to-end invariant violation: item ID ${id} in unassignedItems ` +
        `was not in the original unassigned input.`,
      );
    }
  }

  return { allGroups, unassignedItems: finalUnassigned };
}
