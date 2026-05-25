/**
 * Chunked parallel LLM grouping ("1 Prompt" mode).
 *
 * **Chunk Grouping Prompt** — one Anthropic call per item chunk (parallel).
 * **Chunk Merging Prompt** — one sequential call that merges proposed groups
 * across chunks when there are 2+ chunks.
 *
 * Splits unassigned items into chunks of MAX_ITEMS_PER_CHUNK and issues one
 * Chunk Grouping Prompt per chunk, all in parallel.  Results are folded into a
 * single FinalGroup[] + confidence_scores Map before returning.
 *
 * Token-budget rationale for MAX_ITEMS_PER_CHUNK = 25:
 *   • Per-item input  ≈  50 tokens (250 chars of field data — no numeric signals)
 *   • Per-item output ≈ 100 tokens (compact group JSON)
 *   • Fixed overhead  ≈ 400 tokens (system prompt + user preamble)
 *   → 25 items ≈ 1 650 input + 2 500 output — comfortable under 8 192 max_tokens.
 *
 * Items in different chunks are never grouped together by the Chunk Grouping
 * Prompt alone — the Chunk Merging Prompt reconciles duplicates across chunks.
 *
 * Why no rarity / importance numerics in the prompt:
 *   token_rarities, token_char_weights, and token_importances are NOT stored in
 *   RUN_ITEMS (schema TODO).  Computing them from the unassigned batch alone
 *   produces misleading IDF values — a common token like "verizon" could look
 *   distinctive if it only appears in a few of the unassigned items, even though
 *   it is ubiquitous concept-wide.  The LLM has world knowledge and does not
 *   need these numerics; sending inaccurate values would actively mislead it.
 *
 * Entry point: runOnePromptGrouping(items, conceptName, conceptDefinition)
 */

import fs   from 'fs';
import path from 'path';
import type { RunItemForPairing } from './pairscore';
import type { FinalGroup } from './clique-detection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GROUPING_MODEL_ID = 'claude-sonnet-4-6' as const;

/**
 * Max items per LLM call.  Derived from token-budget analysis in the file
 * header.  Lower = safer JSON, more parallel calls.  Higher = fewer calls but
 * risks truncation.  25 is the calibrated sweet spot.
 */
const MAX_ITEMS_PER_CHUNK = 25;

/**
 * Output token ceiling per chunk call.  8 192 comfortably covers 25 items
 * (≈2 500 tokens worst-case output) with headroom for verbose reasoning.
 */
const MAX_OUTPUT_TOKENS = 8_192;

// Confidence band → numeric score stored in RUN_ITEMS.confidence_score.
// Accepts both the compact single-char form ("h"/"m"/"l") used in the new
// output format and the full words for backward-compat with old breakdown files.
const CONFIDENCE_MAP: Record<string, number> = {
  h: 0.90, high:   0.90,
  m: 0.65, medium: 0.65,
  l: 0.40, low:    0.40,
};

// Fallback score used for items the LLM silently omits (treated as singletons).
const SINGLETON_DEFAULT_SCORE = 0.50;

// ---------------------------------------------------------------------------
// LLM JSON response shapes  (compact format)
// ---------------------------------------------------------------------------
//
// The model now emits:
//   { "g": [ [[item_indices], "proposed_name", "h|m|l"], ... ], "u": [item_index, ...] }
//
// Each group is a 3-element tuple: [number[], string|null, "h"|"m"|"l"]
// Unassigned is a flat array of item indices.

type LLMResponseGroup = [number[], string | null, 'h' | 'm' | 'l'];

interface LLMResponse {
  g: LLMResponseGroup[];
  u: number[];
}

// ---------------------------------------------------------------------------
// JSON extraction helpers (models sometimes add preamble or markdown fences)
// ---------------------------------------------------------------------------

