/**
 * Shared auto-grouping logic (lookup + one-prompt LLM).
 * Used by the run auto-group API route and the hourly pipeline processor.
 */

import 'server-only';

import {
  loadOpRunState,
  saveOpRunState,
  saveOpRunStateWithRev,
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

/**
 * Backfill missing run_item_ids with sequential unique ids so legacy blobs
 * (items without run_item_id) don't all collapse to id 0 and drop items.
 * Prefers index+1; falls back to the next free id on collision. Mutates the
 * items in place so the caller can persist them back into the blob.
 */
function ensureRunItemIds(items: OpStateItem[]): void {
  const used = new Set<number>();
  for (const it of items) {
    if (typeof it.run_item_id === 'number' && it.run_item_id > 0) used.add(it.run_item_id);
  }
  let next = used.size > 0 ? Math.max(...used) + 1 : 1;
  items.forEach((it, idx) => {
    if (typeof it.run_item_id === 'number' && it.run_item_id > 0) return;
    const candidate = idx + 1;
    if (!used.has(candidate)) {
      it.run_item_id = candidate;
      used.add(candidate);
    } else {
      while (used.has(next)) next++;
      it.run_item_id = next;
      used.add(next);
      next++;
    }
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

  // Backfill missing run_item_ids (legacy blobs) with stable sequential ids;
  // persisted back into the blob on save so they stay stable across passes.
  ensureRunItemIds(state.items);

  const alreadyGroupedLiterals = new Set(
    state.groups.flatMap((g) => g.items.map((gi) => gi.literal_value)),
  );

  let itemsToProcess: OpStateItem[];
  if (options.runItemIds && options.runItemIds.length > 0) {
    const requestedSet = new Set(options.runItemIds);
    // Exclude items whose literal already sits in an existing group — otherwise
    // a targeted re-group duplicates the literal into a second group.
    itemsToProcess = state.items.filter(
      (it) => it.run_item_id != null
           && requestedSet.has(it.run_item_id)
           && !alreadyGroupedLiterals.has(it.literal_value),
    );
  } else {
    itemsToProcess = state.items.filter(
      (it) => !alreadyGroupedLiterals.has(it.literal_value),
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

  type Conf = 'h' | 'm' | 'l';
  const CONF_RANK: Record<Conf, number> = { h: 3, m: 2, l: 1 };
  const worseConf = (a: Conf, b: Conf): Conf => (CONF_RANK[a] <= CONF_RANK[b] ? a : b);
  const bandFromScore = (s: number): Conf => (s >= 0.85 ? 'h' : s >= 0.55 ? 'm' : 'l');

  const pendingGroupMap = new Map<string, { items: OpGroupItem[]; from_lookup: boolean; confidence: Conf }>();
  // Normalized display-name → pendingGroupMap key, so an LLM group whose name
  // normalizes equal to a lookup group's merges INTO the lookup group (the
  // lookup alias_name always wins) instead of creating a case-variant duplicate.
  const normNameIndex = new Map<string, string>();

  const addToPendingGroup = (
    displayName: string,
    items:       OpGroupItem[],
    fromLookup:  boolean,
    confidence:  Conf,
  ): void => {
    const normKey     = normalizeLiteral(displayName) || displayName;
    const existingKey = normNameIndex.get(normKey);
    if (existingKey !== undefined) {
      const entry = pendingGroupMap.get(existingKey)!;
      entry.items.push(...items);
      // Lookup groups keep 'h'; LLM-LLM merges keep the worse confidence.
      if (!entry.from_lookup) entry.confidence = worseConf(entry.confidence, confidence);
      return;
    }
    pendingGroupMap.set(displayName, { items: [...items], from_lookup: fromLookup, confidence });
    normNameIndex.set(normKey, displayName);
  };

  for (const item of matchedItems) {
    const alias = lookupMap.get(normalizeLiteral(item.literal_value))!;
    addToPendingGroup(alias, [{ literal_value: item.literal_value, matched_from_lookup: true }], true, 'h');
  }

  const ungroupedFromLLM: string[] = [];
  const llmFailedLiterals: string[] = [];
  if (unmatchedItems.length > 0) {
    const runItems: RunItemForPairing[] = unmatchedItems.map((it) => ({
      run_item_id:         it.run_item_id!,
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
    const approvedAliasNames = existingAliasRows
      .map((r) => String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '').trim())
      .filter(Boolean);

    // Include this run's lookup-group alias names so the merge/grouping prompts
    // treat them as protected canonical names (lookup names always win) even if
    // they fall outside the top-200 usage window.
    const lookupAliasNames  = Array.from(new Set(lookupMap.values()));
    const existingAliasNames = Array.from(new Set([...lookupAliasNames, ...approvedAliasNames]));

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

      // Group confidence = band of the members' LLM confidence scores
      // (the 'h|m|l' from the chunk output), not a hardcoded 'h'.
      const memberScores = group.member_ids
        .map((id) => onePromptResult.confidence_scores.get(id))
        .filter((s): s is number => typeof s === 'number');
      const avgScore = memberScores.length > 0
        ? memberScores.reduce((a, b) => a + b, 0) / memberScores.length
        : 0.5;

      addToPendingGroup(displayName, items, false, bandFromScore(avgScore));
    }

    for (const id of onePromptResult.unassigned_ids ?? []) {
      const ri = runItemsById.get(id);
      if (ri) ungroupedFromLLM.push(ri.literal_value);
    }

    // Items whose chunk LLM call failed even after retries — honest fallback
    // singletons ('llm_failed', confidence 'l', needs_review), never normal groups.
    for (const id of onePromptResult.failed_ids ?? []) {
      const ri = runItemsById.get(id);
      if (ri) llmFailedLiterals.push(ri.literal_value);
    }
  }

  // Group specs — group_ids are assigned at persist time against the FRESH blob
  // so concurrent writers can't produce colliding ids.
  type GroupSpec = Omit<OpGroup, 'group_id'>;
  const newGroupSpecs: GroupSpec[] = [...pendingGroupMap.entries()].map(([aliasName, info]) => ({
    alias_name:        aliasName,
    alias_name_source: info.from_lookup ? ('lookup_validated' as const) : ('llm_proposed' as const),
    // Lookup groups stay 'h'; LLM groups carry the LLM's own confidence band.
    confidence:        info.from_lookup ? ('h' as const) : info.confidence,
    from_lookup_chunk: info.from_lookup,
    items:             info.items,
  }));

  const specLiterals = new Set(newGroupSpecs.flatMap((g) => g.items.map((gi) => gi.literal_value)));

  // Items whose chunk LLM call FAILED (even after retries): honest fallback
  // singletons — self-mapped, confidence 'l', needs_review, source 'llm_failed'.
  // Never presented as confident groupings.
  for (const lv of llmFailedLiterals) {
    if (specLiterals.has(lv)) continue;
    specLiterals.add(lv);
    newGroupSpecs.push({
      alias_name:        lv,
      alias_name_source: 'llm_failed',
      confidence:        'l',
      from_lookup_chunk: false,
      needs_review:      true,
      items:             [{ literal_value: lv, matched_from_lookup: false }],
    });
  }

  // Items the LLM couldn't confidently place become their OWN singleton group,
  // self-mapped (canonical = the raw value) and flagged needs_review. This keeps
  // EVERY processed value written to the lookup — nothing is left ungrouped and
  // unmapped — so a freshly committed pipeline starts with an empty queue, while
  // these still surface in yellow for the user to confirm or rename.
  for (const lv of ungroupedFromLLM) {
    if (specLiterals.has(lv)) continue;
    specLiterals.add(lv);
    newGroupSpecs.push({
      alias_name:        lv,
      alias_name_source: 'llm_proposed',
      confidence:        'l',
      from_lookup_chunk: false,
      needs_review:      true,
      items:             [{ literal_value: lv, matched_from_lookup: false }],
    });
  }

  const processedLiterals = new Set(itemsToProcess.map((it) => it.literal_value));

  // ── Rev-safe persist ───────────────────────────────────────────────────────
  // Re-load the current blob immediately before writing and apply this pass's
  // changes (groups / ungrouped / status / lookup item annotations) to the FRESH
  // blob, then save guarded on the blob's rev. Retry once on conflict; as a last
  // resort force-write the rebased state so the (paid) LLM result isn't dropped.
  const buildMergedState = (fresh: OpRunState): { merged: OpRunState; appended: number } => {
    ensureRunItemIds(fresh.items);

    const freshGrouped = new Set(fresh.groups.flatMap((g) => g.items.map((gi) => gi.literal_value)));
    let nextGroupId = Math.max(0, ...fresh.groups.map((g) => g.group_id)) + 1;
    const appendGroups: OpGroup[] = [];
    for (const spec of newGroupSpecs) {
      // Skip literals that landed in a group since we started (e.g. user drag).
      const itemsLeft = spec.items.filter((gi) => !freshGrouped.has(gi.literal_value));
      if (itemsLeft.length === 0) continue;
      for (const gi of itemsLeft) freshGrouped.add(gi.literal_value);
      appendGroups.push({ ...spec, group_id: nextGroupId++, items: itemsLeft });
    }

    const updatedItems = fresh.items.map((item) => {
      const alias = lookupMap.get(normalizeLiteral(item.literal_value));
      return alias !== undefined
        ? { ...item, matched_from_lookup: true, alias_name: alias }
        : item;
    });

    // Only previously-ungrouped items that weren't reprocessed this pass stay
    // ungrouped; everything processed now lives in a group (real or singleton).
    const newUngrouped = fresh.ungrouped.filter(
      (u) => !processedLiterals.has(u.literal_value) && !freshGrouped.has(u.literal_value),
    );

    return {
      merged: {
        ...fresh,
        status:    'running',
        items:     updatedItems,
        groups:    [...fresh.groups, ...appendGroups],
        ungrouped: newUngrouped,
      },
      appended: appendGroups.length,
    };
  };

  let persisted: { merged: OpRunState; appended: number } | null = null;
  for (let attempt = 0; attempt < 2 && !persisted; attempt++) {
    const fresh = (await loadOpRunState(connection, runId)) ?? state;
    const built = buildMergedState(fresh);
    const saved = await saveOpRunStateWithRev(connection, runId, built.merged, Number(fresh.rev ?? 0));
    if (saved) {
      persisted = built;
    } else {
      console.warn(`[op-auto-group-run] Run ${runId}: state rev conflict while saving auto-group result (attempt ${attempt + 1}) — rebasing.`);
    }
  }
  if (!persisted) {
    const fresh = (await loadOpRunState(connection, runId)) ?? state;
    const built = buildMergedState(fresh);
    console.warn(`[op-auto-group-run] Run ${runId}: rev conflict persisted after retry — force-saving rebased state.`);
    await saveOpRunState(connection, runId, { ...built.merged, rev: Number(fresh.rev ?? 0) + 1 });
    persisted = built;
  }

  return {
    // Every processed item now lands in a group (real or self-mapped singleton).
    groups_created:     persisted.appended,
    items_committed:    itemsToProcess.length,
    lookup_matched:     matchedItems.length,
    llm_grouped:        unmatchedItems.length,
    llm_elapsed_ms:     llmElapsedMs,
    estimated_cost_usd: estimatedCost,
    chunk_count:        chunkCount,
    ungrouped_literals: persisted.merged.ungrouped.map((u) => u.literal_value),
  };
}
