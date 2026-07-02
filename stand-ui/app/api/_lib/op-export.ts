/**
 * One-Prompt Export Pipeline (Steps 1–4).
 *
 * Called after the user confirms and exports a run.
 *
 *   Step 1 — Read state blob            (sole source of truth)
 *   Step 2 — Detect validation cases    (Case A: item moved; Case B: group renamed)
 *   Step 3 — LLM validation pass        (async background; decides Case A/B outcomes)
 *   Step 4 — Write everything at once   (Case A/B per LLM decision; all other items
 *                                         written as-is; log decisions; mark run done)
 *
 * Steps 3–4 run in the background after the HTTP response is sent.
 * The run is immediately marked 'validating' to prevent double-export.
 * On LLM parse failure the run is marked 'failed' so it can be retried.
 *
 * Zero writes to RUN_ITEMS, RUN_GROUPS, RAW_VALUES, ALIAS_SUMMARY, TOKENS_SUMMARY.
 */

import 'server-only';

import fs   from 'node:fs';
import path from 'node:path';

import { withSnowflake } from './snowflake';
import { loadOpRunState, type OpRunState, type OpGroup, type OpGroupItem, type OpStateItem } from './op-auto-group';
import { initBaseline, hasBaseline } from './auto-export-seen';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { appendTiming } from './timing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALIDATION_MODEL      = 'claude-sonnet-4-6';
const VALIDATION_MAX_TOKENS = 4_096;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportResult {
  items_written:    number;
  aliases_updated:  number;
}

interface CaseAItem {
  literal_value:       string;
  original_alias_name: string;
  user_moved_to:       string;
}

interface CaseBGroup {
  group_id:            number;
  original_alias_name: string;
  user_changed_to:     string;
  group_items:         OpGroupItem[];
  // Filled in by fetchCaseBContext:
  alias_exact_literal:    string | null;
  prior_lookup_literal:   string | null;
  current_new_literal:    string | null;
  prior_other_literal:    string | null;
  total_known_literals:   number;
}

interface ValidationDecisionA { lv: string; k: 'u' | 'o'; }
interface ValidationDecisionB { original_alias: string; new_alias: string; k: 'u' | 'o'; apply_to_all: boolean; }
interface ValidationResponse   { case_a?: ValidationDecisionA[]; case_b?: ValidationDecisionB[]; }