/** Strip leading/trailing ```json ... ``` fences, or any inner fenced block. */
function stripMarkdownFences(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, '');
  t = t.replace(/\s*```\s*$/i, '');
  const inner = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (inner?.[1]) return inner[1].trim();
  return t.trim();
}

/**
 * Walk forward from the first `{` using brace depth, respecting string
 * contents (so `{` inside a "reasoning" value does not close the object early).
 */
function extractTopLevelJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth    = 0;
  let inString = false;
  let escape   = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * Try several extraction strategies before giving up:
 *  1. Strip fences, parse directly.
 *  2. Brace-walk the fence-stripped text.
 *  3. Brace-walk the original text (catches preamble + raw JSON).
 *
 * Also normalises Unicode curly-quotes → ASCII and strips C0/C1 control chars
 * that some models occasionally emit and that break JSON.parse.
 */
function normaliseJsonText(s: string): string {
  return s
    // Unicode curly/typographic quotes → ASCII straight quotes
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    // Strip C0 control chars (except tab/newline/CR) and C1 range
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

function tryParseGroupingJson(text: string): LLMResponse | null {
  const stripped = stripMarkdownFences(text);
  const candidates = [
    stripped,
    extractTopLevelJsonObject(stripped),
    extractTopLevelJsonObject(text.trim()),
  ].filter((c): c is string => c != null && c.length > 0);

  const seen = new Set<string>();
  for (const raw of candidates) {
    // Try the candidate as-is, then with normalisation applied.
    for (const c of [raw, normaliseJsonText(raw)]) {
      if (seen.has(c)) continue;
      seen.add(c);
      try { return JSON.parse(c) as LLMResponse; } catch { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATE = `\
You are a grouping assistant for an entity-resolution system.

You are given a set of raw string values from a source data column. Cluster
them into groups where every item in a group refers to the same real-world entity.

For each item you receive: the original raw string, its cleaned form, its
normalized form after stopword removal, the word-level tokens, and two flags.
Use your world knowledge freely — the pipeline cannot recognize that "VZW"
abbreviates "Verizon Wireless" or that "T-Mo" means T-Mobile, but you can.

Only compare items to each other. Do not consider any entities outside of this
batch — group solely based on whether two items in the list refer to the same
real-world entity.

Bias toward not grouping when uncertain. Under-clustering is safe — a human
can drag items together. Over-clustering is harder to fix.

Items with no peer in the batch should be their own singleton group. Items that
are genuinely ambiguous between multiple groups should be left unassigned.

Respond only with valid JSON matching the output schema. No text outside the JSON.

CONCEPT: {concept_name}
DEFINITION: {concept_definition}`;

function buildSystemPrompt(
  conceptName: string,
  conceptDefinition: string,
): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{concept_name}',       conceptName)
    .replace('{concept_definition}', conceptDefinition || '(no definition provided)');
}

// ---------------------------------------------------------------------------
// Item + user-turn builders
// ---------------------------------------------------------------------------

function buildItemBlock(idx: number, item: RunItemForPairing): string {
  const tokens     = item.std_tokens;
  const normTokens = item.norm_tokens;
  return (
    `ITEM ${idx}:\n` +
    `  literal_value: "${item.literal_value}"\n` +
    `  clean_value: "${item.cleaned_value ?? item.literal_value}"\n` +
    `  normalized_value: "${item.normalization_value ?? ''}"\n` +
    `  standard_tokens: [${tokens.map((t) => `"${t}"`).join(', ')}]\n` +
    `  normalized_tokens: [${normTokens.map((t) => `"${t}"`).join(', ')}]\n` +
    `  flags:\n` +
    `    is_pure_acronym: ${/^[A-Z]{2,5}$/.test(item.literal_value)}\n` +
    `    normalized_tokens_empty: ${normTokens.length === 0}`
  );
}

function buildUserTurn(chunkItems: RunItemForPairing[], conceptName: string): string {
  const N          = chunkItems.length;
  const itemBlocks = chunkItems.map((item, i) => buildItemBlock(i + 1, item)).join('\n\n');

  return (
    `You are grouping ${N} unassigned items from the concept "${conceptName}".\n\n` +
    `FIELD GUIDE:\n` +
    `- literal_value: the raw source string exactly as it appears in the data\n` +
    `- clean_value: punctuation removed, whitespace normalised\n` +
    `- normalized_value: clean_value after stopword removal\n` +
    `- standard_tokens: word-level tokens from clean_value\n` +
    `- normalized_tokens: tokens after stopword removal\n` +
    `- is_pure_acronym: ≤5 chars, all uppercase — may abbreviate a longer form in this batch\n` +
    `- normalized_tokens_empty: every token was a stopword — rely on literal_value\n\n` +
    `ITEMS TO GROUP:\n\n` +
    itemBlocks +
    '\n\n---\n\n' +
    `Now group these ${N} items. Return ONLY this JSON — no other text:\n\n` +
    `{"g":[[[item_indices],"proposed_name","h|m|l"],...],"u":[item_index,...]}\n\n` +
    `Schema:\n` +
    `- "g": array of groups. Each group is a 3-element array:\n` +
    `    [0] item_indices — array of 1-based item numbers belonging to this group\n` +
    `    [1] proposed_name — canonical name string, or null if unclear\n` +
    `    [2] confidence — "h" (high), "m" (medium), or "l" (low)\n` +
    `- "u": flat array of item indices that are genuinely ambiguous and cannot\n` +
    `       be placed in any group (omit singletons from here — put them in "g")\n\n` +
    `Example:\n` +
    `{"g":[[[1,4,7],"Verizon","h"],[[2,3],"AT&T","h"],[[5,6],"T-Mobile","m"],[[8],"Dish Wireless","m"]],"u":[9,12]}\n\n` +
    `Every item index from 1 to ${N} must appear exactly once across g and u.`
  );
}

// ---------------------------------------------------------------------------
// Chunk Grouping Prompt — one LLM call per item chunk
// ---------------------------------------------------------------------------

interface ChunkCallResult {
  parsed:         LLMResponse;
  raw_text:       string;
  user_turn:      string;
  stop_reason:    string;
  llm_elapsed_ms: number;
  llm_usage: {
    input_tokens:                number;
    output_tokens:               number;
    cache_read_input_tokens:     number;
    cache_creation_input_tokens: number;
  };
}

async function callChunkLLM(
  apiKey: string,
  systemText: string,
  userText: string,
  chunkLabel: string,
): Promise<ChunkCallResult> {
  const callStart = Date.now();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'anthropic-beta':     'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model:       GROUPING_MODEL_ID,
      max_tokens:  MAX_OUTPUT_TOKENS,
      temperature: 0,
      system:      [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages:    [{ role: 'user', content: userText }],
    }),
  });

  const llm_elapsed_ms = Date.now() - callStart;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `[one-prompt-grouping] Anthropic API error ${res.status} (${chunkLabel}): ${errText.slice(0, 500)}`,
    );
  }

  const apiBody = await res.json() as {
    content?:     Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?:       {
      input_tokens?:                 number;
      output_tokens?:                number;
      cache_read_input_tokens?:      number;
      cache_creation_input_tokens?:  number;
    };
  };

  const rawText = (apiBody.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  const stop_reason = apiBody.stop_reason ?? 'unknown';

  const parsed = tryParseGroupingJson(rawText);
  if (!parsed) {
    const truncHint = stop_reason === 'max_tokens'
      ? ` Output hit max_tokens (${MAX_OUTPUT_TOKENS}). This is unexpected for a ${chunkLabel}-item chunk — file a bug.`
      : '';
    throw new Error(
      `[one-prompt-grouping] Failed to parse LLM JSON (${chunkLabel}, stop_reason=${stop_reason}).${truncHint}\n` +
      `Raw (first 1200 chars): ${rawText.slice(0, 1200)}`,
    );
  }

  return {
    parsed,
    raw_text:    rawText,
    user_turn:   userText,
    stop_reason,
    llm_elapsed_ms,
    llm_usage: {
      input_tokens:                apiBody.usage?.input_tokens                ?? 0,
      output_tokens:               apiBody.usage?.output_tokens               ?? 0,
      cache_read_input_tokens:     apiBody.usage?.cache_read_input_tokens     ?? 0,
      cache_creation_input_tokens: apiBody.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk Merging Prompt — reconcile groups across chunks
// ---------------------------------------------------------------------------

// Each merge entry is a 2-element tuple: [[group_indices], merged_name]
type MergeEntry = [number[], string | null];

// Response shape: { "m": [ [[1,2],"Verizon"], [[3,7,11],"AT&T"] ] }
interface MergeResponse {
  m: MergeEntry[];
}

function tryParseMergeJson(text: string): MergeEntry[] | null {
  const stripped = stripMarkdownFences(text).trim();
  const candidates = [stripped, text.trim()].filter((c) => c.length > 0);

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    try {
      const parsed = JSON.parse(c) as MergeResponse;
      if (parsed && Array.isArray(parsed.m)) return parsed.m;
    } catch { /* next */ }
  }
  return null;
}

function buildMergeSystemPrompt(conceptName: string, conceptDefinition: string): string {
  return (
    `You are reviewing proposed groups from an entity-resolution clustering run.\n` +
    `Items were split into chunks and clustered independently. Some groups across\n` +
    `different chunks may refer to the same real-world entity and should be merged.\n\n` +
    `Only merge when confident they refer to the same entity. When uncertain,\n` +
    `leave them separate — a human reviewer will reconcile.\n\n` +
    `Respond only with valid JSON. No text outside the JSON.\n\n` +
    `CONCEPT: ${conceptName}\n` +
    `DEFINITION: ${conceptDefinition || '(no definition provided)'}`
  );
}

function buildMergeUserTurn(
  groups: FinalGroup[],
  confidenceScores: Map<number, number>,
  runItemById: Map<number, RunItemForPairing>,
): string {
  const groupBlocks = groups.map((g, i) => {
    // Up to 3 representative literal values.
    const reps = g.member_ids
      .slice(0, 3)
      .map((id) => runItemById.get(id)?.literal_value ?? String(id));

    // Derive a confidence band from the average of member scores.
    const avgScore =
      g.member_ids.reduce((sum, id) => sum + (confidenceScores.get(id) ?? SINGLETON_DEFAULT_SCORE), 0) /
      Math.max(g.member_ids.length, 1);
    const confBand = avgScore >= 0.85 ? 'high' : avgScore >= 0.55 ? 'medium' : 'low';

    // Use the first representative as the proposed name (NameScore will pick
    // the best canonical name at commit time; this is just for context).
    const proposedName = reps[0] ?? '';

    return (
      `GROUP ${i + 1}:\n` +
      `  proposed_name: "${proposedName.replace(/"/g, '\\"')}"\n` +
      `  items: [${reps.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(', ')}]\n` +
      `  confidence: "${confBand}"`
    );
  }).join('\n\n');

  return (
    `PROPOSED GROUPS:\n\n` +
    groupBlocks +
    `\n\n---\n\n` +
    `Return ONLY this JSON — no other text:\n\n` +
    `{"m":[[[group_indices],"merged_name"],...]}\n\n` +
    `Schema:\n` +
    `- "m": array of merge entries. Each entry is a 2-element array:\n` +
    `    [0] group_indices — array of 1-based group numbers to collapse into one\n` +
    `    [1] merged_name  — canonical name string, or null if unclear\n\n` +
    `Example:\n` +
    `{"m":[[[1,2],"Verizon"],[[3,7,11],"AT&T"]]}\n\n` +
    `Rules:\n` +
    `- Each entry collapses exactly those groups into one\n` +
    `- A group index may appear in at most one entry\n` +
    `- If no merges are needed: {"m":[]}\n` +
    `- You may list more than two indices per entry`
  );
}

