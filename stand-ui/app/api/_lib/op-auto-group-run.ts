/**
 * Shared auto-grouping logic (lookup + one-prompt LLM).
 * Used by the run auto-group API route and the hourly pipeline processor.
 */

import 'server-only';

import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
  type OpStateItem,
  type OpGroupItem,
  type OpGroup,
} from './op-auto-group';
import { runOnePromptGrouping, writeOnePromptBreakdown, type NamingConvention } from './llm-one-prompt-grouping';
import { sanitizeConventionRules, hasAnyRule } from './convention-rules';
import { appendTiming } from './timing';

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
import { pickBestAliasName } from './namescore';
import { normalizeLiteral } from './normalize';
import type { RunItemForPairing } from './grouping-types';

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      },
    });
  });
}

function buildGroupDisplayNames(
  groups: Array<{ temp_group_id: string; member_ids: number[]; proposed_name?: string | null }>,
  runItemsById: Map<number, RunItemForPairing>,
): Map<string, string> {
  const names = new Map<string, string>();
  groups.forEach((g, idx) => {
    // Prefer the LLM's real-world canonical name (world knowledge). Fall back to
    // a representative input value only when the LLM didn't propose one — e.g.
    // safety-net singletons or an unidentifiable entity.
    const proposed = (g.proposed_name ?? '').trim();
    if (proposed) {
      names.set(g.temp_group_id, proposed);
      return;
    }
    const members = g.member_ids
      .map((id) => runItemsById.get(id))
      .filter((m): m is RunItemForPairing => m != null);
    const best = pickBestAliasName(members);
    names.set(g.temp_group_id, best.literal_value || `Group ${idx + 1}`);
  });
  return names;
}

export interface AutoGroupResult {
  groups_created:     number;
  items_committed:    number;
  lookup_matched:     number;
  llm_grouped:        number;
  llm_elapsed_ms:     number;
  estimated_cost_usd: number;
  chunk_count:        number;
  ungrouped_literals: string[];
}

export interface AutoGroupOptions {
  /** Process only these run_item_ids; default = all currently ungrouped items. */
  runItemIds?:      number[];
  /** Write one_prompt_breakdown_run_*.json (default true). */
  writeBreakdown?:  boolean;
}

/**
 * Runs lookup + LLM grouping on ungrouped items and persists the updated state blob.
 */