// ---------------------------------------------------------------------------
// Snowflake exec helper
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
    if (esc)   { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function tryParseJson<T>(text: string): T | null {
  const stripped = stripFences(text);
  for (const c of [stripped, extractBraced(stripped), extractBraced(text.trim())]) {
    if (!c) continue;
    try { return JSON.parse(c) as T; } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB write helpers
// ---------------------------------------------------------------------------

/**
 * Upsert an alias name and return its alias_id.
 * MERGE matches on (alias_name, domain_id) — the unique key — so the same name
 * in two different domains produces two separate rows with separate alias_ids.
 */
async function upsertApprovedAlias(
  connection: any,
  aliasName:  string,
  domainId:   number | null,
): Promise<number> {
  // domainFilter for MERGE uses alias 't'; selectFilter for plain SELECT uses no alias
  const domainFilter  = domainId != null
    ? `AND t.domain_id = ${Number(domainId)}`
    : `AND t.domain_id IS NULL`;
  const selectFilter  = domainId != null
    ? `AND domain_id = ${Number(domainId)}`
    : `AND domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES AS t
     USING (SELECT ? AS alias_name, ${domainLiteral} AS domain_id) AS s
       ON t.alias_name = s.alias_name ${domainFilter}
     WHEN MATCHED THEN UPDATE SET
       t.usage_count  = t.usage_count + 1,
       t.last_used_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
       VALUES (s.alias_name, s.domain_id, 1, CURRENT_TIMESTAMP())`,
    [aliasName],
  );

  // Retrieve the alias_id via the unique key (alias_name, domain_id).
  const rows = await exec(
    connection,
    `SELECT alias_id
     FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
     WHERE alias_name = ? ${selectFilter}`,
    [aliasName],
  );
  const aliasId = Number((rows[0] as any)?.ALIAS_ID ?? (rows[0] as any)?.alias_id ?? 0);
  if (!aliasId) throw new Error(`[op-export] Could not retrieve alias_id for "${aliasName}"`);
  return aliasId;
}

/**
 * Bulk version of upsertApprovedAlias: upsert MANY alias names in a single
 * MERGE, then fetch all their alias_ids in a single SELECT — 2 round-trips
 * total instead of 2 per name. Returns aliasName → alias_id.
 *
 * This is the hot path during pipeline-creation commit, where a baseline can
 * carry hundreds of distinct canonical names; the old per-name loop made that
 * many sequential Snowflake round-trips, which dominated the "writing to
 * Snowflake" wait.
 */
async function bulkUpsertApprovedAliases(
  connection: any,
  aliasNames: string[],
  domainId:   number | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const names  = Array.from(new Set(aliasNames)).filter((n) => n != null && n !== '');
  if (names.length === 0) return result;

  const domainFilter  = domainId != null ? `AND t.domain_id = ${Number(domainId)}` : `AND t.domain_id IS NULL`;
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}`   : `AND domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  // Upsert every distinct name at once. The source is deduped (Set) so no
  // "multiple source rows matched" error on the MERGE.
  const valuePlaceholders = names.map(() => '(?)').join(', ');
  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES AS t
     USING (SELECT column1 AS alias_name FROM VALUES ${valuePlaceholders}) AS s
       ON t.alias_name = s.alias_name ${domainFilter}
     WHEN MATCHED THEN UPDATE SET
       t.usage_count  = t.usage_count + 1,
       t.last_used_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
       VALUES (s.alias_name, ${domainLiteral}, 1, CURRENT_TIMESTAMP())`,
    names,
  );

  // Fetch every alias_id in one round-trip.
  const inPlaceholders = names.map(() => '?').join(', ');
  const rows = await exec(
    connection,
    `SELECT alias_name, alias_id
     FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
     WHERE alias_name IN (${inPlaceholders}) ${selectFilter}`,
    names,
  );
  for (const r of rows) {
    const name = String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '');
    const id   = Number((r as any).ALIAS_ID   ?? (r as any).alias_id   ?? 0);
    if (name && id) result.set(name, id);
  }

  // Safety net: anything the bulk SELECT somehow missed falls back to the
  // single-name path so the caller always gets a complete map.
  for (const name of names) {
    if (!result.has(name)) result.set(name, await upsertApprovedAlias(connection, name, domainId));
  }
  return result;
}

/**
 * Upsert a literal → alias mapping using the integer alias_id FK.
 * Renames to the parent alias never require touching this table.
 */
async function upsertLiteralMatch(
  connection:   any,
  literalValue: string,
  aliasId:      number,
  domainId:     number | null,
  runId:        number,
): Promise<void> {
  const domainFilter  = domainId != null
    ? `AND t.domain_id = ${Number(domainId)}`
    : `AND t.domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES AS t
     USING (SELECT ? AS literal_value, ${Number(aliasId)} AS alias_id,
                   ${domainLiteral} AS domain_id, ? AS run_id) AS s
       ON t.normalized_value = PRISM_NORMALIZE(s.literal_value) ${domainFilter}
     WHEN MATCHED THEN UPDATE SET
       t.alias_id     = s.alias_id,
       t.run_id       = s.run_id,
       t.confirmed_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
       VALUES (s.literal_value, PRISM_NORMALIZE(s.literal_value), s.alias_id, s.domain_id, s.run_id, CURRENT_TIMESTAMP())`,
    [literalValue, runId],
  );
}

/**
 * Bulk-upsert all literal → alias mappings for a run in a single MERGE statement.
 *
 * A single Snowflake MERGE is inherently atomic (no transaction needed) and
 * eliminates per-row network round-trips.  All entries share the same domain_id
 * and run_id, so the ON condition is uniform across the batch.
 *
 * Snowflake's VALUES subquery exposes implicit column names column1, column2, …
 * and supports up to ~65 k bind variables — well above the 5 000-literal cap
 * used when fetching source values, so no chunking is needed.
 */
async function bulkUpsertLiteralMatches(
  connection: any,
  entries:    Array<{ literalValue: string; aliasId: number }>,
  domainId:   number | null,
  runId:      number,
): Promise<void> {
  if (entries.length === 0) return;

  const domainFilter  = domainId != null
    ? `AND t.domain_id = ${Number(domainId)}`
    : `AND t.domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  // Build (?, ?, ?) placeholders and a flat binds array.
  // column1 = literal_value, column2 = alias_id, column3 = run_id
  const placeholders = entries.map(() => '(?, ?, ?)').join(', ');
  const binds: any[] = entries.flatMap(e => [e.literalValue, e.aliasId, runId]);

  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES AS t
     USING (
       SELECT column1 AS literal_value,
              column2 AS alias_id,
              column3 AS run_id
       FROM VALUES ${placeholders}
     ) AS s
       ON t.normalized_value = PRISM_NORMALIZE(s.literal_value) ${domainFilter}
     WHEN MATCHED THEN UPDATE SET
       t.alias_id     = s.alias_id,
       t.run_id       = s.run_id,
       t.confirmed_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
       VALUES (s.literal_value, PRISM_NORMALIZE(s.literal_value), s.alias_id, ${domainLiteral}, s.run_id, CURRENT_TIMESTAMP())`,
    binds,
  );
}

// ---------------------------------------------------------------------------
// Step 2 — detect Case A and Case B from state (no DB)
// ---------------------------------------------------------------------------

interface DetectResult {
  caseAItems:  CaseAItem[];
  caseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[];
}

function detectCases(state: OpRunState): DetectResult {
  const itemByLiteral = new Map<string, OpStateItem>(
    state.items.map((it) => [it.literal_value, it]),
  );

  const groupByLiteral = new Map<number, OpGroup>();
  const groupIdByLiteral = new Map<string, number>();
  for (const group of state.groups) {
    groupByLiteral.set(group.group_id, group);
    for (const item of group.items) {
      groupIdByLiteral.set(item.literal_value, group.group_id);
    }
  }

  // ── Detect Case B first ──────────────────────────────────────────────────
  type RawCaseB = Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>;

  const caseBGroups: RawCaseB[] = [];
  const caseBOriginalByGroupId = new Map<number, string>();

  for (const group of state.groups) {
    if (!group.from_lookup_chunk || group.alias_name_source !== 'user_override') continue;

    let originalAlias: string | null = null;
    for (const gi of group.items) {
      const si = itemByLiteral.get(gi.literal_value);
      if (si?.matched_from_lookup && si.alias_name) {
        originalAlias = si.alias_name;
        break;
      }
    }
    if (!originalAlias) continue;
    if (originalAlias === group.alias_name) continue;

    caseBGroups.push({
      group_id:            group.group_id,
      original_alias_name: originalAlias,
      user_changed_to:     group.alias_name,
      group_items:         group.items,
    });
    caseBOriginalByGroupId.set(group.group_id, originalAlias);
  }

  // ── Detect Case A ────────────────────────────────────────────────────────
  const caseAItems: CaseAItem[] = [];

  for (const si of state.items) {
    if (!si.matched_from_lookup || !si.alias_name) continue;

    const currentGroupId = groupIdByLiteral.get(si.literal_value);
    if (currentGroupId === undefined) continue;

    const currentGroup = groupByLiteral.get(currentGroupId);
    if (!currentGroup) continue;

    if (currentGroup.alias_name === si.alias_name) continue;

    const caseBOriginal = caseBOriginalByGroupId.get(currentGroupId);
    if (caseBOriginal === si.alias_name) continue;

    caseAItems.push({
      literal_value:       si.literal_value,
      original_alias_name: si.alias_name,
      user_moved_to:       currentGroup.alias_name,
    });
  }

  return { caseAItems, caseBGroups };
}

// ---------------------------------------------------------------------------
// Step 3a — fetch representative context for Case B groups (DB read)
// ---------------------------------------------------------------------------

async function fetchCaseBContext(
  connection: any,
  runId:      number,
  state:      OpRunState,
  rawCaseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[],
  domainId:   number | null,
): Promise<CaseBGroup[]> {
  const result: CaseBGroup[] = [];
  const currentRunLiterals = new Set(state.items.map((it) => it.literal_value));
  const itemByLiteral = new Map<string, OpStateItem>(state.items.map((it) => [it.literal_value, it]));

  const domainFilter = domainId != null
    ? `AND lam.domain_id = ${Number(domainId)}`
    : `AND lam.domain_id IS NULL`;

  for (const raw of rawCaseBGroups) {
    const groupItemLiterals = new Set(raw.group_items.map((gi) => gi.literal_value));

    const exactRows = await exec(
      connection,
      `SELECT lam.literal_value
       FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
       JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan ON lam.alias_id = aan.alias_id
       WHERE aan.alias_name = ? AND lam.literal_value = ? ${domainFilter} LIMIT 1`,
      [raw.original_alias_name, raw.original_alias_name],
    );
    const alias_exact_literal =
      exactRows.length > 0
        ? String((exactRows[0] as any).LITERAL_VALUE ?? (exactRows[0] as any).literal_value ?? '')
        : null;

    const prior_lookup_literal =
      raw.group_items.find((gi) => {
        const si = itemByLiteral.get(gi.literal_value);
        return si?.matched_from_lookup === true;
      })?.literal_value ?? null;

    const current_new_literal =
      raw.group_items.find((gi) => {
        const si = itemByLiteral.get(gi.literal_value);
        return si?.matched_from_lookup === false;
      })?.literal_value ?? null;

    const allKnownRows = await exec(
      connection,
      `SELECT lam.literal_value, COUNT(*) AS total
       FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
       JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan ON lam.alias_id = aan.alias_id
       WHERE aan.alias_name = ? ${domainFilter}
       GROUP BY lam.literal_value`,
      [raw.original_alias_name],
    );

    let prior_other_literal: string | null = null;
    let total_known_literals = 0;
    for (const row of allKnownRows) {
      const lv = String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? '');
      total_known_literals++;
      if (prior_other_literal === null && !currentRunLiterals.has(lv) && !groupItemLiterals.has(lv)) {
        prior_other_literal = lv;
      }
    }

    result.push({
      ...raw,
      alias_exact_literal,
      prior_lookup_literal,
      current_new_literal,
      prior_other_literal,
      total_known_literals,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3b — build validation prompt and call LLM
// ---------------------------------------------------------------------------

const VALIDATION_SYSTEM_PROMPT = `\
You are validating changes a user made to entity groupings after an automated classification run.
Decide whether each user change should be persisted or reverted.
Respond only with valid JSON. No text outside the JSON.

{
  "case_a": [{"lv":"literal_value","k":"u"|"o"},...],
  "case_b": [{"original_alias":"string","new_alias":"string","k":"u"|"o","apply_to_all":true|false},...]
}

Where:
  k = "u" means keep the user's change
  k = "o" means revert to the original
  apply_to_all (case b only) = true means rename the alias for all known literal values mapped to it, not just this run`;

function buildValidationUserTurn(
  caseAItems:  CaseAItem[],
  caseBGroups: CaseBGroup[],
): string {
  const sections: string[] = [];

  if (caseAItems.length > 0) {
    const blocks = caseAItems.map((item, i) =>
      `ITEM ${i + 1}:\n` +
      `  literal_value: "${item.literal_value}"\n` +
      `  original_alias_name: "${item.original_alias_name}"\n` +
      `  user_moved_to: "${item.user_moved_to}"`,
    ).join('\n\n');

    sections.push(
      `CASE A ITEMS:\n\n` +
      `For each Case A item, the user moved a literal value that had a confirmed prior mapping to a different group.\n` +
      `Decide if the user's new mapping is correct or if the original should be kept.\n\n` +
      blocks,
    );
  }

  if (caseBGroups.length > 0) {
    const blocks = caseBGroups.map((g, i) =>
      `GROUP ${i + 1}:\n` +
      `  original_alias_name: "${g.original_alias_name}"\n` +
      `  user_changed_to: "${g.user_changed_to}"\n` +
      `  representative_literals:\n` +
      `    alias_name_exact_match: "${g.alias_exact_literal ?? 'null'}"\n` +
      `    prior_run_lookup_match: "${g.prior_lookup_literal ?? 'null'}"\n` +
      `    current_run_new_item: "${g.current_new_literal ?? 'null'}"\n` +
      `    prior_run_other: "${g.prior_other_literal ?? 'null'}"\n` +
      `  total_known_literals_for_original_alias: ${g.total_known_literals}`,
    ).join('\n\n');

    sections.push(
      `CASE B GROUPS:\n\n` +
      `For each Case B group, the user renamed a validated alias name to something new.\n` +
      `Decide if the new name is a valid correction. If yes, decide if it should apply to all known\n` +
      `literals mapped to the original alias or only to the items in this run.\n\n` +
      blocks,
    );
  }

  return sections.join('\n\n---\n\n');
}

