/**
 * Phase 0 — Full deterministic pairscore matrix for all unassigned items.
 *
 * Pure deterministic computation — no LLM calls, no database calls.
 * All data is expected to be in memory on input.
 *
 * Exports:
 *   getPairKey             — canonical bidirectional pair key
 *   computePairscoreMatrix — main entry point; returns pairscoreMatrix + itemMetadataMap
 *
 * The pairscoreMatrix is read-only after this function returns. No phase may
 * modify scores once Phase 0 completes.
 */

import { computePairScore, type RunItemForPairing } from './pairscore';
import {
  buildItemMetadata,
  type GroupingRunItem,
  type ItemMetadata,
  type GroupingConcept,
} from './grouping-utils';

// ---------------------------------------------------------------------------
// Types — pairscore matrix entry
// ---------------------------------------------------------------------------

export interface PairscoreEntry {
  /**
   * ID of item A — the item whose raw_value sorts first alphabetically.
   * Always item_a.raw_value <= item_b.raw_value.
   */
  run_item_id_a: number;
  run_item_id_b: number;

  // ── Top-level score ───────────────────────────────────────────────────────
  /** Clamped to [0, 1]. Formula: 0.51×Mpair + 0.20×TSpair + 0.12×SSpair + 0.17×ACpair. */
  combined: number;

  // ── Component scores ─────────────────────────────────────────────────────
  Mpair:  number;
  TSpair: number;
  SSpair: number;
  ACpair: number;

  // ── Exact match sub-components ───────────────────────────────────────────
  exact_clean_val:      boolean;
  exact_normalized_val: boolean;
  exact_std_token_sig:  boolean;
  exact_norm_token_sig: boolean;

  // ── Token similarity sub-components ──────────────────────────────────────
  /** Weighted OC for standard tokens (importance × LF applied). */
  overlap_coeff_std:        number;
  /** Weighted OC for normalized tokens (importance × LF applied). */
  overlap_coeff_norm:       number;
  /** Tokens from item_a.tokens that are also present in item_b.tokens (case-folded). */
  intersecting_tokens_std:  string[];
  /** Tokens from item_a.normalized_tokens also in item_b.normalized_tokens. */
  intersecting_tokens_norm: string[];
  /** Weighted LCS score for standard tokens. */
  lcs_std:  number;
  /** Weighted LCS score for normalized tokens. */
  lcs_norm: number;

  // ── String similarity sub-components ─────────────────────────────────────
  /** Jaro-Winkler on normalized values × avg LF. */
  jaro_winkler: number;
  /** Normalised Levenshtein on sorted normalized token sigs × avg LF. */
  levenshtein:  number;

  // ── Acronym sub-components ────────────────────────────────────────────────
  /** First-letter initials of item_a's standard tokens (e.g. ["verizon","wireless"] → "vw"). */
  acronym_initials:            string;
  /** First-letter initials of item_a's normalized tokens. */
  acronym_normalized_initials: string;
  /** True if a deterministic exact acronym match fired in either direction. */
  acronym_exact:   boolean;
  /** Best partial acronym score (0 if < 0.75; see pairscore.ts). */
  acronym_partial: number;
  /** True if item_a.raw_value has no lowercase letters. */
  is_all_caps_a: boolean;
  /** True if item_b.raw_value has no lowercase letters. */
  is_all_caps_b: boolean;
  /** True if ACpair > 0. */
  acronym_fired: boolean;

  // ── Subset flags ──────────────────────────────────────────────────────────
  /** True if every std token in item_a appears in item_b's std tokens. */
  subset_a_in_b: boolean;
  /** True if every std token in item_b appears in item_a's std tokens. */
  subset_b_in_a: boolean;
}

export type PairscoreMatrix = ReadonlyMap<string, PairscoreEntry>;
export type ItemMetadataMap = ReadonlyMap<number, ItemMetadata>;

export interface Phase0Result {
  /** Read-only pairscore matrix keyed by canonical pair key. */
  readonly pairscoreMatrix: PairscoreMatrix;
  /** One ItemMetadata per unassigned item, keyed by run_item_id. */
  readonly itemMetadataMap: ItemMetadataMap;
}

// ---------------------------------------------------------------------------
// Canonical pair key
// ---------------------------------------------------------------------------

/**
 * Build a canonical key for a pair of items. Order-independent — returns the
 * same key for (a, b) and (b, a).
 *
 * The separator "|||" is chosen to be unlikely to appear in real literal values.
 */
export function getPairKey(itemA: GroupingRunItem, itemB: GroupingRunItem): string {
  const [first, second] = [itemA.raw_value, itemB.raw_value].sort();
  return `${first}|||${second}`;
}

/**
 * Build the same canonical key from raw_values directly (for lookups where
 * the full GroupingRunItem is not available).
 */
export function getPairKeyByValue(rawValueA: string, rawValueB: string): string {
  const [first, second] = [rawValueA, rawValueB].sort();
  return `${first}|||${second}`;
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, no external deps)
// ---------------------------------------------------------------------------

const caseFold    = (s: string): string => String(s ?? '').toLocaleLowerCase();
const caseFoldAll = (ts: string[]): string[] => ts.map(caseFold);

/** Tokens in tokensA that also appear in tokensB (case-insensitive). Preserves A ordering. */
function intersectingTokens(tokensA: string[], tokensB: string[]): string[] {
  const setB = new Set(caseFoldAll(tokensB));
  return tokensA.filter((t) => setB.has(caseFold(t)));
}

/** True if every token in subset appears in superset (case-insensitive). Empty subset → false. */
function isSubsetOf(subset: string[], superset: string[]): boolean {
  if (subset.length === 0) return false;
  const sup = new Set(caseFoldAll(superset));
  return subset.every((t) => sup.has(caseFold(t)));
}

