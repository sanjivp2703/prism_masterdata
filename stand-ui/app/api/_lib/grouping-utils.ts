/**
 * Shared building blocks for the LLM-enhanced grouping pipeline.
 *
 * Two utilities exported from this module:
 *   - buildGroupingSystemPrompt — constructs the Anthropic-cached system block
 *     sent on every LLM call across all grouping phases.
 *   - buildItemMetadata — transforms a loaded run item into a reusable
 *     metadata object computed once per item and passed to all phases.
 *
 * Neither function makes any database or LLM calls.
 */

import { DEFAULT_GENERIC_STOPWORDS } from './namescore';

// ---------------------------------------------------------------------------
// Types — concept input
// ---------------------------------------------------------------------------

export interface GroupingConcept {
  concept_name: string;
  concept_definition: string;
}

// ---------------------------------------------------------------------------
// Types — run item input
// ---------------------------------------------------------------------------

/**
 * A run item loaded into memory before the grouping pipeline starts.
 * All fields are pre-computed; buildItemMetadata does not query the database.
 *
 * Note: source_frequency, source_frequency_rank, token_rarities,
 * token_char_weights, and token_importances are not yet stored in RUN_ITEMS.
 * Pass null / empty arrays until the schema is extended.
 */
export interface GroupingRunItem {
  run_item_id: number;
  /** Original unprocessed string from the source column. */
  raw_value: string;
  /** String after punctuation-to-space conversion and whitespace collapse. */
  clean_value: string;
  /** String after stopword removal and deterministic rewrites applied to clean_value tokens. */
  normalized_value: string;
  /**
   * Lowercased tokens from clean_value after word tokenization,
   * alpha-numeric splitting, and camel/pascal case splitting.
   * Full token set before any stopword removal.
   */
  tokens: string[];
  /** Tokens after stopword removal applied to standard_token_signature. */
  normalized_tokens: string[];
  /** Count of source rows containing this exact raw_value. Null until schema supports it. */
  source_frequency: number | null;
  /** Rank of raw_value by frequency among distinct source column values. Null until schema supports it. */
  source_frequency_rank: number | null;
  /**
   * IDF-like rarity per token in the standard token signature.
   * Parallel to tokens[]; range [0, 1]; higher = more distinctive.
   * Pass [] until the column exists.
   */
  token_rarities: number[];
  /**
   * Character-length penalty per token.
   * Parallel to tokens[]; range [0, 1].
   * Pass [] until the column exists.
   */
  token_char_weights: number[];
  /**
   * Computed importance per token combining rarity, char_weight, and position decay.
   * Parallel to tokens[].
   * Pass [] until the column exists.
   */
  token_importances: number[];
}

// ---------------------------------------------------------------------------
// Types — buildItemMetadata output
// ---------------------------------------------------------------------------

export interface PerTokenMeta {
  token: string;
  /** IDF-like rarity; range [0, 1]; higher = more distinctive. */
  rarity: number;
  /** Character-length penalty; range [0, 1]. */
  char_weight: number;
  /** Importance combining rarity, char_weight, and position decay. */
  importance: number;
  /** 1-indexed position in standard_token_signature. */
  position: number;
}

export interface ItemMetadataFlags {
  /**
   * True if literal_value is 2–5 characters, all uppercase alpha,
   * no spaces or punctuation (e.g. "VZW", "ATT").
   */
  is_pure_acronym: boolean;
  /** True if normalized_token_signature has length 0. */
  normalized_signature_is_empty: boolean;
  /**
   * True if every token in standard_token_signature is a known stopword.
   * Uses DEFAULT_GENERIC_STOPWORDS from namescore.ts (the existing TypeScript
   * stopword list). Returns false for empty token sets.
   */
  all_tokens_are_stopwords: boolean;
}

export interface ItemMetadata {
  /** Original unprocessed string from the source column. */
  literal_value: string;
  /** String after punctuation-to-space conversion and whitespace collapse. */
  clean_value: string;
  /** String after stopword removal and deterministic rewrites. */
  normalized_value: string;
  /**
   * Lowercased tokens from clean_value; full set before stopword removal.
   */
  standard_token_signature: string[];
  /** Tokens after stopword removal. */
  normalized_token_signature: string[];
  /** Row count for this exact literal_value in the source table. Null until schema supports it. */
  source_frequency: number | null;
  /** Frequency rank among distinct source column values. Null until schema supports it. */
  source_frequency_rank: number | null;
  /** One entry per token in standard_token_signature, in order. */
  per_token: PerTokenMeta[];
  /** Surface-form flags derived from the item without external data. */
  flags: ItemMetadataFlags;
}

