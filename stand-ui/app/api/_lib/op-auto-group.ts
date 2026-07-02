/**
 * One-Prompt Auto-Grouping Pipeline (Steps 3–7).
 *
 * Executed when the user clicks "Auto Group" in the one-prompt UI.
 *
 *   Step 3 — Literal lookup   : exact-match against one_prompt_literal_alias_matches
 *   Step 4 — Lookup groups    : group matched items by alias_name
 *   Step 5 — LLM chunking     : parallel LLM calls for unmatched items (chunks of 25)
 *   Step 6 — Merge pass       : single LLM call merging all groups
 *   Step 7 — Assemble state   : build final OpRunState (caller writes it to DB)
 *
 * No tokens, no normalization, no pairscores.
 * Items carry only literal_value + source_frequency.
 */

import 'server-only';

import { normalizeLiteral } from './normalize';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID           = 'claude-sonnet-4-6';
const MAX_CHUNK_SIZE     = 25;
const CHUNK_MAX_TOKENS   = 8_192;
const MERGE_MAX_TOKENS   = 4_096;

// ---------------------------------------------------------------------------
// Public types (blob schema)
// ---------------------------------------------------------------------------

export interface OpStateItem {
  run_item_id?:         number;   // stable 1-based index assigned at run creation; absent for legacy blobs
  literal_value:        string;
  source_frequency?:    number;
  matched_from_lookup:  boolean;
  alias_name?:          string;
}

export interface OpGroupItem {
  literal_value:       string;
  matched_from_lookup: boolean;
}

export interface OpGroup {
  group_id:          number;
  alias_name:        string;
  alias_name_source: 'lookup_validated' | 'llm_proposed' | 'user_override';
  confidence:        'h' | 'm' | 'l';
  from_lookup_chunk: boolean;
  /** Singleton groups the LLM couldn't confidently place — self-mapped and
   *  surfaced in yellow for the user to confirm/rename. Still written to the
   *  lookup so no value is left unmapped (keeps the pipeline queue empty). */
  needs_review?:     boolean;
  items:             OpGroupItem[];
}

export interface OpUngrouped {
  literal_value:       string;
  matched_from_lookup: boolean;
}

export interface OpRunState {
  status:    'created' | 'running' | 'complete' | 'failed';
  items:     OpStateItem[];
  groups:    OpGroup[];
  ungrouped: OpUngrouped[];
}

// ---------------------------------------------------------------------------
// Internal pipeline type (before group_id assignment)
// ---------------------------------------------------------------------------

interface PipelineGroup {
  alias_name:         string | null;
  alias_name_source:  'lookup_validated' | 'llm_proposed';
  confidence:         'h' | 'm' | 'l';
  from_lookup_chunk:  boolean;
  items:              OpGroupItem[];
  lookup_usage_count: number;  // for tie-breaking two lookup groups in merge
}

// ---------------------------------------------------------------------------
// LLM JSON shapes
// ---------------------------------------------------------------------------

// Chunk grouping response: { "g": [[[indices], "name", "h|m|l"], ...], "u": [idx, ...] }
type LLMGroupTuple = [number[], string | null, 'h' | 'm' | 'l'];
interface LLMChunkResponse { g: LLMGroupTuple[]; u: number[]; }

// Merge response: { "m": [[[group_indices], "name|null"], ...] }
type MergeEntry = [number[], string | null];
interface LLMMergeResponse { m: MergeEntry[]; }

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function stripFences(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const inner = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return inner?.[1]?.trim() ?? t.trim();
}

