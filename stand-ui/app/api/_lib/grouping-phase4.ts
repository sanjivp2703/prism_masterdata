/**
 * Phase 4 (LLM-enhanced) — Singleton confirmation and unassigned audit.
 *
 * Every item still unassigned after Phase 3 receives a final disposition here.
 *
 * Step 1: Deterministic routing (Conditions A–D) assigns each item to either
 *   Phase 4a (singleton confirmation) or Phase 4b (unassigned audit).
 * Step 2: Phase 4a and Phase 4b LLM calls run in parallel.
 * Step 3: Results are committed. A final invariant check ensures no item is
 *   lost or duplicated.
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
import { type Phase3FinalGroup, type Phase3Item } from './grouping-phase3';

// ---------------------------------------------------------------------------
// Thresholds used in condition routing and payload building
// ---------------------------------------------------------------------------

// Condition A
const COND_A_MAX        = 0.18;
const COND_A_MIN        = 0.12;
// Condition B
const COND_B_MAX        = 0.22;
// Condition C
const COND_C_MAX_LO     = 0.15;
const COND_C_MAX_HI     = 0.18;
const COND_C_MIN        = 0.10;
// Condition D (and Phase 4b strong-peer threshold)
const COND_D_PEER       = 0.15;
const PHASE4B_PEER_MIN  = 0.12;

// Phase 4b group inclusion
const PHASE4B_GROUP_MIN_MAX = 0.10;

// Phase 4a best-score caps
const PHASE4A_GROUP_CAP = 3;
const PHASE4A_PEER_CAP  = 3;
// Phase 4b member cap
const PHASE4B_REP_MEMBERS = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An item that carries all possible per-phase LLM metadata, including Phase 4.
 */
export type Phase4Item = GroupingRunItem & {
  grouping_llm_phase?: 'phase2' | 'phase3' | 'phase4a' | 'phase4b' | 'deterministic';
  grouping_llm_used?: string;
  grouping_reasoning?: string;
  grouping_flags?: string[];
  grouping_deterministic_score?: number;
};

/** A group in the final output — either carried through from Phase 3 or a new singleton. */
export interface Phase4Group {
  temp_group_id: string;
  members: Phase4Item[];
  member_ids: number[];
  /** True for single-item groups created in Phase 4. */
  is_singleton: boolean;
  had_llm_promoted_edges: boolean;
}