// ---------------------------------------------------------------------------
// Internal — Anthropic system block type
//
// Defined locally so this module has no dependency on the Anthropic SDK
// internals. Mirrors the shape used in llm-confidence.ts.
// ---------------------------------------------------------------------------

type SystemTextBlock = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

// ---------------------------------------------------------------------------
// Part 1 — System prompt
// ---------------------------------------------------------------------------

const GROUPING_SYSTEM_PROMPT_TEMPLATE = `\
You are a grouping assistant for an entity-resolution system.

You are working with raw string values from a source data column that have NOT been matched to any known canonical entity. Your job is to decide whether specific items or groups of items refer to the same real-world entity.

You receive structured features computed by a deterministic pipeline. These features measure token overlap, string similarity, acronym matches, and exact matches between items. Use them as evidence.

The pipeline does not have world knowledge. It cannot recognize that "VZW" abbreviates "Verizon Wireless", or that "T-Mo" means T-Mobile. When such cases arise, use your domain knowledge and include the flag "domain_knowledge_required".

These items have already failed to match any existing known alias. You are deciding how to cluster them into candidate new entities for human review.

Bias toward NOT grouping when uncertain. Under-clustering is safe — a human reviewer can drag items together. Over-clustering creates incorrect groupings that are harder for humans to catch and fix.

CONCEPT: {concept_name}
DEFINITION: {concept_definition}`;

/**
 * Build the cached system block for the LLM-enhanced grouping pipeline.
 *
 * Returns a single-element array in the format expected by the Anthropic
 * messages API `system` field. The block carries cache_control so Anthropic's
 * prompt-caching layer recognises identical content across all LLM calls
 * within a run and charges ~10 % of normal input-token cost after the first
 * call warms the cache.
 *
 * The block is constant for every LLM call in a run for a given concept —
 * only per-call user messages (feature payloads) differ.
 *
 * Pass the returned array directly as `system` in the Anthropic API request
 * body alongside `anthropic-beta: prompt-caching-2024-07-31`.
 */
export function buildGroupingSystemPrompt(concept: GroupingConcept): SystemTextBlock[] {
  const text = GROUPING_SYSTEM_PROMPT_TEMPLATE
    .replace('{concept_name}', concept.concept_name)
    .replace('{concept_definition}', concept.concept_definition || '(no definition provided)');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Part 2 — Item metadata
// ---------------------------------------------------------------------------

/**
 * Transform a loaded run item into a reusable metadata object.
 *
 * Call once per item at the start of the grouping pipeline run and keep
 * the result in memory. Pass it to all phases that need it. No database
 * calls are made here.
 */
export function buildItemMetadata(item: GroupingRunItem): ItemMetadata {
  const per_token: PerTokenMeta[] = item.tokens.map((token, idx) => ({
    token,
    rarity:      item.token_rarities[idx]     ?? 0,
    char_weight: item.token_char_weights[idx] ?? 0,
    importance:  item.token_importances[idx]  ?? 0,
    position:    idx + 1,
  }));

  // is_pure_acronym: 2–5 characters, all uppercase alpha, no spaces or punctuation
  const rawVal = item.raw_value;
  const is_pure_acronym =
    rawVal.length >= 2 &&
    rawVal.length <= 5 &&
    /^[A-Z]+$/.test(rawVal);

  const normalized_signature_is_empty = item.normalized_tokens.length === 0;

  // all_tokens_are_stopwords: every token in the standard set is in DEFAULT_GENERIC_STOPWORDS.
  // Empty token sets are not considered "all stopwords" (returns false).
  const all_tokens_are_stopwords =
    item.tokens.length > 0 &&
    item.tokens.every((t) => DEFAULT_GENERIC_STOPWORDS.has(t.toLowerCase()));

  return {
    literal_value:               item.raw_value,
    clean_value:                 item.clean_value,
    normalized_value:            item.normalized_value,
    standard_token_signature:    item.tokens,
    normalized_token_signature:  item.normalized_tokens,
    source_frequency:            item.source_frequency,
    source_frequency_rank:       item.source_frequency_rank,
    per_token,
    flags: {
      is_pure_acronym,
      normalized_signature_is_empty,
      all_tokens_are_stopwords,
    },
  };
}
