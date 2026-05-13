/**
 * LLM call infrastructure for the LLM-enhanced grouping pipeline.
 *
 * Utilities exported from this module:
 *   - callGroupingLLM   — phase-agnostic LLM wrapper with exponential-backoff retry
 *   - shouldCallLLM     — pure pre-filter deciding whether a pair needs an LLM call
 *   - runLLMCalls       — parallel executor with a configurable concurrency limit
 *   - scorePairWithLLM  — LLM pairscore for the ambiguous band (standalone; not wired to phases yet)
 *
 * No caching of any kind lives here. No phase logic lives here.
 */

import { LLM_MODEL_ID } from './llm-confidence';
import {
  buildGroupingSystemPrompt,
  type GroupingConcept,
  type ItemMetadata,
} from './grouping-utils';

// ---------------------------------------------------------------------------
// Named thresholds and limits
// ---------------------------------------------------------------------------

/** Pair score at or above this value is a clear YES; no LLM call needed. */
export const CLEAR_YES_THRESHOLD = 0.30;

/** Pair score below this value (with no other signals) is a clear NO; skip LLM. */
export const CLEAR_NO_THRESHOLD = 0.08;

/** Maximum number of LLM calls in flight simultaneously across all phases. */
export const LLM_CONCURRENCY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Signals extracted from a PairScoreResult that the pre-filter inspects.
 * Build this from PairScoreResult / PairScoreDetails before calling shouldCallLLM.
 */
export interface GroupingPairSignals {
  /** Overall combined pair score (pair_score from PairScoreResult). */
  combined: number;
  /** True if M_clean_val > 0 (any exact clean-value match fired). */
  exact_clean_val: boolean;
  /** True if M_normalized_val > 0 (any exact normalized-value match fired). */
  exact_normalized_val: boolean;
  /** True if AC_pair > 0 (the acronym component fired). */
  acronym_fired: boolean;
}

/**
 * The system-prompt block shape produced by buildGroupingSystemPrompt.
 * Defined locally so this module has no dependency on the Anthropic SDK.
 * Mirrors the TextBlockParam type in llm-confidence.ts.
 */
type SystemBlock = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

// ---------------------------------------------------------------------------
// Part 1 — LLM call wrapper
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic API for a single grouping decision.
 *
 * - Model: LLM_MODEL_ID (claude-haiku-4-5-20251001). max_tokens: 1024.
 * - systemPrompt must be built by buildGroupingSystemPrompt (already carries
 *   cache_control: { type: "ephemeral" }). Passed directly as the API `system` field.
 * - featurePayload is JSON-serialised as the user message content.
 * - Returns the parsed JSON object from the model's response.
 * - Retries `retries` times (default 3) on: network errors, HTTP 429,
 *   HTTP 5xx, and JSON parse failures.
 *   Backoff: wait 1 s before retry 1, 2 s before retry 2, 4 s before retry 3.
 * - Throws with context if all retries are exhausted.
 *   Does NOT fall back to deterministic scoring — the caller decides.
 */
