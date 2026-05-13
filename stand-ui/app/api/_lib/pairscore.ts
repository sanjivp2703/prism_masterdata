/**
 * PairScore: how likely two unassigned run items belong in the same group.
 *
 * Formula (mirroring the value-to-value scoring architecture):
 *   PairScore = 0.51 × M_pair + 0.20 × TS_pair + 0.12 × SS_pair + 0.17 × AC_pair
 *
 * Concept compatibility (C) never lives here. Unassigned-grouping compares run items
 * (same concept). Value-to-alias reuses this function but applies C only when folding
 * alias-member evidence in apply-confident-assignments, not inside PairScore.
 *
 * Other globals in this module:
 *  - Importance (I) = average of both items' position-based token importance.
 *  - LF (length factor) = average of both items' combined LF (min(1, token_chars / 4)).
 *  - IS (is_subset) boost in LS is a flat 10% (symmetric).
 */

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface RunItemForPairing {
  run_item_id: number;
  /** Original source string (used for not_all_caps_penalty). */
  literal_value: string;
  /** Output of pre-tokenization cleaning pass. */
  cleaned_value: string | null;
  /** Output of full normalization pass. */
  normalization_value: string | null;
  /** Standard (pre-normalization) tokens. */
  std_tokens: string[];
  /** Normalized tokens. */
  norm_tokens: string[];
}

export interface PairScoreDetails {
  // ── Exact Match ──────────────────────────────────────────────────────────
  M_clean_val: number;
  M_normalized_val: number;
  M_s_token_sig: number;
  M_n_token_sig: number;
  M_pair: number;
  // ── Token Similarity ─────────────────────────────────────────────────────
  IS_s_token_sig: boolean;
  IS_n_token_sig: boolean;
  OC_s_token_sig: number;
  OC_n_token_sig: number;
  OC_pair: number;
  LS_s_token_sig: number;
  LS_n_token_sig: number;
  LS_pair: number;
  TS_pair: number;
  // ── String Similarity ────────────────────────────────────────────────────
  JW_pair: number;
  LV_pair: number;
  SS_pair: number;
  // ── Acronym Comparison ───────────────────────────────────────────────────
  ac_exact: number;
  ac_partial: number;
  ac_acronym_len: number;
  ac_x: number;
  ac_i_wlf: number;
  ac_penalty: number;
  AC_pair: number;
  // ── Item metadata used in scoring ────────────────────────────────────────
  item_importance_a: number;
  item_importance_b: number;
  avg_importance: number;
  lf_norm_a: number;
  lf_norm_b: number;
  avg_lf_norm: number;
}

export interface PairScoreResult {
  run_item_id_a: number;
  run_item_id_b: number;
  pair_score: number;
  details: PairScoreDetails;
}

// ---------------------------------------------------------------------------
// Core helpers (pure functions, no external dependencies)
// ---------------------------------------------------------------------------

const caseFold = (s: string): string => String(s ?? '').toLocaleLowerCase();

const caseFoldAll = (tokens: string[]): string[] => tokens.map(caseFold);

/**
 * Position-based importance score (1-indexed).
 * Mirrors the alias-token formula: importance = 0.75 + 0.25 / p^0.4
 * No rarity factor since run items are not catalogued; position alone is used.
 */
const positionImportance = (position: number): number =>
  0.75 + 0.25 / Math.pow(Math.max(1, position), 0.4);

/** Compute a parallel importance array for a token list (1-indexed positions). */
const tokenImportanceArray = (tokens: string[]): number[] =>
  tokens.map((_, i) => positionImportance(i + 1));

/** Average importance of an item = mean of its token importance scores. */
const avgItemImportance = (tokens: string[]): number => {
  if (tokens.length === 0) return 0;
  const imps = tokenImportanceArray(tokens);
  return imps.reduce((s, v) => s + v, 0) / imps.length;
};

/**
 * Combined length factor for a token list.
 * LF = min(1, totalChars / 4) — treating the whole list as one unit.
 */
const combinedLF = (tokens: string[]): number =>
  Math.min(1, tokens.reduce((s, t) => s + t.length, 0) / 4);

