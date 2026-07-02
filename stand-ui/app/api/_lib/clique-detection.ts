/**
 * Phase 1 — Clique-based anchor detection
 *
 * Takes the full candidate-pair list from Phase 0 and finds the LARGEST
 * subset of items that simultaneously satisfies both internal cohesion AND
 * external separation.  Each accepted clique becomes a "tentative group"
 * (anchor).  Items that end up in no anchor proceed to Phase 2.
 *
 * A clique S is "valid" if and only if BOTH of the following hold:
 *
 *   Internal cohesion:
 *     |S| >= 3  AND  every pair score in S >= STRONG_EDGE_THRESHOLD, OR
 *     |S| == 2  AND  pair score >= TWO_NODE_THRESHOLD
 *
 *   External separation:
 *     For every outside item x and every member s ∈ S,
 *       PairScore(x, s) < EXTERNAL_SEP_MULTIPLIER × min_internal_score(S)
 *
 * Crucially, external separation is part of the definition of a valid clique,
 * not a post-filter.  A large clique that fails separation is NOT accepted;
 * instead we search its sub-cliques (decreasing size) to find the largest
 * subset that satisfies both constraints simultaneously.
 *
 * Algorithm overview
 * ──────────────────
 * 1. Build strong-pair graph: edges = pairs with PairScore >= STRONG_EDGE_THRESHOLD.
 *
 * 2. Enumerate all maximal cliques via Bron-Kerbosch (finds the structural
 *    upper bounds — each valid anchor must be a sub-clique of one of these).
 *
 * 3. For each maximal clique M, enumerate all sub-cliques of M with size ≥ 2
 *    (from |M| down to 2).  Check each against BOTH cohesion and separation.
 *    Collect every distinct valid sub-clique found across all maximal cliques.
 *
 * 4. Sort valid cliques: size DESC, then avg internal score DESC.
 *
 * 5. Greedy overlap resolution: walk the sorted list; skip any clique that
 *    shares a member with an already-accepted group.
 *
 * 6. Emit accepted cliques as TentativeGroup records.  Remaining items are
 *    unanchored.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single pair entry from Phase 0. run_item_id_a < run_item_id_b always. */
export interface ScoredPair {
  run_item_id_a: number;
  run_item_id_b: number;
  pair_score: number;
}

/** One accepted anchor cluster produced by Phase 1. */
export interface TentativeGroup {
  /** Stable temp identifier within this run's grouping session. */
  temp_group_id: string;
  /** Sorted list of run_item_ids belonging to this group. */
  member_ids: number[];
  /** All internal pair scores for this clique (for diagnostics). */
  internal_scores: ScoredPair[];
  /** Mean of all internal pair scores. */
  avg_internal_score: number;
  /** Minimum of all internal pair scores (used for external separation check). */
  min_internal_score: number;
}

export interface Phase1Result {
  tentative_groups: TentativeGroup[];
  /** run_item_ids that were not placed in any anchor. Proceed to Phase 2. */
  unanchored_ids: number[];
  /** Total items considered (anchored + unanchored). */
  total_items: number;
  /** Diagnostic: total maximal cliques found before validation. */
  raw_clique_count: number;
  /** Diagnostic: cliques that passed both cohesion + separation checks. */
  valid_clique_count: number;
}

// ---------------------------------------------------------------------------
// Phase 2 public types
// ---------------------------------------------------------------------------

/**
 * Mutable working state for a group during Phase 2 absorption passes.
 * `anchor_member_ids` is frozen (the original Phase 1 clique members).
 * `absorbed_member_ids` grows as items are absorbed in each pass.
 */
export interface Phase2Group {
  temp_group_id: string;
  /** Original Phase 1 clique members (never changes). */
  anchor_member_ids: number[];
  /** Members absorbed during Phase 2 (grows across passes). */
  absorbed_member_ids: number[];
  /** Convenience: combined sorted list of all current members. */
  member_ids: number[];
  /** Original Phase 1 internal pair scores (unchanged). */
  internal_scores: ScoredPair[];
  avg_internal_score: number;
  min_internal_score: number;
}

/** Per-pass diagnostic record. */
export interface Phase2PassDiagnostic {
  pass_number: number;
  unassigned_at_start: number;
  /** Items that qualified for exactly one group and were absorbed. */
  assigned: number;
  /** Items that qualified for two or more groups (stayed unassigned). */
  ambiguous: number;
  /** Items that qualified for no group (stayed unassigned). */
  no_match: number;
  unassigned_at_end: number;
}

export interface Phase2Result {
  /** Updated groups: Phase 1 anchors + all absorbed members. */
  groups: Phase2Group[];
  /** Items that remain unassigned after all passes. */
  still_unassigned_ids: number[];
  /** Per-pass diagnostics. */
  passes: Phase2PassDiagnostic[];
  /** Number of passes actually executed (may be < max_passes if converged). */
  passes_run: number;
}

// ---------------------------------------------------------------------------
// Phase 3 public types
// ---------------------------------------------------------------------------

/** A group as it exists after Phase 3 merging.  Extends Phase2Group with
 *  merge-lineage tracking: every group that was absorbed into this one. */
export interface Phase3Group {
  temp_group_id: string;
  member_ids: number[];
  /** Original Phase 1 clique members from all constituent groups. */
  anchor_member_ids: number[];
  /** Phase 2 absorbed members from all constituent groups. */
  absorbed_member_ids: number[];
  /**
   * temp_group_ids of every Phase-2 group that was merged INTO this group
   * (recursively includes their own merge sources).  Empty when this group
   * was never a merge target.
   */
  merged_from_group_ids: string[];
  /** Phase 1 internal scores (unchanged by merging). */
  internal_scores: ScoredPair[];
  avg_internal_score: number;
  min_internal_score: number;
}

/** One merge event recorded during Phase 3. */
export interface Phase3Merge {
  winner_group_id: string;
  loser_group_id: string;
  cross_pair_max: number;
  cross_pair_min: number;
}

