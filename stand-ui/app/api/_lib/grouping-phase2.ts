/**
 * Phase 2 (LLM-enhanced) — Absorption of remaining unassigned items into anchor groups.
 *
 * Up to 3 order-independent passes. Within each pass:
 *   1. Score every unassigned item against every group using the Phase 0 matrix.
 *   2. Classify each item: auto-absorb / auto-reject / LLM.
 *   3. Run all LLM calls for the pass in parallel.
 *   4. Commit all decisions atomically after the pass — never mid-pass.
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
import { type LLMPhase1AnchorGroup } from './grouping-phase1';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MAX_PASSES           = 3;
const AUTO_ABSORB_MAX      = 0.30; // max_score >= this AND …
const AUTO_ABSORB_MIN      = 0.18; // … min_score >= this → auto-absorb (if exactly one group)
const AUTO_REJECT_MAX      = 0.08; // max across ALL groups < this → auto-reject
const LLM_ELIGIBLE_MIN_MAX = 0.10; // groups with max >= this get LLM calls
const LLM_TRIGGER_MIN_MAX  = 0.15; // max in [this, 0.30) → LLM trigger
const LLM_TRIGGER_MIN_MIN  = 0.08; // min in [this, 0.18) (when max >= 0.15) → trigger
const STRONG_PEER_SCORE    = 0.15; // threshold for strong_unassigned_peers
const MAX_REP_MEMBERS      = 5;    // cap on members metadata in LLM payload

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A GroupingRunItem that was absorbed into a group during Phase 2.
 * Carries LLM decision metadata alongside all base fields.
 */
export type Phase2AssignedItem = GroupingRunItem & {
  grouping_llm_phase: 'phase2' | 'deterministic';
  grouping_llm_used?: string;
  grouping_reasoning?: string;
  grouping_flags?: string[];
  grouping_deterministic_score: number;
};

/** One anchor group after Phase 2 absorption passes complete. */
export interface Phase2LLMGroup {
  temp_group_id: string;
  anchor_members: GroupingRunItem[];
  absorbed_members: Phase2AssignedItem[];
  member_ids: number[];
  members: GroupingRunItem[];
  llm_promoted_edges: boolean;
  avg_internal_score: number;
  min_internal_score: number;
}