async function callValidationLLM(apiKey: string, userTurn: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    signal:  AbortSignal.timeout(120_000),
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
    },
    body: JSON.stringify({
      model:       VALIDATION_MODEL,
      max_tokens:  VALIDATION_MAX_TOKENS,
      temperature: 0,
      system:      VALIDATION_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userTurn }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`[op-export] Validation LLM error ${res.status}: ${err.slice(0, 400)}`);
  }

  const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Step 4 — write all decisions at once
//
// Combines what was formerly Step 2 (bulk write) and Step 5 (corrections).
// Every literal gets exactly one write here, using its LLM-adjudicated alias.
// Non-case items are written as-is from the user's current grouping.
// ---------------------------------------------------------------------------

async function writeAllDecisions(
  connection:  any,
  runId:       number,
  state:       OpRunState,
  caseAItems:  CaseAItem[],
  caseBGroups: CaseBGroup[],
  decisions:   ValidationResponse | null,
  domainId:    number | null = null,
): Promise<{ items_written: number; aliases_updated: number }> {
  // Build a map: literal_value → final alias, starting from user's current grouping.
  const finalAlias = new Map<string, string>();
  for (const group of state.groups) {
    for (const gi of group.items) {
      finalAlias.set(gi.literal_value, group.alias_name);
    }
  }

  // Override Case A items per LLM decision.
  const caseADecisions = new Map<string, 'u' | 'o'>();
  for (const d of decisions?.case_a ?? []) {
    caseADecisions.set(d.lv, d.k);
  }
  for (const item of caseAItems) {
    const k = caseADecisions.get(item.literal_value) ?? 'u';
    finalAlias.set(item.literal_value, k === 'o' ? item.original_alias_name : item.user_moved_to);
  }

  // Override Case B groups per LLM decision; collect global renames.
  const caseBDecisions = new Map<string, ValidationDecisionB>();
  for (const d of decisions?.case_b ?? []) {
    caseBDecisions.set(`${d.original_alias}|${d.new_alias}`, d);
  }

  const globalRenames: Array<{ from: string; to: string }> = [];

  for (const group of caseBGroups) {
    const d = caseBDecisions.get(`${group.original_alias_name}|${group.user_changed_to}`);
    const k = d?.k ?? 'u';

    if (k === 'o') {
      for (const gi of group.group_items) {
        finalAlias.set(gi.literal_value, group.original_alias_name);
      }
    } else if (d?.apply_to_all) {
      globalRenames.push({ from: group.original_alias_name, to: group.user_changed_to });
    }
    // k='u', apply_to_all=false: finalAlias already has user's new name.
  }

  // ── Upsert approved alias names first, collecting alias_ids ───────────────
  // One bulk MERGE + one SELECT for ALL names (was 2 round-trips per name).
  const finalAliasNames = new Set(finalAlias.values());
  const aliasIdMap = await bulkUpsertApprovedAliases(connection, [...finalAliasNames], domainId);

  // ── Write all literal→alias matches in one bulk MERGE ────────────────────
  // A single MERGE statement is atomic in Snowflake (no transaction needed)
  // and eliminates N round-trips, so total_mapped jumps from 0 to final
  // atomically on the next poll rather than incrementing one-by-one.
  const matchEntries: Array<{ literalValue: string; aliasId: number }> = [];
  for (const [literalValue, aliasName] of finalAlias) {
    const aliasId = aliasIdMap.get(aliasName);
    if (aliasId == null) continue; // should not happen
    matchEntries.push({ literalValue, aliasId });
  }
  await bulkUpsertLiteralMatches(connection, matchEntries, domainId, runId);
  const items_written = matchEntries.length;

  // ── Apply global Case B renames (touches historical rows outside this run) ─
  const domainFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}` : `AND domain_id IS NULL`;
  for (const rename of globalRenames) {
    const fromRows = await exec(
      connection,
      `SELECT alias_id, usage_count
       FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
       WHERE alias_name = ? ${domainFilter}`,
      [rename.from],
    );
    if (!fromRows.length) continue;
    const fromId    = Number((fromRows[0] as any).ALIAS_ID   ?? (fromRows[0] as any).alias_id);
    const fromCount = Number((fromRows[0] as any).USAGE_COUNT ?? (fromRows[0] as any).usage_count ?? 0);

    // Check whether the target alias already exists under this domain.
    const toRows = await exec(
      connection,
      `SELECT alias_id
       FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
       WHERE alias_name = ? ${domainFilter}`,
      [rename.to],
    );

    if (toRows.length > 0) {
      // Target exists → merge: repoint LITERAL_ALIAS_MATCHES to the target alias_id,
      // then remove the source alias row. No alias_name scan needed.
      const toId = Number((toRows[0] as any).ALIAS_ID ?? (toRows[0] as any).alias_id);
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES
         SET alias_id = ?, confirmed_at = CURRENT_TIMESTAMP()
         WHERE alias_id = ?`,
        [toId, fromId],
      );
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
         SET usage_count = usage_count + ?, last_used_at = CURRENT_TIMESTAMP()
         WHERE alias_id = ?`,
        [fromCount, toId],
      );
      await exec(
        connection,
        `DELETE FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_id = ?`,
        [fromId],
      );
    } else {
      // Pure rename → just update the name in place. LITERAL_ALIAS_MATCHES
      // references alias_id, so this single UPDATE is the entire migration.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
         SET alias_name = ?, last_used_at = CURRENT_TIMESTAMP()
         WHERE alias_id = ?`,
        [rename.to, fromId],
      );
    }
  }

  // ── Log Case A/B decisions ────────────────────────────────────────────────
  for (const d of decisions?.case_a ?? []) {
    const item = caseAItems.find((a) => a.literal_value === d.lv);
    if (!item) continue;
    await exec(
      connection,
      `INSERT INTO STAND_DB.STAND_INTERNAL.VALIDATION_LOG
         (literal_value, run_id, original_alias_name, user_changed_to, llm_decision, decided_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [item.literal_value, runId, item.original_alias_name, item.user_moved_to,
       d.k === 'u' ? 'user' : 'original'],
    );
  }
  for (const d of decisions?.case_b ?? []) {
    const group = caseBGroups.find(
      (b) => b.original_alias_name === d.original_alias && b.user_changed_to === d.new_alias,
    );
    if (!group) continue;
    for (const gi of group.group_items) {
      await exec(
        connection,
        `INSERT INTO STAND_DB.STAND_INTERNAL.VALIDATION_LOG
           (literal_value, run_id, original_alias_name, user_changed_to, llm_decision, decided_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
        [gi.literal_value, runId, group.original_alias_name, group.user_changed_to,
         d.k === 'u' ? 'user' : 'original'],
      );
    }
  }

  // ── Mark run complete ─────────────────────────────────────────────────────
  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
    [runId],
  );

  return { items_written, aliases_updated: finalAliasNames.size };
}