export interface Phase3Result {
  groups: Phase3Group[];
  /** Items still unassigned (unchanged from Phase 2 — carried forward). */
  still_unassigned_ids: number[];
  /** Log of every merge that occurred, in the order they were applied. */
  merges: Phase3Merge[];
  /** Number of full scans required before convergence. */
  passes_run: number;
}

// ---------------------------------------------------------------------------
// Phase 4 public types
// ---------------------------------------------------------------------------

/** Final group representation after Phase 4. */
export interface FinalGroup {
  temp_group_id: string;
  member_ids: number[];
  /** true when this group contains exactly one item (a former singleton). */
  is_singleton: boolean;
  /** LLM-proposed canonical (real-world) name for the group, if any. */
  proposed_name?: string | null;
  anchor_member_ids: number[];
  absorbed_member_ids: number[];
  merged_from_group_ids: string[];
  avg_internal_score: number;
  min_internal_score: number;
}

/**
 * Why a Phase 3 survivor was left unassigned rather than promoted to a singleton.
 *
 *   multi_group_eligible — attracted to ≥ 2 clusters (Condition A)
 *   chaining_suspect     — very strong tie to a member but the group is
 *                          heterogeneous (max ≥ 0.22, min < 0.12) (Condition B)
 *   near_miss            — just under the absorption threshold for one group
 *                          (0.15 ≤ max < 0.18, min ≥ 0.10) (Condition C)
 *   strong_tie_unassigned_peer — no group pull (all max_G < 0.15) but PairScore
 *                          ≥ 0.18 to another still-unassigned item (Condition D)
 */
export type Phase4UnassignedReason =
  | 'multi_group_eligible'
  | 'chaining_suspect'
  | 'near_miss'
  | 'strong_tie_unassigned_peer';

export interface Phase4UnassignedItem {
  run_item_id: number;
  reason: Phase4UnassignedReason;
}