function extractBraced(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc)    { esc = false; continue; }
    if (inStr)  { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function tryParseJson<T>(text: string): T | null {
  const stripped = stripFences(text);
  for (const candidate of [stripped, extractBraced(stripped), extractBraced(text.trim())]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate) as T; } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM call helper
// ---------------------------------------------------------------------------

async function callLLM(
  apiKey:    string,
  system:    string,
  user:      string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model:       MODEL_ID,
      max_tokens:  maxTokens,
      temperature: 0,
      system:      [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages:    [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`[op-auto-group] Anthropic error ${res.status}: ${err.slice(0, 400)}`);
  }

  const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Step 5 — Chunk grouping prompts
// ---------------------------------------------------------------------------

function buildChunkSystemPrompt(domainName: string | null): string {
  const domainLine = domainName
    ? `\nDomain: "${domainName}" — apply domain-specific world knowledge when identifying canonical entity names.`
    : '';

  return (
    `You are a grouping assistant for an entity-resolution system.${domainLine}\n\n` +
    `You receive raw string values from a source data column. Each item has a\n` +
    `literal_value and a source_frequency (how many times it appears in the data).\n\n` +
    `Cluster items into groups where every item refers to the same real-world entity.\n` +
    `Use your world knowledge freely — "VZW" abbreviates "Verizon Wireless",\n` +
    `"T-Mo" means T-Mobile, etc.\n\n` +
    `Only compare items within this batch. Bias toward NOT grouping when uncertain.\n` +
    `Under-clustering is safe — a human can drag items together later.\n\n` +
    `Items with no peer in the batch should be singleton groups.\n` +
    `Items that are genuinely ambiguous go in "u" (not singletons).\n\n` +
    `Respond only with valid JSON. No text outside the JSON.`
  );
}

function buildChunkUserTurn(items: OpStateItem[]): string {
  const N      = items.length;
  const blocks = items
    .map((item, i) =>
      `ITEM ${i + 1}:\n` +
      `  literal_value: "${item.literal_value}"` +
      (item.source_frequency != null ? `\n  source_frequency: ${item.source_frequency}` : ''),
    )
    .join('\n\n');

  return (
    `Group these ${N} items into canonical entity clusters.\n\n` +
    `ITEMS:\n\n${blocks}\n\n` +
    `---\n\n` +
    `Return ONLY this JSON — no other text:\n\n` +
    `{"g":[[[item_indices],"proposed_name","h|m|l"],...],"u":[item_index,...]}\n\n` +
    `Schema:\n` +
    `- "g": array of groups. Each group is a 3-element array:\n` +
    `    [0] item_indices — 1-based item numbers in this group\n` +
    `    [1] proposed_name — canonical name string, or null if unclear\n` +
    `    [2] confidence — "h" (high), "m" (medium), or "l" (low)\n` +
    `- "u": item indices that are genuinely ambiguous (singletons go in "g", not "u")\n` +
    `- Every index 1..${N} must appear exactly once across g and u.\n\n` +
    `Example: {"g":[[[1,4],"Verizon","h"],[[2,3],"AT&T","h"],[[5],"Dish","m"]],"u":[6]}`
  );
}

// ---------------------------------------------------------------------------
// Step 6 — Merge pass prompt
// ---------------------------------------------------------------------------

function buildMergeSystemPrompt(validatedAliasNames: string[], domainName: string | null): string {
  const domainLine = domainName
    ? `Domain: "${domainName}" — use this context when choosing canonical names.\n\n`
    : '';

  const validatedSection =
    validatedAliasNames.length > 0
      ? `\nVALIDATED ALIAS NAMES (preserve these when merging):\n${validatedAliasNames.join('\n')}\n`
      : '';

  return (
    `You are reviewing proposed groups from a multi-chunk entity-resolution run.\n` +
    domainLine +
    `Groups were clustered independently per chunk. Merge any groups that refer to\n` +
    `the same real-world entity.\n\n` +
    `Only merge when confident. When uncertain, leave groups separate.\n` +
    `When proposing a merged_name:\n` +
    `  - If any group being merged has a VALIDATED alias name, always use that name.\n` +
    `  - Otherwise choose the most canonical-sounding name from the groups.\n\n` +
    `Respond only with valid JSON. No text outside the JSON.` +
    validatedSection
  );
}

function buildMergeUserTurn(groups: PipelineGroup[]): string {
  const blocks = groups
    .map((g, i) => {
      const reps    = g.items.slice(0, 3).map((it) => `"${it.literal_value.replace(/"/g, '\\"')}"`).join(', ');
      const nameStr = g.alias_name ? `"${g.alias_name.replace(/"/g, '\\"')}"` : 'null';
      const tag     = g.from_lookup_chunk ? ' [VALIDATED]' : '';
      return (
        `GROUP ${i + 1}:\n` +
        `  alias_name: ${nameStr}${tag}\n` +
        `  confidence: "${g.confidence}"\n` +
        `  sample_items: [${reps}]`
      );
    })
    .join('\n\n');

  return (
    `PROPOSED GROUPS:\n\n${blocks}\n\n` +
    `---\n\n` +
    `Return ONLY this JSON — no other text:\n\n` +
    `{"m":[[[group_indices],"merged_name|null"],...]}\n\n` +
    `Schema:\n` +
    `- "m": array of merge entries. Each entry is a 2-element array:\n` +
    `    [0] group_indices — 1-based group numbers to collapse (≥2 per entry)\n` +
    `    [1] merged_name  — canonical name string, or null\n` +
    `- Groups not referenced remain unchanged.\n` +
    `- If no merges needed: {"m":[]}\n\n` +
    `Example: {"m":[[[1,3],"Verizon"],[[2,5,7],"AT&T"]]}`
  );
}

// ---------------------------------------------------------------------------
// Merge application — enforces lookup-name priority rules
// ---------------------------------------------------------------------------

function applyMerges(groups: PipelineGroup[], merges: MergeEntry[]): PipelineGroup[] {
  const consumed = new Set<number>();
  const result:   PipelineGroup[] = [];

  for (const merge of merges ?? []) {
    const indices = (merge[0] ?? [])
      .map(Number)
      .filter((idx) => Number.isInteger(idx) && idx >= 1 && idx <= groups.length);

    if (indices.length < 2 || indices.some((idx) => consumed.has(idx))) continue;
    for (const idx of indices) consumed.add(idx);

    const toMerge      = indices.map((idx) => groups[idx - 1]);
    const lookupGroups = toMerge.filter((g) => g.from_lookup_chunk && g.alias_name);

    let mergedName:   string | null;
    let mergedSource: 'lookup_validated' | 'llm_proposed';
    let fromLookup:   boolean;
    let mergedConf:   'h' | 'm' | 'l';

    if (lookupGroups.length >= 2) {
      // Two or more lookup groups: keep the name with the highest usage_count.
      const best = lookupGroups.reduce((a, b) =>
        a.lookup_usage_count >= b.lookup_usage_count ? a : b,
      );
      mergedName   = best.alias_name;
      mergedSource = 'lookup_validated';
      fromLookup   = true;
      mergedConf   = 'h';
    } else if (lookupGroups.length === 1) {
      // One lookup group — always use its validated name.
      mergedName   = lookupGroups[0].alias_name;
      mergedSource = 'lookup_validated';
      fromLookup   = true;
      mergedConf   = 'h';
    } else {
      // Two non-lookup groups — use the LLM's proposed merged_name.
      mergedName   = merge[1] ?? toMerge[0].alias_name;
      mergedSource = 'llm_proposed';
      fromLookup   = false;
      // Downgrade confidence one level when merging uncertain groups.
      mergedConf   = toMerge.some((g) => g.confidence === 'h') ? 'm' : 'l';
    }

    result.push({
      alias_name:         mergedName,
      alias_name_source:  mergedSource,
      confidence:         mergedConf,
      from_lookup_chunk:  fromLookup,
      items:              toMerge.flatMap((g) => g.items),
      lookup_usage_count: Math.max(...toMerge.map((g) => g.lookup_usage_count)),
    });
  }

  // Pass through groups that were not part of any merge.
  for (let i = 0; i < groups.length; i++) {
    if (!consumed.has(i + 1)) result.push(groups[i]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Snowflake exec helper (local — not exported)
// ---------------------------------------------------------------------------

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else     resolve(rows ?? []);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Step 3 helpers — literal lookup + usage-count fetch (domain-aware)
// ---------------------------------------------------------------------------

async function fetchLookupMatches(
  connection: any,
  literals:   string[],
  domainId:   number | null,
): Promise<Map<string, string>> {
  if (literals.length === 0) return new Map();

  // Match on the normalized form so casing/whitespace/Unicode variants resolve
  // to the same stored mapping. The returned map is keyed by the normalized
  // value (PRISM_NORMALIZE); callers look up with normalizeLiteral(literal).
  const normLiterals = Array.from(new Set(literals.map(normalizeLiteral))).filter(Boolean);
  if (normLiterals.length === 0) return new Map();

  const placeholders = normLiterals.map(() => '?').join(', ');
  // domain_id is denormalized onto LITERAL_ALIAS_MATCHES for fast filtering;
  // alias_name is retrieved via JOIN since it lives only on APPROVED_ALIAS_NAMES.
  const domainFilter = domainId != null
    ? `AND lam.domain_id = ${Number(domainId)}`
    : `AND lam.domain_id IS NULL`;

  const rows = await exec(
    connection,
    `SELECT lam.normalized_value AS norm_key, aan.alias_name
     FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
     JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan
       ON lam.alias_id = aan.alias_id
     WHERE lam.normalized_value IN (${placeholders})
     ${domainFilter}`,
    normLiterals,
  );

  const result = new Map<string, string>();
  for (const row of rows) {
    const key = String((row as any).NORM_KEY   ?? (row as any).norm_key   ?? '');
    const an  = String((row as any).ALIAS_NAME ?? (row as any).alias_name ?? '');
    if (key && an) result.set(key, an);
  }
  return result;
}

async function fetchUsageCounts(
  connection:  any,
  aliasNames:  string[],
  domainId:    number | null,
): Promise<Map<string, number>> {
  if (aliasNames.length === 0) return new Map();

  const placeholders = aliasNames.map(() => '?').join(', ');
  const domainFilter = domainId != null
    ? `AND domain_id = ${Number(domainId)}`
    : `AND domain_id IS NULL`;

  const rows = await exec(
    connection,
    `SELECT alias_name, usage_count
     FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
     WHERE alias_name IN (${placeholders})
     ${domainFilter}`,
    aliasNames,
  );

  const result = new Map<string, number>();
  for (const row of rows) {
    const an = String((row as any).ALIAS_NAME  ?? (row as any).alias_name  ?? '');
    const uc = Number((row as any).USAGE_COUNT ?? (row as any).usage_count ?? 0);
    if (an) result.set(an, uc);
  }
  return result;
}

// ---------------------------------------------------------------------------
// State persistence helpers (exported for reuse in routes)
// ---------------------------------------------------------------------------

export async function loadOpRunState(connection: any, runId: number): Promise<OpRunState | null> {
  const rows = await exec(
    connection,
    `SELECT state FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
    [runId],
  );
  if (!rows.length) return null;

  const raw = (rows[0] as any).STATE ?? (rows[0] as any).state;
  if (raw == null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as OpRunState;
}

export async function saveOpRunState(
  connection: any,
  runId:      number,
  state:      OpRunState,
): Promise<void> {
  const json = JSON.stringify(state);
  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS
     SET state      = PARSE_JSON(?),
         updated_at = CURRENT_TIMESTAMP()
     WHERE run_id = ?`,
    [json, runId],
  );
}

// ---------------------------------------------------------------------------
// Main pipeline export — Steps 3–7
// ---------------------------------------------------------------------------

export async function runOpAutoGroup(
  connection: any,
  runId:      number,
  apiKey:     string,
): Promise<OpRunState> {

  const state = await loadOpRunState(connection, runId);
  if (!state) {
    throw new Error(`Run state not found for run_id=${runId}. Re-create the run to initialize state.`);
  }

  // ── Fetch domain info for this run ─────────────────────────────────────────
  const runRows = await exec(
    connection,
    `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
    [runId],
  );
  const domainId: number | null =
    runRows.length > 0
      ? (Number((runRows[0] as any).DOMAIN_ID ?? (runRows[0] as any).domain_id) || null)
      : null;

  let domainName: string | null = null;
  if (domainId != null) {
    const domainRows = await exec(
      connection,
      `SELECT name FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
      [domainId],
    );
    domainName = domainRows.length > 0
      ? String((domainRows[0] as any).NAME ?? (domainRows[0] as any).name ?? '')
      : null;
  }

  const items: OpStateItem[] = state.items ?? [];

  // ── Step 3: Literal lookup (domain-scoped) ─────────────────────────────────
  const literals   = items.map((it) => it.literal_value);
  const lookupMap  = await fetchLookupMatches(connection, literals, domainId);

  const matchedItems:   OpStateItem[] = [];
  const unmatchedItems: OpStateItem[] = [];

  for (const item of items) {
    const alias = lookupMap.get(normalizeLiteral(item.literal_value));
    if (alias !== undefined) {
      matchedItems.push({ ...item, matched_from_lookup: true, alias_name: alias });
    } else {
      unmatchedItems.push(item);
    }
  }

  // ── Step 4: Build lookup groups ────────────────────────────────────────────
  const lookupGroupMap = new Map<string, OpGroupItem[]>();
  for (const item of matchedItems) {
    const arr = lookupGroupMap.get(item.alias_name!) ?? [];
    arr.push({ literal_value: item.literal_value, matched_from_lookup: true });
    lookupGroupMap.set(item.alias_name!, arr);
  }

  const lookupAliasNames = [...lookupGroupMap.keys()];
  const usageCountMap    = await fetchUsageCounts(connection, lookupAliasNames, domainId);

  // Each distinct alias_name → one PipelineGroup (from_lookup_chunk = true).
  // Lookup groups are never chunked — all items for a given alias land in one
  // group regardless of count. Only LLM calls have the 25-item limit.
  const rawLookupGroups: PipelineGroup[] = [];
  for (const [aliasName, groupItems] of lookupGroupMap) {
    rawLookupGroups.push({
      alias_name:         aliasName,
      alias_name_source:  'lookup_validated',
      confidence:         'h',
      from_lookup_chunk:  true,
      items:              groupItems,
      lookup_usage_count: usageCountMap.get(aliasName) ?? 0,
    });
  }

  // ── Step 5: LLM chunk grouping for unmatched items ─────────────────────────
  const llmGroups:        PipelineGroup[] = [];
  const ungroupedLiterals: string[]       = [];

  if (unmatchedItems.length > 0) {
    const chunks: OpStateItem[][] = [];
    for (let i = 0; i < unmatchedItems.length; i += MAX_CHUNK_SIZE) {
      chunks.push(unmatchedItems.slice(i, i + MAX_CHUNK_SIZE));
    }

    const chunkSystemPrompt = buildChunkSystemPrompt(domainName);
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const userTurn = buildChunkUserTurn(chunk);
        const rawText  = await callLLM(apiKey, chunkSystemPrompt, userTurn, CHUNK_MAX_TOKENS);
        return { chunk, parsed: tryParseJson<LLMChunkResponse>(rawText) };
      }),
    );

    for (const { chunk, parsed } of chunkResults) {
      if (!parsed) {
        // LLM returned unparseable response — treat all items as ungrouped.
        for (const item of chunk) ungroupedLiterals.push(item.literal_value);
        continue;
      }

      const idxMap = new Map<number, OpStateItem>(chunk.map((item, i) => [i + 1, item]));

      for (const g of parsed.g ?? []) {
        const [idxList, name, conf] = g;
        const groupItems = (idxList ?? [])
          .map((idx) => idxMap.get(idx))
          .filter((item): item is OpStateItem => item !== undefined)
          .map((item): OpGroupItem => ({ literal_value: item.literal_value, matched_from_lookup: false }));

        if (groupItems.length === 0) continue;

        llmGroups.push({
          alias_name:         name ?? null,
          alias_name_source:  'llm_proposed',
          confidence:         (['h', 'm', 'l'] as const).includes(conf) ? conf : 'm',
          from_lookup_chunk:  false,
          items:              groupItems,
          lookup_usage_count: 0,
        });
      }

      for (const idx of parsed.u ?? []) {
        const item = idxMap.get(idx);
        if (item) ungroupedLiterals.push(item.literal_value);
      }
    }
  }

  // ── Step 6: Merge pass ─────────────────────────────────────────────────────
  const allGroups           = [...rawLookupGroups, ...llmGroups];
  let   finalPipelineGroups = allGroups;

  if (allGroups.length >= 2) {
    const validatedNames    = [...new Set(
      allGroups.filter((g) => g.from_lookup_chunk && g.alias_name).map((g) => g.alias_name!),
    )];
    const mergeSystem       = buildMergeSystemPrompt(validatedNames, domainName);
    const mergeUser         = buildMergeUserTurn(allGroups);
    const mergeRaw          = await callLLM(apiKey, mergeSystem, mergeUser, MERGE_MAX_TOKENS);
    const mergeParsed       = tryParseJson<LLMMergeResponse>(mergeRaw);

    if (mergeParsed?.m && mergeParsed.m.length > 0) {
      finalPipelineGroups = applyMerges(allGroups, mergeParsed.m);
    }
  }

  // ── Step 7: Assemble final state ───────────────────────────────────────────
  let nextGroupId = 1;
  const finalGroups: OpGroup[] = finalPipelineGroups.map((g) => ({
    group_id:          nextGroupId++,
    alias_name:        g.alias_name ?? g.items[0]?.literal_value ?? `Group ${nextGroupId - 1}`,
    alias_name_source: g.alias_name_source,
    confidence:        g.confidence,
    from_lookup_chunk: g.from_lookup_chunk,
    items:             g.items,
  }));

  const ungrouped: OpUngrouped[] = ungroupedLiterals.map((lv) => ({
    literal_value:       lv,
    matched_from_lookup: false,
  }));

  // Reflect lookup results back into the top-level items array.
  const updatedItems: OpStateItem[] = items.map((item) => {
    const alias = lookupMap.get(normalizeLiteral(item.literal_value));
    return alias !== undefined
      ? { ...item, matched_from_lookup: true, alias_name: alias }
      : item;
  });

  return {
    status:    'running',
    items:     updatedItems,
    groups:    finalGroups,
    ungrouped,
  };
}
