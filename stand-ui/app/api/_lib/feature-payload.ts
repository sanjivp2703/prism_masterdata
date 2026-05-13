/**
 * Builds the structured feature payload sent to the LLM as the user message
 * for each (run_item, candidate_alias) pair.
 *
 * Raw vs weighted:
 *   - Weighted values (with I, I^0.5, LF, C multipliers) are computed in
 *     apply-confident-assignments via computeValueToAliasConfidence and stored
 *     in deterministic_score_baseline. They are never sent to the LLM.
 *   - Raw values (geometric/structural only, multipliers stripped) are what
 *     fill this payload so the LLM can form its own calibrated judgment.
 */

import { type RunItemForPairing, type PairScoreDetails } from './pairscore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of the alias bundle needed to build the payload. */
export interface AliasBundleForPayload {
  alias_id: number;
  alias_name_literal_value: string;
  alias_name_clean_value: string | null;
  alias_name_normalization_value: string | null;
  /** Standard (pre-normalization) tokens of the alias display name. */
  alias_name_tokens: string[];
  /** Normalized tokens of the alias display name. */
  alias_name_normalized_tokens: string[];
  /** 1.0 = same concept, <1.0 = cross-concept. */
  compatibility_weight: number;
  /** Concept key / display name for this alias's concept. */
  concept_key: string;
  items: AliasMemberForPayload[];
}

export interface AliasMemberForPayload {
  alias_item_id: number;
  literal_value: string;
  cleaned_value: string | null;
  normalization_value: string | null;
  std_tokens: string[];
  norm_tokens: string[];
}

export interface BuildFeaturePayloadParams {
  runItem: RunItemForPairing;
  alias: AliasBundleForPayload;
  /** concept_id of the run (used to determine same/cross concept match counts). */
  runConceptId: number;
  /**
   * Rarity of a token within the run's concept.
   * rarity(t) = 1 − (# same-concept aliases containing t / total same-concept aliases).
   * Range [0,1]; higher = more distinctive.
   */
  tokenRarity: (token: string) => number;
  /**
   * PairScoreDetails from computePairScore(runItem, aliasNamePseudo).
   * Provides acronym sub-components for the alias-name leg.
   */
  namePairDetails: PairScoreDetails;
}

// The payload shape mirrors the template in Step 3. All fields are as described
// in the template comments — duplicated here as TypeScript types for safety.
export type FeaturePayload = ReturnType<typeof buildFeaturePayload>;

// ---------------------------------------------------------------------------
// Internal helpers (pure, no external deps)
// ---------------------------------------------------------------------------

const caseFold = (s: string): string => String(s ?? '').toLocaleLowerCase();
const caseFoldAll = (ts: string[]): string[] => ts.map(caseFold);

/** Pipe-joined case-folded token signature. */
const pipeSig = (tokens: string[]): string => caseFoldAll(tokens).join('|');

const isSubsetOf = (subset: string[], superset: string[]): boolean => {
  if (subset.length === 0) return false;
  const sup = new Set(caseFoldAll(superset));
  return subset.every((t) => sup.has(caseFold(t)));
};

/** Position importance weight (position 1-indexed). */
const posImportance = (pos: number): number =>
  0.75 + 0.25 / Math.pow(Math.max(1, pos), 0.4);

/**
 * Character weight for a token.
 * char_weight = min(1, (len / 6)^1.5)
 */
const charWeight = (token: string): number =>
  Math.min(1, Math.pow(token.length / 6, 1.5));

/**
 * Raw overlap coefficient: |intersection| / min(|A|, |B|).
 * I and LF are excluded (pure structural).
 */
function rawOC(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(caseFoldAll(tokensA));
  const setB = new Set(caseFoldAll(tokensB));
  let hits = 0;
  for (const t of setB) if (setA.has(t)) hits++;
  return Number((hits / Math.min(setA.size, setB.size)).toFixed(6));
}

/**
 * Raw LCS length (token count) between two token lists, case-insensitive.
 * Pure structural — no importance accumulation.
 */