// ---------------------------------------------------------------------------
// Validation audit JSON writer
// ---------------------------------------------------------------------------

function writeValidationAudit(
  runId:      number,
  caseAItems: CaseAItem[],
  caseBGroups: CaseBGroup[],
  systemPrompt: string,
  userTurn:   string,
  rawResponse: string,
  decisions:  ValidationResponse | null,
  appliedDecisions: Array<{
    type:              'case_a' | 'case_b';
    literal_value?:    string;
    original_alias:    string;
    user_changed_to:   string;
    llm_decision:      'user' | 'original';
    apply_to_all?:     boolean;
  }>,
  error: string | null,
): void {
  try {
    const audit = {
      meta: {
        run_id:        runId,
        generated_at:  new Date().toISOString(),
        case_a_count:  caseAItems.length,
        case_b_count:  caseBGroups.length,
        parse_success: decisions !== null,
        error,
      },

      detected_cases: {
        case_a: caseAItems.map((item) => ({
          literal_value:       item.literal_value,
          original_alias_name: item.original_alias_name,
          user_moved_to:       item.user_moved_to,
        })),
        case_b: caseBGroups.map((g) => ({
          group_id:            g.group_id,
          original_alias_name: g.original_alias_name,
          user_changed_to:     g.user_changed_to,
          group_items:         g.group_items.map((gi) => gi.literal_value),
          context: {
            alias_exact_literal:  g.alias_exact_literal,
            prior_lookup_literal: g.prior_lookup_literal,
            current_new_literal:  g.current_new_literal,
            prior_other_literal:  g.prior_other_literal,
            total_known_literals: g.total_known_literals,
          },
        })),
      },

      llm: {
        system_prompt: systemPrompt,
        user_turn:     userTurn,
        raw_response:  rawResponse,
        parsed:        decisions,
      },

      applied_decisions: appliedDecisions,
    };

    const projectRoot = path.resolve(process.cwd(), '..');
    const outPath = path.join(projectRoot, `validation_audit_run_${runId}.json`);
    fs.promises.writeFile(outPath, JSON.stringify(audit, null, 2), 'utf8')
      .then(() => console.log(`[op-export] Validation audit written → ${outPath}`))
      .catch((writeErr) => console.warn('[op-export] Could not write validation audit JSON:', writeErr));
  } catch (writeErr) {
    console.warn('[op-export] Could not write validation audit JSON:', writeErr);
  }
}

