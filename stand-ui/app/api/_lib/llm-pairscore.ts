/**
 * LLM-enhanced pair scoring for the unassigned-item grouping pipeline.
 *
 * Mirrors the architecture of llm-confidence.ts but compares run_item ↔ run_item
 * rather than run_item ↔ alias.  The LLM receives the same structural features
 * produced by computePairScore() minus the importance (I) and length-factor (LF)
 * internal weight terms, which are implementation details of the formula and not
 * meaningful as evidence for entity resolution.
 *
 * Only pairs in an ambiguous band (e.g. 0.01 < pair_score < 0.30) are sent to
 * the LLM.  Scores outside that range are obvious mismatches or clearly the
 * same entity and need no LLM refinement.
 */

import type { RunItemForPairing, PairScoreDetails } from './pairscore';

// ---------------------------------------------------------------------------
// Model / pricing
// ---------------------------------------------------------------------------

export const PAIRSCORE_LLM_MODEL = 'claude-haiku-4-5-20251001' as const;

// Token pricing for claude-haiku-4-5-20251001 (same as apply-confident-assignments).
// Source: https://www.anthropic.com/pricing
const PRICE_INPUT_PER_M      = 0.80;   // USD per 1M input tokens (cache miss)
const PRICE_OUTPUT_PER_M     = 4.00;   // USD per 1M output tokens
const PRICE_CACHE_READ_PER_M = 0.08;   // USD per 1M cache-read tokens (~10% of input)
const PRICE_CACHE_WRITE_PER_M= 1.00;   // USD per 1M cache-creation tokens

export function estimatePairscoreCostUSD(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): number {
  return (
    (usage.input_tokens                / 1_000_000) * PRICE_INPUT_PER_M +
    (usage.output_tokens               / 1_000_000) * PRICE_OUTPUT_PER_M +
    (usage.cache_read_input_tokens     / 1_000_000) * PRICE_CACHE_READ_PER_M +
    (usage.cache_creation_input_tokens / 1_000_000) * PRICE_CACHE_WRITE_PER_M
  );
}

export type PairscoreLLMUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export type LLMPairscoreResponse = {
  /** True if the model believes the two items represent the same entity. */
  same_entity: boolean;
  /**
   * Probability in [0, 1] that the two items are the same entity.
   * This replaces the deterministic pair_score for items in the ambiguous band
   * sent to this LLM (see commit route).  Calibrated: 0.8 ≈ 80% confident.
   */
  confidence: number;
  /** Free-text explanation. Null when confidence < 0.05. */
  reasoning: string | null;
  /**
   * Signal flags that influenced the decision:
   * "domain_knowledge_required" | "acronym_decisive" | "abbreviation_decisive" |
   * "different_entities"
   */
  flags: string[];
};

