/**
 * NameScore: how representative an item's literal value is for its alias/group.
 *
 * NameScore(i) = sqrt(
 *   normalized_token_sig_importance(i)
 *   × cleanliness(i)
 *   × representativeness(i, group)
 *   × length_sanity(i)
 * )
 *
 * The item with the highest NameScore in a group has its (properly-cased)
 * literal value used as the alias/group display name.
 *
 * Calculated at three points:
 *   1. When a run does its initial grouping to pre-existing aliases
 *      (apply-confident-assignments route).
 *   2. When data is exported back to the backend
 *      (one-prompt export route).
 *   3. When an alias is created from unassigned item classification
 *      (unassigned-grouping/commit route).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NameScorable {
  run_item_id: number;
  /** Raw source string (used for casing and char_cleanliness). */
  literal_value: string;
  /** Output of the pre-tokenization cleaning pass. Used for LengthSanity. */
  cleaned_value: string | null;
  /** Standard (pre-normalization) tokens. Used for token_cleanliness. */
  std_tokens: string[];
  /** Normalized tokens. Used for token-sig importance + representativeness. */
  norm_tokens: string[];
}

// ---------------------------------------------------------------------------
// Default generic stopwords
// ---------------------------------------------------------------------------

/**
 * Default generic stopwords for Cleanliness.
 * Mirrors the LKP_STOPWORDS rows with concept_id IS NULL.
 * Carrier/brand-meaningful words are intentionally excluded.
 */
export const DEFAULT_GENERIC_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on', 'by', 'from',
]);

// ---------------------------------------------------------------------------
// Utility: parse Snowflake VARIANT token arrays
// ---------------------------------------------------------------------------

