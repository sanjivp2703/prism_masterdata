/**
 * Phase 3 (LLM-enhanced) — Group merging.
 *
 * Evaluates every pair of groups and merges those that refer to the same
 * real-world entity. Repeats until a full pass produces zero merges.
 *
 * Nothing is persisted to the database here.
 * The pairscore matrix is read-only.
 */

import { callGroupingLLM, runLLMCalls } from './grouping-llm';
import { LLM_MODEL_ID } from './llm-confidence';
import { type GroupingRunItem, type ItemMetadata } from './grouping-utils';
import {
  type PairscoreMatrix,
  type PairscoreEntry,
  type ItemMetadataMap,
} from './grouping-phase0';
import { type Phase2LLMGroup } from './grouping-phase2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REP_MEMBERS      = 5;   // cap on member metadata in LLM payload
const AUTO_MERGE_THRESHOLD = 0.30; // ALL cross-pairs >= this → auto-merge
const AUTO_REJECT_MAX      = 0.08; // ALL cross-pairs < this AND no acronym → auto-reject

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Any run item that may carry grouping metadata from Phase 2 or Phase 3.
 * Fields are optional so plain GroupingRunItem values satisfy this type too.
 */
export type Phase3Item = GroupingRunItem & {
  grouping_llm_phase?: 'phase2' | 'phase3' | 'deterministic';
  grouping_llm_used?: string;
  grouping_reasoning?: string;
  grouping_flags?: string[];
  grouping_deterministic_score?: number;
};

/** A fully merged group at the conclusion of Phase 3. */
export interface Phase3FinalGroup {
  temp_group_id: string;
  members: Phase3Item[];
  member_ids: number[];
  /** True if any member's pair was LLM-promoted during Phase 1 edge recovery. */
  had_llm_promoted_edges: boolean;
}