const pipeSigEqualIgnoreCase = (a: string[], b: string[]): boolean =>
  a.length > 0 &&
  b.length > 0 &&
  a.length === b.length &&
  a.every((t, i) => caseFold(t) === caseFold(b[i]));

const isSubsetOf = (subset: string[], superset: string[]): boolean => {
  if (subset.length === 0) return false;
  const sup = new Set(caseFoldAll(superset));
  return subset.every((t) => sup.has(caseFold(t)));
};

/**
 * Weighted overlap coefficient where intersecting token importance is the
 * average of both sides' position-based importance (symmetric).
 *
 * Returns: { oc, avgIntersectingImportance, avgIntersectingLF }
 */
const pairwiseOC = (
  tokensA: string[],
  impsA: number[],
  tokensB: string[],
  impsB: number[]
): { oc: number; avgIntersectingImportance: number; avgIntersectingLF: number } => {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return { oc: 0, avgIntersectingImportance: 0, avgIntersectingLF: 0 };
  }

  // Build a map from case-folded token → first occurrence importance in A.
  const aMap = new Map<string, number>();
  for (let i = 0; i < tokensA.length; i++) {
    const k = caseFold(tokensA[i]);
    if (!aMap.has(k)) aMap.set(k, impsA[i] ?? 0);
  }

  const setA = new Set(caseFoldAll(tokensA));
  let hits = 0;
  let impSum = 0;
  let charSum = 0;

  for (let i = 0; i < tokensB.length; i++) {
    const k = caseFold(tokensB[i]);
    if (setA.has(k)) {
      hits++;
      const aImp = aMap.get(k) ?? 0;
      const bImp = impsB[i] ?? 0;
      impSum += (aImp + bImp) / 2;
      charSum += tokensB[i].length;
    }
  }

  const oc = hits / Math.min(tokensA.length, tokensB.length);
  return {
    oc: Number(oc.toFixed(6)),
    avgIntersectingImportance: hits > 0 ? Number((impSum / hits).toFixed(6)) : 0,
    avgIntersectingLF: hits > 0 ? Number(Math.min(1, charSum / 4).toFixed(6)) : 0,
  };
};

/**
 * LCS that accumulates importance and char-length of matched tokens.
 * Importance for each match = average of both sides' position importance.
 * Char length accumulates from the B side (used to compute combinedLF).
 */
const pairwiseLCS = (
  tokensA: string[],
  impsA: number[],
  tokensB: string[],
  impsB: number[]
): { length: number; importanceSum: number; lfSum: number } => {
  const m = tokensA.length;
  const n = tokensB.length;
  if (m === 0 || n === 0) return { length: 0, importanceSum: 0, lfSum: 0 };

  const aFold = caseFoldAll(tokensA);
  const bFold = caseFoldAll(tokensB);

  const dp: { len: number; impSum: number; lfSum: number }[][] = Array.from(
    { length: m + 1 },
    () => Array.from({ length: n + 1 }, () => ({ len: 0, impSum: 0, lfSum: 0 }))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aFold[i - 1] === bFold[j - 1]) {
        const avgImp = ((impsA[i - 1] ?? 0) + (impsB[j - 1] ?? 0)) / 2;
        dp[i][j] = {
          len: dp[i - 1][j - 1].len + 1,
          impSum: dp[i - 1][j - 1].impSum + avgImp,
          lfSum: dp[i - 1][j - 1].lfSum + tokensB[j - 1].length,
        };
      } else {
        const up = dp[i - 1][j];
        const left = dp[i][j - 1];
        dp[i][j] =
          up.len > left.len || (up.len === left.len && up.impSum >= left.impSum) ? up : left;
      }
    }
  }

  return { length: dp[m][n].len, importanceSum: dp[m][n].impSum, lfSum: dp[m][n].lfSum };
};

/**
 * LS sub-score for one token direction.
 *   length_ratio = min(|A|, |B|) / max(|A|, |B|)
 *   score_without_is = (lcsLen × avgLcsImportance × combinedLF) /
 *                      (lengthRatio × min + (1 − lengthRatio) × max)
 *   IS boost: flat 10% when either token set is a subset of the other.
 *   LS = min(1, score_without_is × (1 + isBoost))
 */