/** First-letter initials of a token list, lowercased and joined. */
function acronymInitials(tokens: string[]): string {
  return tokens
    .map((t) => String(t ?? '').trim())
    .filter((t) => t.length > 0)
    .map((t) => t[0].toLowerCase())
    .join('');
}

/** True if rawValue has no lowercase alphabetic characters. */
const isAllCaps = (rawValue: string): boolean => !/[a-z]/.test(rawValue);

/** Clamp n to [0, 1] to catch any floating-point drift. */
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// ---------------------------------------------------------------------------
// GroupingRunItem → RunItemForPairing adapter
// ---------------------------------------------------------------------------

function toRunItemForPairing(item: GroupingRunItem): RunItemForPairing {
  return {
    run_item_id:         item.run_item_id,
    literal_value:       item.raw_value,
    cleaned_value:       item.clean_value,
    normalization_value: item.normalized_value,
    std_tokens:          item.tokens,
    norm_tokens:         item.normalized_tokens,
  };
}

// ---------------------------------------------------------------------------
// Phase 0 — main export
// ---------------------------------------------------------------------------

/**
 * Compute the full deterministic pairscore matrix for all unassigned items.
 *
 * Steps:
 *   1. Call buildItemMetadata for every item; store in itemMetadataMap.
 *   2. Iterate all unique pairs — n×(n−1)/2 total; none skipped.
 *   3. For each pair, call computePairScore (existing implementation) and
 *      derive extra sub-components (intersecting tokens, subset flags,
 *      acronym initials, all-caps flags) not stored in PairScoreDetails.
 *   4. Store each entry in pairscoreMatrix under getPairKey(a, b).
 *   5. Return { pairscoreMatrix, itemMetadataMap }.
 *
 * The returned pairscoreMatrix is read-only. No subsequent phase may mutate it.
 *
 * @param unassignedItems  Items that failed Step 1 confident assignment.
 *                         token_rarities / token_char_weights / token_importances
 *                         must be pre-populated (using the unassigned-item pool
 *                         as the IDF corpus) before calling this function.
 * @param concept          Carried through for use by subsequent phases;
 *                         not consumed by Phase 0 itself.
 */
export function computePairscoreMatrix(
  unassignedItems: GroupingRunItem[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _concept: GroupingConcept,
): Phase0Result {
  // ── Step 1: build item metadata ────────────────────────────────────────
  const itemMetadataMap = new Map<number, ItemMetadata>();
  for (const item of unassignedItems) {
    itemMetadataMap.set(item.run_item_id, buildItemMetadata(item));
  }

  // ── Steps 2-4: compute all unique pairs ────────────────────────────────
  const pairscoreMatrix = new Map<string, PairscoreEntry>();

  for (let i = 0; i < unassignedItems.length; i++) {
    for (let j = i + 1; j < unassignedItems.length; j++) {
      const rawI = unassignedItems[i];
      const rawJ = unassignedItems[j];

      // Canonical ordering: itemA has the alphabetically smaller raw_value.
      const [itemA, itemB] = rawI.raw_value <= rawJ.raw_value
        ? [rawI, rawJ]
        : [rawJ, rawI];

      const scorableA = toRunItemForPairing(itemA);
      const scorableB = toRunItemForPairing(itemB);

      const result = computePairScore(scorableA, scorableB);
      const d = result.details;

      // Extra sub-components not stored in PairScoreDetails.
      const intStd  = intersectingTokens(itemA.tokens,             itemB.tokens);
      const intNorm = intersectingTokens(itemA.normalized_tokens,  itemB.normalized_tokens);

      const subsetAInB = isSubsetOf(itemA.tokens, itemB.tokens);
      const subsetBInA = isSubsetOf(itemB.tokens, itemA.tokens);

      // Acronym initials stored from itemA's perspective (canonical ordering).
      const acInitials     = acronymInitials(itemA.tokens);
      const acNormInitials = acronymInitials(itemA.normalized_tokens);

      const entry: PairscoreEntry = {
        run_item_id_a: itemA.run_item_id,
        run_item_id_b: itemB.run_item_id,

        combined: clamp01(result.pair_score),
        Mpair:    clamp01(d.M_pair),
        TSpair:   clamp01(d.TS_pair),
        SSpair:   clamp01(d.SS_pair),
        ACpair:   clamp01(d.AC_pair),

        exact_clean_val:      d.M_clean_val      > 0,
        exact_normalized_val: d.M_normalized_val > 0,
        exact_std_token_sig:  d.M_s_token_sig    > 0,
        exact_norm_token_sig: d.M_n_token_sig    > 0,

        overlap_coeff_std:        clamp01(d.OC_s_token_sig),
        overlap_coeff_norm:       clamp01(d.OC_n_token_sig),
        intersecting_tokens_std:  intStd,
        intersecting_tokens_norm: intNorm,
        lcs_std:                  clamp01(d.LS_s_token_sig),
        lcs_norm:                 clamp01(d.LS_n_token_sig),

        jaro_winkler: clamp01(d.JW_pair),
        levenshtein:  clamp01(d.LV_pair),

        acronym_initials:            acInitials,
        acronym_normalized_initials: acNormInitials,
        acronym_exact:               d.ac_exact   > 0,
        acronym_partial:             d.ac_partial,
        is_all_caps_a:               isAllCaps(itemA.raw_value),
        is_all_caps_b:               isAllCaps(itemB.raw_value),
        acronym_fired:               d.AC_pair    > 0,

        subset_a_in_b: subsetAInB,
        subset_b_in_a: subsetBInA,
      };

      pairscoreMatrix.set(getPairKey(itemA, itemB), entry);
    }
  }

  return { pairscoreMatrix, itemMetadataMap };
}