// ---------------------------------------------------------------------------
// Background write+validate pass (Steps 3–4) — creates its own DB connection
// ---------------------------------------------------------------------------

async function runWriteAndValidatePass(
  runId:          number,
  state:          OpRunState,
  caseAItems:     CaseAItem[],
  rawCaseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[],
  apiKey:         string,
): Promise<void> {
  await withSnowflake(async (connection) => {
    try {
      // Fetch domain_id first — needed for both the Case B context lookup and writeAllDecisions.
      const domainRows = await exec(
        connection,
        `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
        [runId],
      );
      const exportDomainId: number | null =
        domainRows.length > 0
          ? (Number((domainRows[0] as any).DOMAIN_ID ?? (domainRows[0] as any).domain_id) || null)
          : null;

      let decisions:  ValidationResponse | null = null;
      let rawText   = '';
      let userTurn  = '';
      let caseBGroups: CaseBGroup[] = [];

      if (caseAItems.length > 0 || rawCaseBGroups.length > 0) {
        const _valStart = Date.now();
        caseBGroups = await fetchCaseBContext(connection, runId, state, rawCaseBGroups, exportDomainId);
        userTurn    = buildValidationUserTurn(caseAItems, caseBGroups);
        rawText     = await callValidationLLM(apiKey, userTurn);
        decisions   = tryParseJson<ValidationResponse>(rawText);
        appendTiming(`[Timing] accept.validation_llm: ${Date.now() - _valStart}ms (${caseAItems.length} caseA, ${rawCaseBGroups.length} caseB)`);

        if (!decisions) {
          console.error(`[op-export] Run ${runId}: failed to parse validation LLM response.\nRaw: ${rawText.slice(0, 800)}`);
          writeValidationAudit(
            runId, caseAItems, caseBGroups,
            VALIDATION_SYSTEM_PROMPT, userTurn, rawText,
            null, [],
            'Failed to parse LLM response as JSON',
          );
          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
            [runId],
          );
          return;
        }
      }

      // Step 4: write everything (normal items + Case A/B decisions) in one pass.
      const _writeStart = Date.now();
      await writeAllDecisions(connection, runId, state, caseAItems, caseBGroups, decisions, exportDomainId);
      appendTiming(`[Timing] accept.write_decisions: ${Date.now() - _writeStart}ms (lookup + alias upserts)`);
      const _rebuildStart = Date.now();

      // ── Premium mode: rebuild all domain pipelines + clean queue ─────────
      // Runs AFTER writeAllDecisions has committed so:
      //   • refreshExportTable reads the fully-committed LITERAL_ALIAS_MATCHES rows.
      //   • Queue items that are now standardized are removed from PIPELINE_QUEUE.
      //   • PIPELINES.total_mapped / total_source_values are updated for every
      //     active pipeline in the domain (manual standardization can affect any
      //     pipeline watching the same domain column).
      //
      // All steps are awaited (not fire-and-forget) so the UI sees consistent
      // metrics the moment the export request returns.
      if (process.env.NEXT_PUBLIC_APP_MODE === 'premium') {
        try {
          // Collect the set of literals that were just written to LITERAL_ALIAS_MATCHES.
          const standardizedLiterals = state.groups.flatMap((g) => g.items.map((gi) => gi.literal_value));

          // Seed Redis auto-export baseline from the run's source table (once only).
          const runSourceRows = await exec(
            connection,
            `SELECT source_relation, source_column FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ? LIMIT 1`,
            [runId],
          );
          if (runSourceRows.length > 0) {
            const r          = runSourceRows[0] as any;
            const tableFqn   = String(r.SOURCE_RELATION ?? r.source_relation ?? '');
            const columnName = String(r.SOURCE_COLUMN   ?? r.source_column   ?? '');
            if (tableFqn && columnName) {
              const alreadySet = await hasBaseline(tableFqn, columnName);
              if (!alreadySet) {
                const literals = state.items.map((it) => it.literal_value);
                await initBaseline(tableFqn, columnName, literals);
                console.log(
                  `[op-export] Auto-export baseline seeded — ${literals.length} value(s) for ${tableFqn}.${columnName}`,
                );
              }
            }
          }

          // Find all pipelines in this domain (include pending_baseline + paused so
          // that metrics are written even when the initial-run export fires before
          // the pipeline has been advanced to active).
          const domainCond = exportDomainId != null
            ? `p.domain_id = ${Number(exportDomainId)}`
            : `p.domain_id IS NULL`;
          const domainPipelines = await exec(
            connection,
            `SELECT p.pipeline_id, p.table_fqn, p.column_name, p.export_table_fqn, p.status
             FROM STAND_DB.STAND_INTERNAL.PIPELINES p
             WHERE p.status IN ('active', 'paused', 'pending_baseline') AND ${domainCond}
             ORDER BY p.pipeline_id`,
          );

          for (const pRow of domainPipelines) {
            const pipelineId     = Number((pRow as any).PIPELINE_ID      ?? (pRow as any).pipeline_id);
            const tableFqn       = String((pRow as any).TABLE_FQN         ?? (pRow as any).table_fqn       ?? '');
            const colName        = String((pRow as any).COLUMN_NAME       ?? (pRow as any).column_name     ?? '');
            const exportTableFqn = ((pRow as any).EXPORT_TABLE_FQN ?? (pRow as any).export_table_fqn) as string | null;
            const pStatus        = String((pRow as any).STATUS ?? (pRow as any).status ?? '');

            if (!tableFqn || !colName) continue;

            try {
              // Step A: update metrics, and rebuild the export table ONLY for pipelines
              // that are already live. A pending_baseline/paused pipeline must not have
              // its export table populated until the user explicitly starts it from the
              // activation card ("Begin Pipeline Standardization") — which flips it to
              // 'active' and builds the export then. Until then we only refresh metrics
              // (total_mapped / total_source_values) so the activation card is accurate.
              if (exportTableFqn && pStatus === 'active') {
                await refreshExportTable(tableFqn, colName, exportTableFqn, exportDomainId, pipelineId);
              } else {
                await updatePipelineMappedCount(tableFqn, colName, exportDomainId, pipelineId);
              }
            } catch (metricErr) {
              console.warn(`[op-export] Metric refresh failed for pipeline ${pipelineId}:`, metricErr);
            }

            // Step B: remove newly-standardized items from this pipeline's queue
            // and update queue_size / last_queue_empty_at atomically.
            if (standardizedLiterals.length > 0) {
              try {
                const queueHitRows = await exec(
                  connection,
                  `SELECT literal_value FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
                   WHERE pipeline_id = ?
                     AND literal_value IN (${standardizedLiterals.map(() => '?').join(', ')})`,
                  [pipelineId, ...standardizedLiterals],
                );
                const toRemove = queueHitRows.map((r: any) => String(r.LITERAL_VALUE ?? r.literal_value ?? '')).filter(Boolean);

                if (toRemove.length > 0) {
                  await exec(
                    connection,
                    `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
                     WHERE pipeline_id = ? AND literal_value IN (${toRemove.map(() => '?').join(', ')})`,
                    [pipelineId, ...toRemove],
                  );
                }

                // Update queue_size (and last_queue_empty_at if now empty) regardless.
                const [qRow] = await exec(
                  connection,
                  `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
                  [pipelineId],
                );
                const remaining = Number((qRow as any)?.CNT ?? (qRow as any)?.cnt ?? 0);
                const setClauses = ['queue_size = ?', 'updated_at = CURRENT_TIMESTAMP()'];
                const updateBinds: any[] = [remaining];
                if (remaining === 0) setClauses.push('last_queue_empty_at = CURRENT_TIMESTAMP()');
                updateBinds.push(pipelineId);
                await exec(
                  connection,
                  `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES SET ${setClauses.join(', ')} WHERE pipeline_id = ?`,
                  updateBinds,
                );

                if (toRemove.length > 0) {
                  console.log(
                    `[op-export] Pipeline ${pipelineId}: ${toRemove.length} item(s) removed from queue ` +
                    `(${remaining} remaining)`,
                  );
                }
              } catch (queueErr) {
                console.warn(`[op-export] Queue cleanup failed for pipeline ${pipelineId}:`, queueErr);
              }
            }
          }

          appendTiming(`[Timing] accept.export_rebuild+metrics: ${Date.now() - _rebuildStart}ms (${domainPipelines.length} domain pipeline(s))`);

          // The write+export+metric refresh above runs in this background pass —
          // AFTER the export route already returned 200 to the client. Tell the UI
          // to refetch so the pipeline cards show the updated standardized counts
          // without a manual reload.
          broadcastPipelineEvent({ type: 'metrics_updated' });
        } catch (premiumErr) {
          // Non-fatal — metrics can be corrected on the next poll / refresh.
          console.warn('[op-export] Failed in premium post-write steps:', premiumErr);
        }
      }

      // Build flat appliedDecisions list for audit.
      const appliedDecisions: Parameters<typeof writeValidationAudit>[7] = [];
      for (const d of decisions?.case_a ?? []) {
        const item = caseAItems.find((a) => a.literal_value === d.lv);
        if (!item) continue;
        appliedDecisions.push({
          type:            'case_a',
          literal_value:   item.literal_value,
          original_alias:  item.original_alias_name,
          user_changed_to: item.user_moved_to,
          llm_decision:    d.k === 'u' ? 'user' : 'original',
        });
      }
      for (const d of decisions?.case_b ?? []) {
        const group = caseBGroups.find(
          (b) => b.original_alias_name === d.original_alias && b.user_changed_to === d.new_alias,
        );
        if (!group) continue;
        appliedDecisions.push({
          type:            'case_b',
          original_alias:  group.original_alias_name,
          user_changed_to: group.user_changed_to,
          llm_decision:    d.k === 'u' ? 'user' : 'original',
          apply_to_all:    d.apply_to_all,
        });
      }

      writeValidationAudit(
        runId, caseAItems, caseBGroups,
        VALIDATION_SYSTEM_PROMPT, userTurn, rawText,
        decisions, appliedDecisions,
        null,
      );

      const aCount = appliedDecisions.filter((d) => d.type === 'case_a').length;
      const bCount = appliedDecisions.filter((d) => d.type === 'case_b').length;
      console.log(`[op-export] Run ${runId}: write+validate complete — ${aCount} Case A, ${bCount} Case B decisions applied.`);
    } catch (err) {
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
        [runId],
      ).catch(() => {});
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Main export entry point
// ---------------------------------------------------------------------------

