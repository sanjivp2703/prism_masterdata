import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { tokensFromVariant } from '@/app/api/_lib/namescore';
import { computePairScore, type RunItemForPairing } from '@/app/api/_lib/pairscore';
import {
  buildFeaturePayload,
  buildTokenRarityLookup,
  type AliasBundleForPayload,
  type FeaturePayload,
} from '@/app/api/_lib/feature-payload';
import { buildCachedSystemBlock, scorePairWithLLM, LLM_MODEL_ID, type ScoredPairResult, type LLMTokenUsage } from '@/app/api/_lib/llm-confidence';
import { getCachedResult, setCachedResult } from '@/app/api/_lib/redis-cache';

// LLM gate thresholds — tuned for calibrated model confidence (not deterministic scores).
// Set conservatively for initial deployment; retune after eval.
const LLM_CONFIDENT_TOP_SCORE = 0.15;
const LLM_CONFIDENT_MARGIN_RATIO = 2.5;

// Pre-filter threshold: pairs whose deterministic score is below this value AND have no
// exact-match or acronym signals are skipped entirely — confidence is assigned 0.0 and
// no LLM call is made. Retune alongside LLM_CONFIDENT_TOP_SCORE after eval.
const PREFILTER_SCORE_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Token pricing constants for Claude Haiku 4.5 (claude-haiku-4-5-20251001)
// Update these if Anthropic changes their pricing.
// Source: https://www.anthropic.com/pricing
// ---------------------------------------------------------------------------
const PRICE_INPUT_PER_M     = 0.80;   // USD per 1M input tokens (cache miss)
const PRICE_OUTPUT_PER_M    = 4.00;   // USD per 1M output tokens
const PRICE_CACHE_READ_PER_M  = 0.08; // USD per 1M cache-read tokens (~10% of input)
const PRICE_CACHE_WRITE_PER_M = 1.00; // USD per 1M cache-creation tokens

export function estimateCostUSD(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): number {
  return (
    (usage.input_tokens               / 1_000_000) * PRICE_INPUT_PER_M +
    (usage.output_tokens              / 1_000_000) * PRICE_OUTPUT_PER_M +
    (usage.cache_read_input_tokens    / 1_000_000) * PRICE_CACHE_READ_PER_M +
    (usage.cache_creation_input_tokens/ 1_000_000) * PRICE_CACHE_WRITE_PER_M
  );
}

// Maximum number of alias comparisons to run concurrently for a single run_item.
// run_items themselves are processed sequentially to keep the Anthropic prompt cache
// warm across items. Only the alias comparisons within each item are parallelized.
// Reduce if HTTP 429 rate-limit errors are observed; increase for higher throughput.
const LLM_CONCURRENCY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Per-run scoring progress (in-memory, polled by the client via GET)
// ---------------------------------------------------------------------------

type ScoringProgress = {
  phase: 'scoring' | 'saving' | 'done';
  /** Number of run_items fully scored so far. */
  items_scored: number;
  /** Total run_items to score. */
  items_total: number;
  /** Number of alias comparisons completed so far (across all items). */
  pairs_scored: number;
  /** Total alias comparisons to run. */
  pairs_total: number;
  /** Cumulative token usage from live LLM calls (excludes cache-only results). */
  token_usage: LLMTokenUsage;
  /** Estimated cost in USD based on accumulated token usage. */
  estimated_cost_usd: number;
  /**
   * Cumulative wall-clock milliseconds spent waiting on live Anthropic API calls.
   * Excludes time for cache hits, DB queries, and pre-filter skips.
   * Items are processed sequentially; aliases within each item are parallel —
   * this measures the wall-clock duration of each item's parallel alias batch.
   */
  llm_elapsed_ms: number;
  /**
   * Cumulative wall-clock milliseconds spent on deterministic work — items whose
   * entire alias batch was served from cache or skipped by the pre-filter, so no
   * live LLM call was made.  Does NOT double-count time already in llm_elapsed_ms.
   */
  deterministic_elapsed_ms: number;
};

// Keyed by run_id. Entries are set at the start of scoring and cleared
// (set to done) when the POST completes.
const scoringProgress = new Map<number, ScoringProgress>();

/** GET /api/run/[run_id]/apply-confident-assignments — returns current progress. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;
  const runIdNum = Number(run_id);
  const progress = scoringProgress.get(runIdNum) ?? null;
  return Response.json({ progress }, { headers: { 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Parallel execution utility
// ---------------------------------------------------------------------------

/**
 * Runs fn over every item in the array concurrently, up to `limit` in-flight
 * at once. Preserves result order (index-stable, mirrors Promise.all semantics).
 */
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
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

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ---------------------------------------------------------------------------
// LLM call with 429 retry + exponential back-off
// ---------------------------------------------------------------------------

/**
 * Wraps scorePairWithLLM with up to `maxRetries` attempts on HTTP 429.
 * Back-off schedule: 1 s, 2 s, 4 s (exponential).
 * Returns null on non-429 errors or when retries are exhausted — the caller
 * falls back to the deterministic score and continues the run.
 */