export async function callGroupingLLM(
  systemPrompt: SystemBlock[],
  featurePayload: Record<string, unknown>,
  retries = 3,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('[grouping-llm] ANTHROPIC_API_KEY environment variable is not set.');
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Exponential backoff before every retry (not before the first attempt).
    if (attempt > 0) {
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1 s, 2 s, 4 s
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify({
          model: LLM_MODEL_ID,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: JSON.stringify(featurePayload, null, 2),
            },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)');
        const apiErr = new Error(`[grouping-llm] Anthropic API ${res.status}: ${body}`);
        (apiErr as Error & { status: number }).status = res.status;

        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (isRetryable && attempt < retries) {
          lastError = apiErr;
          console.warn(
            `[grouping-llm] HTTP ${res.status} — will retry (attempt ${attempt + 1}/${retries + 1})`,
          );
          continue;
        }
        // 4xx client errors (other than 429) are not retried.
        throw apiErr;
      }

      const data = await res.json() as {
        content?: Array<{ type: string; text?: string }>;
      };

      const textBlock = data.content?.find((b) => b.type === 'text');
      if (!textBlock?.text) {
        throw new Error(
          `[grouping-llm] No text block in Anthropic response: ${JSON.stringify(data)}`,
        );
      }

      const raw = textBlock.text;

      // Strip optional markdown fences before JSON.parse, mirroring llm-confidence.ts.
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

      try {
        return JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        // JSON parse failure is retryable.
        lastError = new Error(
          `[grouping-llm] JSON parse failed (attempt ${attempt + 1}/${retries + 1}): ${raw}`,
        );
        console.warn(String(lastError));
        continue;
      }
    } catch (err) {
      // Re-throw non-retryable errors (e.g. 4xx) immediately.
      const status = (err as Error & { status?: number }).status;
      if (status != null && status >= 400 && status < 500 && status !== 429) throw err;

      // Network / fetch error — retryable.
      lastError = err;
      if (attempt < retries) {
        console.warn(
          `[grouping-llm] Fetch error (attempt ${attempt + 1}/${retries + 1}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // All attempts exhausted — include context for debugging.
  const payloadHint = (() => {
    try {
      return `payload keys: [${Object.keys(featurePayload).slice(0, 4).join(', ')}]`;
    } catch {
      return 'payload: (unserializable)';
    }
  })();

  throw new Error(
    `[grouping-llm] All ${retries + 1} attempt(s) failed. ${payloadHint}. ` +
    `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Part 2 — Pre-filter
// ---------------------------------------------------------------------------

/**
 * Decide whether this pair should be sent to the LLM.
 *
 * Returns true  → call the LLM (acronym signal, or ambiguous band).
 * Returns false → skip the LLM (clear YES handled deterministically, or clear NO).
 *
 * Evaluation order:
 *   1. acronym_fired → always return true (world knowledge required).
 *   2. combined < CLEAR_NO_THRESHOLD AND no exact/acronym signals → false (clear NO).
 *   3. combined >= CLEAR_YES_THRESHOLD AND no acronym → false (clear YES).
 *   4. Everything else (ambiguous band [CLEAR_NO_THRESHOLD, CLEAR_YES_THRESHOLD)) → true.
 *
 * A false return for a clear YES pair means the LLM is not needed for that
 * pair — not that the pair is ignored. The calling phase is responsible for
 * acting on clear YES pairs correctly without an LLM call.
 *
 * Pure function; no side effects.
 */
export function shouldCallLLM(pairScore: GroupingPairSignals): boolean {
  // Rule 1: acronym always requires LLM review.
  if (pairScore.acronym_fired) return true;

  // Rule 2: too weak with no other signals — skip.
  if (
    pairScore.combined < CLEAR_NO_THRESHOLD &&
    !pairScore.exact_clean_val &&
    !pairScore.exact_normalized_val
  ) {
    return false;
  }

  // Rule 3: strong enough to accept deterministically — skip.
  if (pairScore.combined >= CLEAR_YES_THRESHOLD) return false;

  // Rule 4: ambiguous band — send to LLM.
  return true;
}

// ---------------------------------------------------------------------------
// Part 3 — Parallel executor
// ---------------------------------------------------------------------------

/**
 * Execute an array of async call thunks in parallel, at most `concurrencyLimit`
 * in-flight at once. Returns results in the same order as the input array,
 * regardless of completion order.
 *
 * Always use this function for batch LLM calls across all phases.
 * Never call Promise.all directly on LLM batches.
 */
export async function runLLMCalls<T>(
  calls: Array<() => Promise<T>>,
  concurrencyLimit: number = LLM_CONCURRENCY_LIMIT,
): Promise<T[]> {
  const results: Promise<T>[] = [];
  const executing: Promise<T>[] = [];

  for (const call of calls) {
    const promise: Promise<T> = call().then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrencyLimit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ---------------------------------------------------------------------------
// Pairscore LLM — ambiguous-band replacement (standalone; caller integrates)
// ---------------------------------------------------------------------------

/** Deterministic PairScore inputs that populate the LLM feature payload. */
export interface PairscoreDeterministicComponents {
  combined: number;
  exact_clean_val: boolean;
  exact_normalized_val: boolean;
  exact_std_token_sig: boolean;
  exact_norm_token_sig: boolean;
  overlap_coeff_std: number;
  overlap_coeff_norm: number;
  intersecting_tokens_std: string[];
  intersecting_tokens_norm: string[];
  lcs_std: number;
  lcs_norm: number;
  jaro_winkler: number;
  levenshtein: number;
  acronym_initials: string;
  acronym_normalized_initials: string;
  acronym_exact: boolean;
  acronym_partial: number;
  is_all_caps_a: boolean;
  is_all_caps_b: boolean;
  /** True when the deterministic acronym component contributed a non-zero score. */
  acronym_fired: boolean;
  subset_a_in_b: boolean;
  subset_b_in_a: boolean;
}

export type PairscoreLLMOutputFlag =
  | 'domain_knowledge_required'
  | 'acronym_decisive'
  | 'abbreviation_expansion'
  | 'degenerate_token_match'
  | 'clear_mismatch';

export interface PairscoreLLMResponse {
  confidence: number;
  match: boolean;
  reasoning: string | null;
  flags: PairscoreLLMOutputFlag[];
  deterministic_assessment: {
    agrees_with_baseline: boolean;
    disagreement_direction: 'agree' | 'model_higher' | 'model_lower';
  };
}

const PAIRSCORE_LLM_OUTPUT_FLAG_SET = new Set<string>([
  'domain_knowledge_required',
  'acronym_decisive',
  'abbreviation_expansion',
  'degenerate_token_match',
  'clear_mismatch',
]);

function bothNormalizeToSingleToken(a: ItemMetadata, b: ItemMetadata): boolean {
  return (
    a.normalized_token_signature.length === 1 &&
    b.normalized_token_signature.length === 1
  );
}

function intersectingTokensAreShort(intersectingNorm: string[]): boolean {
  if (intersectingNorm.length === 0) return false;
  return intersectingNorm.every((t) => t.length <= 2);
}

function lengthRatioExtreme(a: ItemMetadata, b: ItemMetadata): boolean {
  return (
    Math.abs(
      a.standard_token_signature.length - b.standard_token_signature.length,
    ) >= 3
  );
}

function possibleAbbreviation(a: ItemMetadata, b: ItemMetadata): boolean {
  return (
    a.flags.is_pure_acronym ||
    b.flags.is_pure_acronym ||
    a.standard_token_signature.length <= 1 ||
    b.standard_token_signature.length <= 1
  );
}

/**
 * Map ItemMetadata to the `item_a` / `item_b` shape in the pairscore user payload
 * (same field names as ItemMetadata for the included subset).
 */
function itemMetadataToPayloadBlock(meta: ItemMetadata) {
  return {
    literal_value: meta.literal_value,
    clean_value: meta.clean_value,
    normalized_value: meta.normalized_value,
    standard_token_signature: meta.standard_token_signature,
    normalized_token_signature: meta.normalized_token_signature,
    per_token: meta.per_token,
    flags: meta.flags,
  };
}

const PAIRSCORE_OUTPUT_SCHEMA_TEXT = `{
  "confidence": number,
  "match": boolean,
  "reasoning": string | null,
  "flags": string[],
  "deterministic_assessment": {
    "agrees_with_baseline": boolean,
    "disagreement_direction": "agree" | "model_higher" | "model_lower"
  }
}`;

/**
 * Build the pairscore feature payload (JSON-serialisable; no comments).
 */
function buildPairscoreLLMFeaturePayload(
  itemMetadataA: ItemMetadata,
  itemMetadataB: ItemMetadata,
  d: PairscoreDeterministicComponents,
): Record<string, unknown> {
  const norm = d.intersecting_tokens_norm;

  return {
    task: 'pairscore',
    instructions:
      'Return a confidence score in [0,1] representing the probability these two items refer to the same real-world entity. Use the deterministic features as evidence. Use your world knowledge for acronym and abbreviation relationships the pipeline cannot detect. Respond only in valid JSON matching the output_schema. Do not include any text outside the JSON object.',
    output_schema: PAIRSCORE_OUTPUT_SCHEMA_TEXT,
    output_schema_fields: {
      confidence:
        '[0,1] probability these two items refer to the same entity. Calibrated — 0.8 means ~80% likely correct.',
      match: 'true if confidence >= 0.5',
      reasoning:
        'one sentence referencing at least one specific feature or token; null if confidence < 0.05',
      flags: [
        'domain_knowledge_required',
        'acronym_decisive',
        'abbreviation_expansion',
        'degenerate_token_match',
        'clear_mismatch',
      ],
      deterministic_assessment: {
        agrees_with_baseline:
          'true if model confidence and deterministic combined_score agree on match/no-match at the 0.18 baseline threshold',
        disagreement_direction: 'agree | model_higher | model_lower',
      },
    },
    item_a: itemMetadataToPayloadBlock(itemMetadataA),
    item_b: itemMetadataToPayloadBlock(itemMetadataB),
    deterministic_components: {
      combined_score: d.combined,
      exact_match: {
        exact_clean_value: d.exact_clean_val,
        exact_normalized_value: d.exact_normalized_val,
        exact_standard_token_sig: d.exact_std_token_sig,
        exact_normalized_token_sig: d.exact_norm_token_sig,
      },
      token_similarity: {
        overlap_coefficient_standard: d.overlap_coeff_std,
        overlap_coefficient_normalized: d.overlap_coeff_norm,
        intersecting_tokens_standard: d.intersecting_tokens_std,
        intersecting_tokens_normalized: d.intersecting_tokens_norm,
        lcs_score_standard: d.lcs_std,
        lcs_score_normalized: d.lcs_norm,
        subset_a_in_b: d.subset_a_in_b,
        subset_b_in_a: d.subset_b_in_a,
      },
      string_similarity: {
        jaro_winkler: d.jaro_winkler,
        levenshtein: d.levenshtein,
      },
      acronym: {
        acronym_initials: d.acronym_initials,
        acronym_normalized_initials: d.acronym_normalized_initials,
        acronym_exact_match: d.acronym_exact,
        acronym_partial_score: d.acronym_partial,
        is_all_caps_a: d.is_all_caps_a,
        is_all_caps_b: d.is_all_caps_b,
      },
      flags: {
        acronym_fired: d.acronym_fired,
        both_normalize_to_single_token: bothNormalizeToSingleToken(
          itemMetadataA,
          itemMetadataB,
        ),
        intersecting_tokens_are_short: intersectingTokensAreShort(norm),
        length_ratio_extreme: lengthRatioExtreme(itemMetadataA, itemMetadataB),
        possible_abbreviation: possibleAbbreviation(itemMetadataA, itemMetadataB),
      },
    },
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Compare deterministic baseline (0.18) vs model confidence at same threshold for agreement stats. */
function computeDeterministicAssessment(
  combined: number,
  confidence: number,
): PairscoreLLMResponse['deterministic_assessment'] {
  const detYes = combined >= 0.18;
  const modelYes018 = confidence >= 0.18;
  const agrees = detYes === modelYes018;
  let disagreement_direction: 'agree' | 'model_higher' | 'model_lower';
  if (agrees) {
    disagreement_direction = 'agree';
  } else if (modelYes018 && !detYes) {
    disagreement_direction = 'model_higher';
  } else {
    disagreement_direction = 'model_lower';
  }
  return {
    agrees_with_baseline: agrees,
    disagreement_direction,
  };
}

function parsePairscoreLLMResponse(
  raw: Record<string, unknown>,
  combined: number,
): PairscoreLLMResponse {
  const conf = clamp01(Number(raw.confidence));
  const match =
    typeof raw.match === 'boolean' ? raw.match : conf >= 0.5;

  let reasoning: string | null = null;
  if (typeof raw.reasoning === 'string') {
    reasoning = raw.reasoning;
  } else if (raw.reasoning === null) {
    reasoning = null;
  }

  const flagsIn = Array.isArray(raw.flags) ? raw.flags : [];
  const flags: PairscoreLLMOutputFlag[] = [];
  for (const f of flagsIn) {
    const s = String(f);
    if (PAIRSCORE_LLM_OUTPUT_FLAG_SET.has(s)) {
      flags.push(s as PairscoreLLMOutputFlag);
    }
  }

  let assessment: PairscoreLLMResponse['deterministic_assessment'];
  const da = raw.deterministic_assessment;
  if (
    da != null &&
    typeof da === 'object' &&
    !Array.isArray(da) &&
    typeof (da as Record<string, unknown>).agrees_with_baseline === 'boolean' &&
    typeof (da as Record<string, unknown>).disagreement_direction === 'string'
  ) {
    const dir = (da as Record<string, unknown>).disagreement_direction as string;
    if (dir === 'agree' || dir === 'model_higher' || dir === 'model_lower') {
      assessment = {
        agrees_with_baseline: (da as Record<string, unknown>)
          .agrees_with_baseline as boolean,
        disagreement_direction: dir,
      };
    } else {
      assessment = computeDeterministicAssessment(combined, conf);
    }
  } else {
    assessment = computeDeterministicAssessment(combined, conf);
  }

  return {
    confidence: conf,
    match,
    reasoning: conf < 0.05 ? null : reasoning,
    flags,
    deterministic_assessment: assessment,
  };
}

/**
 * LLM-based pairscore for two unassigned items in the ambiguous band.
 *
 * `itemA` and `itemB` must be **ItemMetadata** objects from `buildItemMetadata`
 * (Phase 0) — do not pass raw run rows or rebuild metadata here.
 *
 * System prompt: `buildGroupingSystemPrompt(concept)` — the shared grouping
 * assistant prompt (bias toward not grouping, domain knowledge for acronyms).
 *
 * Wraps `callGroupingLLM` (same retries and model as the rest of the pipeline).
 */
export async function scorePairWithLLM(
  itemA: ItemMetadata,
  itemB: ItemMetadata,
  deterministicComponents: PairscoreDeterministicComponents,
  concept: GroupingConcept,
): Promise<PairscoreLLMResponse> {
  const systemPrompt = buildGroupingSystemPrompt(concept);
  const featurePayload = buildPairscoreLLMFeaturePayload(
    itemA,
    itemB,
    deterministicComponents,
  );
  const raw = await callGroupingLLM(systemPrompt, featurePayload);
  return parsePairscoreLLMResponse(raw, deterministicComponents.combined);
}