export interface Phase4Result {
  /** Phase 3 groups plus any new singleton groups created in Phase 4. */
  allGroups: Phase4Group[];
  /** Items left in __UNGROUPED__ for human review. */
  unassignedItems: Phase4Item[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ItemGroupScore {
  groupId: string;
  groupNumericId: number;
  maxScore: number;
  minScore: number;
  avgScore: number;
  topMemberId: number;
}

interface ConditionResult {
  routeTo: 'phase4a' | 'phase4b';
  /** Conditions that fired, in evaluation order. */
  triggeredConditions: Array<{ condition: 'A' | 'B' | 'C' | 'D'; description: string }>;
}

interface Phase4aOutcome {
  itemId: number;
  disposition: 'singleton' | 'unassigned';
  reasoning: string;
  flags: string[];
  bestGroupMaxScore: number;
}

interface Phase4bOutcome {
  itemId: number;
  disposition: 'confirm_unassigned' | 'assign_to_group' | 'confirm_singleton';
  assignedGroupId: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  flags: string[];
  bestGroupMaxScore: number;
}

// ---------------------------------------------------------------------------
// Helpers
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

function parseTempId(id: string): number {
  return parseInt(id, 10);
}

/** Compute aggregate scores for one (candidate, group) pair. */
function scoreItemVsGroup(
  candidateId: number,
  group: Phase3FinalGroup,
  idPairMap: Map<string, PairscoreEntry>,
): ItemGroupScore {
  let maxScore = 0;
  let minScore = Infinity;
  let sum = 0;
  let topMemberId = group.member_ids[0] ?? candidateId;
  let topCombined = -Infinity;

  for (const memberId of group.member_ids) {
    const entry    = getEntry(idPairMap, candidateId, memberId);
    const combined = entry?.combined ?? 0;
    if (combined > maxScore) maxScore = combined;
    if (combined < minScore) minScore = combined;
    sum += combined;
    if (combined > topCombined) { topCombined = combined; topMemberId = memberId; }
  }

  return {
    groupId:        group.temp_group_id,
    groupNumericId: parseTempId(group.temp_group_id),
    maxScore,
    minScore:       group.member_ids.length > 0 ? minScore : 0,
    avgScore:       group.member_ids.length > 0 ? sum / group.member_ids.length : 0,
    topMemberId,
  };
}

/** Return up to maxCount member IDs ranked by average internal pairscore. */
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
// Condition routing
// ---------------------------------------------------------------------------

function evaluateConditions(
  candidateId: number,
  groupScores: ItemGroupScore[],
  peers: GroupingRunItem[],
  idPairMap: Map<string, PairscoreEntry>,
): ConditionResult {
  const triggered: Array<{ condition: 'A' | 'B' | 'C' | 'D'; description: string }> = [];

  // Condition A — Multi-group eligibility
  const eligibleGroups = groupScores.filter(
    (g) => g.maxScore >= COND_A_MAX && g.minScore >= COND_A_MIN,
  );
  if (eligibleGroups.length >= 2) {
    const ids = eligibleGroups.map((g) => g.groupId).join(', ');
    triggered.push({
      condition: 'A',
      description: `Item qualifies for ${eligibleGroups.length} groups (max ≥ ${COND_A_MAX}, min ≥ ${COND_A_MIN}): groups ${ids}.`,
    });
    return { routeTo: 'phase4b', triggeredConditions: triggered };
  }

  // Condition B — Strong link blocked by weak min
  if (eligibleGroups.length <= 1) {
    const condBGroup = groupScores.find(
      (g) => g.maxScore >= COND_B_MAX && g.minScore < COND_A_MIN,
    );
    if (condBGroup) {
      triggered.push({
        condition: 'B',
        description:
          `Group ${condBGroup.groupId} has a strong top score (${condBGroup.maxScore.toFixed(3)}) ` +
          `but a weak minimum (${condBGroup.minScore.toFixed(3)}) — partial cluster match.`,
      });
      return { routeTo: 'phase4b', triggeredConditions: triggered };
    }
  }

  // Condition C — Borderline near-miss
  if (eligibleGroups.length === 0) {
    const condCGroup = groupScores.find(
      (g) =>
        g.maxScore >= COND_C_MAX_LO &&
        g.maxScore < COND_C_MAX_HI &&
        g.minScore >= COND_C_MIN,
    );
    if (condCGroup) {
      triggered.push({
        condition: 'C',
        description:
          `Group ${condCGroup.groupId} is a near-miss at max score ${condCGroup.maxScore.toFixed(3)} ` +
          `(threshold ${COND_C_MAX_HI}) with min score ${condCGroup.minScore.toFixed(3)}.`,
      });
      return { routeTo: 'phase4b', triggeredConditions: triggered };
    }
  }

  // Condition D — Strong unassigned peer
  const allGroupsLowMax = groupScores.every((g) => g.maxScore < COND_D_PEER);
  if (allGroupsLowMax) {
    for (const peer of peers) {
      if (peer.run_item_id === candidateId) continue;
      const entry = getEntry(idPairMap, candidateId, peer.run_item_id);
      if (entry && entry.combined >= COND_D_PEER) {
        triggered.push({
          condition: 'D',
          description:
            `Unassigned peer '${peer.raw_value}' has a strong connection (${entry.combined.toFixed(3)}) — possible future grouping candidate.`,
        });
        return { routeTo: 'phase4b', triggeredConditions: triggered };
      }
    }
  }

  return { routeTo: 'phase4a', triggeredConditions: [] };
}

// ---------------------------------------------------------------------------
// Phase 4a payload
// ---------------------------------------------------------------------------

function buildSingletonPayload(
  candidate: GroupingRunItem,
  groupScores: ItemGroupScore[],
  peers: GroupingRunItem[],
  idPairMap: Map<string, PairscoreEntry>,
  itemMetadataMap: ItemMetadataMap,
): Record<string, unknown> {
  const candidateId = candidate.run_item_id;

  const sorted = [...groupScores].sort((a, b) => b.maxScore - a.maxScore);
  const best_group_scores = sorted.slice(0, PHASE4A_GROUP_CAP).map((g) => {
    const topMeta = itemMetadataMap.get(g.topMemberId) as ItemMetadata;
    return {
      group_id:           g.groupNumericId,
      top_member_literal: topMeta?.literal_value ?? String(g.topMemberId),
      max_score:          g.maxScore,
      min_score:          g.minScore,
    };
  });

  const peerScores = peers
    .filter((p) => p.run_item_id !== candidateId)
    .flatMap((p) => {
      const entry = getEntry(idPairMap, candidateId, p.run_item_id);
      if (!entry) return [];
      return [{ literal: p.raw_value, combined_score: entry.combined }];
    })
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, PHASE4A_PEER_CAP);

  return {
    phase: 'singleton_confirmation',
    candidate_item:             itemMetadataMap.get(candidateId) as unknown as Record<string, unknown>,
    best_group_scores,
    best_unassigned_peer_scores: peerScores,
  };
}

// ---------------------------------------------------------------------------
// Phase 4b payload
// ---------------------------------------------------------------------------

function buildAuditPayload(
  candidate: GroupingRunItem,
  triggeredConditions: Array<{ condition: string; description: string }>,
  groups: Phase3FinalGroup[],
  groupScores: ItemGroupScore[],
  peers: GroupingRunItem[],
  idPairMap: Map<string, PairscoreEntry>,
  itemMetadataMap: ItemMetadataMap,
): Record<string, unknown> {
  const candidateId = candidate.run_item_id;

  // Groups with max_score >= 0.10 — full detail
  const eligibleGroupScores = groupScores.filter((g) => g.maxScore >= PHASE4B_GROUP_MIN_MAX);
  const group_scores = eligibleGroupScores.map((gs) => {
    const group    = groups.find((g) => g.temp_group_id === gs.groupId)!;
    const repIds   = mostRepresentativeMembers(group.member_ids, idPairMap, PHASE4B_REP_MEMBERS);
    const members  = repIds.map((id) => itemMetadataMap.get(id) as unknown as Record<string, unknown>);

    const scores_against_candidate = group.member_ids.map((memberId) => {
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

    return {
      group_id:                 gs.groupNumericId,
      member_count:             group.members.length,
      members,
      scores_against_candidate,
      max_score:                gs.maxScore,
      min_score:                gs.minScore,
      avg_score:                gs.avgScore,
    };
  });

  // Strong unassigned peers (combined >= 0.12)
  const strong_unassigned_peers = peers
    .filter((p) => p.run_item_id !== candidateId)
    .flatMap((p) => {
      const entry = getEntry(idPairMap, candidateId, p.run_item_id);
      if (!entry || entry.combined < PHASE4B_PEER_MIN) return [];
      return [{
        literal:        p.raw_value,
        metadata:       itemMetadataMap.get(p.run_item_id) as unknown as Record<string, unknown>,
        combined_score: entry.combined,
        components: {
          exact_match:       entry.Mpair,
          token_similarity:  entry.TSpair,
          string_similarity: entry.SSpair,
          acronym:           entry.ACpair,
        },
        acronym_fired: entry.acronym_fired,
      }];
    });

  return {
    phase: 'unassigned_audit',
    candidate_item:      itemMetadataMap.get(candidateId) as unknown as Record<string, unknown>,
    triggered_conditions: triggeredConditions,
    group_scores,
    strong_unassigned_peers,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full Phase 4 singleton-confirmation and unassigned-audit pipeline.
 *
 * @param finalGroups         Finalized groups from Phase 3.
 * @param remainingUnassigned Items still unassigned after Phase 3.
 * @param pairscoreMatrix     Full pairscore matrix from Phase 0 (read-only).
 * @param itemMetadataMap     Per-item metadata from Phase 0 (read-only).
 * @param systemPrompt        Cached system block from buildGroupingSystemPrompt.
 */
export async function runPhase4(
  finalGroups: Phase3FinalGroup[],
  remainingUnassigned: GroupingRunItem[],
  pairscoreMatrix: PairscoreMatrix,
  itemMetadataMap: ItemMetadataMap,
  systemPrompt: Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }>,
  /**
   * The next available negative-integer temp group ID, threaded from Phase 1
   * via the orchestrator so singleton IDs never collide with anchor group IDs.
   * IDs <= 0 are temp; IDs > 0 are real Snowflake-assigned IDs.
   * Defaults to -1 when called in isolation (e.g. tests).
   */
  startTempId: number = -1,
): Promise<Phase4Result> {
  if (remainingUnassigned.length === 0) {
    return {
      allGroups: finalGroups.map((g) => ({
        temp_group_id:       g.temp_group_id,
        members:             g.members.map((m) => m as Phase4Item),
        member_ids:          g.member_ids,
        is_singleton:        false,
        had_llm_promoted_edges: g.had_llm_promoted_edges,
      })),
      unassignedItems: [],
    };
  }

  const idPairMap = buildIdPairMap(pairscoreMatrix);

  // ── Step 1: pre-compute scores and route each item ─────────────────────
  interface RoutedItem {
    item: GroupingRunItem;
    groupScores: ItemGroupScore[];
    conditionResult: ConditionResult;
  }

  const routed: RoutedItem[] = remainingUnassigned.map((item) => {
    const groupScores = finalGroups.map((g) =>
      scoreItemVsGroup(item.run_item_id, g, idPairMap),
    );
    const conditionResult = evaluateConditions(
      item.run_item_id,
      groupScores,
      remainingUnassigned,
      idPairMap,
    );
    return { item, groupScores, conditionResult };
  });

  const phase4aItems = routed.filter((r) => r.conditionResult.routeTo === 'phase4a');
  const phase4bItems = routed.filter((r) => r.conditionResult.routeTo === 'phase4b');

  // Singleton groups get negative-integer IDs continuing from Phase 1's counter.
  let nextTempId = startTempId;
  function allocateTempId(): string {
    return String(nextTempId--);
  }

  // ── Step 2: run Phase 4a and 4b LLM calls in parallel ─────────────────

  // Phase 4a call builders
  const phase4aCallFns = phase4aItems.map(({ item, groupScores }) => {
    const bestGroupMaxScore = groupScores.reduce((m, g) => Math.max(m, g.maxScore), 0);
    return async (): Promise<Phase4aOutcome> => {
      const payload = buildSingletonPayload(
        item, groupScores, remainingUnassigned, idPairMap, itemMetadataMap,
      );
      try {
        const raw = await callGroupingLLM(systemPrompt, payload);
        const disposition = raw.disposition === 'singleton' ? 'singleton' : 'unassigned';
        return {
          itemId:            item.run_item_id,
          disposition,
          reasoning:         typeof raw.reasoning === 'string' ? raw.reasoning : '',
          flags:             Array.isArray(raw.flags) ? raw.flags.map(String) : [],
          bestGroupMaxScore,
        };
      } catch (err) {
        console.error(
          `[phase4a] LLM failed for item ${item.run_item_id} ('${item.raw_value}'): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        // On failure, conservatively route to unassigned rather than creating a bad singleton.
        return {
          itemId:            item.run_item_id,
          disposition:       'unassigned',
          reasoning:         '',
          flags:             [],
          bestGroupMaxScore,
        };
      }
    };
  });

  // Phase 4b call builders
  const phase4bCallFns = phase4bItems.map(({ item, groupScores, conditionResult }) => {
    const bestGroupMaxScore = groupScores.reduce((m, g) => Math.max(m, g.maxScore), 0);
    return async (): Promise<Phase4bOutcome> => {
      const payload = buildAuditPayload(
        item,
        conditionResult.triggeredConditions,
        finalGroups,
        groupScores,
        remainingUnassigned,
        idPairMap,
        itemMetadataMap,
      );
      try {
        const raw = await callGroupingLLM(systemPrompt, payload);
        const disposition = (['confirm_unassigned', 'assign_to_group', 'confirm_singleton'] as const)
          .includes(raw.disposition as 'confirm_unassigned' | 'assign_to_group' | 'confirm_singleton')
          ? (raw.disposition as Phase4bOutcome['disposition'])
          : 'confirm_unassigned';
        const confidence = (['high', 'medium', 'low'] as const)
          .includes(raw.confidence_in_disposition as 'high' | 'medium' | 'low')
          ? (raw.confidence_in_disposition as 'high' | 'medium' | 'low')
          : 'low';
        const assignedGroupId =
          typeof raw.assigned_group_id === 'number' ? raw.assigned_group_id : null;
        return {
          itemId:         item.run_item_id,
          disposition,
          assignedGroupId,
          confidence,
          reasoning:      typeof raw.reasoning === 'string' ? raw.reasoning : '',
          flags:          Array.isArray(raw.flags) ? raw.flags.map(String) : [],
          bestGroupMaxScore,
        };
      } catch (err) {
        console.error(
          `[phase4b] LLM failed for item ${item.run_item_id} ('${item.raw_value}'): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          itemId:         item.run_item_id,
          disposition:    'confirm_unassigned',
          assignedGroupId: null,
          confidence:     'low',
          reasoning:      '',
          flags:          [],
          bestGroupMaxScore,
        };
      }
    };
  });

  // Run both batches in parallel.
  const [phase4aResults, phase4bResults] = await Promise.all([
    runLLMCalls(phase4aCallFns),
    runLLMCalls(phase4bCallFns),
  ]);

  // ── Step 3: commit decisions ───────────────────────────────────────────

  // Working copies of existing groups (widened to Phase4Item members).
  const workingGroups: Phase4Group[] = finalGroups.map((g) => ({
    temp_group_id:       g.temp_group_id,
    members:             g.members.map((m) => m as Phase4Item),
    member_ids:          [...g.member_ids],
    is_singleton:        false,
    had_llm_promoted_edges: g.had_llm_promoted_edges,
  }));
  const groupByNumericId = new Map<number, Phase4Group>(
    workingGroups.map((g) => [parseTempId(g.temp_group_id), g]),
  );

  const newSingletons: Phase4Group[] = [];
  const unassignedItems: Phase4Item[] = [];

  // Helper: build a metadata-annotated Phase4Item.
  function annotate(
    item: GroupingRunItem,
    phase: 'phase4a' | 'phase4b',
    outcome: { reasoning: string; flags: string[]; bestGroupMaxScore: number },
  ): Phase4Item {
    return {
      ...item,
      grouping_llm_phase:          phase,
      grouping_llm_used:            LLM_MODEL_ID,
      grouping_reasoning:           outcome.reasoning,
      grouping_flags:               outcome.flags,
      grouping_deterministic_score: outcome.bestGroupMaxScore,
    };
  }

  // Index original items by ID for quick lookup.
  const itemById = new Map<number, GroupingRunItem>(
    remainingUnassigned.map((it) => [it.run_item_id, it]),
  );

  // Process Phase 4a results.
  for (const outcome of phase4aResults) {
    const item = itemById.get(outcome.itemId)!;
    const annotated = annotate(item, 'phase4a', outcome);
    if (outcome.disposition === 'singleton') {
      const tid = allocateTempId();
      newSingletons.push({
        temp_group_id:       tid,
        members:             [annotated],
        member_ids:          [item.run_item_id],
        is_singleton:        true,
        had_llm_promoted_edges: false,
      });
    } else {
      unassignedItems.push(annotated);
    }
  }

  // Process Phase 4b results.
  for (const outcome of phase4bResults) {
    const item = itemById.get(outcome.itemId)!;
    const annotated = annotate(item, 'phase4b', outcome);

    if (outcome.disposition === 'confirm_singleton') {
      const tid = allocateTempId();
      newSingletons.push({
        temp_group_id:       tid,
        members:             [annotated],
        member_ids:          [item.run_item_id],
        is_singleton:        true,
        had_llm_promoted_edges: false,
      });
      continue;
    }

    if (outcome.disposition === 'assign_to_group') {
      // Low confidence override — route to unassigned.
      if (outcome.confidence === 'low') {
        unassignedItems.push(annotated);
        continue;
      }
      // Validate group ID.
      const targetGroup = outcome.assignedGroupId !== null
        ? groupByNumericId.get(outcome.assignedGroupId)
        : undefined;
      if (targetGroup) {
        targetGroup.members.push(annotated);
        targetGroup.member_ids.push(item.run_item_id);
        continue;
      }
      // Invalid group_id → fall through to unassigned.
      unassignedItems.push(annotated);
      continue;
    }

    // confirm_unassigned (or any unrecognised disposition)
    unassignedItems.push(annotated);
  }

  // ── Final invariant: every input item appears in exactly one output bucket ─
  const allGroups = [...workingGroups, ...newSingletons];
  const assignedIds = new Set<number>(
    allGroups.flatMap((g) => g.member_ids),
  );
  const unassignedIds = new Set<number>(unassignedItems.map((it) => it.run_item_id));

  for (const item of remainingUnassigned) {
    const inGroups     = assignedIds.has(item.run_item_id);
    const inUnassigned = unassignedIds.has(item.run_item_id);
    if (!inGroups && !inUnassigned) {
      throw new Error(
        `[phase4] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `is missing from both allGroups and unassignedItems.`,
      );
    }
    if (inGroups && inUnassigned) {
      throw new Error(
        `[phase4] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `appears in both allGroups and unassignedItems.`,
      );
    }
  }

  return { allGroups, unassignedItems };
}