const computePairLS = (
  lenA: number,
  lenB: number,
  lcsLen: number,
  lcsImpSum: number,
  lcsLFSum: number,
  isSubset: boolean
): number => {
  if (lenA === 0 || lenB === 0 || lcsLen === 0) return 0;
  const minLen = Math.min(lenA, lenB);
  const maxLen = Math.max(lenA, lenB);
  const lengthRatio = minLen / maxLen;
  const denominator = lengthRatio * minLen + (1 - lengthRatio) * maxLen;
  if (denominator === 0) return 0;
  const avgLcsImportance = lcsLen > 0 ? lcsImpSum / lcsLen : 0;
  const combinedLFVal = Math.min(1, lcsLFSum / 4);
  const scoreWithoutIS = (lcsLen * avgLcsImportance * combinedLFVal) / denominator;
  const isBoost = isSubset ? 0.1 : 0;
  return Math.min(1, Number((scoreWithoutIS * (1 + isBoost)).toFixed(6)));
};

/** Jaro-Winkler similarity score [0, 1]. */
const jaroWinklerScore = (left: string, right: string): number => {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
  const leftMatches = new Array<boolean>(left.length).fill(false);
  const rightMatches = new Array<boolean>(right.length).fill(false);

  let matches = 0;
  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, right.length);
    for (let j = start; j < end; j++) {
      if (rightMatches[j] || left[i] !== right[j]) continue;
      leftMatches[i] = true;
      rightMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let rightIdx = 0;
  for (let i = 0; i < left.length; i++) {
    if (!leftMatches[i]) continue;
    while (!rightMatches[rightIdx]) rightIdx++;
    if (left[i] !== right[rightIdx]) transpositions++;
    rightIdx++;
  }
  transpositions /= 2;

  const jaro =
    (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3;

  let prefixLen = 0;
  const maxPrefix = Math.min(4, left.length, right.length);
  while (prefixLen < maxPrefix && left[prefixLen] === right[prefixLen]) prefixLen++;

  return Number((jaro + prefixLen * 0.1 * (1 - jaro)).toFixed(6));
};

/** Normalised Levenshtein distance in [0, 1] (0 = identical). */
const levenshteinDistance = (left: string, right: string): number => {
  const m = left.length;
  const n = right.length;
  const maxLen = Math.max(m, n);
  if (maxLen === 0) return 0;
  if (m === 0) return n / maxLen;
  if (n === 0) return m / maxLen;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n] / maxLen;
};

const sortedTokenSig = (tokens: string[]): string =>
  caseFoldAll(tokens)
    .sort((a, b) => a.localeCompare(b))
    .join('|');

const normalizeComparableValue = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

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

/** 1.0 if original value is all-caps (no lowercase letters); 0.82 otherwise. */
const notAllCapsPenalty = (original: string): number => (/[a-z]/.test(original) ? 0.82 : 1.0);

const acronymLengthWeight = (len: number): number => {
  if (len >= 3) return 1.0;
  if (len === 2) return 0.35;
  return 0;
};

// ---------------------------------------------------------------------------
// Main pairscore computation
// ---------------------------------------------------------------------------

/**
 * Computes PairScore between two unassigned run items.
 *
 * PairScore = 0.51 × M_pair + 0.20 × TS_pair + 0.12 × SS_pair + 0.17 × AC_pair
 */