type LLMUsage = {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens: number; cache_creation_input_tokens: number;
};

async function callMergeLLM(
  groups: FinalGroup[],
  confidenceScores: Map<number, number>,
  runItemById: Map<number, RunItemForPairing>,
  conceptName: string,
  conceptDefinition: string,
  apiKey: string,
): Promise<{ parsed: MergeEntry[]; raw_text: string; system_text: string; user_text: string; stop_reason: string; llm_elapsed_ms: number; llm_usage: LLMUsage }> {
  const systemText = buildMergeSystemPrompt(conceptName, conceptDefinition);
  const userText   = buildMergeUserTurn(groups, confidenceScores, runItemById);

  const callStart = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model:       GROUPING_MODEL_ID,
      max_tokens:  2048,
      temperature: 0,
      system:      [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages:    [{ role: 'user', content: userText }],
    }),
  });
  const llm_elapsed_ms = Date.now() - callStart;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[one-prompt-grouping] Merge LLM error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const apiBody = await res.json() as {
    content?:     Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?:       {
      input_tokens?:                number;
      output_tokens?:               number;
      cache_read_input_tokens?:     number;
      cache_creation_input_tokens?: number;
    };
  };

  const rawText = (apiBody.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  const parsed = tryParseMergeJson(rawText);
  if (!parsed) {
    throw new Error(
      `[one-prompt-grouping] Failed to parse merge response as JSON (stop_reason=${apiBody.stop_reason ?? 'unknown'}).\n` +
      `Raw (first 800 chars): ${rawText.slice(0, 800)}`,
    );
  }

  return {
    parsed,
    raw_text:    rawText,
    system_text: systemText,
    user_text:   userText,
    stop_reason: apiBody.stop_reason ?? 'unknown',
    llm_elapsed_ms,
    llm_usage: {
      input_tokens:                apiBody.usage?.input_tokens                ?? 0,
      output_tokens:               apiBody.usage?.output_tokens               ?? 0,
      cache_read_input_tokens:     apiBody.usage?.cache_read_input_tokens     ?? 0,
      cache_creation_input_tokens: apiBody.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * Apply the merge plan returned by the Chunk Merging Prompt.
 *
 * Rules enforced here (not trusted from the LLM response):
 *  - A group index must be valid (1 ≤ idx ≤ groups.length).
 *  - A group index can only appear in one merge entry; later entries that
 *    re-use an already-consumed index are silently skipped.
 *  - A merge entry must reference at least 2 distinct groups.
 * Groups not referenced in any merge entry are kept unchanged.
 */
function applyMerges(
  groups: FinalGroup[],
  merges: MergeEntry[],
  nextTempId: number,
): { groups: FinalGroup[]; nextTempId: number } {
  const validMerges = (merges ?? []).filter(
    (m) => Array.isArray(m[0]) && m[0].length >= 2,
  );
  if (validMerges.length === 0) return { groups, nextTempId };

  const consumed = new Set<number>(); // 1-based group indices
  const result:   FinalGroup[] = [];

  for (const merge of validMerges) {
    const indices = (merge[0] ?? [])
      .map(Number)
      .filter((idx) => Number.isInteger(idx) && idx >= 1 && idx <= groups.length);

    // Need ≥2 valid, unconsumed indices.
    if (indices.length < 2 || indices.some((idx) => consumed.has(idx))) continue;

    for (const idx of indices) consumed.add(idx);

    const toMerge = indices.map((idx) => groups[idx - 1]);
    result.push({
      temp_group_id:         `llm_merge_${nextTempId++}`,
      member_ids:            toMerge.flatMap((g) => g.member_ids),
      is_singleton:          toMerge.flatMap((g) => g.member_ids).length === 1,
      anchor_member_ids:     toMerge.flatMap((g) => g.anchor_member_ids),
      absorbed_member_ids:   toMerge.flatMap((g) => g.absorbed_member_ids),
      merged_from_group_ids: toMerge.flatMap((g) => [g.temp_group_id, ...g.merged_from_group_ids]),
      avg_internal_score:    0,
      min_internal_score:    0,
    });
  }

  // Pass through groups that weren't part of any merge.
  for (let i = 0; i < groups.length; i++) {
    if (!consumed.has(i + 1)) result.push(groups[i]);
  }

  return { groups: result, nextTempId };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimateCostUSD(usage: {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens: number; cache_creation_input_tokens: number;
}): number {
  return (
    usage.input_tokens                * (3.00  / 1_000_000) +
    usage.output_tokens               * (15.00 / 1_000_000) +
    usage.cache_read_input_tokens     * (0.30  / 1_000_000) +
    usage.cache_creation_input_tokens * (3.75  / 1_000_000)
  );
}

// ---------------------------------------------------------------------------
// Breakdown types + writer
// ---------------------------------------------------------------------------

/** One Chunk Grouping Prompt invocation (single chunk). */
export interface OnePromptChunkBreakdown {
  chunk_index:  number;
  item_count:   number;
  /** Literal values of items in this chunk, in the order they were numbered. */
  items:        Array<{ index: number; run_item_id: number; literal_value: string }>;
  user_turn:    string;
  raw_response: string;
  stop_reason:  string;
  parsed_groups: Array<{
    group_index:   number;
    item_indices:  number[];
    proposed_name: string | null;
    confidence:    string;
  }>;
  parsed_unassigned: Array<{ item_index: number }>;
  llm_elapsed_ms: number;
  llm_usage: {
    input_tokens:                number;
    output_tokens:               number;
    cache_read_input_tokens:     number;
    cache_creation_input_tokens: number;
  };
  error: string | null;
}

/** Chunk Merging Prompt (cross-chunk reconciliation). */
export interface OnePromptMergeBreakdown {
  ran:             boolean;
  system_prompt:   string;
  user_turn:       string;
  raw_response:    string;
  stop_reason:     string;
  parsed_merges:   MergeEntry[];
  merges_applied:  number;
  llm_elapsed_ms:  number;
  llm_usage: {
    input_tokens:                number;
    output_tokens:               number;
    cache_read_input_tokens:     number;
    cache_creation_input_tokens: number;
  };
  error: string | null;
}

export interface OnePromptBreakdown {
  meta: {
    run_id:                      number;
    generated_at:                string;
    model:                       string;
    concept_name:                string;
    concept_definition:          string;
    total_items:                 number;
    chunk_count:                 number;
    max_items_per_chunk:         number;
    total_groups_before_merge:   number;
    total_groups_after_merge:    number;
    multi_member_groups:         number;
    singleton_groups:            number;
    unassigned_count:            number;
    estimated_cost_usd:          number;
    /** max(chunk grouping ms) + merging ms — matches OnePromptGroupingResult.llm_elapsed_ms */
    llm_elapsed_ms:              number;
    total_input_tokens:          number;
    total_output_tokens:         number;
    total_cache_read_tokens:     number;
    total_cache_creation_tokens: number;
    /** Items resolved from LITERAL_ALIAS_MATCHES (skipped LLM). */
    lookup_matched: number;
  };
  system_prompt: string;
  chunks:        OnePromptChunkBreakdown[];
  merge_step:    OnePromptMergeBreakdown;
  final_groups:  Array<{
    temp_group_id:  string;
    is_singleton:   boolean;
    member_count:   number;
    members:        Array<{ run_item_id: number; literal_value: string; confidence_score: number }>;
  }>;
}

/**
 * Writes a diagnostic JSON for a completed 1-Prompt grouping run.
 * File: `one_prompt_breakdown_run_<run_id>.json` at the project root.
 * Best-effort — any filesystem error is only logged, never thrown.
 */
export function writeOnePromptBreakdown(runId: number, breakdown: OnePromptBreakdown): void {
  try {
    const projectRoot = path.resolve(process.cwd(), '..');
    const outPath     = path.join(projectRoot, `one_prompt_breakdown_run_${runId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(breakdown, null, 2), 'utf8');
    console.log(`[one-prompt-grouping] Breakdown written → ${outPath}`);
  } catch (err) {
    console.warn('[one-prompt-grouping] Could not write breakdown JSON:', err);
  }
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface OnePromptGroupingResult {
  /** Groups ready to persist; identical shape to clique-detection's FinalGroup[]. */
  groups: FinalGroup[];
  /** Confidence score per run_item_id mapped from LLM "high | medium | low" bands. */
  confidence_scores: Map<number, number>;
  /** run_item_ids left unassigned by the LLM (remain group_id = NULL). */
  unassigned_ids: number[];
  /** Wall-clock ms of the slowest chunk (all chunks run in parallel). */
  llm_elapsed_ms: number;
  /** Summed estimated USD cost across all chunks. */
  estimated_cost_usd: number;
  /** Summed token counts across all chunks. */
  llm_usage: {
    input_tokens:                number;
    output_tokens:               number;
    cache_read_input_tokens:     number;
    cache_creation_input_tokens: number;
  };
  /** Number of parallel chunks dispatched. */
  chunk_count: number;
  /** Full diagnostic breakdown — pass to writeOnePromptBreakdown() to persist. */
  breakdown: OnePromptBreakdown;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Group all unassigned items via the Chunk Grouping Prompt (parallel chunks)
 * and optionally the Chunk Merging Prompt (when there are 2+ chunks).
 *
 * Items are split into chunks of MAX_ITEMS_PER_CHUNK (25).  Chunk Grouping
 * Prompts are dispatched in parallel via Promise.all.  Results are folded into
 * FinalGroup records and a confidence_scores map.
 *
 * @param items              All unassigned RunItemForPairing rows.
 * @param conceptName        The concept's display name.
 * @param conceptDefinition  The concept's definition text (may be empty).
 */
export async function runOnePromptGrouping(
  items: RunItemForPairing[],
  conceptName: string,
  conceptDefinition: string,
): Promise<OnePromptGroupingResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[one-prompt-grouping] ANTHROPIC_API_KEY is not set.');

  const emptyMergeBreakdown: OnePromptMergeBreakdown = {
    ran: false, system_prompt: '', user_turn: '', raw_response: '',
    stop_reason: '', parsed_merges: [], merges_applied: 0,
    llm_elapsed_ms: 0,
    llm_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    error: null,
  };

  const EMPTY: OnePromptGroupingResult = {
    groups:             [],
    confidence_scores:  new Map(),
    unassigned_ids:     [],
    llm_elapsed_ms:     0,
    estimated_cost_usd: 0,
    llm_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    chunk_count:        0,
    breakdown: {
      meta: {
        run_id: 0, generated_at: new Date().toISOString(), model: GROUPING_MODEL_ID,
        concept_name: conceptName, concept_definition: conceptDefinition,
        total_items: 0, chunk_count: 0, max_items_per_chunk: MAX_ITEMS_PER_CHUNK,
        total_groups_before_merge: 0, total_groups_after_merge: 0,
        multi_member_groups: 0, singleton_groups: 0, unassigned_count: 0,
        estimated_cost_usd: 0, llm_elapsed_ms: 0,
        total_input_tokens: 0, total_output_tokens: 0,
        total_cache_read_tokens: 0, total_cache_creation_tokens: 0,
        lookup_matched: 0,
      },
      system_prompt: '',
      chunks:        [],
      merge_step:    emptyMergeBreakdown,
      final_groups:  [],
    },
  };
  if (items.length === 0) return EMPTY;

  const systemText = buildSystemPrompt(conceptName, conceptDefinition);

  // ── Split into chunks of MAX_ITEMS_PER_CHUNK ─────────────────────────────
  const chunks: RunItemForPairing[][] = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CHUNK) {
    chunks.push(items.slice(i, i + MAX_ITEMS_PER_CHUNK));
  }

  // ── Dispatch all chunks in parallel ──────────────────────────────────────
  const chunkResults = await Promise.all(
    chunks.map((chunk, chunkIdx) => {
      const userText   = buildUserTurn(chunk, conceptName);
      const chunkLabel = `chunk ${chunkIdx + 1}/${chunks.length}, ${chunk.length} items`;
      return callChunkLLM(apiKey, systemText, userText, chunkLabel).catch((err: unknown) => {
        // Parse/API failure for one chunk: degrade to all-singletons rather than
        // aborting the whole run.  Items will appear ungrouped and can be merged
        // manually by the user.
        console.warn(
          `[one-prompt-grouping] ${chunkLabel} failed — falling back to singletons. Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        const syntheticParsed: LLMResponse = {
          g: chunk.map((_, i) => [[i + 1], null, 'l'] as LLMResponseGroup),
          u: [],
        };
        return {
          parsed:        syntheticParsed,
          raw_text:      '',
          user_turn:     userText,
          stop_reason:   'parse_error',
          llm_elapsed_ms: 0,
          llm_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } satisfies ChunkCallResult;
      });
    })
  );

  // ── Merge results ─────────────────────────────────────────────────────────
  let   groups:           FinalGroup[]               = [];
  const confidence_scores                             = new Map<number, number>();
  const unassigned_ids:   number[]                   = [];
  const assignedGlobally                              = new Set<number>();
  let   nextTempId                                    = 1;
  const chunkBreakdowns:  OnePromptChunkBreakdown[]  = [];

  // Aggregate usage
  let llm_elapsed_ms = 0;
  const llm_usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk  = chunks[chunkIdx];
    const result = chunkResults[chunkIdx];

    // Map 1-indexed LLM item indices → run_item_ids for this chunk.
    const idByIdx = new Map<number, number>(chunk.map((item, i) => [i + 1, item.run_item_id]));

    // Groups — each entry is [item_indices[], proposed_name, confidence]
    for (const g of result.parsed.g ?? []) {
      const memberIds = (g[0] ?? [])
        .map((idx) => idByIdx.get(idx))
        .filter((id): id is number => id !== undefined);
      if (memberIds.length === 0) continue;

      const score       = CONFIDENCE_MAP[String(g[2] ?? '').toLowerCase()] ?? SINGLETON_DEFAULT_SCORE;
      const tempGroupId = `llm_c${chunkIdx}_g${nextTempId++}`;

      groups.push({
        temp_group_id:         tempGroupId,
        member_ids:            memberIds,
        is_singleton:          memberIds.length === 1,
        anchor_member_ids:     memberIds,
        absorbed_member_ids:   [],
        merged_from_group_ids: [],
        avg_internal_score:    0,
        min_internal_score:    0,
      });

      for (const id of memberIds) {
        confidence_scores.set(id, score);
        assignedGlobally.add(id);
      }
    }

    // Unassigned (explicit) — flat array of 1-based item indices
    for (const itemIdx of result.parsed.u ?? []) {
      const id = idByIdx.get(Number(itemIdx));
      if (id !== undefined) {
        unassigned_ids.push(id);
        assignedGlobally.add(id);
      }
    }

    // Silently omitted items → singletons (safety net)
    for (const item of chunk) {
      if (!assignedGlobally.has(item.run_item_id)) {
        const tempGroupId = `llm_c${chunkIdx}_g${nextTempId++}`;
        groups.push({
          temp_group_id:         tempGroupId,
          member_ids:            [item.run_item_id],
          is_singleton:          true,
          anchor_member_ids:     [item.run_item_id],
          absorbed_member_ids:   [],
          merged_from_group_ids: [],
          avg_internal_score:    0,
          min_internal_score:    0,
        });
        confidence_scores.set(item.run_item_id, SINGLETON_DEFAULT_SCORE);
        assignedGlobally.add(item.run_item_id);
      }
    }

    // Aggregate timing + tokens
    llm_elapsed_ms                        = Math.max(llm_elapsed_ms, result.llm_elapsed_ms);
    llm_usage.input_tokens               += result.llm_usage.input_tokens;
    llm_usage.output_tokens              += result.llm_usage.output_tokens;
    llm_usage.cache_read_input_tokens    += result.llm_usage.cache_read_input_tokens;
    llm_usage.cache_creation_input_tokens += result.llm_usage.cache_creation_input_tokens;

    // ── Chunk breakdown record ──────────────────────────────────────────────
    chunkBreakdowns.push({
      chunk_index:  chunkIdx,
      item_count:   chunk.length,
      items:        chunk.map((item, i) => ({
        index:        i + 1,
        run_item_id:  item.run_item_id,
        literal_value: item.literal_value,
      })),
      user_turn:    result.user_turn,
      raw_response: result.raw_text,
      stop_reason:  result.stop_reason,
      parsed_groups: (result.parsed.g ?? []).map((g, gi) => ({
        group_index:   gi + 1,
        item_indices:  g[0] ?? [],
        proposed_name: g[1] ?? null,
        confidence:    g[2] ?? '',
        flags:         [],
      })),
      parsed_unassigned: (result.parsed.u ?? []).map((itemIdx) => ({
        item_index: Number(itemIdx),
      })),
      llm_elapsed_ms: result.llm_elapsed_ms,
      llm_usage:      result.llm_usage,
      error:          null,
    });
  }

  const groupsBeforeMerge = groups.length;

  // ── Chunk Merging Prompt ──────────────────────────────────────────────────
  // Only runs when 2+ chunks were dispatched.  One sequential LLM call
  // receives all proposed groups (with up to 3 representatives each) and
  // returns merge entries.  Failures are non-fatal: pre-merge groups stand.
  let mergeBreakdown: OnePromptMergeBreakdown = { ...emptyMergeBreakdown };

  if (chunks.length > 1 && groups.length > 1) {
    const runItemById = new Map(items.map((item) => [item.run_item_id, item]));
    mergeBreakdown.ran = true;
    try {
      const mergeResult = await callMergeLLM(
        groups, confidence_scores, runItemById,
        conceptName, conceptDefinition, apiKey,
      );

      const groupsBefore = groups.length;
      const merged = applyMerges(groups, mergeResult.parsed, nextTempId);
      groups      = merged.groups;
      nextTempId  = merged.nextTempId;

      // The merge step is sequential after the parallel fan-out, so add its
      // wall-clock time to the total (max was already computed above).
      llm_elapsed_ms                        += mergeResult.llm_elapsed_ms;
      llm_usage.input_tokens               += mergeResult.llm_usage.input_tokens;
      llm_usage.output_tokens              += mergeResult.llm_usage.output_tokens;
      llm_usage.cache_read_input_tokens    += mergeResult.llm_usage.cache_read_input_tokens;
      llm_usage.cache_creation_input_tokens += mergeResult.llm_usage.cache_creation_input_tokens;

      const mergesApplied = groupsBefore - groups.length;

      mergeBreakdown = {
        ran:           true,
        system_prompt: mergeResult.system_text,
        user_turn:     mergeResult.user_text,
        raw_response:  mergeResult.raw_text,
        stop_reason:   mergeResult.stop_reason,
        parsed_merges: mergeResult.parsed,
        merges_applied: mergesApplied,
        llm_elapsed_ms: mergeResult.llm_elapsed_ms,
        llm_usage:      mergeResult.llm_usage,
        error:          null,
      };

      console.log(
        `[one-prompt-grouping] Chunk Merging Prompt: ${mergeResult.parsed.length} merge(s), ` +
        `${groups.length} groups remaining.`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      mergeBreakdown.error = errMsg;
      console.warn(
        '[one-prompt-grouping] Chunk Merging Prompt failed — proceeding with un-merged groups:',
        err,
      );
    }
  }

  // ── Assemble breakdown ────────────────────────────────────────────────────
  const runItemById = new Map(items.map((item) => [item.run_item_id, item]));
  const breakdown: OnePromptBreakdown = {
    meta: {
      run_id:                      0, // caller fills in the real run_id via writeOnePromptBreakdown
      generated_at:                new Date().toISOString(),
      model:                       GROUPING_MODEL_ID,
      concept_name:                conceptName,
      concept_definition:          conceptDefinition,
      total_items:                 items.length,
      chunk_count:                 chunks.length,
      max_items_per_chunk:         MAX_ITEMS_PER_CHUNK,
      total_groups_before_merge:   groupsBeforeMerge,
      total_groups_after_merge:    groups.length,
      multi_member_groups:         groups.filter((g) => !g.is_singleton).length,
      singleton_groups:            groups.filter((g) =>  g.is_singleton).length,
      unassigned_count:            unassigned_ids.length,
      estimated_cost_usd:          estimateCostUSD(llm_usage),
      llm_elapsed_ms,
      total_input_tokens:          llm_usage.input_tokens,
      total_output_tokens:         llm_usage.output_tokens,
      total_cache_read_tokens:     llm_usage.cache_read_input_tokens,
      total_cache_creation_tokens: llm_usage.cache_creation_input_tokens,
      lookup_matched:              0, // filled in by caller if a lookup pass was run
    },
    system_prompt: systemText,
    chunks:        chunkBreakdowns,
    merge_step:    mergeBreakdown,
    final_groups:  groups.map((g) => ({
      temp_group_id: g.temp_group_id,
      is_singleton:  g.is_singleton,
      member_count:  g.member_ids.length,
      members:       g.member_ids.map((id) => ({
        run_item_id:      id,
        literal_value:    runItemById.get(id)?.literal_value ?? String(id),
        confidence_score: confidence_scores.get(id) ?? SINGLETON_DEFAULT_SCORE,
      })),
    })),
  };

  return {
    groups,
    confidence_scores,
    unassigned_ids,
    llm_elapsed_ms,
    estimated_cost_usd: estimateCostUSD(llm_usage),
    llm_usage,
    chunk_count: chunks.length,
    breakdown,
  };
}
