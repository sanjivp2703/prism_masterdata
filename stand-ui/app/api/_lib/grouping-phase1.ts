/**
 * Phase 1 (LLM-enhanced) — Clique-based anchor detection.
 *
 * Phase 1a — build strong-pair graph (combined >= STRONG_EDGE_THRESHOLD = 0.18)
 * Phase 1b — LLM edge recovery: sub-threshold pairs with recovery triggers
 * Phase 1c — Bron-Kerbosch on combined graph (deterministic + LLM-promoted edges)
 * Phase 1d — LLM clique validation: auto-approve / auto-reject / LLM / split
 *
 * Bron-Kerbosch is imported from clique-detection.ts (not rewritten here).
 * All LLM calls go through callGroupingLLM / runLLMCalls from grouping-llm.ts.
 * Nothing is persisted to the database in this phase.
 */

import { bronKerbosch } from './clique-detection';
import { callGroupingLLM, runLLMCalls } from './grouping-llm';
import { type GroupingRunItem, type ItemMetadata } from './grouping-utils';
import {
  type PairscoreMatrix,
  type PairscoreEntry,
  type ItemMetadataMap,
} from './grouping-phase0';

// ---------------------------------------------------------------------------
// Thresholds (tunable)
// ---------------------------------------------------------------------------

/** Phase 1a: minimum combined score to draw a deterministic edge. */
const STRONG_EDGE_THRESHOLD = 0.18;

/** Phase 1d cohesion: pairs in a 3+-member clique must be >= this OR llm_promoted. */
const COHESION_MIN_3PLUS = 0.18;

/** Phase 1d cohesion: a 2-member clique pair must be >= this OR llm_promoted. */
const COHESION_MIN_2 = 0.25;

/** Phase 1d auto-approve: every pair in clique must be >= this (ignoring promoted). */
const AUTO_APPROVE_THRESHOLD = 0.30;

/** Phase 1d auto-reject: any non-promoted pair below this rejects the whole clique. */
const AUTO_REJECT_THRESHOLD = 0.08;

/** Phase 1d external-separation: outsider score threshold to appear in payload. */
const OUTSIDER_SCORE_MIN = 0.10;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Matches the return type of buildGroupingSystemPrompt. */
type SystemBlock = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

/** Recovery trigger classification for a sub-threshold pair. */
type RecoveryTrigger =
  | 'acronym_fired'
  | 'pure_acronym_item'
  | 'empty_normalized_signature'
  | 'length_asymmetry';

interface RecoveryCandidate {
  pairEntry: PairscoreEntry;
  metaA: ItemMetadata;
  metaB: ItemMetadata;
  trigger: RecoveryTrigger;
}

interface CandidateClique {
  members: number[];
  avgInternal: number;
  minInternal: number;
  hasPromotedEdge: boolean;
}

type ValidationOutcome =
  | { action: 'accept'; clique: CandidateClique }
  | { action: 'reject' }
  | { action: 'split'; subcliques: number[][] };

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export interface LLMPhase1AnchorGroup {
  temp_group_id: string;
  member_ids: number[];
  /** Full item objects for each member. */
  members: GroupingRunItem[];
  /** True if any internal edge was LLM-promoted (edge recovery). */
  llm_promoted_edges: boolean;
  avg_internal_score: number;
  min_internal_score: number;
  /** All internal pairs with their scores and llm_promoted flag. */
  internal_pairs: Array<{
    run_item_id_a: number;
    run_item_id_b: number;
    combined_score: number;
    llm_promoted: boolean;
  }>;
}