export interface Phase4Result {
  groups: FinalGroup[];
  /**
   * Items intentionally left unassigned for human review (conditions A–D).
   * These are NOT committed to the DB — they remain group_id = NULL.
   */
  still_unassigned: Phase4UnassignedItem[];
  multi_member_count: number;
  singleton_count: number;
  still_unassigned_count: number;
  total_groups: number;
  /**
   * Grouping confidence score per item, keyed by run_item_id.
   * Items in still_unassigned always score 0.
   * Computed by computeGroupingConfidenceScores at the end of runPhase4.
   */
  confidence_scores: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Thresholds (tunable)
// ---------------------------------------------------------------------------

const STRONG_EDGE_THRESHOLD = 0.12;    // minimum PairScore to draw an edge; |S|>=3 cohesion
const TWO_NODE_THRESHOLD    = 0.15;    // stricter minimum for size-2 cliques
const EXTERNAL_SEP_MULTIPLIER = 0.5;   // outside ties must be < this × min_internal

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** O(1) pair-score lookup. Key is always `${minId}::${maxId}`. */
export function buildPairMap(pairs: ScoredPair[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of pairs) {
    map.set(`${p.run_item_id_a}::${p.run_item_id_b}`, p.pair_score);
  }
  return map;
}

function getPairScore(map: Map<string, number>, a: number, b: number): number {
  const key = a < b ? `${a}::${b}` : `${b}::${a}`;
  return map.get(key) ?? 0;
}

/** Adjacency sets for edges where PairScore >= threshold. */
function buildAdjacency(
  allIds: number[],
  pairs: ScoredPair[],
  threshold: number
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const id of allIds) adj.set(id, new Set<number>());
  for (const p of pairs) {
    if (p.pair_score >= threshold) {
      adj.get(p.run_item_id_a)!.add(p.run_item_id_b);
      adj.get(p.run_item_id_b)!.add(p.run_item_id_a);
    }
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Bron-Kerbosch with pivoting
// ---------------------------------------------------------------------------
// Standard recursive implementation.
// R: current clique being grown
// P: candidates that can extend R
// X: nodes already processed (ensure maximality)
// Pivot u chosen from P ∪ X to maximise |neighbours(u) ∩ P|.

export function bronKerbosch(
  R: Set<number>,
  P: Set<number>,
  X: Set<number>,
  adj: Map<number, Set<number>>,
  out: number[][]
): void {
  if (P.size === 0 && X.size === 0) {
    out.push([...R]);
    return;
  }

  // Pivot selection: node in P ∪ X with the most neighbours in P.
  let pivot = -1;
  let pivotScore = -1;
  for (const u of [...P, ...X]) {
    const score = [...(adj.get(u) ?? [])].filter((v) => P.has(v)).length;
    if (score > pivotScore) {
      pivotScore = score;
      pivot = u;
    }
  }

  const pivotNeighbours = adj.get(pivot) ?? new Set<number>();
  // Iterate over P \ neighbours(pivot) — a copy since we mutate P.
  const candidates = [...P].filter((v) => !pivotNeighbours.has(v));

  for (const v of candidates) {
    const vNeigh = adj.get(v) ?? new Set<number>();
    bronKerbosch(
      new Set([...R, v]),
      new Set([...P].filter((u) => vNeigh.has(u))),
      new Set([...X].filter((u) => vNeigh.has(u))),
      adj,
      out
    );
    P.delete(v);
    X.add(v);
  }
}

// ---------------------------------------------------------------------------
// Clique validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  minInternal: number;
  avgInternal: number;
}

function validateAnchor(
  clique: number[],
  allIds: number[],
  pairMap: Map<string, number>
): ValidationResult {
  if (clique.length < 2) return { valid: false, minInternal: 0, avgInternal: 0 };

  // ── 3a. Internal cohesion ─────────────────────────────────────────────────
  let minInternal = Infinity;
  let sumInternal = 0;
  let pairCount = 0;

  for (let i = 0; i < clique.length; i++) {
    for (let j = i + 1; j < clique.length; j++) {
      const score = getPairScore(pairMap, clique[i], clique[j]);
      if (score < minInternal) minInternal = score;
      sumInternal += score;
      pairCount++;
    }
  }
  const avgInternal = pairCount > 0 ? sumInternal / pairCount : 0;

  if (clique.length === 2) {
    if (minInternal < TWO_NODE_THRESHOLD) return { valid: false, minInternal, avgInternal };
  } else {
    // |S| >= 3 — every internal pair must be >= STRONG_EDGE_THRESHOLD.
    // (Bron-Kerbosch only produces cliques over the strong-edge graph so
    // internal edges already meet STRONG_EDGE_THRESHOLD; this check is kept
    // explicit for clarity and safety.)
    if (minInternal < STRONG_EDGE_THRESHOLD) return { valid: false, minInternal, avgInternal };
  }

  // ── 3b. External separation ───────────────────────────────────────────────
  // TEMPORARILY DISABLED — commented out to test grouping without this constraint.
  // const memberSet = new Set(clique);
  // const externalThreshold = EXTERNAL_SEP_MULTIPLIER * minInternal;
  //
  // for (const x of allIds) {
  //   if (memberSet.has(x)) continue;
  //   for (const s of clique) {
  //     if (getPairScore(pairMap, x, s) >= externalThreshold) {
  //       return { valid: false, minInternal, avgInternal };
  //     }
  //   }
  // }

  return { valid: true, minInternal, avgInternal };
}

// ---------------------------------------------------------------------------
// Sub-clique enumeration helper
// ---------------------------------------------------------------------------

/**
 * Returns all size-k subsets of arr.
 * Used to enumerate sub-cliques of a failing maximal clique so we can find
 * the largest subset that satisfies both cohesion AND external separation.
 * Practical clique sizes are small (≤ ~15), so 2^k is acceptable.
 */
function combinations(arr: number[], k: number): number[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  if (k === arr.length) return [[...arr]];
  const [head, ...tail] = arr;
  return [
    ...combinations(tail, k - 1).map((c) => [head, ...c]),
    ...combinations(tail, k),
  ];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 1 on the given set of unassigned items and their pairscores.
 *
 * @param allIds   All unassigned run_item_ids for this run.
 * @param pairs    Full candidate-pair list from Phase 0 (all pairs, any score).
 */
export function runPhase1(allIds: number[], pairs: ScoredPair[]): Phase1Result {
  if (allIds.length === 0) {
    return {
      tentative_groups: [],
      unanchored_ids: [],
      total_items: 0,
      raw_clique_count: 0,
      valid_clique_count: 0,
    };
  }

  const pairMap = buildPairMap(pairs);
  const adj = buildAdjacency(allIds, pairs, STRONG_EDGE_THRESHOLD);

  // ── Step 2: Find all maximal cliques in the strong-edge graph ────────────
  const rawCliques: number[][] = [];
  bronKerbosch(new Set<number>(), new Set<number>(allIds), new Set<number>(), adj, rawCliques);

  // ── Step 3: Find all valid sub-cliques (cohesion AND separation) ─────────
  //
  // A clique is only valid when BOTH constraints hold simultaneously.
  // If a maximal clique fails external separation, its smaller sub-cliques may
  // still pass — so we enumerate all subsets of each maximal clique (largest
  // first) and accept every distinct one that satisfies both constraints.
  //
  // seenKeys deduplicates: the same subset can appear as a sub-clique of
  // multiple maximal cliques.

  type Validated = {
    members: number[];
    minInternal: number;
    avgInternal: number;
  };

  const seenKeys = new Set<string>();
  const validCliques: Validated[] = [];

  for (const maxClique of rawCliques) {
    // Iterate from the full clique size down to 2.
    for (let size = maxClique.length; size >= 2; size--) {
      const subsets = size === maxClique.length ? [maxClique] : combinations(maxClique, size);
      for (const subset of subsets) {
        const key = [...subset].sort((a, b) => a - b).join(',');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const result = validateAnchor(subset, allIds, pairMap);
        if (result.valid) {
          validCliques.push({
            members: subset,
            minInternal: result.minInternal,
            avgInternal: result.avgInternal,
          });
        }
      }
    }
  }

  // ── Step 4: Sort — largest first, then tightest ───────────────────────────
  // Primary sort: size DESC; secondary: avgInternal DESC.
  validCliques.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return b.avgInternal - a.avgInternal;
  });

  // ── Step 5: Greedy overlap resolution (largest valid clique wins) ────────
  const assigned = new Set<number>();
  const tentativeGroups: TentativeGroup[] = [];
  let groupIdx = 1;

  for (const clique of validCliques) {
    // Skip if any member was already claimed by an earlier (higher-priority) group.
    if (clique.members.some((id) => assigned.has(id))) continue;

    for (const id of clique.members) assigned.add(id);

    // Build internal pair list for the accepted clique.
    const internalScores: ScoredPair[] = [];
    for (let i = 0; i < clique.members.length; i++) {
      for (let j = i + 1; j < clique.members.length; j++) {
        const a = clique.members[i];
        const b = clique.members[j];
        const [lo, hi] = a < b ? [a, b] : [b, a];
        internalScores.push({
          run_item_id_a: lo,
          run_item_id_b: hi,
          pair_score: getPairScore(pairMap, a, b),
        });
      }
    }

    tentativeGroups.push({
      temp_group_id: `anchor_${groupIdx++}`,
      member_ids: [...clique.members].sort((a, b) => a - b),
      internal_scores: internalScores,
      avg_internal_score: Number(clique.avgInternal.toFixed(6)),
      min_internal_score: Number(clique.minInternal.toFixed(6)),
    });
  }

  // ── Step 6: Collect unanchored items ─────────────────────────────────────
  const unanchored_ids = allIds.filter((id) => !assigned.has(id)).sort((a, b) => a - b);

