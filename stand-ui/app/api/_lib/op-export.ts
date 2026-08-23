/**
 * One-Prompt Export Pipeline — USER-FIRST, FAIL-OPEN.
 *
 * Called after the user confirms and exports a run.
 *
 *   Step 1 — Read state blob            (sole source of truth)
 *   Step 2 — Detect validation cases    (Case A: lookup-confirmed item moved;
 *                                         Case B: validated group renamed;
 *                                         Case C: item moved out of a
 *                                         high-confidence initial LLM group)
 *   Step 3 — Validation referee         (only when cases exist; domain-context
 *                                         system prompt; retries; reverts a user
 *                                         change ONLY when extremely confident
 *                                         it's a mistake; on total failure →
 *                                         decisions = null, i.e. user wins)
 *   Step 4 — WRITE everything in one    (verdicts baked in; batched idempotent
 *             pass                        MERGEs; run → 'completed' on success)
 *
 * Steps 3–4 run in the background after the HTTP response is sent.
 * The run is atomically marked 'validating' to prevent double-export.
 * A validation LLM failure NEVER prevents or unwinds the write — the run stays
 * 'completed' and `validation_status: 'failed'` is recorded in the state blob.
 * Only a failure of the write itself marks the run 'failed' (which is retriable).
 *
 * Zero writes to RUN_ITEMS, RUN_GROUPS, RAW_VALUES, ALIAS_SUMMARY, TOKENS_SUMMARY.
 */

import 'server-only';

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

import { withWarehouse, executeQuery as exec, getWarehouseAdapter } from './warehouse';
import { upsertApprovedAliasMssql, bulkUpsertApprovedAliasesMssql, bulkUpsertLiteralMatchesMssql } from './warehouse/mssql/mappings';
import { upsertApprovedAliasPg, bulkUpsertApprovedAliasesPg, bulkUpsertLiteralMatchesPg } from './warehouse/postgres/mappings';
import { upsertApprovedAliasMysql, bulkUpsertApprovedAliasesMysql, bulkUpsertLiteralMatchesMysql } from './warehouse/mysql/mappings';
import { internalTable, prismNormalizeFn } from './warehouse-tables';
import { recordStandardizedUnits } from './billing-meter';
import { getDb } from './sqlite';
import { normalizeLiteral } from './normalize';
import { reportError } from './report-error';
import { loadOpRunState, saveOpRunState, type OpRunState, type OpGroup, type OpGroupItem, type OpStateItem } from './op-auto-group';
import { callAnthropicWithRetry, JSON_ONLY_REMINDER } from './llm-one-prompt-grouping';
import { sanitizeConventionRules, describeConventionRules, hasAnyRule } from './convention-rules';
import { initBaseline, hasBaseline } from './auto-export-seen';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { asExportKind } from './export-kind';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { appendTiming } from './timing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALIDATION_MODEL      = 'claude-sonnet-4-6';
const VALIDATION_MAX_TOKENS = 4_096;