/**
 * Handles a run export request.
 *
 * The caller passes `currentStatus` (already queried) so we avoid a redundant
 * round-trip.  Export always succeeds and returns the run's grouping counts.
 *
 * Backend table writes (LITERAL_ALIAS_MATCHES, APPROVED_ALIAS_NAMES,
 * VALIDATION_LOG) are triggered only on the FIRST export — i.e. when
 * currentStatus is not already 'validating', 'completed', or 'failed'.
 * Subsequent exports return the same counts without re-triggering the write pass.
 */
export async function runOpExport(
  connection:    any,
  runId:         number,
  apiKey:        string,
  currentStatus: string,
  opts?:         { awaitWrite?: boolean },
): Promise<ExportResult> {
  // Step 1 — read state blob.
  const state = await loadOpRunState(connection, runId);
  if (!state) throw new Error(`[op-export] No state found for run_id=${runId}`);

  // Compute return counts from state (always returned regardless of status).
  const items_written   = state.groups.reduce((n, g) => n + g.items.length, 0);
  const aliases_updated = new Set(state.groups.map((g) => g.alias_name)).size;

  const isFirstExport = currentStatus !== 'validating'
                     && currentStatus !== 'completed'
                     && currentStatus !== 'failed';

  if (isFirstExport) {
    // Step 2 — detect Case A/B from state (no DB writes).
    const { caseAItems, caseBGroups: rawCaseBGroups } = detectCases(state);

    // Mark run as 'validating' so concurrent first-export calls are recognised.
    await exec(
      connection,
      `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'validating', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
      [runId],
    );

    // Steps 3–4 — opens its own Snowflake connection.
    // Normally fire-and-forget so the user gets a fast export confirmation, with
    // the lookup writes + export rebuild + metric refresh completing in the
    // background. When `awaitWrite` is set (initial pipeline creation / the
    // multi-column wizard) we await it instead, so the caller does not navigate
    // to the pipelines view until standardization is committed and metrics are
    // current. For a brand-new pipeline there are no lookup matches yet, so there
    // is no Case A/B validation LLM call — the await is just the DB writes +
    // export rebuild (a few seconds), not an LLM round-trip.
    const writePass = runWriteAndValidatePass(runId, state, caseAItems, rawCaseBGroups, apiKey).catch((err) => {
      console.error(`[op-export] ${opts?.awaitWrite ? 'Awaited' : 'Background'} write+validate failed for run ${runId}:`, err);
    });
    if (opts?.awaitWrite) await writePass;
  }

  return { items_written, aliases_updated };
}

/**
 * Writes grouped items directly to the domain lookup tables without the
 * validation LLM pass (no Case A / Case B deviation checks).
 *
 * Used for automated pipeline queue processing where there is no user review.
 */
export async function runOpExportDirect(
  runId: number,
): Promise<ExportResult> {
  return await withSnowflake(async (connection) => {
    const state = await loadOpRunState(connection, runId);
    if (!state) throw new Error(`[op-export] No state found for run_id=${runId}`);

    // Fetch run metadata + matching pipeline in one query so we can rebuild
    // the export table / update total_mapped after writes commit.
    const runMetaRows = await exec(
      connection,
      `SELECT r.domain_id,
              p.pipeline_id,
              p.table_fqn    AS pipeline_table_fqn,
              p.column_name  AS pipeline_column_name,
              p.export_table_fqn
       FROM STAND_DB.STAND_INTERNAL.RUNS r
       LEFT JOIN STAND_DB.STAND_INTERNAL.PIPELINES p
         ON  p.table_fqn   = r.source_relation
         AND p.column_name = r.source_column
         AND (
           (p.domain_id IS NULL AND r.domain_id IS NULL) OR
           p.domain_id = r.domain_id
         )
       WHERE r.run_id = ?
       LIMIT 1`,
      [runId],
    );

    const metaRow  = runMetaRows.length > 0 ? (runMetaRows[0] as any) : null;
    const domainId: number | null = metaRow
      ? (Number(metaRow.DOMAIN_ID ?? metaRow.domain_id) || null)
      : null;

    await exec(
      connection,
      `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'validating', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
      [runId],
    );

    const result = await writeAllDecisions(connection, runId, state, [], [], null, domainId);

    // ── Rebuild export table + update metrics once writes have committed ───────
    // Awaited (not fire-and-forget) so that PIPELINES.total_mapped /
    // total_source_values and the export table are always in sync before the
    // caller removes items from PIPELINE_QUEUE.
    // Only runs in premium mode (pipelines only exist there).
    if (process.env.NEXT_PUBLIC_APP_MODE === 'premium' && metaRow) {
      const exportTableFqn = (metaRow.EXPORT_TABLE_FQN ?? metaRow.export_table_fqn) as string | null;
      const tableFqn       = String(metaRow.PIPELINE_TABLE_FQN   ?? metaRow.pipeline_table_fqn   ?? '');
      const colName        = String(metaRow.PIPELINE_COLUMN_NAME  ?? metaRow.pipeline_column_name  ?? '');
      const pipelineId     = (metaRow.PIPELINE_ID ?? metaRow.pipeline_id) != null
        ? Number(metaRow.PIPELINE_ID ?? metaRow.pipeline_id) : null;

      try {
        if (exportTableFqn && pipelineId != null) {
          await refreshExportTable(tableFqn, colName, exportTableFqn, domainId, pipelineId);
        } else if (pipelineId != null && tableFqn && colName) {
          await updatePipelineMappedCount(tableFqn, colName, domainId, pipelineId);
        }
        broadcastPipelineEvent({ type: 'metrics_updated' });
      } catch (err) {
        // Non-fatal — metrics can be corrected on the next poll / refresh.
        console.error(`[op-export] Metric update failed for run ${runId}:`, err);
      }
    }

    return result;
  });
}