  return {
    tentative_groups: tentativeGroups,
    unanchored_ids,
    total_items: allIds.length,
    raw_clique_count: rawCliques.length,
    valid_clique_count: validCliques.length,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Absorb remaining items
// ---------------------------------------------------------------------------
//
// Dual-threshold absorption gate for each (item x, group G) pair:
//   scores   = [PairScore(x, m) for m in G.current_members]
//   eligible = max(scores) >= MAX_SCORE_THRESHOLD AND min(scores) >= MIN_SCORE_THRESHOLD
//
// Assignment:
//   exactly 1 eligible group → absorb x
//   0 eligible groups        → leave unassigned
//   ≥ 2 eligible groups      → leave unassigned (ambiguous)
//
// Each pass is ORDER-INDEPENDENT: all eligibilities are computed against a
// snapshot of group membership taken at the start of the pass, then all
// single-eligible assignments are committed atomically.  Repeat up to
// MAX_PASSES times (stopping early if no item was assigned in a pass).

const ABS_MAX_THRESHOLD = 0.18;  // at least one strong link to the group
const ABS_MIN_THRESHOLD = 0.12;  // no weak links to any member
const MAX_PASSES        = 3;

/**
 * Run Phase 2 absorption on the groups and unanchored items produced by Phase 1.
 *
 * `pairMap` must be the same pair-score map built during Phase 0 / Phase 1,
 * covering every (a, b) pair in the original unassigned-item pool.
 */
export function runPhase2(phase1: Phase1Result, pairMap: Map<string, number>): Phase2Result {
  // ── Initialise mutable group state ─────────────────────────────────────────
  const groups: Phase2Group[] = phase1.tentative_groups.map((g) => ({
    temp_group_id:        g.temp_group_id,
    anchor_member_ids:    [...g.member_ids],
    absorbed_member_ids:  [],
    member_ids:           [...g.member_ids],
    internal_scores:      g.internal_scores,
    avg_internal_score:   g.avg_internal_score,
    min_internal_score:   g.min_internal_score,
  }));

  let unassigned = new Set<number>(phase1.unanchored_ids);
  const passes: Phase2PassDiagnostic[] = [];
  let passesRun = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (unassigned.size === 0) break;
    passesRun = pass;

    const unassignedAtStart = unassigned.size;

    // ── Snapshot: freeze current membership for this pass ──────────────────
    // Each group's member list at snapshot time.
    const snapshot: Map<string, number[]> = new Map(
      groups.map((g) => [g.temp_group_id, [...g.member_ids]])
    );

    // ── Score all unassigned items against the snapshot ────────────────────
    // eligibilityMap: item_id → list of eligible group ids
    const eligibilityMap = new Map<number, string[]>();
    let ambiguousCount = 0;
    let noMatchCount   = 0;

    for (const x of unassigned) {
      const eligibleGroupIds: string[] = [];

      for (const g of groups) {
        const members = snapshot.get(g.temp_group_id)!;
        if (members.length === 0) continue;

        let maxScore = -Infinity;
        let minScore =  Infinity;
        for (const m of members) {
          const s = getPairScore(pairMap, x, m);
          if (s > maxScore) maxScore = s;
          if (s < minScore) minScore = s;
        }

        if (maxScore >= ABS_MAX_THRESHOLD && minScore >= ABS_MIN_THRESHOLD) {
          eligibleGroupIds.push(g.temp_group_id);
        }
      }

      eligibilityMap.set(x, eligibleGroupIds);

      if (eligibleGroupIds.length === 0) noMatchCount++;
      else if (eligibleGroupIds.length >= 2) ambiguousCount++;
    }

    // ── Commit all unambiguous assignments atomically ──────────────────────
    // Build index for fast group lookup.
    const groupById = new Map<string, Phase2Group>(groups.map((g) => [g.temp_group_id, g]));
    let assignedCount = 0;

    for (const [x, eligible] of eligibilityMap) {
      if (eligible.length !== 1) continue;

      const g = groupById.get(eligible[0])!;
      g.absorbed_member_ids.push(x);
      g.member_ids = [...g.anchor_member_ids, ...g.absorbed_member_ids].sort((a, b) => a - b);
      unassigned.delete(x);
      assignedCount++;
    }

    passes.push({
      pass_number:        pass,
      unassigned_at_start: unassignedAtStart,
      assigned:           assignedCount,
      ambiguous:          ambiguousCount,
      no_match:           noMatchCount,
      unassigned_at_end:  unassigned.size,
    });

    // Early termination: no progress made this pass.
    if (assignedCount === 0) break;
  }

  return {
    groups,
    still_unassigned_ids: [...unassigned].sort((a, b) => a - b),
    passes,
    passes_run: passesRun,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — Group merging
// ---------------------------------------------------------------------------
//
// Two groups G1, G2 are eligible to merge when:
//   cross_pairs = [PairScore(a, b) for a in G1.members, b in G2.members]
//   max(cross_pairs) >= MERGE_MAX_THRESHOLD AND min(cross_pairs) >= MERGE_MIN_THRESHOLD
//
// Same dual-threshold logic as Phase 2: at least one decisive bridge
// (max >= 0.18) AND no weak cross-edges (min >= 0.12).
//
// Identity rule: the LARGER group keeps its temp_group_id.  Size ties are
// broken by lower temp_group_id (lexicographic order).
//
// Implementation: eager scan — find the first eligible pair, merge, then
// restart the scan.  Repeat until a full scan finds no eligible pair.
// This guarantees convergence and handles chain-merge opportunities naturally.

const MERGE_MAX_THRESHOLD = 0.18;
const MERGE_MIN_THRESHOLD = 0.12;

/** Determine (winner, loser) for a merge.  Winner keeps its identity. */
function mergeWinner(
  g1: Phase3Group,
  g2: Phase3Group
): [winner: Phase3Group, loser: Phase3Group] {
  if (g1.member_ids.length > g2.member_ids.length) return [g1, g2];
  if (g2.member_ids.length > g1.member_ids.length) return [g2, g1];
  // Tie → lower temp_group_id wins.
  return g1.temp_group_id <= g2.temp_group_id ? [g1, g2] : [g2, g1];
}

/**
 * Run Phase 3 on the groups + unassigned set produced by Phase 2.
 *
 * `pairMap` must cover every (a, b) pair in the original unassigned-item pool.
 */
export function runPhase3(phase2: Phase2Result, pairMap: Map<string, number>): Phase3Result {
  // Lift Phase2Groups into mutable Phase3Groups.
  const groups: Phase3Group[] = phase2.groups.map((g) => ({
    temp_group_id:         g.temp_group_id,
    member_ids:            [...g.member_ids],
    anchor_member_ids:     [...g.anchor_member_ids],
    absorbed_member_ids:   [...g.absorbed_member_ids],
    merged_from_group_ids: [],
    internal_scores:       g.internal_scores,
    avg_internal_score:    g.avg_internal_score,
    min_internal_score:    g.min_internal_score,
  }));

  const merges: Phase3Merge[] = [];
  let passesRun = 0;

  // Outer loop: repeat until a full scan finds no eligible pair.
  outerLoop: while (true) {
    passesRun++;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const G1 = groups[i];
        const G2 = groups[j];

        // Compute all cross-pair scores between G1 and G2 members.
        let maxCross = -Infinity;
        let minCross =  Infinity;
        for (const a of G1.member_ids) {
          for (const b of G2.member_ids) {
            const s = getPairScore(pairMap, a, b);
            if (s > maxCross) maxCross = s;
            if (s < minCross) minCross = s;
          }
        }

        if (maxCross >= MERGE_MAX_THRESHOLD && minCross >= MERGE_MIN_THRESHOLD) {
          const [winner, loser] = mergeWinner(G1, G2);

          merges.push({
            winner_group_id: winner.temp_group_id,
            loser_group_id:  loser.temp_group_id,
            cross_pair_max:  Number(maxCross.toFixed(6)),
            cross_pair_min:  Number(minCross.toFixed(6)),
          });

          // Absorb loser into winner: union member sets, propagate lineage.
          const combined = new Set([...winner.member_ids, ...loser.member_ids]);
          winner.member_ids = [...combined].sort((a, b) => a - b);

          const combinedAnchor = new Set([...winner.anchor_member_ids, ...loser.anchor_member_ids]);
          winner.anchor_member_ids = [...combinedAnchor].sort((a, b) => a - b);

          const combinedAbsorbed = new Set([...winner.absorbed_member_ids, ...loser.absorbed_member_ids]);
          winner.absorbed_member_ids = [...combinedAbsorbed].sort((a, b) => a - b);

          // Lineage: record the loser's own ID + everything it had already merged.
          winner.merged_from_group_ids = [
            ...winner.merged_from_group_ids,
            loser.temp_group_id,
            ...loser.merged_from_group_ids,
          ];

          // Remove the loser from the working list.
          groups.splice(groups.indexOf(loser), 1);

          // Restart the full scan — the merged group may now be eligible to
          // merge with yet another group.
          continue outerLoop;
        }
      }
    }
    // Completed a full scan with no eligible pair → converged.
    break;
  }

  return {
    groups,
    still_unassigned_ids: [...phase2.still_unassigned_ids],
    merges,
    passes_run: passesRun,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — Singleton promotion with human-review holdouts
// ---------------------------------------------------------------------------
//
// For each item still unassigned after Phase 3, evaluate it against every
// tentative group and route it into one of four outcomes:
//
//   Condition A — Multi-group eligibility (attracted to ≥ 2 clusters):
//     eligible_groups ≥ 2  →  leave unassigned (human decides)
//
//   Condition B — Chaining suspect (very strong tie, heterogeneous group):
//     eligible_groups ≤ 1  AND  ∃ G where max_G ≥ 0.22 AND min_G < 0.12
//     →  leave unassigned (human should inspect)
//
//   Condition C — Borderline near-miss (just under absorption threshold):
//     eligible_groups == 0  AND  ∃ G where 0.15 ≤ max_G < 0.18 AND min_G ≥ 0.10
//     →  leave unassigned (human should confirm or override)
//
//   Condition D — Strong tie to another unassigned item:
//     All groups G have max_G < 0.15
//     AND ∃ still-unassigned y (y ≠ x) with PairScore(x, y) ≥ 0.18
//     →  leave unassigned (human decides if peers form a new alias)
//
//   Otherwise:
//     singleton (true candidate new alias when D does not apply)
//
// Tunable constants:
const P4_ABSORB_MAX_THRESHOLD    = 0.18;   // eligibility gate: decisive-link floor
const P4_ABSORB_MIN_THRESHOLD    = 0.12;   // eligibility gate: weak-link ceiling
const P4_STRONG_LINK_FLOOR       = 0.22;   // Condition B: very-strong-tie floor
const P4_NEAR_MISS_MAX_LOWER     = 0.15;   // Condition C: borderline max lower bound
const P4_NEAR_MISS_MIN_THRESHOLD = 0.10;   // Condition C: min score floor
/** Condition D: every group must have max_G below this (no meaningful cluster pull). */
const P4_CONDITION_D_ALL_MAX_LT   = 0.15;
/** Condition D: item-to-item tie to another Phase 3 unassigned survivor. */
const P4_CONDITION_D_PEER_SCORE   = 0.18;

// ---------------------------------------------------------------------------
// Grouping confidence scoring
// ---------------------------------------------------------------------------

/**
 * Compute a grouping confidence score for every item that was assigned to a
 * group, plus a score of 0 for every item left unassigned.
 *
 * Scores are keyed by run_item_id.  All values are clamped to [0, 1].
 *
 * Formula (for multi-member groups):
 *   internal_strength   = max pair_score vs any other group member
 *   ratio               = internal_strength / max(best_outside_score, 0.01)
 *   ratio_normalized    = min(ratio, 5) / 5
 *   score               = 0.6 * internal_strength + 0.4 * ratio_normalized
 *
 * Singleton groups:
 *   score = 1 − max(best_outside_score, 0)   clamped to [0, 1]
 *
 * LLM-placed items (llmPhaseByItemId value is "phase2"|"phase3"|"phase4a"|"phase4b"):
 *   score = min(score, 0.75)
 *
 * Items in stillUnassigned:
 *   score = 0
 *
 * @param allGroups          Final groups from Phase 4.
 * @param stillUnassigned    Items not placed in any group.
 * @param pairMap            Pair-score lookup map from buildPairMap.
 * @param llmPhaseByItemId   Optional map of item_id → grouping_llm_phase string.
 *                           Omit (or pass an empty Map) when no LLM phases were used.
 */
export function computeGroupingConfidenceScores(
  allGroups: FinalGroup[],
  stillUnassigned: Array<{ run_item_id: number }>,
  pairMap: Map<string, number>,
  llmPhaseByItemId: Map<number, string> = new Map(),
): Map<number, number> {
  const LLM_SCORE_CAP = 0.75;
  const LLM_PHASES    = new Set(['phase2', 'phase3', 'phase4a', 'phase4b']);

  const scores = new Map<number, number>();

  for (const group of allGroups) {
    const memberSet = new Set(group.member_ids);
    const isSingleton = group.member_ids.length === 1;

    for (const itemId of group.member_ids) {
      // 1. Group scores — every peer within the same group.
      const groupScores: number[] = [];
      for (const otherId of group.member_ids) {
        if (otherId === itemId) continue;
        groupScores.push(getPairScore(pairMap, itemId, otherId));
      }

      // 2. Best outside score — highest score vs any item NOT in this group.
      let bestOutside = 0;
      for (const otherGroup of allGroups) {
        if (otherGroup.temp_group_id === group.temp_group_id) continue;
        for (const otherId of otherGroup.member_ids) {
          const s = getPairScore(pairMap, itemId, otherId);
          if (s > bestOutside) bestOutside = s;
        }
      }
      for (const u of stillUnassigned) {
        const s = getPairScore(pairMap, itemId, u.run_item_id);
        if (s > bestOutside) bestOutside = s;
      }

      let score: number;

      if (isSingleton) {
        // Singleton: confidence falls as outside pull rises.
        score = 1 - Math.max(bestOutside, 0);
      } else {
        // 3. Internal strength.
        const internalStrength = Math.max(...groupScores);

        // 4. Ratio normalised.
        const ratio = internalStrength / Math.max(bestOutside, 0.01);
        const ratioNorm = Math.min(ratio, 5) / 5;

        // 5. Weighted combination.
        score = 0.6 * internalStrength + 0.4 * ratioNorm;
      }

      // LLM-placed items are capped.
      const llmPhase = llmPhaseByItemId.get(itemId);
      if (llmPhase !== undefined && LLM_PHASES.has(llmPhase)) {
        score = Math.min(score, LLM_SCORE_CAP);
      }

      scores.set(itemId, Math.min(1, Math.max(0, score)));
    }
  }

  // Items left unassigned always score 0.
  for (const u of stillUnassigned) {
    scores.set(u.run_item_id, 0);
  }

  return scores;
}

/**
 * Run Phase 4 on the groups + unassigned items produced by Phase 3.
 *
 * Items that clearly belong nowhere become singletons; items where the
 * algorithm is uncertain (conditions A–D) are left in `still_unassigned`
 * for human review and are NOT written to the DB.
 *
 * @param pairMap  The full pair-score map from Phase 0/1 (needed to score
 *                 each unassigned item against every tentative group).
 */
export function runPhase4(phase3: Phase3Result, pairMap: Map<string, number>): Phase4Result {
  const groups: FinalGroup[] = phase3.groups.map((g) => ({
    temp_group_id:         g.temp_group_id,
    member_ids:            g.member_ids,
    is_singleton:          false,
    anchor_member_ids:     g.anchor_member_ids,
    absorbed_member_ids:   g.absorbed_member_ids,
    merged_from_group_ids: g.merged_from_group_ids,
    avg_internal_score:    g.avg_internal_score,
    min_internal_score:    g.min_internal_score,
  }));

  const stillUnassigned: Phase4UnassignedItem[] = [];
  let singletonIdx = 1;

  for (const id of phase3.still_unassigned_ids) {
    let eligibleGroupCount = 0;
    let hasConditionB      = false;
    let hasConditionC      = false;
    /** Condition D premise: max_G < P4_CONDITION_D_ALL_MAX_LT for every tentative group. */
    let allGroupsMaxBelowD = true;

    for (const g of phase3.groups) {
      let maxScore = -Infinity;
      let minScore =  Infinity;
      for (const m of g.member_ids) {
        const s = getPairScore(pairMap, id, m);
        if (s > maxScore) maxScore = s;
        if (s < minScore) minScore = s;
      }

      if (maxScore >= P4_CONDITION_D_ALL_MAX_LT) {
        allGroupsMaxBelowD = false;
      }

      // Eligibility gate (same dual-threshold as Phase 2).
      if (maxScore >= P4_ABSORB_MAX_THRESHOLD && minScore >= P4_ABSORB_MIN_THRESHOLD) {
        eligibleGroupCount++;
      }

      // Condition B signal: decisive tie to at least one member, but the group
      // is heterogeneous enough that the min link is below the cohesion floor.
      if (maxScore >= P4_STRONG_LINK_FLOOR && minScore < P4_ABSORB_MIN_THRESHOLD) {
        hasConditionB = true;
      }

      // Condition C signal: just under the absorption max threshold, but with
      // a decent minimum (not a random noise match).
      if (
        maxScore >= P4_NEAR_MISS_MAX_LOWER &&
        maxScore <  P4_ABSORB_MAX_THRESHOLD &&
        minScore >= P4_NEAR_MISS_MIN_THRESHOLD
      ) {
        hasConditionC = true;
      }
    }

    // ── Condition A: attracted to multiple clusters ───────────────────────
    if (eligibleGroupCount >= 2) {
      stillUnassigned.push({ run_item_id: id, reason: 'multi_group_eligible' });
      continue;
    }

    // ── Condition B: chaining suspect ────────────────────────────────────
    if (hasConditionB) {
      stillUnassigned.push({ run_item_id: id, reason: 'chaining_suspect' });
      continue;
    }

    // ── Condition C: borderline near-miss ────────────────────────────────
    if (eligibleGroupCount === 0 && hasConditionC) {
      stillUnassigned.push({ run_item_id: id, reason: 'near_miss' });
      continue;
    }

    // ── Condition D: strong tie to another unassigned item (no cluster home) ─
    if (allGroupsMaxBelowD) {
      const hasStrongUnassignedPeer = phase3.still_unassigned_ids.some(
        (y) =>
          y !== id &&
          getPairScore(pairMap, id, y) >= P4_CONDITION_D_PEER_SCORE
      );
      if (hasStrongUnassignedPeer) {
        stillUnassigned.push({ run_item_id: id, reason: 'strong_tie_unassigned_peer' });
        continue;
      }
    }

    // ── Otherwise: true singleton (no group pull, no strong unassigned peer) ─
    groups.push({
      temp_group_id:         `singleton_${singletonIdx++}`,
      member_ids:            [id],
      is_singleton:          true,
      anchor_member_ids:     [],
      absorbed_member_ids:   [],
      merged_from_group_ids: [],
      avg_internal_score:    0,
      min_internal_score:    0,
    });
  }

  const singletonCount   = singletonIdx - 1;
  const multiMemberCount = phase3.groups.length;

  // Compute grouping confidence scores for all placed items (and 0 for
  // still-unassigned items) before returning.  No LLM-phase info is available
  // in this deterministic pipeline, so the LLM cap never fires here.
  const confidence_scores = computeGroupingConfidenceScores(
    groups,
    stillUnassigned,
    pairMap,
  );

  return {
    groups,
    still_unassigned:       stillUnassigned,
    multi_member_count:     multiMemberCount,
    singleton_count:        singletonCount,
    still_unassigned_count: stillUnassigned.length,
    total_groups:           groups.length,
    confidence_scores,
  };
}

// ---------------------------------------------------------------------------
// Phase 6 — Post-grouping validation
// ---------------------------------------------------------------------------
//
// Audits the Phase 4 output against five structural invariants and logs every
// violation to the server terminal via console.warn.  All checks are purely
// in-memory; no DB interaction is required.
//
// ┌─────┬────────────────────────────────────────────────────────────────────┐
// │  #  │ Invariant                                                          │
// ├─────┼────────────────────────────────────────────────────────────────────┤
// │  1  │ Cohesion floor: every pair inside a group scores ≥ 0.12           │
// │  2  │ Decisive link: every member has ≥ 1 peer with score ≥ 0.18        │
// │  3  │ External separation: no outside item ties to any member at         │
// │     │   score ≥ 0.5 × group's min_internal_score                        │
// │  4  │ Group separation: no two distinct groups are merge-eligible        │
// │     │   (max_cross ≥ 0.18 AND min_cross ≥ 0.12)                        │
// │  5  │ Missed absorption: no singleton is uniquely eligible for exactly  │
// │     │   one multi-member group (Phase 2 should have absorbed it)        │
// └─────┴────────────────────────────────────────────────────────────────────┘

export type Phase6CheckName =
  | 'cohesion_floor'
  | 'decisive_link'
  | 'external_separation'
  | 'group_separation'
  | 'missed_absorption';

export interface Phase6Violation {
  /** Which invariant failed. */
  check: Phase6CheckName;
  /** Temp group ID of the primary group involved. */
  group_id: string;
  /** Item ID at the centre of the violation (if applicable). */
  item_id?: number;
  /** Second group ID for group_separation violations. */
  other_group_id?: string;
  /** Human-readable explanation printed to the terminal. */
  description: string;
  /** The score that triggered the violation (for numeric checks). */
  score?: number;
}

export interface Phase6Result {
  /** True only when zero violations were found. */
  passed: boolean;
  violation_count: number;
  violations: Phase6Violation[];
  check_summary: {
    cohesion_floor_violations: number;
    decisive_link_violations: number;
    external_separation_violations: number;
    group_separation_violations: number;
    missed_absorption_violations: number;
  };
}

/**
 * Run Phase 6 validation against the Phase 4 output.
 *
 * All violations are printed to `console.warn` so they appear in the
 * Next.js server terminal immediately.  The full structured result is
 * also returned so the calling API route can include it in its JSON
 * response for inspection in the browser / client.
 *
 * @param phase4  The complete output of `runPhase4`.
 * @param pairMap The pair-score lookup map built by `buildPairMap`.
 */
export function runPhase6(phase4: Phase4Result, pairMap: Map<string, number>): Phase6Result {
  const violations: Phase6Violation[] = [];

  const multiGroups = phase4.groups.filter((g) => !g.is_singleton);
  const singletons  = phase4.groups.filter((g) =>  g.is_singleton);

  // Set of every item ID across all groups AND still_unassigned items — used
  // for external separation so we also flag outside pull from held-back items.
  const allItemIds = new Set([
    ...phase4.groups.flatMap((g) => g.member_ids),
    ...phase4.still_unassigned.map((u) => u.run_item_id),
  ]);

  // ── Check 1: Cohesion floor ─────────────────────────────────────────────
  // Every pair within a multi-member group must score ≥ 0.12.
  for (const group of multiGroups) {
    for (let i = 0; i < group.member_ids.length; i++) {
      for (let j = i + 1; j < group.member_ids.length; j++) {
        const a = group.member_ids[i];
        const b = group.member_ids[j];
        const score = getPairScore(pairMap, a, b);
        if (score < 0.12) {
          violations.push({
            check:       'cohesion_floor',
            group_id:    group.temp_group_id,
            item_id:     a,
            description: `[cohesion_floor] Group ${group.temp_group_id}: items ${a} ↔ ${b} score ${score.toFixed(4)} < 0.12`,
            score,
          });
        }
      }
    }
  }

  // ── Check 2: Decisive link ──────────────────────────────────────────────
  // Every member must have PairScore ≥ 0.18 with at least one peer.
  for (const group of multiGroups) {
    for (const m of group.member_ids) {
      const hasLink = group.member_ids.some(
        (other) => other !== m && getPairScore(pairMap, m, other) >= 0.18
      );
      if (!hasLink) {
        violations.push({
          check:       'decisive_link',
          group_id:    group.temp_group_id,
          item_id:     m,
          description: `[decisive_link] Group ${group.temp_group_id}: item ${m} has no peer with PairScore ≥ 0.18`,
        });
      }
    }
  }

  // ── Check 3: External separation ───────────────────────────────────────
  // For each non-singleton group, recompute min_internal_score live (groups
  // may have grown via Phase 3 merging without updating the stored field).
  // Then verify no outside item ties to any member at ≥ 0.5 × that minimum.
  for (const group of multiGroups) {
    let minInternal = Infinity;
    for (let i = 0; i < group.member_ids.length; i++) {
      for (let j = i + 1; j < group.member_ids.length; j++) {
        const s = getPairScore(pairMap, group.member_ids[i], group.member_ids[j]);
        if (s < minInternal) minInternal = s;
      }
    }
    if (!isFinite(minInternal)) continue;

    const sepThreshold = 0.5 * minInternal;
    const memberSet    = new Set(group.member_ids);

    for (const outsideId of allItemIds) {
      if (memberSet.has(outsideId)) continue;

      for (const memberId of group.member_ids) {
        const score = getPairScore(pairMap, outsideId, memberId);
        if (score >= sepThreshold) {
          violations.push({
            check:          'external_separation',
            group_id:       group.temp_group_id,
            item_id:        outsideId,
            description:    `[external_separation] Group ${group.temp_group_id}: outside item ${outsideId} scores ${score.toFixed(4)} with member ${memberId} ≥ sep threshold ${sepThreshold.toFixed(4)} (0.5 × min_internal ${minInternal.toFixed(4)})`,
            score,
          });
          break; // one violation per (outside item, group) pair is sufficient
        }
      }
    }
  }

  // ── Check 4: Group separation ───────────────────────────────────────────
  // No two distinct groups should satisfy the Phase 3 merge condition —
  // if they do, Phase 3 failed to merge them.
  for (let i = 0; i < multiGroups.length; i++) {
    for (let j = i + 1; j < multiGroups.length; j++) {
      const G1 = multiGroups[i];
      const G2 = multiGroups[j];

      let maxCross = -Infinity;
      let minCross =  Infinity;
      for (const a of G1.member_ids) {
        for (const b of G2.member_ids) {
          const s = getPairScore(pairMap, a, b);
          if (s > maxCross) maxCross = s;
          if (s < minCross) minCross = s;
        }
      }

      if (maxCross >= 0.18 && minCross >= 0.12) {
        violations.push({
          check:          'group_separation',
          group_id:       G1.temp_group_id,
          other_group_id: G2.temp_group_id,
          description:    `[group_separation] Groups ${G1.temp_group_id} and ${G2.temp_group_id} are merge-eligible (max_cross=${maxCross.toFixed(4)}, min_cross=${minCross.toFixed(4)}) — Phase 3 should have merged them`,
          score:          maxCross,
        });
      }
    }
  }

  // ── Check 5: Missed absorption ──────────────────────────────────────────
  // A singleton item x is incorrectly unabsorbed if it is eligible for
  // exactly one multi-member group (max ≥ 0.18 AND min ≥ 0.12 across all
  // members of that group).  Eligibility for 0 or ≥2 groups is fine.
  // Note: under the new Phase 4 logic, true singletons should have max < 0.15
  // for every group, so this check should rarely fire.  Items that were
  // held back by conditions A–D are not singletons and are not checked here.
  for (const singleton of singletons) {
    const x = singleton.member_ids[0];
    const eligibleGroupIds: string[] = [];

    for (const group of multiGroups) {
      const scores    = group.member_ids.map((m) => getPairScore(pairMap, x, m));
      const maxScore  = Math.max(...scores);
      const minScore  = Math.min(...scores);
      if (maxScore >= 0.18 && minScore >= 0.12) {
        eligibleGroupIds.push(group.temp_group_id);
      }
    }

    if (eligibleGroupIds.length === 1) {
      violations.push({
        check:       'missed_absorption',
        group_id:    eligibleGroupIds[0],
        item_id:     x,
        description: `[missed_absorption] Singleton item ${x} is uniquely eligible for group ${eligibleGroupIds[0]} (max ≥ 0.18, min ≥ 0.12) — Phase 2 should have absorbed it`,
      });
    }
    // 0 eligible groups  → correct singleton
    // 2+ eligible groups → correct singleton (ambiguous, Phase 2 abstains)
  }

  // ── Emit to server terminal ─────────────────────────────────────────────
  const tag = '[Phase 6]';
  if (violations.length === 0) {
    console.log(`${tag} ✓ All checks passed — grouping output is internally consistent.`);
  } else {
    console.warn(`${tag} ⚠  ${violations.length} violation(s) found:`);
    for (const v of violations) {
      console.warn(`  ${v.description}`);
    }
  }

  return {
    passed:          violations.length === 0,
    violation_count: violations.length,
    violations,
    check_summary: {
      cohesion_floor_violations:       violations.filter((v) => v.check === 'cohesion_floor').length,
      decisive_link_violations:        violations.filter((v) => v.check === 'decisive_link').length,
      external_separation_violations:  violations.filter((v) => v.check === 'external_separation').length,
      group_separation_violations:     violations.filter((v) => v.check === 'group_separation').length,
      missed_absorption_violations:    violations.filter((v) => v.check === 'missed_absorption').length,
    },
  };
}