export async function runAutoGroupForRun(
  connection: any,
  runId:      number,
  apiKey:     string,
  options:    AutoGroupOptions = {},
): Promise<AutoGroupResult> {
  const state = await loadOpRunState(connection, runId);
  if (!state) {
    throw new Error(`Run state not found for run_id=${runId}.`);
  }

  const conceptRows = await exec(
    connection,
    `SELECT concept_key, domain_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
    [runId],
  );
  const conceptKeyName = conceptRows.length > 0
    ? String((conceptRows[0] as any).CONCEPT_KEY ?? (conceptRows[0] as any).concept_key ?? '')
    : '';
  const runDomainId: number | null =
    conceptRows.length > 0
      ? (Number((conceptRows[0] as any).DOMAIN_ID ?? (conceptRows[0] as any).domain_id) || null)
      : null;

  // Naming convention + description + standardization rules for this domain.
  let namingConvention: NamingConvention | null = null;
  let effectiveConceptName = conceptKeyName;
  let effectiveConceptDef  = '';
  let standardizationRules: string[] | null = null;

  if (runDomainId != null) {
    const convRows = await exec(
      connection,
      `SELECT name, description, standardization_rules, convention_type, convention_value, convention_rules
       FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
      [runDomainId],
    );
    if (convRows.length > 0) {
      const domainName = String((convRows[0] as any).NAME ?? (convRows[0] as any).name ?? '').trim();
      const domainDesc = String((convRows[0] as any).DESCRIPTION ?? (convRows[0] as any).description ?? '').trim();
      const stdRulesRaw = (convRows[0] as any).STANDARDIZATION_RULES ?? (convRows[0] as any).standardization_rules ?? null;

      if (!effectiveConceptName && domainName) effectiveConceptName = domainName;
      if (domainDesc) effectiveConceptDef = domainDesc;

      if (stdRulesRaw) {
        const parsed = safeJsonParse(typeof stdRulesRaw === 'string' ? stdRulesRaw : JSON.stringify(stdRulesRaw));
        if (Array.isArray(parsed)) {
          standardizationRules = (parsed as unknown[]).map(String).filter(Boolean);
          if (standardizationRules.length === 0) standardizationRules = null;
        }
      }

      const ct = String((convRows[0] as any).CONVENTION_TYPE ?? (convRows[0] as any).convention_type ?? '').toLowerCase();
      const cv = String((convRows[0] as any).CONVENTION_VALUE ?? (convRows[0] as any).convention_value ?? '');
      const crRaw = (convRows[0] as any).CONVENTION_RULES ?? (convRows[0] as any).convention_rules ?? null;
      const rules = crRaw ? sanitizeConventionRules(typeof crRaw === 'string' ? safeJsonParse(crRaw) : crRaw) : null;
      const type = (ct === 'regex' || ct === 'examples' || ct === 'natural') && cv.trim() ? ct : null;
      if (type || (rules && hasAnyRule(rules))) {
        namingConvention = { type, value: cv, rules: rules && hasAnyRule(rules) ? rules : null };
      }
    }
  }

  let itemsToProcess: OpStateItem[];
  if (options.runItemIds && options.runItemIds.length > 0) {
    const requestedSet = new Set(options.runItemIds);
    itemsToProcess = state.items.filter(
      (it) => it.run_item_id != null && requestedSet.has(it.run_item_id),
    );
  } else {
    const groupedLiterals = new Set(
      state.groups.flatMap((g) => g.items.map((gi) => gi.literal_value)),
    );
    itemsToProcess = state.items.filter(
      (it) => !groupedLiterals.has(it.literal_value),
    );
  }

  if (itemsToProcess.length === 0) {
    return {
      groups_created:     0,
      items_committed:    0,
      lookup_matched:     0,
      llm_grouped:        0,
      llm_elapsed_ms:     0,
      estimated_cost_usd: 0,
      chunk_count:        0,
      ungrouped_literals: state.ungrouped.map((u) => u.literal_value),
    };
  }

  const literals = itemsToProcess.map((it) => it.literal_value);
  // Keyed by the normalized form so casing/whitespace/Unicode variants resolve
  // to the same stored mapping; look up with normalizeLiteral(literal).
  const lookupMap = new Map<string, string>();
  const _lookupStart = Date.now();
  if (literals.length > 0) {
    const normLiterals = Array.from(new Set(literals.map(normalizeLiteral))).filter(Boolean);
    if (normLiterals.length > 0) {
      const placeholders = normLiterals.map(() => '?').join(', ');
      const domainFilter = runDomainId != null
        ? `AND lam.domain_id = ${Number(runDomainId)}`
        : `AND lam.domain_id IS NULL`;
      const lookupRows = await exec(
        connection,
        `SELECT lam.normalized_value AS norm_key, aan.alias_name
         FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
         JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
           ON lam.alias_id = aan.alias_id
         WHERE lam.normalized_value IN (${placeholders})
           ${domainFilter}`,
        normLiterals,
      );
      for (const row of lookupRows) {
        const key = String((row as any).NORM_KEY   ?? (row as any).norm_key   ?? '');
        const an  = String((row as any).ALIAS_NAME ?? (row as any).alias_name ?? '');
        if (key && an) lookupMap.set(key, an);
      }
    }
  }
  appendTiming(`[Timing] autogroup.lookup_pass: ${Date.now() - _lookupStart}ms (${literals.length} item(s))`);

  const matchedItems   = itemsToProcess.filter((it) =>  lookupMap.has(normalizeLiteral(it.literal_value)));
  const unmatchedItems = itemsToProcess.filter((it) => !lookupMap.has(normalizeLiteral(it.literal_value)));

  let llmElapsedMs  = 0;
  let estimatedCost = 0;
  let chunkCount    = 0;

  const pendingGroupMap = new Map<string, { items: OpGroupItem[]; from_lookup: boolean }>();

  for (const item of matchedItems) {
    const alias = lookupMap.get(normalizeLiteral(item.literal_value))!;
    const entry = pendingGroupMap.get(alias) ?? { items: [], from_lookup: true };
    entry.items.push({ literal_value: item.literal_value, matched_from_lookup: true });
    pendingGroupMap.set(alias, entry);
  }

  const ungroupedFromLLM: string[] = [];
  if (unmatchedItems.length > 0) {
    const runItems: RunItemForPairing[] = unmatchedItems.map((it) => ({
      run_item_id:         it.run_item_id ?? 0,
      literal_value:       it.literal_value,
      cleaned_value:       null,
      normalization_value: null,
      std_tokens:          [],
      norm_tokens:         [],
    }));

    // Existing approved alias names for this domain — handed to the LLM so it
    // reuses an already-confirmed canonical name verbatim when a group matches
    // one, instead of coining a near-duplicate. Ordered by usage and capped to
    // bound the prompt size.
    const aliasFilter = runDomainId != null
      ? `WHERE domain_id = ${Number(runDomainId)}`
      : `WHERE domain_id IS NULL`;
    const existingAliasRows = await exec(
      connection,
      `SELECT alias_name FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
       ${aliasFilter}
       ORDER BY usage_count DESC NULLS LAST, last_used_at DESC NULLS LAST
       LIMIT 200`,
    );
    const existingAliasNames = existingAliasRows
      .map((r) => String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '').trim())
      .filter(Boolean);

    const _groupStart = Date.now();
    const onePromptResult = await runOnePromptGrouping(runItems, effectiveConceptName, effectiveConceptDef, existingAliasNames, namingConvention, standardizationRules);
    appendTiming(`[Timing] autogroup.runOnePromptGrouping: ${Date.now() - _groupStart}ms (${runItems.length} unmatched item(s))`);
    llmElapsedMs  = onePromptResult.llm_elapsed_ms;
    estimatedCost = onePromptResult.estimated_cost_usd;
    chunkCount    = onePromptResult.chunk_count;

    if (options.writeBreakdown !== false) {
      onePromptResult.breakdown.meta.run_id = runId;
      onePromptResult.breakdown.meta.lookup_matched = matchedItems.length;
      writeOnePromptBreakdown(runId, onePromptResult.breakdown);
    }

    const runItemsById  = new Map(runItems.map((ri) => [ri.run_item_id, ri]));
    const orderedGroups = [
      ...onePromptResult.groups.filter((g) => !g.is_singleton),
      ...onePromptResult.groups.filter((g) =>  g.is_singleton),
    ];
    const groupNames = buildGroupDisplayNames(orderedGroups, runItemsById);

    for (const group of orderedGroups) {
      const displayName = groupNames.get(group.temp_group_id) ?? `Group`;
      const items: OpGroupItem[] = group.member_ids
        .map((id) => runItemsById.get(id))
        .filter((ri): ri is RunItemForPairing => ri != null)
        .map((ri) => ({ literal_value: ri.literal_value, matched_from_lookup: false }));

      if (items.length === 0) continue;

      const existing = pendingGroupMap.get(displayName);
      if (existing) {
        existing.items.push(...items);
      } else {
        pendingGroupMap.set(displayName, { items, from_lookup: false });
      }
    }

    for (const id of onePromptResult.unassigned_ids ?? []) {
      const ri = runItemsById.get(id);
      if (ri) ungroupedFromLLM.push(ri.literal_value);
    }
  }

  const existingMaxGroupId = Math.max(0, ...state.groups.map((g) => g.group_id));
  let nextGroupId = existingMaxGroupId + 1;

  const newGroups: OpGroup[] = [...pendingGroupMap.entries()].map(([aliasName, info]) => ({
    group_id:          nextGroupId++,
    alias_name:        aliasName,
    alias_name_source: (info.from_lookup ? 'lookup_validated' : 'llm_proposed') as
      'lookup_validated' | 'llm_proposed',
    confidence:        'h' as const,
    from_lookup_chunk: info.from_lookup,
    items:             info.items,
  }));

  // Items the LLM couldn't confidently place become their OWN singleton group,
  // self-mapped (canonical = the raw value) and flagged needs_review. This keeps
  // EVERY processed value written to the lookup — nothing is left ungrouped and
  // unmapped — so a freshly committed pipeline starts with an empty queue, while
  // these still surface in yellow for the user to confirm or rename.
  const groupedLiterals = new Set(newGroups.flatMap((g) => g.items.map((gi) => gi.literal_value)));
  for (const lv of ungroupedFromLLM) {
    if (groupedLiterals.has(lv)) continue;
    groupedLiterals.add(lv);
    newGroups.push({
      group_id:          nextGroupId++,
      alias_name:        lv,
      alias_name_source: 'llm_proposed',
      confidence:        'l',
      from_lookup_chunk: false,
      needs_review:      true,
      items:             [{ literal_value: lv, matched_from_lookup: false }],
    });
  }

  const updatedItems = state.items.map((item) => {
    const alias = lookupMap.get(normalizeLiteral(item.literal_value));
    return alias !== undefined
      ? { ...item, matched_from_lookup: true, alias_name: alias }
      : item;
  });

  const processedLiterals = new Set(itemsToProcess.map((it) => it.literal_value));

  // Only previously-ungrouped items that weren't reprocessed this pass stay
  // ungrouped; everything processed now lives in a group (real or singleton).
  const newUngrouped = state.ungrouped.filter((u) => !processedLiterals.has(u.literal_value));

  const newState: OpRunState = {
    status:    'running',
    items:     updatedItems,
    groups:    [...state.groups, ...newGroups],
    ungrouped: newUngrouped,
  };

  await saveOpRunState(connection, runId, newState);

  return {
    // Every processed item now lands in a group (real or self-mapped singleton).
    groups_created:     newGroups.length,
    items_committed:    itemsToProcess.length,
    lookup_matched:     matchedItems.length,
    llm_grouped:        unmatchedItems.length,
    llm_elapsed_ms:     llmElapsedMs,
    estimated_cost_usd: estimatedCost,
    chunk_count:        chunkCount,
    ungrouped_literals: newUngrouped.map((u) => u.literal_value),
  };
}