export function computePairScore(a: RunItemForPairing, b: RunItemForPairing): PairScoreResult {
  const stdA = a.std_tokens;
  const stdB = b.std_tokens;
  const normA = a.norm_tokens;
  const normB = b.norm_tokens;

  const impsStdA = tokenImportanceArray(stdA);
  const impsStdB = tokenImportanceArray(stdB);
  const impsNormA = tokenImportanceArray(normA);
  const impsNormB = tokenImportanceArray(normB);

  // ── Item-level importance (average of all token importances) ─────────────
  const preferStdA = stdA.length > 0;
  const preferStdB = stdB.length > 0;
  const item_importance_a = avgItemImportance(preferStdA ? stdA : normA);
  const item_importance_b = avgItemImportance(preferStdB ? stdB : normB);
  const avg_importance = (item_importance_a + item_importance_b) / 2;

  // ── Length factors for normalized tokens ─────────────────────────────────
  const lf_norm_a = combinedLF(normA);
  const lf_norm_b = combinedLF(normB);
  const avg_lf_norm = (lf_norm_a + lf_norm_b) / 2;

  // ── I^0.5 term (used in M_normalized_val and M_n_token_sig) ──────────────
  const I_sqrt = Math.sqrt(avg_importance);

  // =========================================================================
  // 1. Exact Match (M_pair)
  // =========================================================================
  const cleanA = caseFold(a.cleaned_value ?? '');
  const cleanB = caseFold(b.cleaned_value ?? '');
  const normValA = caseFold(a.normalization_value ?? '');
  const normValB = caseFold(b.normalization_value ?? '');

  const match_clean_val =
    cleanA.length > 0 &&
    cleanB.length > 0 &&
    (cleanA === cleanB ||
      cleanA.replace(/\s+/g, '') === cleanB.replace(/\s+/g, ''));
  const match_normalized_val =
    normValA.length > 0 &&
    normValB.length > 0 &&
    (normValA === normValB ||
      normValA.replace(/\s+/g, '') === normValB.replace(/\s+/g, ''));
  const match_s_token_sig = pipeSigEqualIgnoreCase(stdA, stdB);
  const match_n_token_sig = pipeSigEqualIgnoreCase(normA, normB);

  // Scores for each sub-component
  const M_clean_val = match_clean_val ? 1.0 : 0;
  const M_normalized_val = match_normalized_val
    ? Number((0.95 * I_sqrt * avg_lf_norm).toFixed(6))
    : 0;
  const M_s_token_sig = match_s_token_sig ? 0.85 : 0;
  const M_n_token_sig = match_n_token_sig
    ? Number((0.90 * I_sqrt * avg_lf_norm).toFixed(6))
    : 0;

  const M_pair = Number(
    Math.max(M_clean_val, M_normalized_val, M_s_token_sig, M_n_token_sig).toFixed(6)
  );

  // =========================================================================
  // 2. Token Similarity (TS_pair)
  // =========================================================================

  // ── Standard token direction ──────────────────────────────────────────────
  const aStdSubsetOfB = isSubsetOf(stdA, stdB);
  const bStdSubsetOfA = isSubsetOf(stdB, stdA);
  const IS_s_token_sig = aStdSubsetOfB || bStdSubsetOfA;

  const { oc: rawOC_std, avgIntersectingImportance: avgImp_std, avgIntersectingLF: avgLF_std } =
    pairwiseOC(stdA, impsStdA, stdB, impsStdB);
  const OC_s_token_sig = Number((rawOC_std * avgImp_std * avgLF_std).toFixed(6));

  const lcsStd = pairwiseLCS(stdA, impsStdA, stdB, impsStdB);
  const LS_s_token_sig = computePairLS(
    stdA.length, stdB.length,
    lcsStd.length, lcsStd.importanceSum, lcsStd.lfSum,
    IS_s_token_sig
  );

  // ── Normalized token direction ────────────────────────────────────────────
  const aNormSubsetOfB = isSubsetOf(normA, normB);
  const bNormSubsetOfA = isSubsetOf(normB, normA);
  const IS_n_token_sig = aNormSubsetOfB || bNormSubsetOfA;

  const { oc: rawOC_norm, avgIntersectingImportance: avgImp_norm, avgIntersectingLF: avgLF_norm } =
    pairwiseOC(normA, impsNormA, normB, impsNormB);
  const OC_n_token_sig = Number((rawOC_norm * avgImp_norm * avgLF_norm).toFixed(6));

  const lcsNorm = pairwiseLCS(normA, impsNormA, normB, impsNormB);
  const LS_n_token_sig = computePairLS(
    normA.length, normB.length,
    lcsNorm.length, lcsNorm.importanceSum, lcsNorm.lfSum,
    IS_n_token_sig
  );

  // ── Combined TS_pair ──────────────────────────────────────────────────────
  const OC_pair = Number(Math.max(OC_n_token_sig, OC_s_token_sig).toFixed(6));
  const LS_pair = Number(Math.max(LS_n_token_sig, LS_s_token_sig).toFixed(6));
  const TS_pair = Number((0.55 * OC_pair + 0.45 * LS_pair).toFixed(6));

  // =========================================================================
  // 3. String Similarity (SS_pair)
  // =========================================================================

  // JW on normalized values; LF = avg_lf_norm
  const jw = jaroWinklerScore(normValA, normValB);
  const JW_pair = Number((jw * avg_lf_norm).toFixed(6));

  // LV on sorted normalized token signatures; LF = avg_lf_norm
  const sortedSigA = sortedTokenSig(normA);
  const sortedSigB = sortedTokenSig(normB);
  const lv = sortedSigA.length > 0 && sortedSigB.length > 0
    ? levenshteinDistance(sortedSigA, sortedSigB)
    : null;
  const LV_pair = lv !== null ? Number(((1 - lv) * avg_lf_norm).toFixed(6)) : 0;

  const SS_pair = Number(Math.max(JW_pair, LV_pair).toFixed(6));

  // =========================================================================
  // 4. Acronym Comparison (AC_pair)
  // =========================================================================

  // Item with larger token_signature is the "acronym" side (bidirectional check).
  // We check both directions symmetrically: A initials vs B norm_val, and B initials vs A norm_val.
  const normValForA = normalizeComparableValue(a.normalization_value ?? '');
  const normValForB = normalizeComparableValue(b.normalization_value ?? '');

  const acronymStd_A = acronymFromTokens(stdA);   // first letters of A std tokens
  const acronymStd_B = acronymFromTokens(stdB);   // first letters of B std tokens
  const acronymNorm_A = acronymFromTokens(normA); // first letters of A norm tokens
  const acronymNorm_B = acronymFromTokens(normB); // first letters of B norm tokens

  // Direction 1: A's std initials vs B's normalized value
  const dir1_std_exact = acronymStd_A.length > 0 && normValForB.length > 0 && acronymStd_A === normValForB;
  const dir1_std_partial = partialAcronymScore(acronymStd_A, normValForB);
  // Direction 2: B's std initials vs A's normalized value
  const dir2_std_exact = acronymStd_B.length > 0 && normValForA.length > 0 && acronymStd_B === normValForA;
  const dir2_std_partial = partialAcronymScore(acronymStd_B, normValForA);
  // Direction 3: A's norm initials vs B's normalized value
  const dir3_norm_exact = acronymNorm_A.length > 0 && normValForB.length > 0 && acronymNorm_A === normValForB;
  const dir3_norm_partial = partialAcronymScore(acronymNorm_A, normValForB);
  // Direction 4: B's norm initials vs A's normalized value
  const dir4_norm_exact = acronymNorm_B.length > 0 && normValForA.length > 0 && acronymNorm_B === normValForA;
  const dir4_norm_partial = partialAcronymScore(acronymNorm_B, normValForA);

  const ac_exact = (dir1_std_exact || dir2_std_exact || dir3_norm_exact || dir4_norm_exact) ? 1 : 0;
  const bestPartialRaw = Math.max(dir1_std_partial, dir2_std_partial, dir3_norm_partial, dir4_norm_partial);
  const ac_partial = bestPartialRaw >= 0.75 ? bestPartialRaw : 0;

  // Acronym length from whichever direction(s) matched.
  let ac_acronym_len = 0;
  if (dir1_std_exact) ac_acronym_len = Math.max(ac_acronym_len, acronymStd_A.length);
  if (dir2_std_exact) ac_acronym_len = Math.max(ac_acronym_len, acronymStd_B.length);
  if (dir3_norm_exact) ac_acronym_len = Math.max(ac_acronym_len, acronymNorm_A.length);
  if (dir4_norm_exact) ac_acronym_len = Math.max(ac_acronym_len, acronymNorm_B.length);
  if (ac_acronym_len === 0 && ac_partial > 0) {
    ac_acronym_len = Math.max(
      acronymStd_A.length, acronymStd_B.length,
      acronymNorm_A.length, acronymNorm_B.length
    );
  }

  // not_all_caps_penalty: check ORIGINAL (non-lowercased) value of the side that IS the acronym.
  // Direction 1/3: B is the single-word abbreviation → check B's literal_value.
  // Direction 2/4: A is the single-word abbreviation → check A's literal_value.
  let ac_penalty = 1.0;
  if (ac_exact > 0 || ac_partial > 0) {
    const dir1or3 = dir1_std_exact || dir3_norm_exact ||
      (dir1_std_partial >= 0.75 && dir1_std_partial >= dir2_std_partial &&
       dir1_std_partial >= dir3_norm_partial && dir1_std_partial >= dir4_norm_partial) ||
      (dir3_norm_partial >= 0.75 && dir3_norm_partial > dir1_std_partial &&
       dir3_norm_partial >= dir2_std_partial && dir3_norm_partial >= dir4_norm_partial);
    const dir2or4 = dir2_std_exact || dir4_norm_exact ||
      (dir2_std_partial >= 0.75 && dir2_std_partial >= dir1_std_partial &&
       dir2_std_partial >= dir3_norm_partial && dir2_std_partial >= dir4_norm_partial) ||
      (dir4_norm_partial >= 0.75 && dir4_norm_partial > dir2_std_partial &&
       dir4_norm_partial >= dir1_std_partial && dir4_norm_partial >= dir3_norm_partial);
    if (dir1or3) ac_penalty = Math.min(ac_penalty, notAllCapsPenalty(b.literal_value));
    if (dir2or4) ac_penalty = Math.min(ac_penalty, notAllCapsPenalty(a.literal_value));
  }

  // I_wlf (without length factor): avg pure importance of both items' token sets.
  const I_wlf = avg_importance;
  const ac_x = acronymLengthWeight(ac_acronym_len);
  const AC_pair = Number(
    (Math.max(ac_exact, ac_partial) * Math.pow(I_wlf, 0.25) * ac_x * ac_penalty).toFixed(6)
  );

  // =========================================================================
  // Final PairScore
  // =========================================================================
  const pair_score = Number(
    Math.min(1, 0.51 * M_pair + 0.20 * TS_pair + 0.12 * SS_pair + 0.17 * AC_pair).toFixed(6)
  );

  return {
    run_item_id_a: a.run_item_id,
    run_item_id_b: b.run_item_id,
    pair_score,
    details: {
      M_clean_val,
      M_normalized_val,
      M_s_token_sig,
      M_n_token_sig,
      M_pair,
      IS_s_token_sig,
      IS_n_token_sig,
      OC_s_token_sig,
      OC_n_token_sig,
      OC_pair,
      LS_s_token_sig,
      LS_n_token_sig,
      LS_pair,
      TS_pair,
      JW_pair,
      LV_pair,
      SS_pair,
      ac_exact,
      ac_partial,
      ac_acronym_len,
      ac_x,
      ac_i_wlf: Number(I_wlf.toFixed(6)),
      ac_penalty,
      AC_pair,
      item_importance_a: Number(item_importance_a.toFixed(6)),
      item_importance_b: Number(item_importance_b.toFixed(6)),
      avg_importance: Number(avg_importance.toFixed(6)),
      lf_norm_a: Number(lf_norm_a.toFixed(6)),
      lf_norm_b: Number(lf_norm_b.toFixed(6)),
      avg_lf_norm: Number(avg_lf_norm.toFixed(6)),
    },
  };
}

/**
 * Compute pairscores for all combinations of a set of run items.
 * Returns one result per (a, b) pair where a.run_item_id < b.run_item_id.
 */
export function computeAllPairScores(items: RunItemForPairing[]): PairScoreResult[] {
  const results: PairScoreResult[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      results.push(computePairScore(items[i], items[j]));
    }
  }
  return results;
}