export interface Phase1LLMResult {
  anchorGroups: LLMPhase1AnchorGroup[];
  remainingUnassigned: GroupingRunItem[];
  /**
   * The next available negative-integer temp group ID after all Phase 1 anchor
   * groups have been assigned IDs. Pass this to Phase 4 (via the orchestrator)
   * so singleton groups created there do not collide with Phase 1 IDs.
   */
  nextTempId: number;
  diagnostics: {
    edge_recovery_candidates: number;
    edges_promoted: number;
    raw_clique_count: number;
    auto_approved: number;
    auto_rejected: number;
    llm_validated: number;
    llm_confirmed: number;
    llm_rejected: number;
    llm_split: number;
    anchor_count: number;
    anchored_item_count: number;
    remaining_unassigned_count: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical edge key for O(1) lookup: `${minId}::${maxId}`. */
function ek(a: number, b: number): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Build a secondary Map keyed by `minId::maxId` from the pairscoreMatrix.
 * Phase 0 stores all n*(n-1)/2 pairs, so this map covers every possible pair.
 */
function buildIdPairMap(pairscoreMatrix: PairscoreMatrix): Map<string, PairscoreEntry> {
  const m = new Map<string, PairscoreEntry>();
  for (const entry of pairscoreMatrix.values()) {
    m.set(ek(entry.run_item_id_a, entry.run_item_id_b), entry);
  }
  return m;
}

function getPairEntry(
  idPairMap: Map<string, PairscoreEntry>,
  a: number,
  b: number,
): PairscoreEntry | undefined {
  return idPairMap.get(ek(a, b));
}

/**
 * Classify the first-matching recovery trigger for a sub-threshold pair.
 * Returns null if no trigger applies.
 */
function classifyRecoveryTrigger(
  pairEntry: PairscoreEntry,
  metaA: ItemMetadata,
  metaB: ItemMetadata,
): RecoveryTrigger | null {
  if (pairEntry.acronym_fired) return 'acronym_fired';
  if (metaA.flags.is_pure_acronym || metaB.flags.is_pure_acronym) return 'pure_acronym_item';
  if (metaA.flags.normalized_signature_is_empty || metaB.flags.normalized_signature_is_empty) {
    return 'empty_normalized_signature';
  }
  const lenA = metaA.standard_token_signature.length;
  const lenB = metaB.standard_token_signature.length;
  if ((lenA <= 1 && lenB >= 3) || (lenB <= 1 && lenA >= 3)) return 'length_asymmetry';
  return null;
}

/**
 * Check whether a clique passes the deterministic cohesion test.
 * LLM-promoted edges always pass. Deterministic pairs must meet
 * size-dependent thresholds.
 */
function passesCohesion(
  sortedIds: number[],
  idPairMap: Map<string, PairscoreEntry>,
  promotedEdgeKeys: Set<string>,
): boolean {
  if (sortedIds.length < 2) return false;
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      const a = sortedIds[i];
      const b = sortedIds[j];
      if (promotedEdgeKeys.has(ek(a, b))) continue;
      const combined = getPairEntry(idPairMap, a, b)?.combined ?? 0;
      const threshold = sortedIds.length >= 3 ? COHESION_MIN_3PLUS : COHESION_MIN_2;
      if (combined < threshold) return false;
    }
  }
  return true;
}

/** Compute avgInternal, minInternal, and hasPromotedEdge for a clique. */
function internalStats(
  sortedIds: number[],
  idPairMap: Map<string, PairscoreEntry>,
  promotedEdgeKeys: Set<string>,
): { avgInternal: number; minInternal: number; hasPromotedEdge: boolean } {
  let sum = 0;
  let min = Infinity;
  let count = 0;
  let hasPromoted = false;
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      const a = sortedIds[i];
      const b = sortedIds[j];
      const combined = getPairEntry(idPairMap, a, b)?.combined ?? 0;
      if (promotedEdgeKeys.has(ek(a, b))) hasPromoted = true;
      sum += combined;
      if (combined < min) min = combined;
      count++;
    }
  }
  return {
    avgInternal:     count > 0 ? sum / count : 0,
    minInternal:     min === Infinity ? 0 : min,
    hasPromotedEdge: hasPromoted,
  };
}

// ---------------------------------------------------------------------------
// Phase 1a — Build strong-pair adjacency
// ---------------------------------------------------------------------------