// Max rows per bulk MERGE statement. Snowflake caps bind variables at ~65k per
// statement (3 binds/literal ⇒ hard failure above ~21.8k literals in a single
// MERGE); 5 000 keeps each statement comfortably inside that with headroom.
// Batching trades single-statement atomicity for scale — safe because the
// MERGEs are idempotent upserts and the 'validating' status guard makes a
// partial-failure retry re-run the same batches.
const EXPORT_MERGE_BATCH = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportResult {
  items_written:    number;
  aliases_updated:  number;
  /** true when another request already claimed/finished this run's export —
   *  the counts are returned but no write pass was started. */
  already_in_progress?: boolean;
  /** true when the mappings were written but rebuilding the customer-visible
   *  export object FAILED. Callers must not then claim the standardized output
   *  is up to date (see KI-146). */
  export_refresh_failed?: boolean;
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

/** Case C: user moved an item away from a high-confidence initial LLM grouping
 *  (the initial standardization is trusted, like the lookup is for Case A). */
interface CaseCItem {
  literal_value:       string;
  original_alias_name: string;
  user_moved_to:       string;
}

interface ValidationDecisionA { lv: string; k: 'u' | 'o'; }
interface ValidationDecisionB { original_alias: string; new_alias: string; k: 'u' | 'o'; apply_to_all: boolean; }
interface ValidationResponse   { case_a?: ValidationDecisionA[]; case_b?: ValidationDecisionB[]; case_c?: ValidationDecisionA[]; }

// ---------------------------------------------------------------------------
// Snowflake exec helper
// ---------------------------------------------------------------------------

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

/** RUNS lives in SQLite — status transitions are local writes. */
function setRunStatus(runId: number, status: string): void {
  getDb()
    .prepare(`UPDATE runs SET run_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id = ?`)
    .run(status, runId);
}

/**
 * Upsert an alias name and return its alias_id.
 * MERGE matches on (alias_name, domain_id) — the unique key — so the same name
 * in two different domains produces two separate rows with separate alias_ids.
 */
export async function upsertApprovedAlias(
  connection: any,
  aliasName:  string,
  domainId:   number | null,
): Promise<number> {
  if (getWarehouseAdapter().kind === 'mssql') return upsertApprovedAliasMssql(connection, aliasName, domainId);
  if (getWarehouseAdapter().kind === 'postgres') return upsertApprovedAliasPg(connection, aliasName, domainId);
  if (getWarehouseAdapter().kind === 'mysql') return upsertApprovedAliasMysql(connection, aliasName, domainId);
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
    `MERGE INTO ${internalTable('APPROVED_ALIAS_NAMES')} AS t
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
     FROM ${internalTable('APPROVED_ALIAS_NAMES')}
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
  if (getWarehouseAdapter().kind === 'mssql') return bulkUpsertApprovedAliasesMssql(connection, aliasNames, domainId);
  if (getWarehouseAdapter().kind === 'postgres') return bulkUpsertApprovedAliasesPg(connection, aliasNames, domainId);
  if (getWarehouseAdapter().kind === 'mysql') return bulkUpsertApprovedAliasesMysql(connection, aliasNames, domainId);
  const result = new Map<string, number>();
  const names  = Array.from(new Set(aliasNames)).filter((n) => n != null && n !== '');
  if (names.length === 0) return result;

  const domainFilter  = domainId != null ? `AND t.domain_id = ${Number(domainId)}` : `AND t.domain_id IS NULL`;
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}`   : `AND domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  // Upsert every distinct name, batched to stay under the bind ceiling. The
  // source is deduped (Set) so no "multiple source rows matched" on the MERGE.
  for (let i = 0; i < names.length; i += EXPORT_MERGE_BATCH) {
    const batch = names.slice(i, i + EXPORT_MERGE_BATCH);
    const valuePlaceholders = batch.map(() => '(?)').join(', ');
    await exec(
      connection,
      `MERGE INTO ${internalTable('APPROVED_ALIAS_NAMES')} AS t
       USING (SELECT column1 AS alias_name FROM VALUES ${valuePlaceholders}) AS s
         ON t.alias_name = s.alias_name ${domainFilter}
       WHEN MATCHED THEN UPDATE SET
         t.usage_count  = t.usage_count + 1,
         t.last_used_at = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
         VALUES (s.alias_name, ${domainLiteral}, 1, CURRENT_TIMESTAMP())`,
      batch,
    );
  }

  // Fetch every alias_id, batched the same way.
  for (let i = 0; i < names.length; i += EXPORT_MERGE_BATCH) {
    const batch = names.slice(i, i + EXPORT_MERGE_BATCH);
    const inPlaceholders = batch.map(() => '?').join(', ');
    const rows = await exec(
      connection,
      `SELECT alias_name, alias_id
       FROM ${internalTable('APPROVED_ALIAS_NAMES')}
       WHERE alias_name IN (${inPlaceholders}) ${selectFilter}`,
      batch,
    );
    for (const r of rows) {
      const name = String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '');
      const id   = Number((r as any).ALIAS_ID   ?? (r as any).alias_id   ?? 0);
      if (name && id) result.set(name, id);
    }
  }

  // Safety net: anything the bulk SELECT somehow missed falls back to the
  // single-name path so the caller always gets a complete map.
  for (const name of names) {
    if (!result.has(name)) result.set(name, await upsertApprovedAlias(connection, name, domainId));
  }
  return result;
}

/**
 * Bulk-upsert all literal → alias mappings for a run in a single MERGE statement.
 *
 * A single Snowflake MERGE is inherently atomic (no transaction needed) and
 * eliminates per-row network round-trips.  All entries share the same domain_id
 * and run_id, so the ON condition is uniform across the batch.
 *
 * Snowflake's VALUES subquery exposes implicit column names column1, column2, …
 * and caps bind variables at ~65 k per statement (3 binds/literal). Entries are
 * batched at EXPORT_MERGE_BATCH so a bulk-load-sized run (20 k+ literals) can't
 * blow the ceiling; each batch MERGE is an idempotent upsert, so a retry after
 * a partial failure re-runs safely.
 */
async function bulkUpsertLiteralMatches(
  connection: any,
  entries:    Array<{ literalValue: string; aliasId: number }>,
  domainId:   number | null,
  runId:      number,
): Promise<number> {
  if (entries.length === 0) return 0;

  // Dedup on the NORMALIZED form before anything else — above the adapter
  // branch so both warehouses get it.
  //
  // The MERGE below joins ON t.normalized_value = PRISM_NORMALIZE(s.literal_value),
  // so two entries whose literals normalize to the same key (e.g. 'Verizon' and
  // 'verizon', or NFC vs NFD accents) are DUPLICATE JOIN KEYS in one source.
  // Snowflake rejects that outright ("duplicate MERGE source keys"); the mssql
  // path can land two rows and break the documented one-row-per
  // (normalized_value, spec) invariant that every lookup/export join relies on.
  //
  // CLAUDE.md has always documented this dedup as existing here. It did not —
  // normalizeLiteral was imported and never called. The Google Sheets connect
  // flow makes it reachable with ordinary customer data, because that path
  // dedups client-side with a raw case-sensitive Set (KI-107).
  //
  // Keep the FIRST mapping for a given normalized key so the result is
  // deterministic, and warn when a conflicting one is dropped — a literal
  // resolving to two different aliases means the run state disagrees with
  // itself, which is worth surfacing rather than silently picking a winner.
  const byNormalized = new Map<string, { literalValue: string; aliasId: number }>();
  for (const e of entries) {
    const key = normalizeLiteral(e.literalValue);
    const existing = byNormalized.get(key);
    if (!existing) { byNormalized.set(key, e); continue; }
    if (existing.aliasId !== e.aliasId) {
      console.warn(
        `[op-export] run ${runId}: literals "${existing.literalValue}" and "${e.literalValue}" ` +
        `normalize to the same key but map to different aliases (${existing.aliasId} vs ${e.aliasId}); ` +
        `keeping the first. The run state maps one value to two groups.`,
      );
    }
  }
  const deduped = Array.from(byNormalized.values());
  if (deduped.length !== entries.length) {
    console.log(`[op-export] run ${runId}: deduped ${entries.length} → ${deduped.length} literal(s) on the normalized form.`);
  }
  entries = deduped;

  // Non-Snowflake dialect writers don't report insert counts yet — §2.8 metering
  // is Snowflake-only for now (the native edition's requirement); see billing-meter.ts.
  if (getWarehouseAdapter().kind === 'mssql') { await bulkUpsertLiteralMatchesMssql(connection, entries, domainId, runId); return 0; }
  if (getWarehouseAdapter().kind === 'postgres') { await bulkUpsertLiteralMatchesPg(connection, entries, domainId, runId); return 0; }
  if (getWarehouseAdapter().kind === 'mysql') { await bulkUpsertLiteralMatchesMysql(connection, entries, domainId, runId); return 0; }

  const domainFilter  = domainId != null
    ? `AND t.domain_id = ${Number(domainId)}`
    : `AND t.domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  let insertedTotal = 0;
  for (let i = 0; i < entries.length; i += EXPORT_MERGE_BATCH) {
    const batch = entries.slice(i, i + EXPORT_MERGE_BATCH);
    // Build (?, ?, ?) placeholders and a flat binds array.
    // column1 = literal_value, column2 = alias_id, column3 = run_id
    const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
    const binds: any[] = batch.flatMap(e => [e.literalValue, e.aliasId, runId]);

    const mergeResult = await exec(
      connection,
      `MERGE INTO ${internalTable('LITERAL_ALIAS_MATCHES')} AS t
       USING (
         SELECT column1 AS literal_value,
                column2 AS alias_id,
                column3 AS run_id
         FROM VALUES ${placeholders}
       ) AS s
         ON t.normalized_value = ${prismNormalizeFn()}(s.literal_value) ${domainFilter}
       WHEN MATCHED THEN UPDATE SET
         t.alias_id     = s.alias_id,
         t.run_id       = s.run_id,
         t.confirmed_at = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
         VALUES (s.literal_value, ${prismNormalizeFn()}(s.literal_value), s.alias_id, ${domainLiteral}, s.run_id, CURRENT_TIMESTAMP())`,
      binds,
    );
    // §2.8 billing: MERGE-reported inserts are the billable unit — a NEW row
    // means a value standardized for the first time in this scope. Retried
    // idempotent batches MATCH instead of inserting and report 0.
    insertedTotal += Number(mergeResult?.[0]?.['number of rows inserted'] ?? 0);
  }
  return insertedTotal;
}

// ---------------------------------------------------------------------------
// Step 2 — detect Case A and Case B from state (no DB)
// ---------------------------------------------------------------------------

interface DetectResult {
  caseAItems:  CaseAItem[];
  caseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[];
  caseCItems:  CaseCItem[];
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

  // ── Detect Case C ────────────────────────────────────────────────────────
  // The initial standardization is trusted: an item stamped with a
  // high-confidence initial LLM group that now sits in a DIFFERENT group was
  // moved by the user — referee it like Case A. Lookup-matched items are
  // excluded (Case A covers them); 'm'/'l' initial groups are not trusted
  // enough to second-guess the user over.
  const caseCItems: CaseCItem[] = [];
  for (const si of state.items) {
    if (si.matched_from_lookup) continue;
    if (!si.initial_alias_name || si.initial_confidence !== 'h') continue;
    if (typeof si.initial_group_id !== 'number') continue;

    const currentGroupId = groupIdByLiteral.get(si.literal_value);
    if (currentGroupId === undefined || currentGroupId === si.initial_group_id) continue;
    const currentGroup = groupByLiteral.get(currentGroupId);
    if (!currentGroup) continue;

    // Revert target: the initial group's CURRENT alias when it still exists
    // (the user may have legitimately renamed it), else the stamped name.
    const initialGroup  = groupByLiteral.get(si.initial_group_id);
    const originalAlias = initialGroup?.alias_name ?? si.initial_alias_name;
    if (currentGroup.alias_name === originalAlias) continue;

    caseCItems.push({
      literal_value:       si.literal_value,
      original_alias_name: originalAlias,
      user_moved_to:       currentGroup.alias_name,
    });
  }

  return { caseAItems, caseBGroups, caseCItems };
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

    const limitOne = getWarehouseAdapter().kind === 'mssql' ? 'SELECT TOP (1)' : 'SELECT';
    const limitTail = getWarehouseAdapter().kind === 'mssql' ? '' : 'LIMIT 1';
    const exactRows = await exec(
      connection,
      `${limitOne} lam.literal_value
       FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
       JOIN ${internalTable('APPROVED_ALIAS_NAMES')}  aan ON lam.alias_id = aan.alias_id
       WHERE aan.alias_name = ? AND lam.literal_value = ? ${domainFilter} ${limitTail}`,
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
       FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
       JOIN ${internalTable('APPROVED_ALIAS_NAMES')}  aan ON lam.alias_id = aan.alias_id
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
The user is a domain expert reviewing their own data — their changes are presumed
correct and the default verdict is to keep them ("u"). Revert to the original ("o")
ONLY when you are extremely confident the change is a mistake: an unambiguous error
a well-informed person would immediately recognize, such as mapping a literal to a
clearly unrelated entity or what looks like an accidental drag/typo. If there is ANY
plausible reading under which the change is intentional and correct — a granularity
choice, an in-house naming preference, domain knowledge you may lack — keep it.
When torn, keep the user's change.
Respond only with valid JSON. No text outside the JSON.

{
  "case_a": [{"lv":"literal_value","k":"u"|"o"},...],
  "case_b": [{"original_alias":"string","new_alias":"string","k":"u"|"o","apply_to_all":true|false},...],
  "case_c": [{"lv":"literal_value","k":"u"|"o"},...]
}

Where:
  k = "u" means keep the user's change
  k = "o" means revert to the original
  apply_to_all (case b only) = true means rename the alias for all known literal values mapped to it, not just this run`;

/** Spec context handed to the validation referee (5a): the same concept /
 *  rules / convention information the grouping prompts get, so keep-vs-revert
 *  verdicts are judged with knowledge of what the column actually is. */
interface ValidationSpecContext {
  conceptName:            string;
  conceptDef:             string;
  stdRules:               string[];
  conventionRequirements: string[];
}

function loadValidationSpecContext(runId: number): ValidationSpecContext {
  const ctx: ValidationSpecContext = { conceptName: '', conceptDef: '', stdRules: [], conventionRequirements: [] };
  try {
    // `runs.domain_id` now holds the per-column spec_id (the lookup scope). The
    // validation referee's CONCEPT is the column name; its DEFINITION is the
    // spec description.
    const row = getDb()
      .prepare(
        `SELECT r.concept_key, r.source_column, cs.description, cs.standardization_rules,
                cs.convention_type, cs.convention_value, cs.convention_rules
         FROM runs r
         LEFT JOIN column_specs cs ON cs.spec_id = r.domain_id
         WHERE r.run_id = ?`,
      )
      .get(runId) as any;
    if (!row) return ctx;

    ctx.conceptName = String(row.source_column ?? row.concept_key ?? '').trim();
    ctx.conceptDef  = String(row.description ?? '').trim();

    if (row.standardization_rules) {
      try {
        const parsed = JSON.parse(String(row.standardization_rules));
        if (Array.isArray(parsed)) ctx.stdRules = parsed.map(String).filter(Boolean);
      } catch { /* malformed rules JSON → no rules context */ }
    }

    const ct = String(row.convention_type ?? '').toLowerCase();
    const cv = String(row.convention_value ?? '').trim();
    if (ct === 'regex' && cv) {
      ctx.conventionRequirements.push(`fully match this regular expression (anchored start-to-end): ${cv}`);
    } else if (ct === 'examples' && cv) {
      const examples = cv.split('\n').map((s) => s.trim()).filter(Boolean).join(' | ');
      if (examples) ctx.conventionRequirements.push(`follow the form of these examples: ${examples}`);
    } else if (ct === 'natural' && cv) {
      ctx.conventionRequirements.push(cv);
    }
    if (row.convention_rules) {
      try {
        const rules = sanitizeConventionRules(JSON.parse(String(row.convention_rules)));
        if (hasAnyRule(rules)) ctx.conventionRequirements.push(...describeConventionRules(rules));
      } catch { /* malformed convention rules → skip */ }
    }
  } catch (e) {
    console.warn('[op-export] Could not load spec context for validation:', e);
  }
  return ctx;
}

function buildValidationSystemPrompt(ctx: ValidationSpecContext): string {
  let out = VALIDATION_SYSTEM_PROMPT;
  const parts: string[] = [];
  if (ctx.conceptName) parts.push(`CONCEPT: ${ctx.conceptName}`);
  if (ctx.conceptDef)  parts.push(`DEFINITION: ${ctx.conceptDef}`);
  if (ctx.stdRules.length > 0) {
    parts.push(
      `STANDARDIZATION RULES — mandatory rules for this column. A user change that clearly\n` +
      `violates one of these is evidence of a mistake (the extremely-confident bar\n` +
      `above still applies):\n` +
      ctx.stdRules.map((r) => `  - ${r}`).join('\n'),
    );
  }
  if (ctx.conventionRequirements.length > 0) {
    parts.push(
      `NAMING CONVENTION — canonical names for this column must:\n` +
      ctx.conventionRequirements.map((r) => `  - ${r}`).join('\n'),
    );
  }
  if (parts.length > 0) {
    out += `\n\nDOMAIN CONTEXT — use this to judge the user's changes:\n\n` + parts.join('\n\n');
  }
  return out;
}

function buildValidationUserTurn(
  caseAItems:  CaseAItem[],
  caseBGroups: CaseBGroup[],
  caseCItems:  CaseCItem[] = [],
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
      `Keep the user's new mapping ("u") unless it is unambiguously a mistake ("o").\n\n` +
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
      `Keep the new name ("u") unless it is unambiguously a mistake ("o"). When keeping, decide\n` +
      `if it should apply to all known literals mapped to the original alias or only to the\n` +
      `items in this run.\n\n` +
      blocks,
    );
  }

  if (caseCItems.length > 0) {
    const blocks = caseCItems.map((item, i) =>
      `ITEM ${i + 1}:\n` +
      `  literal_value: "${item.literal_value}"\n` +
      `  original_alias_name: "${item.original_alias_name}"\n` +
      `  user_moved_to: "${item.user_moved_to}"`,
    ).join('\n\n');

    sections.push(
      `CASE C ITEMS:\n\n` +
      `For each Case C item, the automated standardization placed the value in a group with\n` +
      `high confidence, and the user moved it to a different group.\n` +
      `Keep the user's new mapping ("u") unless it is unambiguously a mistake ("o") — e.g. the\n` +
      `value clearly refers to the original group's entity and not the destination's (a likely\n` +
      `accidental drag).\n\n` +
      blocks,
    );
  }

  return sections.join('\n\n---\n\n');
}

