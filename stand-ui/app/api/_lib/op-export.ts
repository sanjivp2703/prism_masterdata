/**
 * One-Prompt Export Pipeline (Steps 1–5).
 *
 * Called after the user confirms and exports a one-prompt run.
 *
 *   Step 1 — Read state blob          (sole source of truth)
 *   Step 2 — Write alias matches       (upsert literal→alias, upsert approved names,
 *                                        mark run 'complete')
 *   Step 3 — Detect validation cases   (Case A: item moved; Case B: group renamed)
 *   Step 4 — LLM validation pass       (async, does not block the export response)
 *   Step 5 — Apply validation decisions (revert/persist, log every decision)
 *
 * Steps 3–5 run in the background after the HTTP response is already sent.
 * They open their own Snowflake connection via withSnowflake.
 *
 * Zero writes to RUN_ITEMS, RUN_GROUPS, RAW_VALUES, ALIAS_SUMMARY, TOKENS_SUMMARY.
 */

import 'server-only';

import { withSnowflake } from './snowflake';
import { loadOpRunState, type OpRunState, type OpGroup, type OpGroupItem, type OpStateItem } from './op-auto-group';

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
// Step 2 helpers — upsert alias matches + approved names
// ---------------------------------------------------------------------------

async function upsertLiteralMatch(
  connection: any,
  literalValue: string,
  aliasName:    string,
  runId:        number,
): Promise<void> {
  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES AS t
     USING (SELECT ? AS literal_value, ? AS alias_name, ? AS run_id) AS s
       ON t.literal_value = s.literal_value
     WHEN MATCHED THEN UPDATE SET
       t.alias_name    = s.alias_name,
       t.run_id        = s.run_id,
       t.confirmed_at  = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (literal_value, alias_name, run_id, confirmed_at)
       VALUES (s.literal_value, s.alias_name, s.run_id, CURRENT_TIMESTAMP())`,
    [literalValue, aliasName, runId],
  );
}

async function upsertApprovedAlias(connection: any, aliasName: string): Promise<void> {
  await exec(
    connection,
    `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES AS t
     USING (SELECT ? AS alias_name) AS s
       ON t.alias_name = s.alias_name
     WHEN MATCHED THEN UPDATE SET
       t.usage_count  = t.usage_count + 1,
       t.last_used_at = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (alias_name, usage_count, last_used_at)
       VALUES (s.alias_name, 1, CURRENT_TIMESTAMP())`,
    [aliasName],
  );
}

// ---------------------------------------------------------------------------
// Step 2 — write export data to DB
// ---------------------------------------------------------------------------

async function writeExportData(
  connection: any,
  runId:      number,
  state:      OpRunState,
): Promise<ExportResult> {
  let items_written   = 0;
  const aliasesToUpsert = new Set<string>();

  for (const group of state.groups) {
    for (const item of group.items) {
      await upsertLiteralMatch(connection, item.literal_value, group.alias_name, runId);
      items_written++;
    }
    aliasesToUpsert.add(group.alias_name);
  }

  for (const aliasName of aliasesToUpsert) {
    await upsertApprovedAlias(connection, aliasName);
  }

  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
    [runId],
  );

  return { items_written, aliases_updated: aliasesToUpsert.size };
}

// ---------------------------------------------------------------------------
// Step 3 — detect Case A and Case B
// ---------------------------------------------------------------------------

interface DetectResult {
  caseAItems:  CaseAItem[];
  caseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[];
}

function detectCases(state: OpRunState): DetectResult {
  // Build a fast lookup: literal_value → OpStateItem (from top-level items array).
  const itemByLiteral = new Map<string, OpStateItem>(
    state.items.map((it) => [it.literal_value, it]),
  );

  // Build a map: literal_value → current group (scanning state.groups).
  const groupByLiteral = new Map<number, OpGroup>();   // group_id → group
  const groupIdByLiteral = new Map<string, number>();  // literal_value → group_id
  for (const group of state.groups) {
    groupByLiteral.set(group.group_id, group);
    for (const item of group.items) {
      groupIdByLiteral.set(item.literal_value, group.group_id);
    }
  }

  // ── Detect Case B first ──────────────────────────────────────────────────
  // Case B: group was originally lookup-validated but user renamed it.
  //   from_lookup_chunk = true  AND  alias_name_source = 'user_override'
  // Original alias: the alias_name recorded in state.items for any
  //   matched_from_lookup item in this group.

  type RawCaseB = Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>;

  const caseBGroups: RawCaseB[] = [];
  // Track (group_id, original_alias) for Case A exclusion below.
  const caseBOriginalByGroupId = new Map<number, string>();

  for (const group of state.groups) {
    if (!group.from_lookup_chunk || group.alias_name_source !== 'user_override') continue;

    // Find original alias from the first lookup-matched item in this group.
    let originalAlias: string | null = null;
    for (const gi of group.items) {
      const si = itemByLiteral.get(gi.literal_value);
      if (si?.matched_from_lookup && si.alias_name) {
        originalAlias = si.alias_name;
        break;
      }
    }
    if (!originalAlias) continue;  // no matched items — can't determine original
    if (originalAlias === group.alias_name) continue;  // name unchanged

    caseBGroups.push({
      group_id:            group.group_id,
      original_alias_name: originalAlias,
      user_changed_to:     group.alias_name,
      group_items:         group.items,
    });
    caseBOriginalByGroupId.set(group.group_id, originalAlias);
  }

  // ── Detect Case A ────────────────────────────────────────────────────────
  // Case A: item has a preexisting lookup match (matched_from_lookup = true,
  //   alias_name set) but is now in a group with a DIFFERENT alias_name.
  //   Exclude items whose discrepancy is fully explained by a Case B rename
  //   of the group they currently belong to.

  const caseAItems: CaseAItem[] = [];

  for (const si of state.items) {
    if (!si.matched_from_lookup || !si.alias_name) continue;

    const currentGroupId = groupIdByLiteral.get(si.literal_value);
    if (currentGroupId === undefined) continue;  // item is in ungrouped — skip

    const currentGroup = groupByLiteral.get(currentGroupId);
    if (!currentGroup) continue;

    if (currentGroup.alias_name === si.alias_name) continue;  // name matches, no change

    // Check if this discrepancy is a Case B rename (group was renamed from si.alias_name).
    const caseBOriginal = caseBOriginalByGroupId.get(currentGroupId);
    if (caseBOriginal === si.alias_name) continue;  // explained by Case B rename — skip

    caseAItems.push({
      literal_value:       si.literal_value,
      original_alias_name: si.alias_name,
      user_moved_to:       currentGroup.alias_name,
    });
  }

  return { caseAItems, caseBGroups };
}

// ---------------------------------------------------------------------------
// Step 3 — fetch representative context for Case B groups
// ---------------------------------------------------------------------------

async function fetchCaseBContext(
  connection: any,
  runId:      number,
  state:      OpRunState,
  rawCaseBGroups: Omit<CaseBGroup, 'alias_exact_literal' | 'prior_lookup_literal' | 'current_new_literal' | 'prior_other_literal' | 'total_known_literals'>[],
): Promise<CaseBGroup[]> {
  const result: CaseBGroup[] = [];
  const currentRunLiterals = new Set(state.items.map((it) => it.literal_value));
  const itemByLiteral = new Map<string, OpStateItem>(state.items.map((it) => [it.literal_value, it]));

  for (const raw of rawCaseBGroups) {
    const groupItemLiterals = new Set(raw.group_items.map((gi) => gi.literal_value));

    // 1. Literal value in one_prompt_literal_alias_matches where literal_value = original_alias_name.
    const exactRows = await exec(
      connection,
      `SELECT literal_value FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
       WHERE alias_name = ? AND literal_value = ? LIMIT 1`,
      [raw.original_alias_name, raw.original_alias_name],
    );
    const alias_exact_literal =
      exactRows.length > 0
        ? String((exactRows[0] as any).LITERAL_VALUE ?? (exactRows[0] as any).literal_value ?? '')
        : null;

    // 2. One literal from this run that WAS a preexisting lookup match for this group.
    const prior_lookup_literal =
      raw.group_items.find((gi) => {
        const si = itemByLiteral.get(gi.literal_value);
        return si?.matched_from_lookup === true;
      })?.literal_value ?? null;

    // 3. One literal from this run that was NOT a preexisting lookup match.
    const current_new_literal =
      raw.group_items.find((gi) => {
        const si = itemByLiteral.get(gi.literal_value);
        return si?.matched_from_lookup === false;
      })?.literal_value ?? null;

    // 4. One literal from one_prompt_literal_alias_matches for this alias that is
    //    NOT in the current run at all.
    const allKnownRows = await exec(
      connection,
      `SELECT literal_value, COUNT(*) AS total
       FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
       WHERE alias_name = ?
       GROUP BY literal_value`,
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
// Step 4 — build validation prompt and call LLM
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
// Step 5 — apply validation decisions
// ---------------------------------------------------------------------------

async function applyValidationDecisions(
  connection:  any,
  runId:       number,
  caseAItems:  CaseAItem[],
  caseBGroups: CaseBGroup[],
  decisions:   ValidationResponse,
): Promise<void> {
  // ── Case A decisions ──────────────────────────────────────────────────────
  for (const decision of decisions.case_a ?? []) {
    const item = caseAItems.find((a) => a.literal_value === decision.lv);
    if (!item) continue;

    if (decision.k === 'o') {
      // Revert: put the literal back to its original alias.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
         SET alias_name = ?, confirmed_at = CURRENT_TIMESTAMP()
         WHERE literal_value = ?`,
        [item.original_alias_name, item.literal_value],
      );
      // Decrement the group alias that was incorrectly used.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES
         SET usage_count = GREATEST(0, usage_count - 1), last_used_at = CURRENT_TIMESTAMP()
         WHERE alias_name = ?`,
        [item.user_moved_to],
      );
      // Increment the original alias.
      await upsertApprovedAlias(connection, item.original_alias_name);
    }
    // k = 'u': record from Step 2 is already correct — no action needed.

    // Log the decision.
    await exec(
      connection,
      `INSERT INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_VALIDATION_LOG
         (literal_value, run_id, original_alias_name, user_changed_to, llm_decision, decided_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [item.literal_value, runId, item.original_alias_name, item.user_moved_to,
       decision.k === 'u' ? 'user' : 'original'],
    );
  }

  // ── Case B decisions ──────────────────────────────────────────────────────
  for (const decision of decisions.case_b ?? []) {
    const group = caseBGroups.find(
      (b) => b.original_alias_name === decision.original_alias && b.user_changed_to === decision.new_alias,
    );
    if (!group) continue;

    if (decision.k === 'o') {
      // Revert: put all run items back to original alias.
      for (const gi of group.group_items) {
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
           SET alias_name = ?, confirmed_at = CURRENT_TIMESTAMP()
           WHERE literal_value = ?`,
          [group.original_alias_name, gi.literal_value],
        );
      }
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES
         SET usage_count = GREATEST(0, usage_count - 1), last_used_at = CURRENT_TIMESTAMP()
         WHERE alias_name = ?`,
        [group.user_changed_to],
      );
      await upsertApprovedAlias(connection, group.original_alias_name);

    } else if (decision.k === 'u' && decision.apply_to_all) {
      // Apply globally: rename ALL literals mapped to original_alias to new_alias.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
         SET alias_name = ?, confirmed_at = CURRENT_TIMESTAMP()
         WHERE alias_name = ?`,
        [group.user_changed_to, group.original_alias_name],
      );
      // Carry forward the original's usage_count into the new alias.
      const origRows = await exec(
        connection,
        `SELECT usage_count FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES
         WHERE alias_name = ?`,
        [group.original_alias_name],
      );
      const origCount = Number((origRows[0] as any)?.USAGE_COUNT ?? (origRows[0] as any)?.usage_count ?? 0);

      await exec(
        connection,
        `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES AS t
         USING (SELECT ? AS alias_name, ? AS extra_count) AS s
           ON t.alias_name = s.alias_name
         WHEN MATCHED THEN UPDATE SET
           t.usage_count  = t.usage_count + s.extra_count,
           t.last_used_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (alias_name, usage_count, last_used_at)
           VALUES (s.alias_name, s.extra_count, CURRENT_TIMESTAMP())`,
        [group.user_changed_to, origCount],
      );
      // Zero out (not delete) the original alias.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES
         SET usage_count = 0
         WHERE alias_name = ?`,
        [group.original_alias_name],
      );

    }
    // k = 'u' AND apply_to_all = false: run items already correct from Step 2.
    // Both alias names remain in approved names. No further action.

    // Log one entry per affected literal value.
    for (const gi of group.group_items) {
      await exec(
        connection,
        `INSERT INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_VALIDATION_LOG
           (literal_value, run_id, original_alias_name, user_changed_to, llm_decision, decided_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
        [gi.literal_value, runId, group.original_alias_name, group.user_changed_to,
         decision.k === 'u' ? 'user' : 'original'],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Background validation pass (Steps 3–5)  — creates its own DB connection
// ---------------------------------------------------------------------------

async function runValidationPass(
  runId:  number,
  state:  OpRunState,
  apiKey: string,
): Promise<void> {
  const { caseAItems, caseBGroups: rawCaseBGroups } = detectCases(state);

  if (caseAItems.length === 0 && rawCaseBGroups.length === 0) {
    console.log(`[op-export] Run ${runId}: no validation cases detected.`);
    return;
  }

  await withSnowflake(async (connection) => {
    const caseBGroups = await fetchCaseBContext(connection, runId, state, rawCaseBGroups);

    const userTurn = buildValidationUserTurn(caseAItems, caseBGroups);
    const rawText  = await callValidationLLM(apiKey, userTurn);
    const decisions = tryParseJson<ValidationResponse>(rawText);

    if (!decisions) {
      console.error(`[op-export] Run ${runId}: failed to parse validation LLM response.\nRaw: ${rawText.slice(0, 800)}`);
      return;
    }

    await applyValidationDecisions(connection, runId, caseAItems, caseBGroups, decisions);

    const aCount = (decisions.case_a ?? []).length;
    const bCount = (decisions.case_b ?? []).length;
    console.log(`[op-export] Run ${runId}: validation complete — ${aCount} Case A, ${bCount} Case B decisions applied.`);
  });
}

// ---------------------------------------------------------------------------
// Main export entry point
// ---------------------------------------------------------------------------

export async function runOpExport(
  connection: any,
  runId:      number,
  apiKey:     string,
): Promise<ExportResult> {
  // Step 1 — read state blob.
  const state = await loadOpRunState(connection, runId);
  if (!state) throw new Error(`[op-export] No state found for run_id=${runId}`);

  // Step 2 — write all alias matches + approved names + mark run complete.
  const result = await writeExportData(connection, runId, state);

  // Steps 3–5 — fire and forget.  The connection used here is already closing
  // after this function returns; the validation pass opens its own connection.
  runValidationPass(runId, state, apiKey).catch((err) => {
    console.error(`[op-export] Background validation failed for run ${runId}:`, err);
  });

  return result;
}