export interface Phase2LLMResult {
  updatedGroups: Phase2LLMGroup[];
  remainingUnassigned: GroupingRunItem[];
  diagnostics: {
    passes_run: number;
    total_auto_absorbed: number;
    total_llm_absorbed: number;
    total_still_unassigned: number;
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkingGroup {
  temp_group_id: string;
  anchorMembers: GroupingRunItem[];
  absorbedMembers: Phase2AssignedItem[];
  /** currentMemberIds grows at end of each pass (used for NEXT pass scoring). */
  currentMemberIds: number[];
  llmPromotedEdges: boolean;
  avgInternalScore: number;
  minInternalScore: number;
}

interface ItemGroupScores {
  groupId: string;
  maxScore: number;
  minScore: number;
  avgScore: number;
  /** True if any (candidate, member) pair in this group has acronym_fired. */
  acronymFiredAny: boolean;
  /** Member with the highest combined score against the candidate. */
  topMemberId: number;
}

interface LLMCallOutcome {
  itemId: number;
  groupId: string;
  absorb: boolean;
  reasoning: string;
  flags: string[];
  /** True when other_eligible_groups was empty in this call's payload. */
  otherEligibleEmpty: boolean;
  maxScore: number;
}

// Resolved LLM assignment for one item (built after all outcomes are collected).
interface ResolvedLLMAssignment {
  groupId: string;
  reasoning: string;
  flags: string[];
  maxScore: number;
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

/** Compute aggregate scores between a candidate and a snapshot of group members. */
function scoreItemVsGroup(
  candidateId: number,
  memberIds: number[],
  idPairMap: Map<string, PairscoreEntry>,
  groupId: string,
): ItemGroupScores {
  let maxScore = 0;
  let minScore = Infinity;
  let sum = 0;
  let topMemberId = memberIds[0] ?? candidateId;
  let topCombined = -Infinity;
  let acronymFiredAny = false;

  for (const memberId of memberIds) {
    const entry    = getEntry(idPairMap, candidateId, memberId);
    const combined = entry?.combined ?? 0;
    if (combined > maxScore) maxScore = combined;
    if (combined < minScore) minScore = combined;
    sum += combined;
    if (combined > topCombined) { topCombined = combined; topMemberId = memberId; }
    if (entry?.acronym_fired)  acronymFiredAny = true;
  }

  return {
    groupId,
    maxScore,
    minScore:        memberIds.length > 0 ? minScore : 0,
    avgScore:        memberIds.length > 0 ? sum / memberIds.length : 0,
    acronymFiredAny,
    topMemberId,
  };
}

/**
 * Return up to `maxCount` member IDs with the highest average pairscore
 * against all other members — the most representative members of the group.
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
// Feature payload builder
// ---------------------------------------------------------------------------

function buildAbsorptionPayload(
  candidate: GroupingRunItem,
  group: WorkingGroup,
  snapshotMemberIds: number[],
  groupScores: ItemGroupScores,
  otherEligible: Array<{ group: WorkingGroup; scores: ItemGroupScores }>,
  stillUnassigned: GroupingRunItem[],
  idPairMap: Map<string, PairscoreEntry>,
  itemMetadataMap: ItemMetadataMap,
): Record<string, unknown> {
  const candidateId = candidate.run_item_id;

  // scores_against_candidate: one entry per group member (no cap)
  const scoresAgainstCandidate = snapshotMemberIds.map((memberId) => {
    const entry      = getEntry(idPairMap, candidateId, memberId);
    const memberMeta = itemMetadataMap.get(memberId) as ItemMetadata;
    const isA        = entry ? entry.run_item_id_a === candidateId : true;
    return {
      member_literal:  memberMeta?.literal_value ?? String(memberId),
      combined_score:  entry?.combined ?? 0,
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
        subset_candidate_in_member: isA ? (entry?.subset_a_in_b ?? false)
                                        : (entry?.subset_b_in_a ?? false),
        subset_member_in_candidate: isA ? (entry?.subset_b_in_a ?? false)
                                        : (entry?.subset_a_in_b ?? false),
      },
    };
  });

  // representative members metadata (capped)
  const repIds      = mostRepresentativeMembers(snapshotMemberIds, idPairMap, MAX_REP_MEMBERS);
  const membersMeta = repIds.map(
    (id) => itemMetadataMap.get(id) as unknown as Record<string, unknown>,
  );

  // other_eligible_groups (excluding target)
  const other_eligible_groups = otherEligible.map(({ group: og, scores: os }) => {
    const topMeta = itemMetadataMap.get(os.topMemberId) as ItemMetadata;
    return {
      group_id:           og.temp_group_id,
      member_count:       og.currentMemberIds.length,
      top_member_literal: topMeta?.literal_value ?? String(os.topMemberId),
      max_score:          os.maxScore,
      min_score:          os.minScore,
    };
  });

  // strong_unassigned_peers
  const strong_unassigned_peers = stillUnassigned
    .filter((p) => p.run_item_id !== candidateId)
    .flatMap((p) => {
      const entry = getEntry(idPairMap, candidateId, p.run_item_id);
      if (!entry || entry.combined < STRONG_PEER_SCORE) return [];
      return [{ literal: p.raw_value, combined_score: entry.combined }];
    });

  return {
    phase: 'absorption_decision',
    candidate_item: itemMetadataMap.get(candidateId) as unknown as Record<string, unknown>,
    target_group: {
      member_count:             snapshotMemberIds.length,
      members:                  membersMeta,
      scores_against_candidate: scoresAgainstCandidate,
      max_score:                groupScores.maxScore,
      min_score:                groupScores.minScore,
      avg_score:                groupScores.avgScore,
    },
    other_eligible_groups,
    strong_unassigned_peers,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full LLM-enhanced Phase 2 absorption pipeline (up to 3 passes).
 *
 * @param anchorGroups      Accepted anchor groups from Phase 1.
 * @param remainingUnassigned  Items not placed in Phase 1.
 * @param pairscoreMatrix   Full pairscore matrix from Phase 0 (read-only).
 * @param itemMetadataMap   Per-item metadata from Phase 0 (read-only).
 * @param systemPrompt      Cached system block from buildGroupingSystemPrompt.
 */
export async function runPhase2(
  anchorGroups: LLMPhase1AnchorGroup[],
  remainingUnassigned: GroupingRunItem[],
  pairscoreMatrix: PairscoreMatrix,
  itemMetadataMap: ItemMetadataMap,
  systemPrompt: Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }>,
): Promise<Phase2LLMResult> {
  const idPairMap = buildIdPairMap(pairscoreMatrix);

  const workingGroups: WorkingGroup[] = anchorGroups.map((g) => ({
    temp_group_id:    g.temp_group_id,
    anchorMembers:    g.members,
    absorbedMembers:  [],
    currentMemberIds: [...g.member_ids],
    llmPromotedEdges: g.llm_promoted_edges,
    avgInternalScore: g.avg_internal_score,
    minInternalScore: g.min_internal_score,
  }));

  let unassigned: GroupingRunItem[] = [...remainingUnassigned];
  let totalAutoAbsorbed = 0;
  let totalLLMAbsorbed  = 0;
  let passesRun         = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (unassigned.length === 0) break;
    passesRun = pass;

    // ── Freeze membership snapshot for this pass ─────────────────────────
    const snapshot = new Map<string, number[]>(
      workingGroups.map((g) => [g.temp_group_id, [...g.currentMemberIds]]),
    );

    // ── Classify every unassigned item ────────────────────────────────────
    // autoAbsorb: itemId → { groupId, maxScore }
    const autoAbsorb = new Map<number, { groupId: string; maxScore: number }>();
    // needsLLM: itemId → eligible group scores
    const needsLLM   = new Map<number, Array<{ group: WorkingGroup; scores: ItemGroupScores }>>();

    for (const item of unassigned) {
      const itemId = item.run_item_id;
      const perGroup: Array<{ group: WorkingGroup; scores: ItemGroupScores }> = [];

      for (const g of workingGroups) {
        const memberIds = snapshot.get(g.temp_group_id) ?? g.currentMemberIds;
        if (memberIds.length === 0) continue;
        const scores = scoreItemVsGroup(itemId, memberIds, idPairMap, g.temp_group_id);
        perGroup.push({ group: g, scores });
      }

      // Auto-absorb candidates
      const autoAbsorbMatches = perGroup.filter(
        ({ scores }) => scores.maxScore >= AUTO_ABSORB_MAX && scores.minScore >= AUTO_ABSORB_MIN,
      );
      if (autoAbsorbMatches.length === 1) {
        autoAbsorb.set(itemId, {
          groupId:  autoAbsorbMatches[0].group.temp_group_id,
          maxScore: autoAbsorbMatches[0].scores.maxScore,
        });
        continue;
      }

      // Auto-reject: max against every group < 0.08
      const globalMax = perGroup.reduce((m, { scores }) => Math.max(m, scores.maxScore), 0);
      if (globalMax < AUTO_REJECT_MAX) continue; // stays unassigned; no LLM needed

      // LLM trigger check
      const triggered = autoAbsorbMatches.length > 1 || perGroup.some(({ scores }) =>
        (scores.maxScore >= LLM_TRIGGER_MIN_MAX && scores.maxScore < AUTO_ABSORB_MAX) ||
        (scores.maxScore >= LLM_TRIGGER_MIN_MAX && scores.minScore >= LLM_TRIGGER_MIN_MIN && scores.minScore < AUTO_ABSORB_MIN) ||
        scores.acronymFiredAny,
      );

      if (triggered) {
        const eligible = perGroup.filter(({ scores }) => scores.maxScore >= LLM_ELIGIBLE_MIN_MAX);
        if (eligible.length > 0) needsLLM.set(itemId, eligible);
        // else: triggered but no group meets min max — stays unassigned
      }
      // else: no trigger, no auto-absorb, max >= 0.08 → stays unassigned this pass
    }

    // ── Build and run all LLM calls for this pass in parallel ─────────────
    const llmCallFns: Array<() => Promise<LLMCallOutcome>> = [];

    for (const [itemId, eligibleGroups] of needsLLM) {
      const item = unassigned.find((it) => it.run_item_id === itemId)!;

      for (const { group, scores } of eligibleGroups) {
        const otherEligible    = eligibleGroups.filter(
          (g) => g.group.temp_group_id !== group.temp_group_id,
        );
        const otherEligibleEmpty = otherEligible.length === 0;
        const memberIds = snapshot.get(group.temp_group_id) ?? group.currentMemberIds;

        llmCallFns.push(async (): Promise<LLMCallOutcome> => {
          const payload = buildAbsorptionPayload(
            item,
            group,
            memberIds,
            scores,
            otherEligible,
            unassigned,
            idPairMap,
            itemMetadataMap,
          );
          try {
            const raw = await callGroupingLLM(systemPrompt, payload);
            return {
              itemId,
              groupId:            group.temp_group_id,
              absorb:             Boolean(raw.absorb),
              reasoning:          typeof raw.reasoning === 'string' ? raw.reasoning : '',
              flags:              Array.isArray(raw.flags) ? raw.flags.map(String) : [],
              otherEligibleEmpty,
              maxScore:           scores.maxScore,
            };
          } catch (err) {
            console.error(
              `[phase2 pass ${pass}] LLM failed for item ${itemId} ` +
              `vs group ${group.temp_group_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
            return {
              itemId,
              groupId:            group.temp_group_id,
              absorb:             false,
              reasoning:          '',
              flags:              [],
              otherEligibleEmpty,
              maxScore:           scores.maxScore,
            };
          }
        });
      }
    }

    const llmResults = await runLLMCalls(llmCallFns);

    // Group LLM outcomes by item and resolve per-item assignment decision.
    const llmByItem = new Map<number, LLMCallOutcome[]>();
    for (const outcome of llmResults) {
      if (!llmByItem.has(outcome.itemId)) llmByItem.set(outcome.itemId, []);
      llmByItem.get(outcome.itemId)!.push(outcome);
    }

    // resolvedLLM: itemId → assignment, constructed locally for this pass
    const resolvedLLM = new Map<number, ResolvedLLMAssignment>();

    for (const [itemId, outcomes] of llmByItem) {
      const absorbing = outcomes.filter((o) => o.absorb);

      // Assign only when exactly one group said absorb AND that call had no competing groups.
      if (absorbing.length === 1 && absorbing[0].otherEligibleEmpty) {
        const o = absorbing[0];
        resolvedLLM.set(itemId, {
          groupId:  o.groupId,
          reasoning: o.reasoning,
          flags:     o.flags,
          maxScore:  o.maxScore,
        });
      }
      // All other cases (0 absorb, 2+ absorb, or other_eligible non-empty): stay unassigned.
    }

    // ── Commit all decisions atomically at end of pass ────────────────────
    const newlyAssigned = new Set<number>();
    const groupById = new Map<string, WorkingGroup>(
      workingGroups.map((g) => [g.temp_group_id, g]),
    );

    for (const item of unassigned) {
      const itemId = item.run_item_id;

      // 1. Auto-absorb
      const ab = autoAbsorb.get(itemId);
      if (ab) {
        const g = groupById.get(ab.groupId);
        if (g) {
          g.absorbedMembers.push({
            ...item,
            grouping_llm_phase:          'deterministic',
            grouping_deterministic_score: ab.maxScore,
          });
          g.currentMemberIds.push(itemId);
          newlyAssigned.add(itemId);
          totalAutoAbsorbed++;
        }
        continue;
      }

      // 2. LLM assignment
      const llm = resolvedLLM.get(itemId);
      if (llm) {
        const g = groupById.get(llm.groupId);
        if (g) {
          g.absorbedMembers.push({
            ...item,
            grouping_llm_phase:          'phase2',
            grouping_llm_used:            LLM_MODEL_ID,
            grouping_reasoning:           llm.reasoning,
            grouping_flags:               llm.flags,
            grouping_deterministic_score: llm.maxScore,
          });
          g.currentMemberIds.push(itemId);
          newlyAssigned.add(itemId);
          totalLLMAbsorbed++;
        }
      }
      // else: stays unassigned for this pass
    }

    unassigned = unassigned.filter((it) => !newlyAssigned.has(it.run_item_id));
    if (newlyAssigned.size === 0) break; // no progress → converged early
  }

  // ── Build final output ────────────────────────────────────────────────
  const updatedGroups: Phase2LLMGroup[] = workingGroups.map((g) => ({
    temp_group_id:    g.temp_group_id,
    anchor_members:   g.anchorMembers,
    absorbed_members: g.absorbedMembers,
    member_ids:       g.currentMemberIds.slice().sort((a, b) => a - b),
    members:          ([...g.anchorMembers, ...g.absorbedMembers] as GroupingRunItem[]),
    llm_promoted_edges: g.llmPromotedEdges,
    avg_internal_score: g.avgInternalScore,
    min_internal_score: g.minInternalScore,
  }));

  // ── Output invariant: every input item in exactly one bucket ─────────────
  const absorbedIds      = new Set<number>(workingGroups.flatMap((g) => g.absorbedMembers.map((m) => m.run_item_id)));
  const finalUnassignedIds = new Set<number>(unassigned.map((it) => it.run_item_id));
  for (const item of remainingUnassigned) {
    const inAbsorbed   = absorbedIds.has(item.run_item_id);
    const inUnassigned = finalUnassignedIds.has(item.run_item_id);
    if (!inAbsorbed && !inUnassigned) {
      throw new Error(
        `[phase2] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `is missing from both updatedGroups absorbed members and remainingUnassigned.`,
      );
    }
    if (inAbsorbed && inUnassigned) {
      throw new Error(
        `[phase2] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `appears in both updatedGroups absorbed members and remainingUnassigned.`,
      );
    }
  }

  return {
    updatedGroups,
    remainingUnassigned: unassigned,
    diagnostics: {
      passes_run:             passesRun,
      total_auto_absorbed:    totalAutoAbsorbed,
      total_llm_absorbed:     totalLLMAbsorbed,
      total_still_unassigned: unassigned.length,
    },
  };
}