async function callValidationLLM(apiKey: string, systemPrompt: string, userTurn: string): Promise<string> {
  const body = await callAnthropicWithRetry(apiKey, {
    model:       VALIDATION_MODEL,
    max_tokens:  VALIDATION_MAX_TOKENS,
    temperature: 0,
    system:      systemPrompt,
    messages:    [{ role: 'user', content: userTurn }],
  }, 'export validation');
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
  caseCItems:  CaseCItem[] = [],
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

  // Override Case C items per LLM decision (same semantics as Case A; the
  // revert target is the item's initial high-confidence LLM group).
  const caseCDecisions = new Map<string, 'u' | 'o'>();
  for (const d of decisions?.case_c ?? []) {
    caseCDecisions.set(d.lv, d.k);
  }
  for (const item of caseCItems) {
    const k = caseCDecisions.get(item.literal_value) ?? 'u';
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
  const newlyInserted = await bulkUpsertLiteralMatches(connection, matchEntries, domainId, runId);
  await recordStandardizedUnits(connection, newlyInserted, 'pipeline_export');
  const items_written = matchEntries.length;

  // ── Apply global Case B renames (touches historical rows outside this run) ─
  const domainFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}` : `AND domain_id IS NULL`;
  for (const rename of globalRenames) {
    const fromRows = await exec(
      connection,
      `SELECT alias_id, usage_count
       FROM ${internalTable('APPROVED_ALIAS_NAMES')}
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
       FROM ${internalTable('APPROVED_ALIAS_NAMES')}
       WHERE alias_name = ? ${domainFilter}`,
      [rename.to],
    );

    if (toRows.length > 0) {
      // Target exists → merge: repoint LITERAL_ALIAS_MATCHES to the target alias_id,
      // then remove the source alias row. No alias_name scan needed.
      const toId = Number((toRows[0] as any).ALIAS_ID ?? (toRows[0] as any).alias_id);
      await exec(
        connection,
        // Paren-LESS CURRENT_TIMESTAMP: this block has no mssql delegation, so
        // the same SQL runs on both warehouses. The `CURRENT_TIMESTAMP()` form
        // is Snowflake-only and fails on SQL Server with "Incorrect syntax near
        // ')'" (msg 102) — verified live on both. The paren-less form is valid
        // on Snowflake AND T-SQL, which is why the sibling UPDATE just below
        // already used it. See KI-105.
        `UPDATE ${internalTable('LITERAL_ALIAS_MATCHES')}
         SET alias_id = ?, confirmed_at = CURRENT_TIMESTAMP
         WHERE alias_id = ?`,
        [toId, fromId],
      );
      await exec(
        connection,
        `UPDATE ${internalTable('APPROVED_ALIAS_NAMES')}
         SET usage_count = usage_count + ?, last_used_at = CURRENT_TIMESTAMP
         WHERE alias_id = ?`,
        [fromCount, toId],
      );
      await exec(
        connection,
        `DELETE FROM ${internalTable('APPROVED_ALIAS_NAMES')} WHERE alias_id = ?`,
        [fromId],
      );
    } else {
      // Pure rename → just update the name in place. LITERAL_ALIAS_MATCHES
      // references alias_id, so this single UPDATE is the entire migration.
      await exec(
        connection,
        // Paren-less for the same dual-dialect reason as above (KI-105).
        `UPDATE ${internalTable('APPROVED_ALIAS_NAMES')}
         SET alias_name = ?, last_used_at = CURRENT_TIMESTAMP
         WHERE alias_id = ?`,
        [rename.to, fromId],
      );
    }
  }

  // ── Log Case A/B decisions (append-only audit trail, warehouse-side) ──────
  // VALIDATION_LOG contains literal source values, so it lives in the
  // customer's warehouse (data residency), written on the already-open export
  // connection. Failures are logged but never fail the export.
  const vlogTable = getWarehouseAdapter().kind === 'mssql'
    ? 'INTERNAL.VALIDATION_LOG'
    : internalTable('VALIDATION_LOG');
  const insertValidationLog = async (
    literalValue: string, originalAlias: string, changedTo: string, k: string,
  ) => {
    try {
      await exec(
        connection,
        `INSERT INTO ${vlogTable}
           (literal_value, run_id, original_alias_name, user_changed_to, llm_decision)
         VALUES (?, ?, ?, ?, ?)`,
        [literalValue.slice(0, 800), runId, originalAlias, changedTo, k === 'u' ? 'user' : 'original'],
      );
    } catch (err) {
      console.error('[op-export] validation_log insert failed (non-fatal):', err);
    }
  };
  for (const d of decisions?.case_a ?? []) {
    const item = caseAItems.find((a) => a.literal_value === d.lv);
    if (!item) continue;
    await insertValidationLog(item.literal_value, item.original_alias_name, item.user_moved_to, d.k);
  }
  for (const d of decisions?.case_b ?? []) {
    const group = caseBGroups.find(
      (b) => b.original_alias_name === d.original_alias && b.user_changed_to === d.new_alias,
    );
    if (!group) continue;
    for (const gi of group.group_items) {
      await insertValidationLog(gi.literal_value, group.original_alias_name, group.user_changed_to, d.k);
    }
  }
  for (const d of decisions?.case_c ?? []) {
    const item = caseCItems.find((c) => c.literal_value === d.lv);
    if (!item) continue;
    await insertValidationLog(item.literal_value, item.original_alias_name, item.user_moved_to, d.k);
  }

  // ── Mark run complete ─────────────────────────────────────────────────────
  setRunStatus(runId, 'completed');

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
    type:              'case_a' | 'case_b' | 'case_c';
    literal_value?:    string;
    original_alias:    string;
    user_changed_to:   string;
    llm_decision:      'user' | 'original';
    apply_to_all?:     boolean;
  }>,
  error: string | null,
): void {
  // GATE FIRST — this artifact contains the customer's literal values, their
  // alias names, the full validation prompt and the raw LLM response. It was
  // previously written UNCONDITIONALLY, on every export with a Case A/B/C
  // deviation, in every install including customer deployments. Matches the
  // gating writeOnePromptBreakdown already had.
  if (process.env.PRISM_DEBUG_ARTIFACTS !== 'true') return;
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

    // os.tmpdir(), never the project tree. This used to resolve to the PARENT of
    // the app working directory — i.e. the repo root — so customer values were
    // written into the checkout itself.
    const outPath = path.join(os.tmpdir(), `validation_audit_run_${runId}.json`);
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
  caseCItems:     CaseCItem[] = [],
): Promise<void> {
  await withWarehouse(async (connection) => {
    try {
      // Fetch domain_id first — needed for both the Case B context lookup and writeAllDecisions.
      const domainRow = getDb().prepare(`SELECT domain_id FROM runs WHERE run_id = ?`).get(runId) as any;
      const exportDomainId: number | null = domainRow ? (Number(domainRow.domain_id) || null) : null;

      let decisions:  ValidationResponse | null = null;
      let rawText   = '';
      let userTurn  = '';
      let caseBGroups: CaseBGroup[] = [];
      let validationError: string | null = null;

      const systemPrompt = buildValidationSystemPrompt(loadValidationSpecContext(runId));

      // OWNER DECISION 2026-08-18 (client-sim rehearsal, C3): the export
      // referee is DISABLED. The reviewer's exported mappings are written
      // exactly as specified — no LLM second-guessing, even for moves that
      // contradict the confirmed lookup. (The owner watched Case A revert a
      // deliberate move — "Boost" into the AT&T group — and chose user
      // sovereignty over the safety net: the customer's specified mapping
      // always wins.) The detection/validation machinery is retained behind
      // this flag rather than deleted: decisions = null IS the documented
      // fail-open path (every case keeps the user's change), VALIDATION_LOG
      // simply receives no rows, and re-enabling is a one-line change.
      const EXPORT_REFEREE_ENABLED = false;

      if (EXPORT_REFEREE_ENABLED && (caseAItems.length > 0 || rawCaseBGroups.length > 0 || caseCItems.length > 0)) {
        const _valStart = Date.now();
        caseBGroups = await fetchCaseBContext(connection, runId, state, rawCaseBGroups, exportDomainId);
        userTurn    = buildValidationUserTurn(caseAItems, caseBGroups, caseCItems);
        try {
          rawText   = await callValidationLLM(apiKey, systemPrompt, userTurn);
          decisions = tryParseJson<ValidationResponse>(rawText);
          if (!decisions) {
            // One retry with an explicit JSON-only reminder (parity with the
            // grouping calls).
            rawText   = await callValidationLLM(apiKey, systemPrompt, userTurn + JSON_ONLY_REMINDER);
            decisions = tryParseJson<ValidationResponse>(rawText);
          }
        } catch (err) {
          validationError = err instanceof Error ? err.message : String(err);
        }
        appendTiming(`[Timing] accept.validation_llm: ${Date.now() - _valStart}ms (${caseAItems.length} caseA, ${rawCaseBGroups.length} caseB, ${caseCItems.length} caseC)`);

        // FAIL-OPEN: a validation failure never blocks the write. The user's
        // decisions are written at face value (decisions = null → every case
        // defaults to keeping the user's change) and validation_status:
        // 'failed' is recorded in the state blob after the write.
        if (!decisions) {
          validationError ??= 'Failed to parse LLM response as JSON';
          console.error(`[op-export] Run ${runId}: validation LLM failed — proceeding with the user's decisions unvalidated. ${validationError}\nRaw: ${rawText.slice(0, 800)}`);
          writeValidationAudit(
            runId, caseAItems, caseBGroups,
            systemPrompt, userTurn, rawText,
            null, [],
            validationError,
          );
        }
      }

      // Step 4: write everything (normal items + Case A/B/C decisions) in one pass.
      const _writeStart = Date.now();
      await writeAllDecisions(connection, runId, state, caseAItems, caseBGroups, decisions, exportDomainId, caseCItems);
      appendTiming(`[Timing] accept.write_decisions: ${Date.now() - _writeStart}ms (lookup + alias upserts)`);

      // Record the validation outcome in the state blob (the run itself stays
      // 'completed' — the write landed; only validation was skipped).
      if (validationError !== null) {
        try {
          const st = await loadOpRunState(runId);
          if (st) await saveOpRunState(runId, { ...st, validation_status: 'failed', rev: Number(st.rev ?? 0) + 1 });
        } catch (e) {
          console.warn(`[op-export] Run ${runId}: could not record validation_status in state blob:`, e);
        }
      }
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
      {
        try {
          // Collect the set of literals that were just written to LITERAL_ALIAS_MATCHES.
          const standardizedLiterals = state.groups.flatMap((g) => g.items.map((gi) => gi.literal_value));

          // Seed Redis auto-export baseline from the run's source table (once only).
          const runSourceRow = getDb()
            .prepare(`SELECT source_relation, source_column FROM runs WHERE run_id = ?`)
            .get(runId) as any;
          if (runSourceRow) {
            const r          = runSourceRow;
            const tableFqn   = String(r.source_relation ?? '');
            const columnName = String(r.source_column   ?? '');
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
          const domainPipelines = getDb()
            .prepare(
              `SELECT p.pipeline_id, p.table_fqn, p.column_name, p.export_table_fqn, p.export_kind, p.status
               FROM pipelines p
               WHERE p.status IN ('active', 'paused', 'pending_baseline') AND ${domainCond}
               ORDER BY p.pipeline_id`,
            )
            .all() as any[];

          for (const pRow of domainPipelines) {
            const pipelineId     = Number(pRow.pipeline_id);
            const tableFqn       = String(pRow.table_fqn       ?? '');
            const colName        = String(pRow.column_name     ?? '');
            const exportTableFqn = pRow.export_table_fqn as string | null;
            const exportKind     = asExportKind(pRow.export_kind);
            const pStatus        = String((pRow as any).STATUS ?? (pRow as any).status ?? '');

            if (!tableFqn || !colName) continue;

            try {
              // Step A: update metrics, and rebuild the export table ONLY for pipelines
              // that are already live. A pending_baseline/paused pipeline must not have
              // its export table populated until the user explicitly starts it from the
              // activation card ("Begin Pipeline Standardization") — which flips it to
              // 'active' and builds the export then. Until then we only refresh metrics
              // (total_mapped / total_source_values) so the activation card is accurate.
              // A view is live already — it only needs creating once, at activation
              // (handled by the pipeline status route), so every pass after that only
              // recomputes metrics, same as a pipeline with no export object at all.
              if (exportTableFqn && pStatus === 'active' && exportKind !== 'view') {
                await refreshExportTable(tableFqn, colName, exportTableFqn, exportDomainId, pipelineId, exportKind);
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
                // Match the queue on the NORMALIZED form, not the raw literal.
                //
                // Every writer into PIPELINE_QUEUE dedups on the normalized
                // value and stores an ARBITRARY representative original, so the
                // queue may hold 'at&t' while the reviewed run wrote 'AT&T'.
                // A raw `literal_value IN (...)` comparison misses those rows,
                // leaving already-standardized values queued forever: they get
                // re-standardized every tick, keep queue_size non-zero, and so
                // hold fully_synced_at back — the card says "not up to date"
                // about work that is finished. Live-reproduced on both
                // warehouses (EXP-01).
                //
                // Done app-side rather than with PRISM_NORMALIZE so the one
                // normalization implementation (normalizeLiteral) decides, and
                // so this path behaves identically on SQL Server, which has no
                // SQL-side normalize at all. Scoped to this pipeline's queue,
                // which is bounded by its distinct source values.
                const wantNormalized = new Set(standardizedLiterals.map((lv) => normalizeLiteral(lv)));
                const queueHitRows = await exec(
                  connection,
                  `SELECT literal_value FROM ${internalTable('PIPELINE_QUEUE')}
                   WHERE pipeline_id = ?`,
                  [pipelineId],
                );
                const toRemove = queueHitRows
                  .map((r: any) => String(r.LITERAL_VALUE ?? r.literal_value ?? ''))
                  .filter((lv: string) => lv && wantNormalized.has(normalizeLiteral(lv)));

                // Batched under the adapter's bind budget, same as the tick's
                // removeExportedFromQueue: a large drain would otherwise blow
                // SQL Server's ~2.1k-parameter ceiling in a single statement.
                const DEL_BATCH = Math.max(100, getWarehouseAdapter().bindLimit - 100);
                for (let i = 0; i < toRemove.length; i += DEL_BATCH) {
                  const batch = toRemove.slice(i, i + DEL_BATCH);
                  await exec(
                    connection,
                    `DELETE FROM ${internalTable('PIPELINE_QUEUE')}
                     WHERE pipeline_id = ? AND literal_value IN (${batch.map(() => '?').join(', ')})`,
                    [pipelineId, ...batch],
                  );
                }

                // Update queue_size (and last_queue_empty_at if now empty) regardless.
                const [qRow] = await exec(
                  connection,
                  `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
                  [pipelineId],
                );
                const remaining = Number((qRow as any)?.CNT ?? (qRow as any)?.cnt ?? 0);
                const setClauses = [`queue_size = ?`, `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
                const updateBinds: any[] = [remaining];
                if (remaining === 0) setClauses.push(`last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
                updateBinds.push(pipelineId);
                getDb()
                  .prepare(`UPDATE pipelines SET ${setClauses.join(', ')} WHERE pipeline_id = ?`)
                  .run(...updateBinds);

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

          appendTiming(`[Timing] accept.export_rebuild+metrics: ${Date.now() - _rebuildStart}ms (${domainPipelines.length} spec-scoped pipeline(s))`);

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
      for (const d of decisions?.case_c ?? []) {
        const item = caseCItems.find((c) => c.literal_value === d.lv);
        if (!item) continue;
        appliedDecisions.push({
          type:            'case_c',
          literal_value:   item.literal_value,
          original_alias:  item.original_alias_name,
          user_changed_to: item.user_moved_to,
          llm_decision:    d.k === 'u' ? 'user' : 'original',
        });
      }

      if (decisions !== null) {
        writeValidationAudit(
          runId, caseAItems, caseBGroups,
          systemPrompt, userTurn, rawText,
          decisions, appliedDecisions,
          null,
        );
      }

      const aCount = appliedDecisions.filter((d) => d.type === 'case_a').length;
      const bCount = appliedDecisions.filter((d) => d.type === 'case_b').length;
      const cCount = appliedDecisions.filter((d) => d.type === 'case_c').length;
      console.log(`[op-export] Run ${runId}: write+validate complete — ${aCount} Case A, ${bCount} Case B, ${cCount} Case C decisions applied.`);
    } catch (err) {
      try { setRunStatus(runId, 'failed'); } catch { /* best-effort */ }
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
 * VALIDATION_LOG) are triggered only when the run has not already been claimed
 * or finished — i.e. when currentStatus is not 'validating' or 'completed'.
 *
 * 'failed' is DELIBERATELY retriable and must stay out of that exclusion list.
 * It used to be excluded, which turned an idempotency guard into a data-loss
 * path: once a mid-write failure marked a run 'failed', re-POSTing the export
 * skipped writeAllDecisions entirely and returned a SUCCESS-shaped result
 * computed from the state blob, while the caller went on to clear
 * PIPELINE_QUEUE and advance the pipeline — so the user saw a successful
 * export, the queue emptied, and no mappings were ever written. Nothing else in
 * the codebase resets a user-driven run to 'created', so there was no recovery
 * path at all.
 *
 * Callers MUST branch on `already_in_progress` before treating an export as
 * committed: when it is true no write pass ran on this call.
 */
export async function runOpExport(
  connection:    any,
  runId:         number,
  apiKey:        string,
  currentStatus: string,
  opts?:         { awaitWrite?: boolean },
): Promise<ExportResult> {
  // Step 1 — read state blob.
  const state = await loadOpRunState(runId);
  if (!state) throw new Error(`[op-export] No state found for run_id=${runId}`);

  // Compute return counts from state (always returned regardless of status).
  const items_written   = state.groups.reduce((n, g) => n + g.items.length, 0);
  const aliases_updated = new Set(state.groups.map((g) => g.alias_name)).size;

  // NOTE: 'failed' is intentionally absent — see the doc comment above. Only a
  // run that is mid-write ('validating') or already committed ('completed') may
  // skip the write pass.
  const isFirstExport = currentStatus !== 'validating'
                     && currentStatus !== 'completed';

  if (isFirstExport) {
    // Step 2 — detect Case A/B/C from state (no DB writes).
    const { caseAItems, caseBGroups: rawCaseBGroups, caseCItems } = detectCases(state);

    // Mark run as 'validating' so concurrent first-export calls are recognized.
    setRunStatus(runId, 'validating');

    // Steps 3–4 — opens its own Snowflake connection.
    // Normally fire-and-forget so the user gets a fast export confirmation, with
    // the lookup writes + export rebuild + metric refresh completing in the
    // background. When `awaitWrite` is set (initial pipeline creation / the
    // multi-column wizard) we await it instead, so the caller does not navigate
    // to the pipelines view until standardization is committed and metrics are
    // current. For a brand-new pipeline there are no lookup matches yet, so there
    // is no Case A/B validation LLM call — the await is just the DB writes +
    // export rebuild (a few seconds), not an LLM round-trip.
    const writePass = runWriteAndValidatePass(runId, state, caseAItems, rawCaseBGroups, apiKey, caseCItems);

    if (opts?.awaitWrite) {
      // PROPAGATE when the caller is waiting. runWriteAndValidatePass already
      // marks the run 'failed' and rethrows; swallowing that into console.error
      // meant even the AWAITED path resolved normally and returned
      // blob-derived counts, so the pipeline-creation wizard and
      // commit-standardizations reported a successful export ({items_written:3,
      // aliases_updated:2}) for a write that had failed outright. The caller
      // asked to wait precisely so it could act on the outcome — give it one.
      await writePass;
    } else {
      // Fire-and-forget: the HTTP response has already been sent, so there is
      // nobody to reject to. Log AND report, so a background failure reaches
      // Sentry instead of dying in a server log nobody reads. The run is left
      // marked 'failed' by runWriteAndValidatePass, which (since KI-202) is a
      // retriable state.
      void writePass.catch((err) => {
        reportError(err, { runId, phase: 'background-write-validate' });
      });
    }
  }

  // Tell the caller whether a write pass actually ran on THIS call, so it can
  // avoid treating a no-op as a committed export (see KI-202).
  return { items_written, aliases_updated, already_in_progress: !isFirstExport };
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
  return await withWarehouse(async (connection) => {
    const state = await loadOpRunState(runId);
    if (!state) throw new Error(`[op-export] No state found for run_id=${runId}`);

    // Fetch run metadata + matching pipeline in one query so we can rebuild
    // the export table / update total_mapped after writes commit.
    const metaRow = getDb()
      .prepare(
        `SELECT r.domain_id,
                p.pipeline_id,
                p.table_fqn    AS pipeline_table_fqn,
                p.column_name  AS pipeline_column_name,
                p.export_table_fqn,
                p.export_kind
         FROM runs r
         LEFT JOIN pipelines p
           ON  p.table_fqn   = r.source_relation
           AND p.column_name = r.source_column
           AND (
             (p.domain_id IS NULL AND r.domain_id IS NULL) OR
             p.domain_id = r.domain_id
           )
         WHERE r.run_id = ?`,
      )
      .get(runId) as any ?? null;
    const domainId: number | null = metaRow
      ? (Number(metaRow.domain_id) || null)
      : null;

    setRunStatus(runId, 'validating');

    // Mark the run 'failed' if the write dies mid-flight, then rethrow.
    //
    // Without this, a mid-write failure left the run stranded at 'validating'
    // forever: createRunFromQueue's retry-reuse lookup only matches
    // 'created'/'running', so every subsequent tick INSERTed a fresh RUNS row
    // instead of reusing the pending one — the exact pileup the reuse lookup
    // exists to prevent — and each orphan kept its own RUN_STATE blob holding
    // customer values. runWriteAndValidatePass (the user-facing export) has
    // always done this; runOpExportDirect (the automated tick path) never did.
    //
    // 'failed' rather than resetting to 'created': it is honest about what
    // happened, and since KI-202 'failed' is a retriable state that
    // runOpExport will re-attempt, so nothing is stuck.
    let result: ExportResult;
    try {
      result = await writeAllDecisions(connection, runId, state, [], [], null, domainId);
    } catch (writeErr) {
      try { setRunStatus(runId, 'failed'); } catch { /* best-effort */ }
      throw writeErr;
    }

    // ── Rebuild export table + update metrics once writes have committed ───────
    // Awaited (not fire-and-forget) so that PIPELINES.total_mapped /
    // total_source_values and the export table are always in sync before the
    // caller removes items from PIPELINE_QUEUE.
    if (metaRow) {
      const exportTableFqn = (metaRow.EXPORT_TABLE_FQN ?? metaRow.export_table_fqn) as string | null;
      const exportKind     = asExportKind(metaRow.EXPORT_KIND ?? metaRow.export_kind);
      const tableFqn       = String(metaRow.PIPELINE_TABLE_FQN   ?? metaRow.pipeline_table_fqn   ?? '');
      const colName        = String(metaRow.PIPELINE_COLUMN_NAME  ?? metaRow.pipeline_column_name  ?? '');
      const pipelineId     = (metaRow.PIPELINE_ID ?? metaRow.pipeline_id) != null
        ? Number(metaRow.PIPELINE_ID ?? metaRow.pipeline_id) : null;

      try {
        // A view is always live — never needs rebuilding, only metrics recomputed
        // (same as the no-export-object case).
        if (exportTableFqn && exportKind !== 'view' && pipelineId != null) {
          await refreshExportTable(tableFqn, colName, exportTableFqn, domainId, pipelineId, exportKind);
        } else if (pipelineId != null && tableFqn && colName) {
          await updatePipelineMappedCount(tableFqn, colName, domainId, pipelineId);
        }
        broadcastPipelineEvent({ type: 'metrics_updated' });
      } catch (err) {
        // Non-fatal to the MAPPINGS — those are already committed above, and
        // metrics can be corrected on the next poll / refresh. But the caller
        // must be told, because the customer-visible export object was NOT
        // rebuilt: draining the queue and stamping "standardized table last
        // updated just now" on the back of a failed rebuild is exactly the
        // false-freshness bug (KI-146).
        console.error(`[op-export] Export/metric refresh failed for run ${runId}:`, err);
        reportError(err, { runId, phase: 'export-refresh' });
        result.export_refresh_failed = true;
      }
    }

    return result;
  });
}
