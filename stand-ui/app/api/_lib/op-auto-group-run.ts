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
import { getDb } from './sqlite';
import { runOnePromptGrouping, writeOnePromptBreakdown, fixNamesForConvention, type NamingConvention } from './llm-one-prompt-grouping';
import { sanitizeConventionRules, hasAnyRule, applyConventionRules, validateConventionViolations, conventionMatches} from './convention-rules';
import { compileSafeRegex } from './safe-regex';
import { appendTiming } from './timing';

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
import { pickBestAliasName } from './namescore';
import { normalizeLiteral } from './normalize';
import type { RunItemForPairing } from './grouping-types';
import { executeQuery as exec, getWarehouseAdapter } from './warehouse';

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
  const state = await loadOpRunState(runId);
  if (!state) {
    throw new Error(`Run state not found for run_id=${runId}.`);
  }

  const conceptRow = getDb()
    .prepare(`SELECT concept_key, source_column, domain_id FROM runs WHERE run_id = ?`)
    .get(runId) as any;
  const conceptKeyName = conceptRow ? String(conceptRow.concept_key ?? '') : '';
  const sourceColumn   = conceptRow ? String(conceptRow.source_column ?? '') : '';
  // The historical `domain_id` column now holds this run's per-column spec_id —
  // the lookup scope. See column-specs.ts / SQLite migration 011.
  const runDomainId: number | null = conceptRow
    ? (Number(conceptRow.domain_id) || null)
    : null;

  // Description + standardization rules + naming convention for this column, read
  // from its per-column spec (spec_id === the run's scope integer). The LLM
  // concept NAME is now the column name; the DEFINITION is the spec description.
  let namingConvention: NamingConvention | null = null;
  let effectiveConceptName = sourceColumn || conceptKeyName;
  let effectiveConceptDef  = '';
  let standardizationRules: string[] | null = null;

  if (runDomainId != null) {
    const specRow = getDb()
      .prepare(
        `SELECT description, standardization_rules, convention_type, convention_value, convention_rules
         FROM column_specs WHERE spec_id = ?`,
      )
      .get(runDomainId);
    const convRows = specRow ? [specRow] : [];
    if (convRows.length > 0) {
      const specDesc = String((convRows[0] as any).DESCRIPTION ?? (convRows[0] as any).description ?? '').trim();
      const stdRulesRaw = (convRows[0] as any).STANDARDIZATION_RULES ?? (convRows[0] as any).standardization_rules ?? null;

      if (specDesc) effectiveConceptDef = specDesc;

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
      const domainFilter = runDomainId != null
        ? `AND lam.domain_id = ${Number(runDomainId)}`
        : `AND lam.domain_id IS NULL`;
      // Batched under the adapter's bind budget (a 5k-value queue drain would
      // otherwise blow SQL Server's ~2.1k-parameter statement ceiling).
      const IN_BATCH = Math.max(100, getWarehouseAdapter().bindLimit - 100);
      for (let i = 0; i < normLiterals.length; i += IN_BATCH) {
        const batch = normLiterals.slice(i, i + IN_BATCH);
        const placeholders = batch.map(() => '?').join(', ');
        const lookupRows = await exec(
          connection,
          `SELECT lam.normalized_value AS norm_key, aan.alias_name
           FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES  lam
           JOIN PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES   aan
             ON lam.alias_id = aan.alias_id
           WHERE lam.normalized_value IN (${placeholders})
             ${domainFilter}`,
          batch,
        );
        for (const row of lookupRows) {
          const key = String((row as any).NORM_KEY   ?? (row as any).norm_key   ?? '');
          const an  = String((row as any).ALIAS_NAME ?? (row as any).alias_name ?? '');
          if (key && an) lookupMap.set(key, an);
        }
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

  // Every literal must land in exactly ONE group. The chunk LLM (or a merge that
  // concatenates member_ids) can emit the same member in two overlapping groups;
  // left unchecked that duplicates the value inside the persisted blob, which
  // then collides React keys and double-counts the value in review. First
  // placement wins; later duplicates (across groups OR within one group's batch)
  // are dropped here at the single assembly chokepoint.
  const placedLiterals = new Set<string>();
  const addToPendingGroup = (
    displayName: string,
    items:       OpGroupItem[],
    fromLookup:  boolean,
    confidence:  Conf,
  ): void => {
    const fresh: OpGroupItem[] = [];
    for (const it of items) {
      if (placedLiterals.has(it.literal_value)) continue;
      placedLiterals.add(it.literal_value);
      fresh.push(it);
    }
    if (fresh.length === 0) return;

    const normKey     = normalizeLiteral(displayName) || displayName;
    const existingKey = normNameIndex.get(normKey);
    if (existingKey !== undefined) {
      const entry = pendingGroupMap.get(existingKey)!;
      entry.items.push(...fresh);
      // Lookup groups keep 'h'; LLM-LLM merges keep the worse confidence.
      if (!entry.from_lookup) entry.confidence = worseConf(entry.confidence, confidence);
      return;
    }
    pendingGroupMap.set(displayName, { items: [...fresh], from_lookup: fromLookup, confidence });
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
    // T-SQL sorts NULLs lowest, so plain DESC already means NULLS LAST there.
    const existingAliasRows = await exec(
      connection,
      getWarehouseAdapter().kind === 'mssql'
        ? `SELECT TOP (200) alias_name FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES
           ${aliasFilter}
           ORDER BY usage_count DESC, last_used_at DESC`
        : `SELECT alias_name FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES
           ${aliasFilter}
           ORDER BY usage_count DESC NULLS LAST, last_used_at DESC NULLS LAST
           LIMIT 200`,
    );
    const approvedAliasNames = existingAliasRows
      .map((r) => String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '').trim())
      .filter(Boolean);

    // Retrieval slice: when the domain has MORE approved names than the top-200
    // usage window, also pull in approved names whose first word matches a first
    // word in this batch — the entities demonstrably in play. Without this, a
    // new variant of alias #201+ gets a freshly coined near-duplicate name.
    // Plain LOWER/SPLIT_PART (no UDF): this is a user-action path, and the
    // approximation only needs to be good enough for retrieval.
    if (existingAliasRows.length >= 200) {
      const batchFirstTokens = Array.from(new Set(
        unmatchedItems
          .map((it) => normalizeLiteral(it.literal_value).split(' ')[0])
          .filter((t) => t.length >= 2),
      )).slice(0, 300);
      if (batchFirstTokens.length > 0) {
        try {
          const tokenPlaceholders = batchFirstTokens.map(() => '?').join(', ');
          // First-word extraction: SPLIT_PART is Snowflake-only; T-SQL uses
          // LEFT + CHARINDEX (with a trailing-space sentinel for one-word names).
          const relatedRows = await exec(
            connection,
            getWarehouseAdapter().kind === 'mssql'
              ? `SELECT TOP (100) alias_name FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES
                 ${aliasFilter}
                   AND LOWER(LEFT(LTRIM(RTRIM(alias_name)), CHARINDEX(' ', LTRIM(RTRIM(alias_name)) + ' ') - 1)) IN (${tokenPlaceholders})
                 ORDER BY usage_count DESC`
              : `SELECT alias_name FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES
                 ${aliasFilter}
                   AND LOWER(SPLIT_PART(TRIM(alias_name), ' ', 1)) IN (${tokenPlaceholders})
                 ORDER BY usage_count DESC NULLS LAST
                 LIMIT 100`,
            batchFirstTokens,
          );
          for (const r of relatedRows) {
            const n = String((r as any).ALIAS_NAME ?? (r as any).alias_name ?? '').trim();
            if (n) approvedAliasNames.push(n);
          }
        } catch (e) {
          console.warn('[op-auto-group-run] related-alias retrieval failed (continuing with top-200 only):', e);
        }
      }
    }

    // Include this run's lookup-group alias names so the merge/grouping prompts
    // treat them as protected canonical names (lookup names always win) even if
    // they fall outside the top-200 usage window.
    const lookupAliasNames  = Array.from(new Set(lookupMap.values()));
    // Also include the run's OWN current group names — unexported, so invisible
    // to the DB queries above. Without these, a second grouping pass on the same
    // run (failed-export retry picking up new queue values, or a future partial
    // re-group) can coin a different name for an entity the first pass already
    // named ("Verizon Wireless" vs "Verizon"), splitting one entity in two.
    const inRunGroupNames = state.groups.map((g) => g.alias_name).filter(Boolean);
    const existingAliasNames = Array.from(new Set([...lookupAliasNames, ...inRunGroupNames, ...approvedAliasNames]));

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

  // ── Convention-compliant self-map names ────────────────────────────────────
  // Values the LLM couldn't place still ALWAYS become singleton groups (nothing
  // is ever left unmapped), but their alias names must respect the domain's
  // naming convention — a raw literal usually won't. Deterministic form rules
  // are applied first; names still violating the regex/constraints get one
  // batched LLM fix attempt (skipped for llm_failed literals — the API is
  // unhealthy right then). Anything still non-conforming keeps the deterministic
  // best-effort name and stays needs_review for the human.
  // RE2, not `new RegExp` — this pattern is user-authored and is matched against
  // raw source literals on the single Node thread, where a backtracking hang is
  // a whole-installation outage that cannot be interrupted. RE2 is linear-time.
  // Null (unsupported construct) means "cannot enforce", never "fall back to
  // the backtracking engine".
  const anchoredConventionRegex =
    namingConvention?.type === 'regex' && namingConvention.value.trim()
      ? compileSafeRegex(namingConvention.value)
      : null;
  const violatesConvention = (name: string): boolean => {
    if (!name) return true;
    // Length-capped match — see conventionMatches / MAX_CONVENTION_TEST_LEN.
    // `name` here can be a raw source literal, which has no length cap.
    if (anchoredConventionRegex && !conventionMatches(anchoredConventionRegex, name)) return true;
    return validateConventionViolations(name, namingConvention?.rules ?? null).length > 0;
  };
  const llmFailedSet   = new Set(llmFailedLiterals);
  const allSelfLiterals = [...new Set([...llmFailedLiterals, ...ungroupedFromLLM])];
  const selfMapNames = new Map<string, string>(); // literal → convention-adjusted alias name
  for (const lv of allSelfLiterals) {
    const name = namingConvention?.rules && hasAnyRule(namingConvention.rules)
      ? (applyConventionRules(lv, namingConvention.rules) || lv)
      : lv;
    selfMapNames.set(lv, name);
  }
  if (namingConvention) {
    const fixable = allSelfLiterals.filter(
      (lv) => !llmFailedSet.has(lv) && violatesConvention(selfMapNames.get(lv)!),
    );
    if (fixable.length > 0) {
      try {
        const fixes = await fixNamesForConvention(
          fixable.map((lv) => ({ id: lv, current: selfMapNames.get(lv)!, reps: [lv] })),
          namingConvention, effectiveConceptName, apiKey,
        );
        for (const [lv, fixed] of fixes) {
          if (!violatesConvention(fixed)) selfMapNames.set(lv, fixed);
        }
      } catch (e) {
        console.warn('[op-auto-group-run] convention name-fix for self-mapped singletons failed:', e);
      }
    }
  }

  // Self-mapped singletons: llm_failed = the chunk LLM call failed after retries
  // (honest fallback, never a confident group); llm_proposed = the LLM left the
  // item unassigned. Both confidence 'l' + needs_review. Literals whose
  // convention-adjusted names collide share one group (post-transform equals).
  const selfMapSpecByName = new Map<string, GroupSpec>();
  const addSelfMapSingleton = (lv: string, source: 'llm_failed' | 'llm_proposed'): void => {
    if (specLiterals.has(lv)) return;
    specLiterals.add(lv);
    const aliasName = selfMapNames.get(lv) ?? lv;
    const existing  = selfMapSpecByName.get(aliasName);
    if (existing) {
      existing.items.push({ literal_value: lv, matched_from_lookup: false });
      return;
    }
    const spec: GroupSpec = {
      alias_name:        aliasName,
      alias_name_source: source,
      confidence:        'l',
      from_lookup_chunk: false,
      needs_review:      true,
      items:             [{ literal_value: lv, matched_from_lookup: false }],
    };
    selfMapSpecByName.set(aliasName, spec);
    newGroupSpecs.push(spec);
  };
  for (const lv of llmFailedLiterals) addSelfMapSingleton(lv, 'llm_failed');
  for (const lv of ungroupedFromLLM)  addSelfMapSingleton(lv, 'llm_proposed');

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

    // Initial-standardization stamps for LLM-grouped items (Case C referee
    // baseline): record each item's first-proposed group alias/id/confidence.
    // Lookup groups are excluded — Case A already covers those.
    const initialByLiteral = new Map<string, { alias: string; gid: number; conf: 'h' | 'm' | 'l' }>();
    for (const g of appendGroups) {
      if (g.from_lookup_chunk) continue;
      for (const gi of g.items) {
        initialByLiteral.set(gi.literal_value, { alias: g.alias_name, gid: g.group_id, conf: g.confidence });
      }
    }

    const updatedItems = fresh.items.map((item) => {
      const alias = lookupMap.get(normalizeLiteral(item.literal_value));
      if (alias !== undefined) {
        return { ...item, matched_from_lookup: true, alias_name: alias };
      }
      const init = initialByLiteral.get(item.literal_value);
      if (init && item.initial_alias_name == null) {
        return {
          ...item,
          initial_alias_name: init.alias,
          initial_group_id:   init.gid,
          initial_confidence: init.conf,
        };
      }
      return item;
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
    const fresh = (await loadOpRunState(runId)) ?? state;
    const built = buildMergedState(fresh);
    const saved = await saveOpRunStateWithRev(runId, built.merged, Number(fresh.rev ?? 0));
    if (saved) {
      persisted = built;
    } else {
      console.warn(`[op-auto-group-run] Run ${runId}: state rev conflict while saving auto-group result (attempt ${attempt + 1}) — rebasing.`);
    }
  }
  if (!persisted) {
    const fresh = (await loadOpRunState(runId)) ?? state;
    const built = buildMergedState(fresh);
    console.warn(`[op-auto-group-run] Run ${runId}: rev conflict persisted after retry — force-saving rebased state.`);
    await saveOpRunState(runId, { ...built.merged, rev: Number(fresh.rev ?? 0) + 1 });
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