function rawLCSLength(tokensA: string[], tokensB: string[]): number {
  const m = tokensA.length;
  const n = tokensB.length;
  if (m === 0 || n === 0) return 0;
  const aFold = caseFoldAll(tokensA);
  const bFold = caseFoldAll(tokensB);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aFold[i - 1] === bFold[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Raw LS score: lcsLen / denominator.
 * I excluded from numerator; length_ratio denominator kept as structural normalization.
 * IS (subset) boost: flat 10% when either token set is a subset of the other.
 */
function rawLS(lenA: number, lenB: number, lcsLen: number, isSubset: boolean): number {
  if (lenA === 0 || lenB === 0 || lcsLen === 0) return 0;
  const minLen = Math.min(lenA, lenB);
  const maxLen = Math.max(lenA, lenB);
  const lengthRatio = minLen / maxLen;
  const denominator = lengthRatio * minLen + (1 - lengthRatio) * maxLen;
  if (denominator === 0) return 0;
  const base = lcsLen / denominator;
  return Number(Math.min(1, base * (isSubset ? 1.1 : 1)).toFixed(6));
}

/** Jaro-Winkler similarity (no LF multiplier). */
function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const matchDist = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
  const lm = new Array<boolean>(left.length).fill(false);
  const rm = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, right.length);
    for (let j = start; j < end; j++) {
      if (rm[j] || left[i] !== right[j]) continue;
      lm[i] = rm[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let trans = 0;
  let ri = 0;
  for (let i = 0; i < left.length; i++) {
    if (!lm[i]) continue;
    while (!rm[ri]) ri++;
    if (left[i] !== right[ri]) trans++;
    ri++;
  }
  trans /= 2;
  const jaro = (matches / left.length + matches / right.length + (matches - trans) / matches) / 3;
  let pfx = 0;
  const maxPfx = Math.min(4, left.length, right.length);
  while (pfx < maxPfx && left[pfx] === right[pfx]) pfx++;
  return Number((jaro + pfx * 0.1 * (1 - jaro)).toFixed(6));
}

/** Normalised Levenshtein (1 − dist/max) — no LF multiplier. */
function levenshtein1minus(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const maxLen = Math.max(m, n);
  if (maxLen === 0) return 1;
  if (m === 0) return 1 - n / maxLen;
  if (n === 0) return 1 - m / maxLen;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return Number((1 - dp[m][n] / maxLen).toFixed(6));
}

/**
 * Lightweight exact-match cascade followed by JW fallback.
 * Returns score in [0,1] and the component that drove it.
 */
function pairscoreLite(
  runItem: RunItemForPairing,
  aliasItem: AliasMemberForPayload,
): { score: number; match_basis: string } {
  const cleanR = caseFold(runItem.cleaned_value ?? '');
  const cleanA = caseFold(aliasItem.cleaned_value ?? '');
  if (cleanR && cleanA && cleanR === cleanA)
    return { score: 1.0, match_basis: 'exact_clean_value' };

  const normR = caseFold(runItem.normalization_value ?? '');
  const normA = caseFold(aliasItem.normalization_value ?? '');
  if (normR && normA && normR === normA)
    return { score: 0.95, match_basis: 'exact_normalized_value' };

  const stdPipR = pipeSig(runItem.std_tokens);
  const stdPipA = pipeSig(aliasItem.std_tokens);
  if (stdPipR && stdPipA && stdPipR === stdPipA)
    return { score: 0.85, match_basis: 'exact_standard_token_signature' };

  const normPipR = pipeSig(runItem.norm_tokens);
  const normPipA = pipeSig(aliasItem.norm_tokens);
  if (normPipR && normPipA && normPipR === normPipA)
    return { score: 0.80, match_basis: 'exact_normalized_token_signature' };

  return {
    score: normR && normA ? jaroWinkler(normR, normA) : 0,
    match_basis: 'string_similarity',
  };
}

/** First letter of each token joined as a lowercase string. */
const acronymFromTokens = (tokens: string[]): string =>
  tokens
    .map((t) => String(t ?? '').trim())
    .filter((t) => t.length > 0)
    .map((t) => t[0].toLowerCase())
    .join('');

const longestCommonPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

const partialAcronymScore = (initials: string, target: string): number => {
  if (!initials || !target) return 0;
  const maxLen = Math.max(initials.length, target.length);
  return maxLen > 0 ? longestCommonPrefixLength(initials, target) / maxLen : 0;
};

// ---------------------------------------------------------------------------
// Exact match helpers (raw — no I / LF)
// ---------------------------------------------------------------------------

interface ExactMatchCounts {
  matched: boolean;
  match_count: number;
  same_concept_match_count: number;
  cross_concept_match_count: number;
}

/**
 * For each alias_item in alias.items, checks whether the given predicate fires.
 * Returns counts split by same-concept vs cross-concept.
 *
 * Since ALIAS_ITEMS inherit concept from their parent ALIAS, all items in a
 * given alias bundle share the same concept. same_concept is determined by
 * compatibility_weight === 1.0 (same concept as run).
 */
function exactMatchCounts(
  items: AliasMemberForPayload[],
  isSameConcept: boolean,
  predicate: (item: AliasMemberForPayload) => boolean,
): ExactMatchCounts {
  let matchCount = 0;
  for (const item of items) {
    if (predicate(item)) matchCount++;
  }
  return {
    matched: matchCount > 0,
    match_count: matchCount,
    same_concept_match_count: isSameConcept ? matchCount : 0,
    cross_concept_match_count: isSameConcept ? 0 : matchCount,
  };
}

// ---------------------------------------------------------------------------
// Representative alias items selection
// ---------------------------------------------------------------------------

function selectRepresentativeItems(
  items: AliasMemberForPayload[],
  aliasNameLiteral: string,
  conceptKey: string,
  compatibilityWeight: number,
): Array<{ literal_value: string; concept: string; concept_compatibility: number }> {
  if (items.length === 0) return [];

  const results: AliasMemberForPayload[] = [];

  // (1) item whose literal_value matches the alias display name (case-insensitive)
  const nameMatch = items.find(
    (it) => caseFold(it.literal_value) === caseFold(aliasNameLiteral),
  );
  const anchor = nameMatch ?? items[0];
  results.push(anchor);

  if (items.length > 1) {
    // (2) largest token-signature difference from anchor (max Jaccard distance)
    const anchorTokSet = new Set(caseFoldAll(anchor.std_tokens));
    let maxJaccard = -1;
    let mostDifferentByToken: AliasMemberForPayload | null = null;
    for (const it of items) {
      if (it === anchor) continue;
      const itSet = new Set(caseFoldAll(it.std_tokens));
      const intersect = [...itSet].filter((t) => anchorTokSet.has(t)).length;
      const union = new Set([...anchorTokSet, ...itSet]).size;
      const jaccard = union > 0 ? intersect / union : 0;
      const dist = 1 - jaccard;
      if (dist > maxJaccard) {
        maxJaccard = dist;
        mostDifferentByToken = it;
      }
    }
    if (mostDifferentByToken) results.push(mostDifferentByToken);
  }

  if (items.length > 2 && results.length < 3) {
    // (3) largest character-level difference from anchor (max normalised Levenshtein distance)
    const anchorNorm = caseFold(anchor.literal_value);
    let maxLevDist = -1;
    let mostDifferentByChar: AliasMemberForPayload | null = null;
    for (const it of items) {
      if (results.includes(it)) continue;
      const itNorm = caseFold(it.literal_value);
      const score = levenshtein1minus(anchorNorm, itNorm);
      const dist = 1 - score;
      if (dist > maxLevDist) {
        maxLevDist = dist;
        mostDifferentByChar = it;
      }
    }
    if (mostDifferentByChar) results.push(mostDifferentByChar);
  }

  return results.map((it) => ({
    literal_value: it.literal_value,
    concept: conceptKey,
    concept_compatibility: Number(compatibilityWeight.toFixed(6)),
  }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Builds the per-pair feature payload inserted as the user message in the
 * LLM API call. All raw (unweighted) values are derived here. The weighted
 * deterministic formula result (deterministic_score_baseline) is computed
 * separately in apply-confident-assignments and is never included here.
 */
export function buildFeaturePayload({
  runItem,
  alias,
  tokenRarity,
  namePairDetails,
}: BuildFeaturePayloadParams) {
  const isSameConcept = Math.abs(alias.compatibility_weight - 1.0) < 1e-9;

  // ── Run item string values ─────────────────────────────────────────────────
  const runStd = runItem.std_tokens;
  const runNorm = runItem.norm_tokens;
  const runClean = caseFold(runItem.cleaned_value ?? '');
  const runNormVal = caseFold(runItem.normalization_value ?? '');

  // ── Alias name string values ───────────────────────────────────────────────
  const aliasStd = alias.alias_name_tokens;
  const aliasNorm = alias.alias_name_normalized_tokens;
  const aliasNormVal = caseFold(alias.alias_name_normalization_value ?? '');

  // ── Aggregate alias_item token sets (union, case-folded) ──────────────────
  const aggStdSet = new Set<string>();
  const aggNormSet = new Set<string>();
  for (const item of alias.items) {
    for (const t of item.std_tokens) aggStdSet.add(caseFold(t));
    for (const t of item.norm_tokens) aggNormSet.add(caseFold(t));
  }
  const aggStd = [...aggStdSet];
  const aggNorm = [...aggNormSet];

  // ── per_token metadata for run item ──────────────────────────────────────
  const perToken = runStd.map((token, idx) => {
    const pos = idx + 1;
    const rar = Number(tokenRarity(token).toFixed(6));
    const cw = Number(charWeight(token).toFixed(6));
    const imp = Number((rar * cw * posImportance(pos)).toFixed(6));
    return { token, rarity: rar, char_weight: cw, importance: imp, position: pos };
  });

  // =========================================================================
  // Exact match components (raw — I, LF, C stripped)
  // =========================================================================

  const matchCleanVal = exactMatchCounts(alias.items, isSameConcept, (it) => {
    const a = caseFold(it.cleaned_value ?? '');
    return runClean.length > 0 && a.length > 0 && runClean === a;
  });

  const matchNormVal = exactMatchCounts(alias.items, isSameConcept, (it) => {
    const a = caseFold(it.normalization_value ?? '');
    return runNormVal.length > 0 && a.length > 0 && runNormVal === a;
  });

  const runStdPipe = pipeSig(runStd);
  const matchStdSig = exactMatchCounts(alias.items, isSameConcept, (it) => {
    const a = pipeSig(it.std_tokens);
    return runStdPipe.length > 0 && a.length > 0 && runStdPipe === a;
  });

  const runNormPipe = pipeSig(runNorm);
  const matchNormSig = exactMatchCounts(alias.items, isSameConcept, (it) => {
    const a = pipeSig(it.norm_tokens);
    return runNormPipe.length > 0 && a.length > 0 && runNormPipe === a;
  });

  const exactAliasNameClean = (() => {
    const a = caseFold(alias.alias_name_clean_value ?? '');
    return runClean.length > 0 && a.length > 0 && runClean === a;
  })();

  const exactAliasNameNorm = (() => {
    return runNormVal.length > 0 && aliasNormVal.length > 0 && runNormVal === aliasNormVal;
  })();

  // =========================================================================
  // Token similarity (raw OC, raw LCS/LS — I and LF stripped)
  // =========================================================================

  // Raw OC: against aggregate union of all alias_item tokens.
  const rawOcStd = rawOC(runStd, aggStd);
  const rawOcNorm = rawOC(runNorm, aggNorm);

  // Intersecting tokens (tokens in run_item that appear in the aggregate set).
  const intersectingStd = runStd.filter((t) => aggStdSet.has(caseFold(t)));
  const intersectingNorm = runNorm.filter((t) => aggNormSet.has(caseFold(t)));

  // Raw LS: max across alias_items (I excluded; structural length ratio kept).
  let rawLsStd = 0;
  let rawLsNorm = 0;
  for (const item of alias.items) {
    const lcsStdLen = rawLCSLength(runStd, item.std_tokens);
    const isStd = isSubsetOf(runStd, item.std_tokens) || isSubsetOf(item.std_tokens, runStd);
    rawLsStd = Math.max(rawLsStd, rawLS(runStd.length, item.std_tokens.length, lcsStdLen, isStd));

    const lcsNormLen = rawLCSLength(runNorm, item.norm_tokens);
    const isNrm = isSubsetOf(runNorm, item.norm_tokens) || isSubsetOf(item.norm_tokens, runNorm);
    rawLsNorm = Math.max(rawLsNorm, rawLS(runNorm.length, item.norm_tokens.length, lcsNormLen, isNrm));
  }
  // Fall back to alias name if there are no alias_items.
  if (alias.items.length === 0) {
    const lcsStdLen = rawLCSLength(runStd, aliasStd);
    const isStd = isSubsetOf(runStd, aliasStd) || isSubsetOf(aliasStd, runStd);
    rawLsStd = rawLS(runStd.length, aliasStd.length, lcsStdLen, isStd);
    const lcsNormLen = rawLCSLength(runNorm, aliasNorm);
    const isNrm = isSubsetOf(runNorm, aliasNorm) || isSubsetOf(aliasNorm, runNorm);
    rawLsNorm = rawLS(runNorm.length, aliasNorm.length, lcsNormLen, isNrm);
  }

  // =========================================================================
  // String similarity (raw — no LF)
  // =========================================================================

  const jwNorm = runNormVal && aliasNormVal ? jaroWinkler(runNormVal, aliasNormVal) : 0;

  const sortedRunNorm = [...caseFoldAll(runNorm)].sort((a, b) => a.localeCompare(b)).join('|');
  const sortedAliasNorm = [...caseFoldAll(aliasNorm)].sort((a, b) => a.localeCompare(b)).join('|');
  const lvNorm = sortedRunNorm && sortedAliasNorm ? levenshtein1minus(sortedRunNorm, sortedAliasNorm) : 0;

  // =========================================================================
  // Acronym (raw inputs only — model makes its own judgment)
  // =========================================================================

  const acInitialsStd = acronymFromTokens(runStd);
  const acInitialsNorm = acronymFromTokens(runNorm);

  // deterministic_exact_match: any exact acronym direction from namePair
  const acDeterministicExact = namePairDetails.ac_exact > 0;

  // deterministic_partial_score: best partial score across directions (0 if < 0.75)
  const acDeterministicPartial = namePairDetails.ac_partial; // already 0 if < 0.75 per pairscore

  // =========================================================================
  // Closest alias item (pairscore_lite)
  // =========================================================================

  let closestItem: { literal_value: string; concept: string; concept_compatibility: number; pairscore_lite: number; match_basis: string } | null = null;
  for (const item of alias.items) {
    const { score, match_basis } = pairscoreLite(runItem, item);
    if (closestItem === null || score > closestItem.pairscore_lite) {
      closestItem = {
        literal_value: item.literal_value,
        concept: alias.concept_key,
        concept_compatibility: Number(alias.compatibility_weight.toFixed(6)),
        pairscore_lite: score,
        match_basis,
      };
    }
  }

  // =========================================================================
  // Representative alias items (up to 3)
  // =========================================================================

  const representativeItems = selectRepresentativeItems(
    alias.items,
    alias.alias_name_literal_value,
    alias.concept_key,
    alias.compatibility_weight,
  );

  // =========================================================================
  // Flags
  // =========================================================================

  const acronymFired = namePairDetails.AC_pair > 0;

  const isSubsetAliasNameInRunItem = isSubsetOf(aliasNorm, runNorm);
  const isSubsetRunItemInAliasName = isSubsetOf(runNorm, aliasNorm);

  const litVal = runItem.literal_value;
  const runItemIsPureAcronym =
    litVal.length >= 2 &&
    litVal.length <= 5 &&
    /^[A-Z]+$/.test(litVal);

  const runNormSigEmpty = runNorm.length === 0;

  // Overlap only on stopwords: intersecting_std non-empty but intersecting_norm is empty
  // (norm tokens have stopwords removed, so if nothing overlaps on norm, the std overlap is stopwords).
  const tokensOverlapOnlyOnStopwords =
    intersectingStd.length > 0 && intersectingNorm.length === 0;

  const lengthRatioExtreme = Math.abs(runStd.length - aliasStd.length) >= 3;

  const possibleAbbreviationOrNickname =
    litVal.length <= 4 && aliasStd.length >= 3;

  // =========================================================================
  // Assemble payload
  // =========================================================================

  return {
    run_item: {
      literal_value: runItem.literal_value,
      clean_value: runItem.cleaned_value ?? '',
      normalized_value: runItem.normalization_value ?? '',
      standard_token_signature: runStd,
      normalized_token_signature: runNorm,
      per_token: perToken,
      // source_frequency and source_frequency_rank are not stored in RUN_ITEMS
      // in the current schema. These will be null until a frequency column is added.
      source_frequency: null as number | null,
      source_frequency_rank: null as number | null,
    },

    candidate_alias: {
      alias_name_literal_value: alias.alias_name_literal_value,
      alias_name_clean_value: alias.alias_name_clean_value ?? '',
      alias_name_normalized_value: alias.alias_name_normalization_value ?? '',
      alias_name_standard_token_signature: aliasStd,
      alias_name_normalized_token_signature: aliasNorm,
      alias_total_approved_items: alias.items.length,
      representative_alias_items: representativeItems,
      closest_alias_item: closestItem,
    },

    pipeline_components: {
      exact_match: {
        exact_clean_value_match: matchCleanVal,
        exact_normalized_value_match: matchNormVal,
        exact_standard_token_signature_match: matchStdSig,
        exact_normalized_token_signature_match: matchNormSig,
        exact_alias_name_clean_value_match: exactAliasNameClean,
        exact_alias_name_normalized_value_match: exactAliasNameNorm,
      },

      token_similarity: {
        overlap_coefficient_standard_raw: rawOcStd,
        overlap_coefficient_normalized_raw: rawOcNorm,
        intersecting_tokens_standard: intersectingStd,
        intersecting_tokens_normalized: intersectingNorm,
        longest_subsequence_score_standard_raw: Number(rawLsStd.toFixed(6)),
        longest_subsequence_score_normalized_raw: Number(rawLsNorm.toFixed(6)),
      },

      string_similarity: {
        jaro_winkler_normalized: jwNorm,
        levenshtein_normalized: lvNorm,
      },

      acronym: {
        run_item_literal_value: runItem.literal_value,
        run_item_standard_token_signature: runStd,
        run_item_normalized_token_signature: runNorm,
        alias_name_literal_value: alias.alias_name_literal_value,
        alias_name_standard_token_signature: aliasStd,
        alias_name_normalized_token_signature: aliasNorm,
        deterministic_acronym_initials: acInitialsStd,
        deterministic_acronym_normalized_initials: acInitialsNorm,
        deterministic_exact_match: acDeterministicExact,
        deterministic_partial_score: acDeterministicPartial,
      },
    },

    flags: {
      acronym_fired: acronymFired,
      exact_match_clean_value_fired: matchCleanVal.matched,
      exact_match_normalized_value_fired: matchNormVal.matched,
      subset_alias_name_in_run_item: isSubsetAliasNameInRunItem,
      subset_run_item_in_alias_name: isSubsetRunItemInAliasName,
      run_item_is_pure_acronym: runItemIsPureAcronym,
      alias_has_single_item: alias.items.length === 1,
      run_item_normalized_signature_is_empty: runNormSigEmpty,
      tokens_overlap_only_on_stopwords: tokensOverlapOnlyOnStopwords,
      length_ratio_extreme: lengthRatioExtreme,
      possible_abbreviation_or_nickname: possibleAbbreviationOrNickname,
    },
  };
}

// ---------------------------------------------------------------------------
// Token rarity map builder
// ---------------------------------------------------------------------------

/**
 * Builds a token → rarity lookup for the run's concept.
 * rarity(t) = 1 − (# same-concept aliases containing t / total same-concept aliases).
 *
 * Only same-concept aliases are used so that rarity reflects
 * distinctiveness within the concept, not across concepts.
 *
 * Call once per run (before the scoring loop) and pass the resulting
 * function as `tokenRarity` to buildFeaturePayload.
 */
export function buildTokenRarityLookup(
  aliases: AliasBundleForPayload[],
): (token: string) => number {
  // Same-concept aliases only (compatibility_weight === 1.0).
  const sameConceptAliases = aliases.filter((a) => Math.abs(a.compatibility_weight - 1.0) < 1e-9);
  const total = sameConceptAliases.length;

  if (total === 0) return () => 1;

  // For each alias, collect the unique case-folded tokens across all its items
  // (alias_items std_tokens + alias_name_tokens).
  const tokenCount = new Map<string, number>();
  for (const alias of sameConceptAliases) {
    const aliasTokenSet = new Set<string>();
    for (const t of alias.alias_name_tokens) aliasTokenSet.add(caseFold(t));
    for (const item of alias.items) {
      for (const t of item.std_tokens) aliasTokenSet.add(caseFold(t));
    }
    for (const t of aliasTokenSet) {
      tokenCount.set(t, (tokenCount.get(t) ?? 0) + 1);
    }
  }

  return (token: string): number => {
    const count = tokenCount.get(caseFold(token)) ?? 0;
    return Number((1 - count / total).toFixed(6));
  };
}