function buildStrongAdjacency(
  allIds: number[],
  idPairMap: Map<string, PairscoreEntry>,
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const id of allIds) adj.set(id, new Set<number>());
  for (const entry of idPairMap.values()) {
    if (entry.combined >= STRONG_EDGE_THRESHOLD) {
      adj.get(entry.run_item_id_a)?.add(entry.run_item_id_b);
      adj.get(entry.run_item_id_b)?.add(entry.run_item_id_a);
    }
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Phase 1b — Feature payload builder
// ---------------------------------------------------------------------------

function buildEdgeRecoveryPayload(
  pairEntry: PairscoreEntry,
  metaA: ItemMetadata,
  metaB: ItemMetadata,
  trigger: RecoveryTrigger,
): Record<string, unknown> {
  return {
    phase: 'edge_recovery',
    item_a: metaA as unknown as Record<string, unknown>,
    item_b: metaB as unknown as Record<string, unknown>,
    deterministic_score: pairEntry.combined,
    recovery_trigger: trigger,
    components: {
      exact_match:       pairEntry.Mpair,
      token_similarity:  pairEntry.TSpair,
      string_similarity: pairEntry.SSpair,
      acronym:           pairEntry.ACpair,
    },
    sub_features: {
      intersecting_tokens_normalized: pairEntry.intersecting_tokens_norm,
      overlap_coefficient_normalized: pairEntry.overlap_coeff_norm,
      jaro_winkler:                   pairEntry.jaro_winkler,
      acronym_fired:                  pairEntry.acronym_fired,
      acronym_initials:               pairEntry.acronym_initials,
      acronym_normalized_initials:    pairEntry.acronym_normalized_initials,
      acronym_exact:                  pairEntry.acronym_exact,
      acronym_partial:                pairEntry.acronym_partial,
      subset_a_in_b:                  pairEntry.subset_a_in_b,
      subset_b_in_a:                  pairEntry.subset_b_in_a,
      is_pure_acronym_a:              metaA.flags.is_pure_acronym,
      is_pure_acronym_b:              metaB.flags.is_pure_acronym,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 1d — Feature payload builder
// ---------------------------------------------------------------------------

function buildCliqueValidationPayload(
  sortedIds: number[],
  itemMetadataMap: ItemMetadataMap,
  idPairMap: Map<string, PairscoreEntry>,
  promotedEdgeKeys: Set<string>,
  allUnassignedItems: GroupingRunItem[],
): Record<string, unknown> {
  const memberSet = new Set(sortedIds);

  const clique_items = sortedIds.map((id) => itemMetadataMap.get(id) as unknown as Record<string, unknown>);

  const pairwise_scores: Record<string, unknown>[] = [];
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      const a = sortedIds[i];
      const b = sortedIds[j];
      const entry = getPairEntry(idPairMap, a, b);
      if (!entry) continue;
      const isPromoted = promotedEdgeKeys.has(ek(a, b));
      pairwise_scores.push({
        item_a_literal: (itemMetadataMap.get(a) as ItemMetadata).literal_value,
        item_b_literal: (itemMetadataMap.get(b) as ItemMetadata).literal_value,
        combined_score: entry.combined,
        llm_promoted:   isPromoted,
        components: {
          exact_match:       entry.Mpair,
          token_similarity:  entry.TSpair,
          string_similarity: entry.SSpair,
          acronym:           entry.ACpair,
        },
        sub_features: {
          intersecting_tokens_normalized: entry.intersecting_tokens_norm,
          overlap_coefficient_normalized: entry.overlap_coeff_norm,
          jaro_winkler:   entry.jaro_winkler,
          acronym_fired:  entry.acronym_fired,
          acronym_initials: entry.acronym_initials,
          subset_a_in_b:  entry.subset_a_in_b,
          subset_b_in_a:  entry.subset_b_in_a,
        },
      });
    }
  }

  const threatening_outsiders: Record<string, unknown>[] = [];
  for (const outsider of allUnassignedItems) {
    if (memberSet.has(outsider.run_item_id)) continue;
    const scoresVsClique: Array<{ clique_member_literal: string; combined_score: number }> = [];
    let maxScore = 0;
    for (const memberId of sortedIds) {
      const entry = getPairEntry(idPairMap, outsider.run_item_id, memberId);
      if (!entry || entry.combined < OUTSIDER_SCORE_MIN) continue;
      scoresVsClique.push({
        clique_member_literal: (itemMetadataMap.get(memberId) as ItemMetadata).literal_value,
        combined_score: entry.combined,
      });
      if (entry.combined > maxScore) maxScore = entry.combined;
    }
    if (scoresVsClique.length > 0) {
      threatening_outsiders.push({
        outsider_literal:          outsider.raw_value,
        outsider_metadata:         itemMetadataMap.get(outsider.run_item_id) as unknown as Record<string, unknown>,
        scores_against_clique:     scoresVsClique,
        max_score_against_clique:  maxScore,
      });
    }
  }

  return {
    phase: 'clique_validation',
    clique_items,
    pairwise_scores,
    external_separation: { threatening_outsiders },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full LLM-enhanced Phase 1 pipeline (1a → 1b → 1c → 1d).
 *
 * @param unassignedItems  Items that failed Step 1 confident assignment.
 * @param pairscoreMatrix  Full pairscore matrix from Phase 0 (read-only).
 * @param itemMetadataMap  Per-item metadata from Phase 0 (read-only).
 * @param systemPrompt     Cached system block from buildGroupingSystemPrompt.
 */
export async function runPhase1(
  unassignedItems: GroupingRunItem[],
  pairscoreMatrix: PairscoreMatrix,
  itemMetadataMap: ItemMetadataMap,
  systemPrompt: SystemBlock[],
): Promise<Phase1LLMResult> {
  if (unassignedItems.length === 0) {
    return {
      anchorGroups: [],
      remainingUnassigned: [],
      nextTempId: -1,
      diagnostics: {
        edge_recovery_candidates: 0, edges_promoted: 0,
        raw_clique_count: 0, auto_approved: 0, auto_rejected: 0,
        llm_validated: 0, llm_confirmed: 0, llm_rejected: 0, llm_split: 0,
        anchor_count: 0, anchored_item_count: 0, remaining_unassigned_count: 0,
      },
    };
  }

  const allIds = unassignedItems.map((it) => it.run_item_id);
  const itemById = new Map<number, GroupingRunItem>(
    unassignedItems.map((it) => [it.run_item_id, it]),
  );
  const idByLiteral = new Map<string, number>(
    unassignedItems.map((it) => [it.raw_value, it.run_item_id]),
  );

  const idPairMap = buildIdPairMap(pairscoreMatrix);

  // ── Phase 1a: deterministic strong-pair graph ───────────────────────────
  const adj = buildStrongAdjacency(allIds, idPairMap);

  // ── Phase 1b: LLM edge recovery ─────────────────────────────────────────
  // Collect all sub-threshold pairs that have a recovery trigger.
  // Pairs with any recovery trigger are always sent to the LLM — the
  // combined score alone cannot determine whether world knowledge would
  // draw an edge (e.g. "ATT" vs "American Telephone and Telegraph").
  const recoveryCandidates: RecoveryCandidate[] = [];
  for (const entry of idPairMap.values()) {
    if (entry.combined >= STRONG_EDGE_THRESHOLD) continue; // already has deterministic edge
    const metaA = itemMetadataMap.get(entry.run_item_id_a);
    const metaB = itemMetadataMap.get(entry.run_item_id_b);
    if (!metaA || !metaB) continue;
    const trigger = classifyRecoveryTrigger(entry, metaA, metaB);
    if (!trigger) continue;
    recoveryCandidates.push({ pairEntry: entry, metaA, metaB, trigger });
  }

  const promotedEdgeKeys = new Set<string>();

  // Run all edge-recovery calls in parallel before BK runs.
  const recoveryResults = await runLLMCalls(
    recoveryCandidates.map((candidate) => async () => {
      const payload = buildEdgeRecoveryPayload(
        candidate.pairEntry,
        candidate.metaA,
        candidate.metaB,
        candidate.trigger,
      );
      try {
        const raw = await callGroupingLLM(systemPrompt, payload);
        return {
          candidate,
          drawEdge: Boolean(raw.draw_edge),
          reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
          flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
        };
      } catch (err) {
        console.error(
          `[phase1b] Edge recovery failed for items ` +
          `${candidate.pairEntry.run_item_id_a}↔${candidate.pairEntry.run_item_id_b}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return { candidate, drawEdge: false, reasoning: '', flags: [] };
      }
    }),
  );

  // Promote qualifying edges and add to the combined adjacency.
  for (const result of recoveryResults) {
    if (!result.drawEdge) continue;
    const { run_item_id_a, run_item_id_b } = result.candidate.pairEntry;
    const key = ek(run_item_id_a, run_item_id_b);
    promotedEdgeKeys.add(key);
    // adj was seeded with all IDs in Phase 1a, so .get() is always defined.
    adj.get(run_item_id_a)!.add(run_item_id_b);
    adj.get(run_item_id_b)!.add(run_item_id_a);
  }

  const edgesPromoted = promotedEdgeKeys.size;

  // ── Phase 1c: Bron-Kerbosch on combined graph ────────────────────────────
  // BK is imported from clique-detection.ts (not rewritten here).
  const rawCliques: number[][] = [];
  bronKerbosch(
    new Set<number>(),
    new Set<number>(allIds),
    new Set<number>(),
    adj,
    rawCliques,
  );

  // ── Phase 1d: clique validation ─────────────────────────────────────────
  const autoApproved: CandidateClique[] = [];
  const toValidate:   CandidateClique[] = [];
  let autoRejected = 0;

  const seenKeys = new Set<string>();

  for (const raw of rawCliques) {
    if (raw.length < 2) continue;
    const sorted = [...raw].sort((a, b) => a - b);
    const key    = sorted.join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Auto-reject: any non-promoted pair below AUTO_REJECT_THRESHOLD.
    let reject = false;
    for (let i = 0; i < sorted.length && !reject; i++) {
      for (let j = i + 1; j < sorted.length && !reject; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (promotedEdgeKeys.has(ek(a, b))) continue;
        if ((getPairEntry(idPairMap, a, b)?.combined ?? 0) < AUTO_REJECT_THRESHOLD) {
          reject = true;
        }
      }
    }
    if (reject) { autoRejected++; continue; }

    // Deterministic cohesion check (size-dependent thresholds).
    if (!passesCohesion(sorted, idPairMap, promotedEdgeKeys)) {
      autoRejected++;
      continue;
    }

    const stats = internalStats(sorted, idPairMap, promotedEdgeKeys);
    const candidate: CandidateClique = {
      members:         sorted,
      avgInternal:     stats.avgInternal,
      minInternal:     stats.minInternal,
      hasPromotedEdge: stats.hasPromotedEdge,
    };

    // Auto-approve: every non-promoted pair >= AUTO_APPROVE_THRESHOLD.
    let allStrong = true;
    outer: for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (promotedEdgeKeys.has(ek(a, b))) continue;
        if ((getPairEntry(idPairMap, a, b)?.combined ?? 0) < AUTO_APPROVE_THRESHOLD) {
          allStrong = false;
          break outer;
        }
      }
    }

    if (allStrong) {
      autoApproved.push(candidate);
    } else {
      toValidate.push(candidate);
    }
  }

  // Run all clique-validation LLM calls in parallel.
  const validationResults = await runLLMCalls(
    toValidate.map((clique) => async (): Promise<ValidationOutcome> => {
      const payload = buildCliqueValidationPayload(
        clique.members,
        itemMetadataMap,
        idPairMap,
        promotedEdgeKeys,
        unassignedItems,
      );
      try {
        const raw = await callGroupingLLM(systemPrompt, payload);
        const validClique  = Boolean(raw.valid_clique);
        const splitRaw     = Array.isArray(raw.split_suggestion) ? raw.split_suggestion : null;

        if (validClique) {
          return { action: 'accept', clique };
        }
        if (splitRaw && splitRaw.length > 0) {
          const subcliques = (splitRaw as unknown[])
            .map((group) =>
              (Array.isArray(group) ? group : [])
                .map((lit: unknown) => idByLiteral.get(String(lit)))
                .filter((id): id is number => id !== undefined),
            )
            .filter((sub) => sub.length >= 2);
          return { action: 'split', subcliques };
        }
        return { action: 'reject' };
      } catch (err) {
        console.error(
          `[phase1d] Clique validation failed for [${clique.members.join(',')}]: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        // On error: reject safely (members return to unassigned pool).
        return { action: 'reject' };
      }
    }),
  );

  // ── Collect all accepted candidates ─────────────────────────────────────
  const allCandidates: CandidateClique[] = [...autoApproved];
  let llmConfirmed = 0;
  let llmRejected  = 0;
  let llmSplit     = 0;

  for (const outcome of validationResults) {
    if (outcome.action === 'accept') {
      llmConfirmed++;
      allCandidates.push(outcome.clique);
    } else if (outcome.action === 'split') {
      llmSplit++;
      // Validate each suggested sub-clique with deterministic cohesion check.
      for (const subIds of outcome.subcliques) {
        const sorted = subIds.sort((a, b) => a - b);
        if (!passesCohesion(sorted, idPairMap, promotedEdgeKeys)) continue;
        const stats = internalStats(sorted, idPairMap, promotedEdgeKeys);
        allCandidates.push({
          members:         sorted,
          avgInternal:     stats.avgInternal,
          minInternal:     stats.minInternal,
          hasPromotedEdge: stats.hasPromotedEdge,
        });
      }
    } else {
      llmRejected++;
    }
  }

  // ── Greedy overlap resolution: size DESC, then avgInternal DESC ──────────
  allCandidates.sort((a, b) =>
    b.members.length !== a.members.length
      ? b.members.length - a.members.length
      : b.avgInternal - a.avgInternal,
  );

  const assigned    = new Set<number>();
  const anchorGroups: LLMPhase1AnchorGroup[] = [];
  // Temp group IDs are negative integers starting at -1 and decrementing.
  // Spec: IDs <= 0 are temp; IDs > 0 are real Snowflake-assigned IDs.
  let nextTempId = -1;

  for (const candidate of allCandidates) {
    if (candidate.members.some((id) => assigned.has(id))) continue;
    for (const id of candidate.members) assigned.add(id);

    const internalPairs = [];
    for (let i = 0; i < candidate.members.length; i++) {
      for (let j = i + 1; j < candidate.members.length; j++) {
        const a = candidate.members[i];
        const b = candidate.members[j];
        internalPairs.push({
          run_item_id_a:  a,
          run_item_id_b:  b,
          combined_score: getPairEntry(idPairMap, a, b)?.combined ?? 0,
          llm_promoted:   promotedEdgeKeys.has(ek(a, b)),
        });
      }
    }

    anchorGroups.push({
      temp_group_id:      String(nextTempId--),  // -1, -2, -3, …
      member_ids:         candidate.members,
      members:            candidate.members.map((id) => itemById.get(id)!).filter(Boolean),
      llm_promoted_edges: candidate.hasPromotedEdge,
      avg_internal_score: Number(candidate.avgInternal.toFixed(6)),
      min_internal_score: Number(candidate.minInternal.toFixed(6)),
      internal_pairs:     internalPairs,
    });
  }

  const remainingUnassigned = unassignedItems.filter(
    (it) => !assigned.has(it.run_item_id),
  );

  // ── Output invariant: every input item in exactly one bucket ─────────────
  const anchoredIds   = new Set<number>(anchorGroups.flatMap((g) => g.member_ids));
  const remainingIds  = new Set<number>(remainingUnassigned.map((it) => it.run_item_id));
  for (const item of unassignedItems) {
    const inAnchored  = anchoredIds.has(item.run_item_id);
    const inRemaining = remainingIds.has(item.run_item_id);
    if (!inAnchored && !inRemaining) {
      throw new Error(
        `[phase1] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `is missing from both anchorGroups and remainingUnassigned.`,
      );
    }
    if (inAnchored && inRemaining) {
      throw new Error(
        `[phase1] invariant violation: item ${item.run_item_id} ('${item.raw_value}') ` +
        `appears in both anchorGroups and remainingUnassigned.`,
      );
    }
  }

  return {
    anchorGroups,
    remainingUnassigned,
    nextTempId,
    diagnostics: {
      edge_recovery_candidates:    recoveryCandidates.length,
      edges_promoted:              edgesPromoted,
      raw_clique_count:            rawCliques.length,
      auto_approved:               autoApproved.length,
      auto_rejected:               autoRejected,
      llm_validated:               toValidate.length,
      llm_confirmed:               llmConfirmed,
      llm_rejected:                llmRejected,
      llm_split:                   llmSplit,
      anchor_count:                anchorGroups.length,
      anchored_item_count:         assigned.size,
      remaining_unassigned_count:  remainingUnassigned.length,
    },
  };
}