export const tokensFromVariant = (v: unknown): string[] => {
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

// ---------------------------------------------------------------------------
// Sub-component: Normalized token signature importance
// ---------------------------------------------------------------------------

/**
 * Position-based token importance (1-indexed).
 * importance = 0.75 + 0.25 / p^0.4   (mirrors pairscore.ts)
 */
function positionImportance(p: number): number {
  return 0.75 + 0.25 / Math.pow(Math.max(1, p), 0.4);
}

/**
 * Normalized token signature importance score.
 *   s / (s + 1.0 + 0.2 × (n − 1))
 * where s = Σ importance(pos) over unique tokens, n = # unique tokens.
 */
export function normalizedTokenSigImportance(normTokens: string[]): number {
  if (normTokens.length === 0) return 0;
  const firstPos = new Map<string, number>(); // token → first 1-indexed position
  normTokens.forEach((t, i) => {
    const k = t.toLowerCase();
    if (!firstPos.has(k)) firstPos.set(k, i + 1);
  });
  const n = firstPos.size;
  let s = 0;
  for (const pos of firstPos.values()) s += positionImportance(pos);
  return s / (s + 1.0 + 0.2 * (n - 1.0));
}

// ---------------------------------------------------------------------------
// Sub-component: Cleanliness
// ---------------------------------------------------------------------------

/**
 * Cleanliness(i) = 0.5 × token_cleanliness + 0.5 × char_cleanliness
 *
 * token_cleanliness = 1 − (# std tokens that are in genericStopwords / # std tokens)
 *   Only generic (non-carrier) stopwords count as noise; carrier/brand words are kept.
 *
 * char_cleanliness  = 1 − min(0.5, weird_chars / max(len(literal), 1))
 *   weird chars = not alphanumeric, not space, not &, not -, not apostrophe
 */
export function computeCleanliness(
  item: { literal_value: string; std_tokens: string[] },
  genericStopwords: ReadonlySet<string> = DEFAULT_GENERIC_STOPWORDS,
): number {
  const total = item.std_tokens.length;
  const noiseCount = total === 0
    ? 0
    : item.std_tokens.filter((t) => genericStopwords.has(t.toLowerCase())).length;
  const tokenCleanliness = total === 0 ? 1.0 : 1 - noiseCount / total;

  const literal = item.literal_value;
  let weirdCount = 0;
  for (const ch of literal) {
    if (!/[a-zA-Z0-9\s&'\-]/.test(ch)) weirdCount++;
  }
  const charCleanliness = 1 - Math.min(0.5, weirdCount / Math.max(literal.length, 1));

  return 0.5 * tokenCleanliness + 0.5 * charCleanliness;
}

// ---------------------------------------------------------------------------
// Sub-component: Representativeness
// ---------------------------------------------------------------------------

/**
 * avg_token_support(i) = average over item's unique norm tokens of
 *   (group_token_freq[token] / n)
 *
 * group_token_freq[t] = number of group members that contain t in their norm_tokens.
 * n = total number of members in the group.
 *
 * A singleton group returns 1.0 (the item trivially covers all its own tokens).
 */
export function computeRepresentativeness(
  item: { norm_tokens: string[] },
  allMembers: Array<{ norm_tokens: string[] }>,
): number {
  const n = allMembers.length;
  if (item.norm_tokens.length === 0 || n === 0) return 0;

  const groupFreq = new Map<string, number>();
  for (const member of allMembers) {
    const seen = new Set(member.norm_tokens.map((t) => t.toLowerCase()));
    for (const t of seen) groupFreq.set(t, (groupFreq.get(t) ?? 0) + 1);
  }

  const uniqueTokens = [...new Set(item.norm_tokens.map((t) => t.toLowerCase()))];
  const supportSum = uniqueTokens.reduce(
    (sum, t) => sum + (groupFreq.get(t) ?? 0) / n,
    0,
  );
  return supportSum / uniqueTokens.length;
}

// ---------------------------------------------------------------------------
// Sub-component: LengthSanity
// ---------------------------------------------------------------------------

/**
 * LengthSanity based on len(cleaned_value).
 *   < 2          → 0.3  (single char, almost certainly not a name)
 *   2–60 chars   → 1.0  (normal range)
 *   61–100 chars → 0.7  (long, probably has descriptive cruft)
 *   > 100 chars  → 0.4  (unreasonably long)
 */
export function computeLengthSanity(cleanedValue: string | null): number {
  const len = (cleanedValue ?? '').length;
  if (len < 2) return 0.3;
  if (len <= 60) return 1.0;
  if (len <= 100) return 0.7;
  return 0.4;
}

// ---------------------------------------------------------------------------
// Full NameScore
// ---------------------------------------------------------------------------

/**
 * Full NameScore for item i within a group.
 * NameScore(i) = sqrt(tokenSig × cleanliness × representativeness × lengthSanity)
 */
export function computeNameScore(
  item: NameScorable,
  allMembers: Array<{ norm_tokens: string[] }>,
  genericStopwords: ReadonlySet<string> = DEFAULT_GENERIC_STOPWORDS,
): number {
  const tokenSig = normalizedTokenSigImportance(item.norm_tokens);
  const clean    = computeCleanliness(item, genericStopwords);
  const rep      = computeRepresentativeness(item, allMembers);
  const lenSan   = computeLengthSanity(item.cleaned_value);
  return Math.sqrt(tokenSig * clean * rep * lenSan);
}

// ---------------------------------------------------------------------------
// Proper casing
// ---------------------------------------------------------------------------

/**
 * Returns true if the value looks like an acronym:
 *   all alphabetic characters are uppercase AND 2 ≤ # alpha chars ≤ 5.
 */
export function isLikelyAcronym(literalValue: string): boolean {
  const alpha = literalValue.replace(/[^a-zA-Z]/g, '');
  if (alpha.length < 2 || alpha.length > 5) return false;
  return alpha === alpha.toUpperCase();
}

/**
 * Applies proper title-casing to a literal value.
 * Acronyms (fully uppercase, 2–5 alpha chars) are preserved as-is.
 */
export function applyAliasNameCasing(literal: string): string {
  if (isLikelyAcronym(literal)) return literal;
  return literal.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// ---------------------------------------------------------------------------
// Group-level picker
// ---------------------------------------------------------------------------

/**
 * Given all members of a group, returns the best candidate alias name.
 *
 * Winner = highest NameScore; ties broken by shortest literal_value.
 * Proper casing is applied to the winning literal.
 */
export function pickBestAliasName(
  members: NameScorable[],
  genericStopwords: ReadonlySet<string> = DEFAULT_GENERIC_STOPWORDS,
): { run_item_id: number; literal_value: string; name_score: number } {
  if (members.length === 0) {
    return { run_item_id: -1, literal_value: '', name_score: 0 };
  }

  const scored = members.map((m) => ({
    run_item_id:  m.run_item_id,
    raw_literal:  m.literal_value,
    name_score:   computeNameScore(m, members, genericStopwords),
  }));

  scored.sort((a, b) =>
    b.name_score !== a.name_score
      ? b.name_score - a.name_score
      : a.raw_literal.length - b.raw_literal.length, // tie-break: prefer shorter
  );

  const best = scored[0];
  return {
    run_item_id:   best.run_item_id,
    literal_value: applyAliasNameCasing(best.raw_literal),
    name_score:    best.name_score,
  };
}