export type PairscoreLLMResult = {
  parsed: LLMPairscoreResponse;
  rawText: string;
  usage: PairscoreLLMUsage;
  /**
   * Wall-clock milliseconds from just before the HTTP request was sent to
   * just after the response JSON was fully parsed.  Does NOT include
   * retry back-off sleep.
   */
  llm_call_ms: number;
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const PAIRSCORE_SYSTEM_PROMPT_TEMPLATE = `\
You are an entity-resolution assistant.

You are comparing two raw string values that both appeared in the same source
data column.  Neither value has been matched to any known canonical entity —
they are both unclassified.  Your job is to decide whether these two strings
likely refer to the same real-world entity.

When deciding whether two items refer to the same entity, match the level of
granularity that is natural for this concept. Two items should only be grouped
if they are different surface forms of the exact same entity — not if one is a
parent, child, division, subsidiary, regional variant, or related-but-distinct
version of the other.

Examples of items that should NOT be grouped:
- A parent company and its subsidiary (they are distinct legal entities)
- A brand and a sub-brand (they are distinct products)
- A national entity and a regional branch (they are distinct operations)
- Two related but independently named organizations

When in doubt about whether two items are the same entity or merely related
entities, do not group them. A human reviewer can merge groups that should be
together. A human reviewer cannot easily detect groups that should have been
kept apart.

You receive structured features computed by a deterministic pipeline.  These
features measure token overlap, string similarity, acronym relationships, and
exact matches between the two strings.  Use them as factual evidence.

The pipeline has no world knowledge.  It cannot recognize that "VZW" is short
for "Verizon Wireless", or that "A T & T" is a spaced rendering of "AT&T".
When your domain knowledge changes the answer, use it and flag the response.

For the acronym section:  use your world knowledge to determine whether one
value is an acronym, abbreviation, or shorthand for the other.  First-letter
extraction alone misses cases like "VZW", "BoA", "AmEx", "TMo".  Your judgment
here supersedes the deterministic scores.  Flag "acronym_decisive" when an
acronym or abbreviation relationship drove your decision.

Your output is a confidence value in [0, 1] representing the probability
that the two strings refer to the same real-world entity.  Calibration matters
— 0.8 means ~80 % likely the same.  Avoid clustering near 0 or 1 unless the
evidence is decisive.

If confidence is below 0.05, reasoning may be null.

Respond ONLY in valid JSON matching this schema:
{
  "same_entity": boolean,
  "confidence": number,
  "reasoning": string | null,
  "flags": string[]
}

---

CONCEPT: {{concept_name}}
DEFINITION: {{concept_definition}}`;

// Defined locally to avoid importing Anthropic SDK internal types.
type TextBlockParam = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

/**
 * Build the static cached system block for a run.
 *
 * Identical for every pair in a given run — only the user message (feature
 * payload) changes per call.  The Anthropic prompt-caching layer recognises
 * the stable content and charges ~10 % after the first call warms the cache.
 */
export function buildPairscoreSystemBlock(
  conceptName: string,
  conceptDefinition: string,
): TextBlockParam[] {
  const text = PAIRSCORE_SYSTEM_PROMPT_TEMPLATE
    .replace('{{concept_name}}', conceptName)
    .replace('{{concept_definition}}', conceptDefinition || '(no definition provided)');

  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// ---------------------------------------------------------------------------
// Feature payload builder
// ---------------------------------------------------------------------------

/**
 * Build the per-pair user-message payload sent to the LLM.
 *
 * Includes all PairScore sub-components EXCEPT:
 *  - item_importance_a / b / avg_importance  (I — internal token weight term)
 *  - lf_norm_a / b / avg_lf_norm             (LF — length-factor weight term)
 *  - ac_x, ac_i_wlf, ac_penalty              (internal AC formula intermediates)
 * These are formula implementation details that the LLM cannot meaningfully
 * interpret and would only add noise to the prompt.
 */
export function buildPairscorePayload(
  itemA: RunItemForPairing,
  itemB: RunItemForPairing,
  pairScore: number,
  details: PairScoreDetails,
): Record<string, unknown> {
  return {
    item_a: {
      literal_value:       itemA.literal_value,
      cleaned_value:       itemA.cleaned_value,
      normalization_value: itemA.normalization_value,
      std_tokens:          itemA.std_tokens,
      norm_tokens:         itemA.norm_tokens,
    },
    item_b: {
      literal_value:       itemB.literal_value,
      cleaned_value:       itemB.cleaned_value,
      normalization_value: itemB.normalization_value,
      std_tokens:          itemB.std_tokens,
      norm_tokens:         itemB.norm_tokens,
    },
    deterministic_score: pairScore,
    components: {
      M_pair:  details.M_pair,
      TS_pair: details.TS_pair,
      SS_pair: details.SS_pair,
      AC_pair: details.AC_pair,
    },
    exact_match: {
      M_clean_val:      details.M_clean_val,
      M_normalized_val: details.M_normalized_val,
      M_s_token_sig:    details.M_s_token_sig,
      M_n_token_sig:    details.M_n_token_sig,
    },
    token_similarity: {
      intersecting_std_tokens:  details.IS_s_token_sig,
      intersecting_norm_tokens: details.IS_n_token_sig,
      overlap_coeff_std:        details.OC_s_token_sig,
      overlap_coeff_norm:       details.OC_n_token_sig,
      lcs_std:                  details.LS_s_token_sig,
      lcs_norm:                 details.LS_n_token_sig,
    },
    string_similarity: {
      jaro_winkler: details.JW_pair,
      levenshtein:  details.LV_pair,
    },
    acronym: {
      exact_acronym_match:  details.ac_exact,
      partial_acronym_score: details.ac_partial,
      acronym_len:           details.ac_acronym_len,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Score a single (itemA, itemB) pair using the LLM.
 *
 * Uses raw fetch to match the Anthropic API spec including prompt-caching
 * headers.  Throws on network error, non-200 response, or JSON parse failure —
 * the caller handles retries and falls back to the deterministic score on
 * exhausted retries.
 */
export async function scorePairWithPairscoreLLM(
  cachedSystemBlock: ReturnType<typeof buildPairscoreSystemBlock>,
  payload: Record<string, unknown>,
): Promise<PairscoreLLMResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[llm-pairscore] ANTHROPIC_API_KEY is not set.');

  const llmCallStart = Date.now();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: PAIRSCORE_LLM_MODEL,
      max_tokens: 512,
      system: cachedSystemBlock,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    const err = new Error(`[llm-pairscore] Anthropic API ${res.status}: ${body}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`[llm-pairscore] No text block in response: ${JSON.stringify(data)}`);
  }

  const raw = textBlock.text;
  let cleaned: string;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    const stripped = raw.replace(/```json\n?/g, '').replace(/```/g, '');
    const firstBrace = stripped.indexOf('{');
    const lastBrace  = stripped.lastIndexOf('}');
    cleaned = firstBrace !== -1 && lastBrace > firstBrace
      ? stripped.slice(firstBrace, lastBrace + 1)
      : stripped.trim();
  }

  const usage: PairscoreLLMUsage = {
    input_tokens:                  data.usage?.input_tokens                  ?? 0,
    output_tokens:                 data.usage?.output_tokens                 ?? 0,
    cache_read_input_tokens:       data.usage?.cache_read_input_tokens       ?? 0,
    cache_creation_input_tokens:   data.usage?.cache_creation_input_tokens   ?? 0,
  };

  try {
    const parsed = JSON.parse(cleaned) as LLMPairscoreResponse;
    return { parsed, rawText: raw, usage, llm_call_ms: Date.now() - llmCallStart };
  } catch {
    throw new Error(`[llm-pairscore] Failed to parse LLM JSON: ${raw}`);
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps scorePairWithPairscoreLLM with up to maxRetries attempts on HTTP 429.
 * Back-off: 1 s, 2 s, 4 s (exponential).
 * Returns null when retries are exhausted — caller keeps the deterministic score.
 */
export async function scorePairWithPairscoreRetry(
  cachedSystemBlock: ReturnType<typeof buildPairscoreSystemBlock>,
  payload: Record<string, unknown>,
  maxRetries = 3,
): Promise<PairscoreLLMResult | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await scorePairWithPairscoreLLM(cachedSystemBlock, payload);
    } catch (err) {
      const is429 = err instanceof Error && (err as Error & { status?: number }).status === 429;
      if (is429 && attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        console.warn(`[llm-pairscore] HTTP 429 — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.error(`[llm-pairscore] LLM call failed (attempt ${attempt + 1}/${maxRetries}):`, err);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Concurrency helper (mirrors parallelWithLimit in apply-confident-assignments)
// ---------------------------------------------------------------------------

export const PAIRSCORE_LLM_CONCURRENCY = 10;

export async function parallelPairscoreLLM<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number = PAIRSCORE_LLM_CONCURRENCY,
): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing: Promise<R>[] = [];

  for (const item of items) {
    const promise: Promise<R> = fn(item).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    results.push(promise);
    executing.push(promise);
    if (executing.length >= limit) await Promise.race(executing);
  }

  return Promise.all(results);
}