export interface Phase3LLMResult {
  finalGroups: Phase3FinalGroup[];
  /** Passed through unchanged from Phase 2. */
  remainingUnassigned: GroupingRunItem[];
  diagnostics: {
    passes_run: number;
    total_auto_merged: number;
    total_llm_merged: number;
    total_groups_final: number;
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkingGroup {
  temp_group_id: string;
  members: Phase3Item[];
  member_ids: number[];
  hadLLMPromotedEdges: boolean;
}

interface CrossPairSummary {
  maxScore: number;
  minScore: number;
  avgScore: number;
  pairsAbove018: number;
  pairsAbove012: number;
  totalPairs: number;
  acronymFiredAny: boolean;
}

interface LLMCallOutcome {
  groupAId: string;
  groupBId: string;
  merge: boolean;
  reasoning: string;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ek(a: number, b: number): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function getEntry(
  idPairMap: Map<string, PairscoreEntry>,
  a: number,
  b: number,
): PairscoreEntry | undefined {
  return idPairMap.get(ek(a, b));
}

function buildIdPairMap(pairscoreMatrix: PairscoreMatrix): Map<string, PairscoreEntry> {
  const m = new Map<string, PairscoreEntry>();
  for (const entry of pairscoreMatrix.values()) {
    m.set(ek(entry.run_item_id_a, entry.run_item_id_b), entry);
  }
  return m;
}

/** Parse a temp_group_id like "-3" to its numeric value for comparison. */
function parseTempId(id: string): number {
  return parseInt(id, 10);
}

/**
 * Determine which group survives a merge.
 * Larger by member count wins; ties go to the numerically lower temp_group_id.
 */
function survivorOf(a: WorkingGroup, b: WorkingGroup): { survivor: WorkingGroup; absorbed: WorkingGroup } {
  if (a.members.length > b.members.length) return { survivor: a, absorbed: b };
  if (b.members.length > a.members.length) return { survivor: b, absorbed: a };
  // Tie: lower (more negative) temp_group_id survives.
  return parseTempId(a.temp_group_id) < parseTempId(b.temp_group_id)
    ? { survivor: a, absorbed: b }
    : { survivor: b, absorbed: a };
}

/**
 * Return up to `maxCount` member IDs with the highest average pairscore
 * against all other members in the same group (most representative).
 */
function mostRepresentativeMembers(
  memberIds: number[],
  idPairMap: Map<string, PairscoreEntry>,
  maxCount: number,
): number[] {
  if (memberIds.length <= maxCount) return [...memberIds];
  const ranked = memberIds.map((id) => {
    const others = memberIds.filter((o) => o !== id);
    const avg = others.length === 0
      ? 0
      : others.reduce((s, o) => s + (getEntry(idPairMap, id, o)?.combined ?? 0), 0) / others.length;
    return { id, avg };
  });
  ranked.sort((a, b) => b.avg - a.avg);
  return ranked.slice(0, maxCount).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Cross-pair scoring
// ---------------------------------------------------------------------------

function computeCrossPairSummary(
  groupA: WorkingGroup,
  groupB: WorkingGroup,
  idPairMap: Map<string, PairscoreEntry>,
): CrossPairSummary {
  let maxScore = 0;
  let minScore = Infinity;
  let sum = 0;
  let pairsAbove018 = 0;
  let pairsAbove012 = 0;
  let totalPairs = 0;
  let acronymFiredAny = false;

  for (const aId of groupA.member_ids) {
    for (const bId of groupB.member_ids) {
      const entry    = getEntry(idPairMap, aId, bId);
      const combined = entry?.combined ?? 0;
      if (combined > maxScore) maxScore = combined;
      if (combined < minScore) minScore = combined;
      sum += combined;
      totalPairs++;
      if (combined >= 0.18) pairsAbove018++;
      if (combined >= 0.12) pairsAbove012++;
      if (entry?.acronym_fired) acronymFiredAny = true;
    }
  }

  return {
    maxScore,
    minScore:      totalPairs > 0 ? minScore : 0,
    avgScore:      totalPairs > 0 ? sum / totalPairs : 0,
    pairsAbove018,
    pairsAbove012,
    totalPairs,
    acronymFiredAny,
  };
}

// ---------------------------------------------------------------------------
// Feature payload builder
// ---------------------------------------------------------------------------

function buildGroupMergePayload(
  groupA: WorkingGroup,
  groupB: WorkingGroup,
  summary: CrossPairSummary,
  idPairMap: Map<string, PairscoreEntry>,
  itemMetadataMap: ItemMetadataMap,
): Record<string, unknown> {
  // cross_pair_scores: all (a, b) combinations
  const cross_pair_scores = groupA.member_ids.flatMap((aId) =>
    groupB.member_ids.map((bId) => {
      const entry  = getEntry(idPairMap, aId, bId);
      const aMeta  = itemMetadataMap.get(aId)  as ItemMetadata;
      const bMeta  = itemMetadataMap.get(bId)  as ItemMetadata;
      return {
        a_literal:      aMeta?.literal_value ?? String(aId),
        b_literal:      bMeta?.literal_value ?? String(bId),
        combined_score: entry?.combined ?? 0,
        components: {
          exact_match:       entry?.Mpair  ?? 0,
          token_similarity:  entry?.TSpair ?? 0,
          string_similarity: entry?.SSpair ?? 0,
          acronym:           entry?.ACpair ?? 0,
        },
        sub_features: {
          intersecting_tokens_normalized: entry?.intersecting_tokens_norm ?? [],
          overlap_coefficient_normalized: entry?.overlap_coeff_norm       ?? 0,
          jaro_winkler:                   entry?.jaro_winkler             ?? 0,
          acronym_fired:                  entry?.acronym_fired            ?? false,
          acronym_initials:               entry?.acronym_initials         ?? '',
          subset_a_in_b:                  entry?.subset_a_in_b           ?? false,
          subset_b_in_a:                  entry?.subset_b_in_a           ?? false,
        },
      };
    }),
  );

  // representative members metadata for each group
  const repAIds = mostRepresentativeMembers(groupA.member_ids, idPairMap, MAX_REP_MEMBERS);
  const repBIds = mostRepresentativeMembers(groupB.member_ids, idPairMap, MAX_REP_MEMBERS);

  return {
    phase: 'group_merge_decision',
    group_a: {
      member_count: groupA.members.length,
      members:      repAIds.map((id) => itemMetadataMap.get(id) as unknown as Record<string, unknown>),
    },
    group_b: {
      member_count: groupB.members.length,
      members:      repBIds.map((id) => itemMetadataMap.get(id) as unknown as Record<string, unknown>),
    },
    cross_pair_scores,
    cross_pair_summary: {
      max_score:       summary.maxScore,
      min_score:       summary.minScore,
      avg_score:       summary.avgScore,
      pairs_above_018: summary.pairsAbove018,
      pairs_above_012: summary.pairsAbove012,
      total_pairs:     summary.totalPairs,
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full LLM-enhanced Phase 3 group-merging pipeline.
 *
 * Repeats passes until a full pass produces zero merges.
 *
 * @param updatedGroups       Groups from Phase 2.
 * @param remainingUnassigned Items still unassigned after Phase 2 (passed through).
 * @param pairscoreMatrix     Full pairscore matrix from Phase 0 (read-only).
 * @param itemMetadataMap     Per-item metadata from Phase 0 (read-only).
 * @param systemPrompt        Cached system block from buildGroupingSystemPrompt.
 */
export async function runPhase3(
  updatedGroups: Phase2LLMGroup[],
  remainingUnassigned: GroupingRunItem[],
  pairscoreMatrix: PairscoreMatrix,
  itemMetadataMap: ItemMetadataMap,
  systemPrompt: Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }>,
): Promise<Phase3LLMResult> {
  const idPairMap = buildIdPairMap(pairscoreMatrix);

  // Lift Phase 2 groups into mutable working state. Members are widened to
  // Phase3Item so we can attach / update metadata as merges occur.
  const workingGroups: WorkingGroup[] = updatedGroups.map((g) => ({
    temp_group_id:      g.temp_group_id,
    members:            g.members.map((m) => m as Phase3Item),
    member_ids:         [...g.member_ids],
    hadLLMPromotedEdges: g.llm_promoted_edges,
  }));

  let totalAutoMerged = 0;
  let totalLLMMerged  = 0;
  let passesRun       = 0;

  // ── Merge until convergence ─────────────────────────────────────────────
  while (true) {
    if (workingGroups.length < 2) break;
    passesRun++;

    // Snapshot: build list of group pairs and their cross-pair summaries.
    // n*(n-1)/2 pairs.
    const groups = [...workingGroups]; // snapshot of group list for this pass

    type GroupPair = {
      a: WorkingGroup;
      b: WorkingGroup;
      summary: CrossPairSummary;
      key: string; // sorted canonical key
    };

    const pairs: GroupPair[] = [];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const summary = computeCrossPairSummary(a, b, idPairMap);
        const key = [a.temp_group_id, b.temp_group_id].sort().join('|||');
        pairs.push({ a, b, summary, key });
      }
    }

    // Deterministic classification for each pair.
    type MergeDecision = 'auto_merge' | 'auto_reject' | 'llm';
    const decisions = new Map<string, MergeDecision>();

    for (const { key, summary } of pairs) {
      if (summary.totalPairs === 0) {
        decisions.set(key, 'auto_reject');
        continue;
      }
      if (summary.minScore >= AUTO_MERGE_THRESHOLD) {
        decisions.set(key, 'auto_merge');
      } else if (summary.maxScore < AUTO_REJECT_MAX && !summary.acronymFiredAny) {
        decisions.set(key, 'auto_reject');
      } else {
        decisions.set(key, 'llm');
      }
    }

    // ── LLM calls for ambiguous pairs ─────────────────────────────────────
    const llmPairs = pairs.filter(({ key }) => decisions.get(key) === 'llm');

    const llmCallFns: Array<() => Promise<LLMCallOutcome>> = llmPairs.map(
      ({ a, b, summary }) => async (): Promise<LLMCallOutcome> => {
        const payload = buildGroupMergePayload(a, b, summary, idPairMap, itemMetadataMap);
        try {
          const raw = await callGroupingLLM(systemPrompt, payload);
          return {
            groupAId:  a.temp_group_id,
            groupBId:  b.temp_group_id,
            merge:     Boolean(raw.merge),
            reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
            flags:     Array.isArray(raw.flags) ? raw.flags.map(String) : [],
          };
        } catch (err) {
          console.error(
            `[phase3 pass ${passesRun}] LLM failed for groups ` +
            `${a.temp_group_id} + ${b.temp_group_id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            groupAId:  a.temp_group_id,
            groupBId:  b.temp_group_id,
            merge:     false,
            reasoning: '',
            flags:     [],
          };
        }
      },
    );

    const llmResults = await runLLMCalls(llmCallFns);

    // Index LLM results by canonical key.
    const llmByKey = new Map<string, LLMCallOutcome>();
    for (const outcome of llmResults) {
      const key = [outcome.groupAId, outcome.groupBId].sort().join('|||');
      llmByKey.set(key, outcome);
    }

    // ── Collect all merges for this pass ───────────────────────────────────
    // A group can participate in at most one merge per pass:
    // if two separate pairs both want to merge a group, the first one (in
    // iteration order) wins and the second is skipped. The next pass will
    // re-evaluate the updated groups.

    const absorbedThisPass = new Set<string>();

    // Process auto-merges first, then LLM merges, preserving iteration order.
    type PlannedMerge = {
      survivor: WorkingGroup;
      absorbed: WorkingGroup;
      llmOutcome: LLMCallOutcome | null;
      deterministic: boolean;
    };
    const plannedMerges: PlannedMerge[] = [];

    // Helper to check and register a merge.
    const scheduleMerge = (
      a: WorkingGroup,
      b: WorkingGroup,
      llmOutcome: LLMCallOutcome | null,
      deterministic: boolean,
    ): boolean => {
      if (absorbedThisPass.has(a.temp_group_id) || absorbedThisPass.has(b.temp_group_id)) {
        return false; // one of these groups already absorbed this pass
      }
      const { survivor, absorbed } = survivorOf(a, b);
      absorbedThisPass.add(absorbed.temp_group_id);
      plannedMerges.push({ survivor, absorbed, llmOutcome, deterministic });
      return true;
    };

    // Auto-merges
    for (const { a, b, key } of pairs) {
      if (decisions.get(key) === 'auto_merge') {
        scheduleMerge(a, b, null, true);
      }
    }

    // LLM merges
    for (const { a, b, key } of pairs) {
      if (decisions.get(key) === 'llm') {
        const outcome = llmByKey.get(key);
        if (outcome?.merge) {
          scheduleMerge(a, b, outcome, false);
        }
      }
    }

    if (plannedMerges.length === 0) break; // converged — no merges this pass

    // ── Commit all planned merges atomically ──────────────────────────────
    for (const { survivor, absorbed, llmOutcome, deterministic } of plannedMerges) {
      // Update metadata on items that move from absorbed → survivor.
      const movedMembers: Phase3Item[] = absorbed.members.map((item) => {
        if (deterministic) {
          return { ...item, grouping_llm_phase: 'deterministic' as const };
        }
        return {
          ...item,
          grouping_llm_phase: 'phase3' as const,
          grouping_llm_used:  LLM_MODEL_ID,
          grouping_reasoning: llmOutcome?.reasoning ?? '',
          grouping_flags:     llmOutcome?.flags     ?? [],
        };
      });

      // Merge into survivor.
      survivor.members.push(...movedMembers);
      survivor.member_ids.push(...absorbed.member_ids);
      if (absorbed.hadLLMPromotedEdges) survivor.hadLLMPromotedEdges = true;

      // Remove absorbed group from working set.
      const idx = workingGroups.indexOf(absorbed);
      if (idx !== -1) workingGroups.splice(idx, 1);

      if (deterministic) totalAutoMerged++;
      else               totalLLMMerged++;
    }
  }

  // ── Build final output ─────────────────────────────────────────────────
  const finalGroups: Phase3FinalGroup[] = workingGroups.map((g) => ({
    temp_group_id:       g.temp_group_id,
    members:             g.members,
    member_ids:          g.member_ids.slice().sort((a, b) => a - b),
    had_llm_promoted_edges: g.hadLLMPromotedEdges,
  }));

  // ── Output invariant: every item from every input group appears in exactly
  //    one group in finalGroups — no item lost, none duplicated across groups ─
  const inputIds = new Set<number>(updatedGroups.flatMap((g) => g.member_ids));
  const seenInOutput = new Set<number>();
  for (const g of finalGroups) {
    for (const id of g.member_ids) {
      if (seenInOutput.has(id)) {
        throw new Error(
          `[phase3] invariant violation: item ID ${id} appears in multiple groups in finalGroups.`,
        );
      }
      seenInOutput.add(id);
    }
  }
  for (const id of inputIds) {
    if (!seenInOutput.has(id)) {
      throw new Error(
        `[phase3] invariant violation: item ID ${id} from input groups is missing from finalGroups.`,
      );
    }
  }

  return {
    finalGroups,
    remainingUnassigned,
    diagnostics: {
      passes_run:         passesRun,
      total_auto_merged:  totalAutoMerged,
      total_llm_merged:   totalLLMMerged,
      total_groups_final: finalGroups.length,
    },
  };
}