async function scorePairWithRetry(
  cachedSystemBlock: ReturnType<typeof buildCachedSystemBlock>,
  payload: FeaturePayload,
  maxRetries = 3,
): Promise<ScoredPairResult | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await scorePairWithLLM(cachedSystemBlock, payload);
    } catch (err) {
      const is429 =
        err instanceof Error && (err as Error & { status?: number }).status === 429;
      if (is429 && attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        console.warn(
          `[apply-confident] HTTP 429 rate-limit — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.error(
        `[apply-confident] LLM API call failed (attempt ${attempt + 1}/${maxRetries}):`,
        err,
      );
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM breakdown debug writer
// ---------------------------------------------------------------------------

type LLMPairRecord = {
  run_item_id: number;
  literal_value: string;
  alias_id: number;
  alias_name_literal_value: string;
  compatibility_weight: number;
  /** The exact JSON-serialised user message sent to the LLM. */
  prompt_user_message: unknown;
  /** Raw text returned by the LLM (before fence stripping / parsing). */
  llm_raw_response: string | null;
  /** Parsed response, or null if parsing/network failed. */
  llm_parsed_response: unknown | null;
  /** Confidence extracted from the parsed response. Null on failure. */
  llm_confidence: number | null;
  /** Deterministic formula score for this pair (stored as baseline). */
  deterministic_score: number;
  /** True if the LLM call succeeded; false = deterministic fallback used. */
  llm_succeeded: boolean;
  /** True when the pre-filter short-circuited this pair — no LLM call was made. */
  skipped_by_prefilter: boolean;
  /** True when the result was served from the Redis cache (no live LLM call). */
  from_cache: boolean;
  /** Whether this pair was the top-scoring alias for this run item. */
  is_top_candidate: boolean;
  /** Whether this run item was assigned to this alias after the gate. */
  assigned: boolean;
  error: string | null;
};

/**
 * Writes a diagnostic JSON for every (run_item, alias) LLM call in the run.
 * File: `llm_confidence_breakdown_run_<run_id>.json` at the project root.
 * Best-effort — any filesystem error is only logged, never thrown.
 */
function writeLLMBreakdown(
  runId: number,
  conceptKey: string,
  conceptDescription: string,
  model: string,
  systemPromptText: string,
  records: LLMPairRecord[],
): void {
  try {
    const projectRoot = path.resolve(process.cwd(), '..');
    const outPath = path.join(projectRoot, `llm_confidence_breakdown_run_${runId}.json`);
    const breakdown = {
      meta: {
        run_id: runId,
        generated_at: new Date().toISOString(),
        model,
        concept_key: conceptKey,
        concept_description: conceptDescription,
        total_pairs: records.length,
        llm_success_count: records.filter((r) => r.llm_succeeded).length,
        llm_failure_count: records.filter((r) => !r.llm_succeeded && !r.skipped_by_prefilter).length,
        prefilter_skipped_count: records.filter((r) => r.skipped_by_prefilter).length,
        cache_hits: records.filter((r) => r.from_cache).length,
        cache_misses: records.filter((r) => !r.from_cache && !r.skipped_by_prefilter && r.llm_succeeded).length,
        cache_hit_rate: (() => {
          const scoredByLlm = records.filter((r) => !r.skipped_by_prefilter);
          if (scoredByLlm.length === 0) return null;
          return Number((records.filter((r) => r.from_cache).length / scoredByLlm.length).toFixed(4));
        })(),
        assigned_count: records.filter((r) => r.assigned).length,
        thresholds: {
          prefilter_score_threshold: PREFILTER_SCORE_THRESHOLD,
          llm_confident_top_score: LLM_CONFIDENT_TOP_SCORE,
          llm_confident_margin_ratio: LLM_CONFIDENT_MARGIN_RATIO,
        },
      },
      system_prompt: systemPromptText,
      pairs: records,
    };
    fs.writeFileSync(outPath, JSON.stringify(breakdown, null, 2), 'utf8');
    console.log(`[apply-confident] LLM breakdown written → ${outPath}`);
  } catch (err) {
    console.warn('[apply-confident] Could not write LLM breakdown JSON:', err);
  }
}

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

// Diminishing aggregate per spec:
// Let M = [m1 >= m2 >= ... >= mn] (sorted descending).
// aggregate_diminishing(M) =
//   m1 + 0.30*m2 + 0.10*m3 + 0.03*sum_{k>=4}(mk), capped at 1.
function diminishingAggregate(values: number[]): number {
  if (values.length === 0) return 0;
  const m = values
    .map((v) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
    .sort((a, b) => b - a);
  let agg = 0;
  if (m.length >= 1) agg += m[0];
  if (m.length >= 2) agg += 0.30 * m[1];
  if (m.length >= 3) agg += 0.10 * m[2];
  if (m.length >= 4) {
    for (let i = 3; i < m.length; i++) agg += 0.03 * m[i];
  }
  return Number(Math.min(1, agg).toFixed(6));
}

type AliasItemScorable = RunItemForPairing & { alias_item_id: number };

type AliasBundle = {
  alias_id: number;
  /** concept_id of the alias (inherited from ALIASES.concept_id). */
  concept_id: number;
  /** concept_key display name for this alias's concept. */
  concept_key: string;
  alias_name_literal_value: string;
  alias_name_clean_value: string | null;
  alias_name_normalization_value: string | null;
  alias_name_tokens: string[];
  alias_name_normalized_tokens: string[];
  /** 1.0 for same-concept aliases; <1.0 for cross-concept compatible aliases (from CONCEPT_COMPATIBILITY). */
  compatibility_weight: number;
  items: AliasItemScorable[];
};

function toScorable(row: any): RunItemForPairing {
  return {
    run_item_id: Number(row.RUN_ITEM_ID ?? row.run_item_id),
    literal_value: String(row.LITERAL_VALUE ?? row.literal_value ?? ''),
    cleaned_value: row.CLEANED_VALUE ?? row.cleaned_value ?? null,
    normalization_value: row.NORMALIZATION_VALUE ?? row.normalization_value ?? null,
    std_tokens: tokensFromVariant(row.TOKENS ?? row.tokens),
    norm_tokens: tokensFromVariant(row.NORMALIZED_TOKENS ?? row.normalized_tokens),
  };
}

type ValueToAliasResult = {
  /** Weighted deterministic confidence score (stored as deterministic_score_baseline). */
  score: number;
  /** True if the deterministic acronym component produced a non-zero score for this pair. */
  acronymFired: boolean;
  /** True if any alias_item.clean_value matched run_item.clean_value. */
  exactMatchCleanValueFired: boolean;
  /** True if any alias_item.normalized_value matched run_item.normalized_value. */
  exactMatchNormValueFired: boolean;
  /** The already-computed alias-name pair result (reused in the loop for acronym details). */
  namePair: ReturnType<typeof computePairScore>;
};

function computeValueToAliasConfidence(runItem: RunItemForPairing, alias: AliasBundle): ValueToAliasResult {
  // PairScore is concept-agnostic (same math for any two items). Unassigned-grouping
  // uses it for run_item ↔ run_item only; here we reuse it for run_item ↔ alias_member
  // and run_item ↔ alias name, without baking C into pairscore.ts.
  //
  // C = concept compatibility (run concept vs alias's concept). It discounts evidence
  // from pre-existing ALIAS_ITEMS that “belong” to another concept—not the pair formula.
  // Run ↔ alias-name is not scaled by C (literal/canonical name is concept-independent).
  const C = alias.compatibility_weight;

  const pairScores = alias.items.map((it) => computePairScore(runItem, it));

  // Pre-filter signals — derived here once; never recomputed.
  const exactMatchCleanValueFired = pairScores.some((p) => p.details.M_clean_val > 0);
  const exactMatchNormValueFired  = pairScores.some((p) => p.details.M_normalized_val > 0);

  const mCleanVals = pairScores.filter((p) => p.details.M_clean_val > 0).map((p) => p.details.M_clean_val);
  const mNormVals = pairScores.filter((p) => p.details.M_normalized_val > 0).map((p) => p.details.M_normalized_val);
  const mSTokenVals = pairScores.filter((p) => p.details.M_s_token_sig > 0).map((p) => p.details.M_s_token_sig);
  const mNTokenVals = pairScores.filter((p) => p.details.M_n_token_sig > 0).map((p) => p.details.M_n_token_sig);

  const maCleanVal = Number((C * diminishingAggregate(mCleanVals)).toFixed(6));
  const maNormalizedVal = Number((C * diminishingAggregate(mNormVals)).toFixed(6));
  const maSTokenSig = Number((C * diminishingAggregate(mSTokenVals)).toFixed(6));
  const maNTokenSig = Number((C * diminishingAggregate(mNTokenVals)).toFixed(6));

  const tsAgg = Number((C * diminishingAggregate(pairScores.map((p) => p.details.TS_pair))).toFixed(6));
  const ssAgg = Number((C * diminishingAggregate(pairScores.map((p) => p.details.SS_pair))).toFixed(6));
  const acAgg = Number((C * diminishingAggregate(pairScores.map((p) => p.details.AC_pair))).toFixed(6));

  // Value-to-Alias-Name by treating alias name as a pseudo-item.
  const aliasNamePseudo: RunItemForPairing = {
    run_item_id: -alias.alias_id,
    literal_value: alias.alias_name_literal_value,
    cleaned_value: alias.alias_name_clean_value,
    normalization_value: alias.alias_name_normalization_value,
    std_tokens: alias.alias_name_tokens,
    norm_tokens: alias.alias_name_normalized_tokens,
  };
  const namePair = computePairScore(runItem, aliasNamePseudo);

  const mAliasName = Number(Math.max(
    namePair.details.M_clean_val,
    namePair.details.M_normalized_val,
    namePair.details.M_s_token_sig,
    namePair.details.M_n_token_sig
  ).toFixed(6));
  const mAlias = Number(Math.max(
    mAliasName,
    maCleanVal,
    maNormalizedVal,
    maSTokenSig,
    maNTokenSig
  ).toFixed(6));

  const ocAliasName = Math.max(namePair.details.OC_n_token_sig, namePair.details.OC_s_token_sig);
  const lsAliasName = Math.max(namePair.details.LS_n_token_sig, namePair.details.LS_s_token_sig);
  const tsAliasName = Number((0.55 * ocAliasName + 0.45 * lsAliasName).toFixed(6));
  const tsAlias = Number(Math.max(tsAliasName, tsAgg).toFixed(6));

  const ssAliasName = Number(Math.max(namePair.details.JW_pair, namePair.details.LV_pair).toFixed(6));
  const ssAlias = Number((0.35 * ssAliasName + 0.65 * ssAgg).toFixed(6));

  const acAliasName = namePair.details.AC_pair;
  const acAlias = Number(Math.max(
    acAliasName,
    acAgg,
    (0.6 * acAliasName + 0.4 * acAgg)
  ).toFixed(6));

  const score = Number(
    Math.min(1, 0.51 * mAlias + 0.20 * tsAlias + 0.12 * ssAlias + 0.17 * acAlias).toFixed(6)
  );

  // acronymFired: non-zero AC in the alias-name leg OR any alias-item leg.
  const acronymFired = acAliasName > 0 || acAgg > 0;

  return { score, acronymFired, exactMatchCleanValueFired, exactMatchNormValueFired, namePair };
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  try {
    return await withSnowflake(async (connection) => {
      const runIdNum = Number(run_id);

      // Run the deterministic classification pipeline on any items that were
      // inserted without tokens (i.e. created via the new lightweight CREATE_RUN).
      // CLASSIFY_RUN_ITEMS is idempotent — it only processes rows where tokens IS NULL.
      const classifyResult = await exec(
        connection,
        `CALL STAND_DB.STAND.CLASSIFY_RUN_ITEMS(?)`,
        [runIdNum]
      );
      const classifyMsg = String(
        (classifyResult[0] as any)?.CLASSIFY_RUN_ITEMS ??
        (classifyResult[0] as any)?.classify_run_items ?? ''
      );
      if (classifyMsg.startsWith('ERROR:')) {
        console.error('[apply-confident] CLASSIFY_RUN_ITEMS failed:', classifyMsg);
        return Response.json({ error: `Classification failed: ${classifyMsg}` }, { status: 500 });
      }
      console.log('[apply-confident] CLASSIFY_RUN_ITEMS:', classifyMsg);

      // Unassigned run items only (idempotent update behavior).
      const runItemRows = await exec(
        connection,
        `SELECT run_item_id, literal_value, cleaned_value, normalization_value, tokens, normalized_tokens
         FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
         WHERE run_id = ? AND group_id IS NULL`,
        [runIdNum]
      );
      if (runItemRows.length === 0) {
        return Response.json({
          assigned: 0,
          groups_created: 0,
          message: 'No unassigned items to score.',
        });
      }

      // Fetch the run's concept key and description for the cached LLM system block.
      const conceptRows = await exec(
        connection,
        `SELECT c.concept_id, c.concept_key, COALESCE(c.description, '') AS concept_description
         FROM STAND_DB.STAND_INTERNAL.RUNS r
         JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
         WHERE r.run_id = ?`,
        [runIdNum]
      );
      const runConceptId = conceptRows.length > 0
        ? Number((conceptRows[0] as any).CONCEPT_ID ?? (conceptRows[0] as any).concept_id)
        : -1;
      const runConceptKey = conceptRows.length > 0
        ? String((conceptRows[0] as any).CONCEPT_KEY ?? (conceptRows[0] as any).concept_key ?? '')
        : '';
      const runConceptDescription = conceptRows.length > 0
        ? String((conceptRows[0] as any).CONCEPT_DESCRIPTION ?? (conceptRows[0] as any).concept_description ?? '')
        : '';

      // Active aliases for this run's concept AND any compatible concepts.
      // Same-concept aliases get compatibility_weight = 1.0.
      // Cross-concept aliases are included via CONCEPT_COMPATIBILITY (the table
      // enforces concept_low_id < concept_high_id, so we normalise with LEAST/GREATEST).
      const aliasRows = await exec(
        connection,
        `SELECT a.alias_id, a.concept_id, c_alias.concept_key AS alias_concept_key,
                a.alias_name_literal_value, a.alias_name_clean_value,
                a.alias_name_normalization_value, a.alias_name_tokens, a.alias_name_normalized_tokens,
                COALESCE(cc.compatibility_score, 1.0) AS compatibility_weight
         FROM STAND_DB.STAND_INTERNAL.ALIASES a
         JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c_alias ON c_alias.concept_id = a.concept_id
         JOIN STAND_DB.STAND_INTERNAL.RUNS r
           ON r.run_id = ?
         LEFT JOIN STAND_DB.STAND_INTERNAL.CONCEPT_COMPATIBILITY cc
           ON cc.concept_low_id  = LEAST(r.concept_id, a.concept_id)
          AND cc.concept_high_id = GREATEST(r.concept_id, a.concept_id)
          AND r.concept_id <> a.concept_id
         WHERE a.status = 'active'
           AND (a.concept_id = r.concept_id OR cc.compatibility_score IS NOT NULL)`,
        [runIdNum]
      );
      if (aliasRows.length === 0) {
        return Response.json({
          assigned: 0,
          groups_created: 0,
          message: 'No active aliases found for this run concept.',
        });
      }

      // Alias items for all candidate aliases.
      const aliasIds = aliasRows.map((r: any) => Number(r.ALIAS_ID ?? r.alias_id)).filter(Number.isFinite);
      const aliasItems: any[] = aliasIds.length > 0
        ? await exec(
            connection,
            `SELECT alias_item_id, alias_id, literal_value, cleaned_value, normalization_value, tokens, normalized_tokens
             FROM STAND_DB.STAND_INTERNAL.ALIAS_ITEMS
             WHERE alias_id IN (${aliasIds.map(() => '?').join(', ')})`,
            aliasIds
          )
        : [];

      const itemsByAliasId = new Map<number, AliasItemScorable[]>();
      for (const r of aliasItems) {
        const aliasId = Number(r.ALIAS_ID ?? r.alias_id);
        const item: AliasItemScorable = {
          alias_item_id: Number(r.ALIAS_ITEM_ID ?? r.alias_item_id),
          run_item_id: Number(r.ALIAS_ITEM_ID ?? r.alias_item_id), // placeholder id for computePairScore
          literal_value: String(r.LITERAL_VALUE ?? r.literal_value ?? ''),
          cleaned_value: r.CLEANED_VALUE ?? r.cleaned_value ?? null,
          normalization_value: r.NORMALIZATION_VALUE ?? r.normalization_value ?? null,
          std_tokens: tokensFromVariant(r.TOKENS ?? r.tokens),
          norm_tokens: tokensFromVariant(r.NORMALIZED_TOKENS ?? r.normalized_tokens),
        };
        if (!itemsByAliasId.has(aliasId)) itemsByAliasId.set(aliasId, []);
        itemsByAliasId.get(aliasId)!.push(item);
      }

      const aliases: AliasBundle[] = aliasRows.map((r: any) => {
        const aliasId = Number(r.ALIAS_ID ?? r.alias_id);
        const compatRaw = r.COMPATIBILITY_WEIGHT ?? r.compatibility_weight;
        return {
          alias_id: aliasId,
          concept_id: Number(r.CONCEPT_ID ?? r.concept_id ?? -1),
          concept_key: String(r.ALIAS_CONCEPT_KEY ?? r.alias_concept_key ?? ''),
          alias_name_literal_value: String(r.ALIAS_NAME_LITERAL_VALUE ?? r.alias_name_literal_value ?? ''),
          alias_name_clean_value: r.ALIAS_NAME_CLEAN_VALUE ?? r.alias_name_clean_value ?? null,
          alias_name_normalization_value: r.ALIAS_NAME_NORMALIZATION_VALUE ?? r.alias_name_normalization_value ?? null,
          alias_name_tokens: tokensFromVariant(r.ALIAS_NAME_TOKENS ?? r.alias_name_tokens),
          alias_name_normalized_tokens: tokensFromVariant(r.ALIAS_NAME_NORMALIZED_TOKENS ?? r.alias_name_normalized_tokens),
          compatibility_weight: compatRaw != null ? Number(compatRaw) : 1.0,
          items: itemsByAliasId.get(aliasId) ?? [],
        };
      });

      // Build the per-concept token rarity lookup (used in feature payloads).
      // Cast aliases to AliasBundleForPayload — the shapes are compatible.
      const tokenRarity = buildTokenRarityLookup(aliases as AliasBundleForPayload[]);

      // Build the static LLM system block (cached across all pairs in this run).
      // All alias names in the run's concept are listed as context for the model.
      const sameConceptAliases = aliases.filter((a) => Math.abs(a.compatibility_weight - 1.0) < 1e-9);
      const sameConceptAliasCount = sameConceptAliases.length;
      const sameConceptAliasNames = sameConceptAliases.map((a) => a.alias_name_literal_value);
      const cachedSystemBlock = buildCachedSystemBlock(
        runConceptKey,
        runConceptDescription,
        sameConceptAliasNames,
      );

      // Accumulates one record per (run_item, alias) LLM call for the debug JSON.
      const llmBreakdownRecords: LLMPairRecord[] = [];

      // ── Scoring types ───────────────────────────────────────────────────────
      type TopEntry = {
        aliasId: number;
        aliasName: string;
        /** LLM confidence (or deterministic fallback). Drives the gate. */
        score: number;
        /** Original deterministic formula score. Stored as baseline, never sent to LLM. */
        deterministicScore: number;
        llmReasoning: string | null;
        llmFlags: string[] | null;
        /** Non-null when the LLM call succeeded; null when deterministic fallback was used. */
        modelUsed: string | null;
      };
      const topByItem = new Map<number, TopEntry>();
      const secondByItem = new Map<number, { score: number }>();

      // ── Per-alias scoring closure ────────────────────────────────────────────
      // Captures run-scoped state (cachedSystemBlock, tokenRarity, runConceptId).
      // Called in parallel across aliases for each run_item.
      type AliasScoreResult = {
        aliasId: number;
        aliasName: string;
        score: number;
        deterministicScore: number;
        llmReasoning: string | null;
        llmFlags: string[] | null;
        modelUsed: string | null;
        /** Token usage for this pair (zeroed for prefilter-skipped and cache-hit pairs). */
        usage: LLMTokenUsage;
        /** Wall-clock ms of the live Anthropic API call only. Zero for cache hits, prefilter skips, and failures. */
        llm_call_ms: number;
        breakdownRecord: LLMPairRecord;
      };

      async function scoreOneAlias(
        runItem: ReturnType<typeof toScorable>,
        alias: AliasBundle,
      ): Promise<AliasScoreResult> {
        const runItemId = runItem.run_item_id;
        const aliasId = alias.alias_id;
        const aliasName = alias.alias_name_literal_value;

        // Compute deterministic score and read pre-filter signals in one pass.
        // computeValueToAliasConfidence computes all computePairScore calls once;
        // the three pre-filter flags and namePair are extracted from those results.
        const {
          score: deterministicScore,
          acronymFired,
          exactMatchCleanValueFired,
          exactMatchNormValueFired,
          namePair,
        } = computeValueToAliasConfidence(runItem, alias);

        // ── Pre-filter ─────────────────────────────────────────────────────────
        const shouldSkip = (
          deterministicScore < PREFILTER_SCORE_THRESHOLD
          && !acronymFired
          && !exactMatchCleanValueFired
          && !exactMatchNormValueFired
        );

        if (shouldSkip) {
          return {
            aliasId,
            aliasName,
            score: 0.0,
            deterministicScore,
            llmReasoning: null,
            llmFlags: null,
            modelUsed: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            llm_call_ms: 0,
            breakdownRecord: {
              run_item_id: runItemId,
              literal_value: runItem.literal_value,
              alias_id: aliasId,
              alias_name_literal_value: aliasName,
              compatibility_weight: alias.compatibility_weight,
              prompt_user_message: null,
              llm_raw_response: null,
              llm_parsed_response: null,
              llm_confidence: null,
              deterministic_score: deterministicScore,
              llm_succeeded: false,
              skipped_by_prefilter: true,
              from_cache: false,
              is_top_candidate: false,
              assigned: false,
              error: null,
            },
          };
        }

        // Build feature payload (never includes weighted scores or deterministic baseline).
        const payload = buildFeaturePayload({
          runItem,
          alias: alias as AliasBundleForPayload,
          runConceptId,
          tokenRarity,
          namePairDetails: namePair.details,
        });

        let score = deterministicScore;
        let llmReasoning: string | null = null;
        let llmFlags: string[] | null = null;
        let modelUsed: string | null = null;
        let llmRawResponse: string | null = null;
        let llmParsedResponse: unknown | null = null;
        let llmSucceeded = false;
        let fromCache = false;
        let llmError: string | null = null;
        let pairUsage: LLMTokenUsage = {
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        };
        let pairLLMCallMs = 0;

        // ── Cache check ────────────────────────────────────────────────────────
        const cachedParsed = await getCachedResult(runItem.literal_value, runConceptId, aliasId);

        if (cachedParsed !== null) {
          // Cache hit: use the stored parsed response directly (no live LLM call).
          fromCache = true;
          score = Math.min(1, Math.max(0, cachedParsed.confidence));
          llmReasoning = score < 0.05 ? null : (cachedParsed.reasoning ?? null);
          llmFlags = cachedParsed.flags ?? [];
          modelUsed = LLM_MODEL_ID;
          llmParsedResponse = cachedParsed;
          llmSucceeded = true;
        } else {
          // ── Cache miss → LLM call with retry ────────────────────────────────
          // scoreAliasMatchWithRetry chain:
          //   scorePairWithRetry (retry on 429)
          //     └── scorePairWithLLM (actual Anthropic API call)
          const result = await scorePairWithRetry(cachedSystemBlock, payload);

          if (result !== null) {
            llmRawResponse = result.rawText;
            llmParsedResponse = result.parsed;
            score = Math.min(1, Math.max(0, result.parsed.confidence));
            llmReasoning = score < 0.05 ? null : (result.parsed.reasoning ?? null);
            llmFlags = result.parsed.flags ?? [];
            modelUsed = LLM_MODEL_ID;
            llmSucceeded = true;
            pairUsage = result.usage;
            pairLLMCallMs = result.llm_call_ms;
            // Store in cache so future runs for this (literalValue, concept, alias) skip the live call.
            await setCachedResult(runItem.literal_value, runConceptId, aliasId, result.parsed);
          } else {
            // Retries exhausted or non-429 error — fall back to deterministic score.
            llmError = 'LLM call failed after retries — deterministic fallback used';
            console.error(
              `[apply-confident] LLM failed for item ${runItemId} vs alias ${aliasId} — using deterministic fallback`,
            );
          }
        }

        return {
          aliasId,
          aliasName,
          score,
          deterministicScore,
          llmReasoning,
          llmFlags,
          modelUsed,
          usage: pairUsage,
          llm_call_ms: pairLLMCallMs,
          breakdownRecord: {
            run_item_id: runItemId,
            literal_value: runItem.literal_value,
            alias_id: aliasId,
            alias_name_literal_value: aliasName,
            compatibility_weight: alias.compatibility_weight,
            prompt_user_message: payload,
            llm_raw_response: llmRawResponse,
            llm_parsed_response: llmParsedResponse,
            llm_confidence: llmSucceeded ? score : null,
            deterministic_score: deterministicScore,
            llm_succeeded: llmSucceeded,
            skipped_by_prefilter: false,
            from_cache: fromCache,
            is_top_candidate: false,
            assigned: false,
            error: llmError,
          },
        };
      }

      // ── Scoring loop ─────────────────────────────────────────────────────────
      // Outer loop: run_items processed sequentially to keep the Anthropic prompt
      // cache warm (all calls share the same cached system block keyed on the run's
      // concept). Inner comparisons: all aliases for a single run_item are scored
      // concurrently up to LLM_CONCURRENCY_LIMIT.
      //
      // Call chain per alias:
      //   scoreOneAlias (this closure)
      //     └── getCachedResult       (cache check — skip live call on hit)
      //     └── scorePairWithRetry    (cache miss: retry wrapper for HTTP 429)
      //           └── scorePairWithLLM (actual Anthropic API call)
      //     └── setCachedResult       (write result to cache on success)

      const zeroUsage: LLMTokenUsage = {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      };

      // Initialise progress so the client can start polling immediately.
      scoringProgress.set(runIdNum, {
        phase: 'scoring',
        items_scored: 0,
        items_total: runItemRows.length,
        pairs_scored: 0,
        pairs_total: runItemRows.length * aliases.length,
        token_usage: { ...zeroUsage },
        estimated_cost_usd: 0,
        llm_elapsed_ms: 0,
        deterministic_elapsed_ms: 0,
      });


      let itemsScored = 0;
      let pairsScored = 0;
      let llmElapsedMs = 0;
      let deterministicElapsedMs = 0;
      const cumulativeUsage: LLMTokenUsage = { ...zeroUsage };

      for (const row of runItemRows) {
        const runItem = toScorable(row);

        const batchStart = Date.now();
        const aliasResults = await parallelWithLimit(
          aliases,
          (alias) => scoreOneAlias(runItem, alias),
          LLM_CONCURRENCY_LIMIT,
        );
        // Only count this batch toward LLM elapsed time if at least one live
        // Anthropic API call was made (i.e. not all cache hits / pre-filter skips).
        // wall-clock of the batch ≈ time spent waiting on the LLM for this item.
        if (aliasResults.some((r) => r.llm_call_ms > 0)) {
          llmElapsedMs += Date.now() - batchStart;
        } else {
          // Entire batch was served from cache or pre-filtered — counts as deterministic work.
          deterministicElapsedMs += Date.now() - batchStart;
        }

        itemsScored += 1;
        pairsScored += aliasResults.length;
        for (const r of aliasResults) {
          cumulativeUsage.input_tokens                += r.usage.input_tokens;
          cumulativeUsage.output_tokens               += r.usage.output_tokens;
          cumulativeUsage.cache_read_input_tokens     += r.usage.cache_read_input_tokens;
          cumulativeUsage.cache_creation_input_tokens += r.usage.cache_creation_input_tokens;
        }
        scoringProgress.set(runIdNum, {
          phase: 'scoring',
          items_scored: itemsScored,
          items_total: runItemRows.length,
          pairs_scored: pairsScored,
          pairs_total: runItemRows.length * aliases.length,
          token_usage: { ...cumulativeUsage },
          estimated_cost_usd: estimateCostUSD(cumulativeUsage),
          llm_elapsed_ms: llmElapsedMs,
          deterministic_elapsed_ms: deterministicElapsedMs,
        });

        for (const r of aliasResults) {
          llmBreakdownRecords.push(r.breakdownRecord);

          const runItemId = runItem.run_item_id;
          const existing = topByItem.get(runItemId);
          if (!existing || r.score > existing.score || (r.score === existing.score && r.aliasId < existing.aliasId)) {
            if (existing) {
              const existingSecond = secondByItem.get(runItemId);
              if (!existingSecond || existing.score > existingSecond.score) {
                secondByItem.set(runItemId, { score: existing.score });
              }
            }
            topByItem.set(runItemId, {
              aliasId: r.aliasId,
              aliasName: r.aliasName,
              score: r.score,
              deterministicScore: r.deterministicScore,
              llmReasoning: r.llmReasoning,
              llmFlags: r.llmFlags,
              modelUsed: r.modelUsed,
            });
          } else {
            const existingSecond = secondByItem.get(runItemId);
            if (!existingSecond || r.score > existingSecond.score) {
              secondByItem.set(runItemId, { score: r.score });
            }
          }
        }
      }

      // Apply dual-threshold gate; collect alias -> assigned run items.
      type ConfidentItem = {
        runItemId: number;
        topScore: number;
        deterministicScore: number;
        llmReasoning: string | null;
        llmFlags: string[] | null;
        modelUsed: string | null;
      };
      const aliasToItems = new Map<number, { aliasName: string; items: ConfidentItem[] }>();

      for (const [runItemId, top] of topByItem) {
        // Absolute threshold — always required. Also catches top_score == 0 explicitly.
        if (top.score <= 0 || top.score < LLM_CONFIDENT_TOP_SCORE) continue;

        // Margin ratio — skipped when there is only one alias in the concept
        // (no meaningful second candidate) or when the second score is negligible.
        if (sameConceptAliasCount > 1) {
          const secondScore = secondByItem.get(runItemId)?.score ?? 0;
          if (secondScore >= 0.01 && top.score / secondScore < LLM_CONFIDENT_MARGIN_RATIO) continue;
        }

        const item: ConfidentItem = {
          runItemId,
          topScore: top.score,
          deterministicScore: top.deterministicScore,
          llmReasoning: top.llmReasoning,
          llmFlags: top.llmFlags,
          modelUsed: top.modelUsed,
        };
        const bucket = aliasToItems.get(top.aliasId);
        if (bucket) {
          bucket.items.push(item);
        } else {
          aliasToItems.set(top.aliasId, { aliasName: top.aliasName, items: [item] });
        }
      }

      if (aliasToItems.size === 0) {
        scoringProgress.delete(runIdNum);
        return Response.json({
          assigned: 0,
          groups_created: 0,
          message: 'No items passed the confidence gate.',
        });
      }

      // Signal to the client that scoring is done and DB writes are in progress.
      scoringProgress.set(runIdNum, {
        phase: 'saving',
        items_scored: runItemRows.length,
        items_total: runItemRows.length,
        pairs_scored: pairsScored,
        pairs_total: runItemRows.length * aliases.length,
        token_usage: { ...cumulativeUsage },
        estimated_cost_usd: estimateCostUSD(cumulativeUsage),
        llm_elapsed_ms: llmElapsedMs,
        deterministic_elapsed_ms: deterministicElapsedMs,
      });

      // Fetch existing alias-backed groups for this run.
      const existingGroupRows = await exec(
        connection,
        `SELECT group_id, final_alias_id AS alias_id
         FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
         WHERE run_id = ? AND final_alias_id IS NOT NULL`,
        [runIdNum]
      );

      const groupIdByAliasId = new Map<number, number>();
      for (const g of existingGroupRows) {
        const aid = (g as any).ALIAS_ID ?? (g as any).alias_id;
        const gid = (g as any).GROUP_ID ?? (g as any).group_id;
        if (aid != null && gid != null) groupIdByAliasId.set(Number(aid), Number(gid));
      }

      let groupsCreated = 0;
      for (const [aliasId, { aliasName }] of aliasToItems) {
        if (groupIdByAliasId.has(aliasId)) continue;
        await exec(
          connection,
          `INSERT INTO STAND_DB.STAND_INTERNAL.RUN_GROUPS (
             run_id, initial_alias_name, alias_name_literal_value,
             final_alias_id, is_user_created, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, FALSE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
           WHERE NOT EXISTS (
             SELECT 1 FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
             WHERE run_id = ? AND final_alias_id = ?
           )`,
          [runIdNum, aliasName, aliasName, aliasId, runIdNum, aliasId]
        );
        const rows = await exec(
          connection,
          `SELECT group_id FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
           WHERE run_id = ? AND final_alias_id = ?
           ORDER BY group_id DESC LIMIT 1`,
          [runIdNum, aliasId]
        );
        const groupId = Number((rows[0] as any)?.GROUP_ID ?? (rows[0] as any)?.group_id ?? -1);
        if (groupId !== -1) {
          groupIdByAliasId.set(aliasId, groupId);
          groupsCreated++;
        }
      }

      type Assignment = {
        runItemId: number;
        groupId: number;
        score: number;
        deterministicScore: number;
        llmReasoning: string | null;
        llmFlagsJson: string | null;  // JSON string for PARSE_JSON; null → SQL NULL
        modelUsed: string | null;
      };
      const assignments: Assignment[] = [];
      for (const [aliasId, { items }] of aliasToItems) {
        const groupId = groupIdByAliasId.get(aliasId);
        if (groupId == null) continue;
        for (const { runItemId, topScore, deterministicScore, llmReasoning, llmFlags, modelUsed } of items) {
          assignments.push({
            runItemId,
            groupId,
            score: topScore,
            deterministicScore,
            llmReasoning,
            // llmFlags is an array on LLM success (possibly empty) or null on fallback.
            // PARSE_JSON(NULL) in Snowflake returns SQL NULL cleanly.
            llmFlagsJson: llmFlags !== null ? JSON.stringify(llmFlags) : null,
            modelUsed,
          });
        }
      }

      if (assignments.length === 0) {
        return Response.json({
          assigned: 0,
          groups_created: groupsCreated,
          message: `Created ${groupsCreated} group(s) but no items could be assigned.`,
        });
      }

      // 7 columns per row: run_item_id, group_id, confidence_score,
      // deterministic_score_baseline, confidence_reasoning, confidence_flags, model_used.
      const clauses = assignments.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      const updateBinds: any[] = [];
      for (const { runItemId, groupId, score, deterministicScore, llmReasoning, llmFlagsJson, modelUsed } of assignments) {
        updateBinds.push(runItemId, groupId, score, deterministicScore, llmReasoning, llmFlagsJson, modelUsed);
      }
      updateBinds.push(runIdNum, runIdNum);

      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
         SET
           group_id                     = mv.group_id,
           confidence_score             = mv.confidence_score,
           deterministic_score_baseline = mv.deterministic_score_baseline,
           confidence_reasoning         = mv.confidence_reasoning,
           confidence_flags             = mv.confidence_flags,
           model_used                   = mv.model_used,
           updated_at                   = CURRENT_TIMESTAMP()
         FROM (
           SELECT
             column1::NUMBER(38,0)  AS run_item_id,
             column2::NUMBER(38,0)  AS group_id,
             column3::FLOAT         AS confidence_score,
             column4::FLOAT         AS deterministic_score_baseline,
             column5::VARCHAR       AS confidence_reasoning,
             PARSE_JSON(column6::VARCHAR) AS confidence_flags,
             column7::VARCHAR       AS model_used
           FROM VALUES ${clauses}
         ) mv
         JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
           ON rg.run_id   = ?
          AND rg.group_id = mv.group_id
         WHERE ri.run_id      = ?
           AND ri.run_item_id = mv.run_item_id
           AND ri.group_id IS NULL`,
        updateBinds
      );

      // Back-fill is_top_candidate and assigned on breakdown records, then write JSON.
      const topRunItemIds = new Set(topByItem.keys());
      const assignedRunItemIds = new Set(assignments.map((a) => a.runItemId));
      for (const rec of llmBreakdownRecords) {
        const top = topByItem.get(rec.run_item_id);
        rec.is_top_candidate = top?.aliasId === rec.alias_id;
        rec.assigned = rec.is_top_candidate && assignedRunItemIds.has(rec.run_item_id);
      }
      // system prompt text is the first block's text in the cached system block.
      const systemPromptText = cachedSystemBlock[0]?.text ?? '';
      writeLLMBreakdown(runIdNum, runConceptKey, runConceptDescription, LLM_MODEL_ID, systemPromptText, llmBreakdownRecords);
      void topRunItemIds; // used above only for clarity; suppress unused warning

      scoringProgress.delete(runIdNum);

      return Response.json(
        {
          assigned: assignments.length,
          groups_created: groupsCreated,
          message: `Assigned ${assignments.length} item(s) to ${aliasToItems.size} alias(es). Created ${groupsCreated} new group(s).`,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });
  } catch (error) {
    // Clear any in-progress entry so the client doesn't remain stuck on a progress bar.
    const { run_id } = await params;
    scoringProgress.delete(Number(run_id));
    console.error('apply-confident-assignments error:', error);
    return snowflakeErrorResponse(error, 'Failed to apply confident assignments');
  }
}
