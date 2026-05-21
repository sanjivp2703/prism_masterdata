/**
 * POST /api/one-prompt/runs/[run_id]/auto-group
 *
 * Runs the one-prompt grouping pipeline on the ungrouped items in
 * ONE_PROMPT_RUN_STATE. All results are written back to that state blob.
 * RUN_GROUPS and RUN_ITEMS are no longer touched.
 *
 * Request body (JSON, optional):
 *   run_item_ids  number[]  Explicit list of run_item_ids to cluster.
 *                           When omitted, all currently-ungrouped items are used.
 */

import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
  type OpStateItem,
  type OpGroupItem,
} from '@/app/api/_lib/op-auto-group';
import { runOnePromptGrouping, writeOnePromptBreakdown } from '@/app/api/_lib/llm-one-prompt-grouping';
import { pickBestAliasName } from '@/app/api/_lib/namescore';
import type { RunItemForPairing } from '@/app/api/_lib/pairscore';

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

function buildGroupDisplayNames(
  groups: Array<{ temp_group_id: number; member_ids: number[] }>,
  runItemsById: Map<number, RunItemForPairing>,
): Map<number, string> {
  const names = new Map<number, string>();
  groups.forEach((g, idx) => {
    const members = g.member_ids
      .map((id) => runItemsById.get(id))
      .filter((m): m is RunItemForPairing => m != null);
    const best = pickBestAliasName(members);
    names.set(g.temp_group_id, best.literal_value || `Group ${idx + 1}`);
  });
  return names;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const runId = Number(run_id);
  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });
  }

  let requestedIds: number[] | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body?.run_item_ids) && body.run_item_ids.length > 0) {
      requestedIds = (body.run_item_ids as unknown[])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch { /* ignore */ }

  try {
    return await withSnowflake(async (connection) => {
      // Verify run exists.
      const runRows = await exec(
        connection,
        `SELECT run_id FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS WHERE run_id = ? LIMIT 1`,
        [runId],
      );
      if (!runRows.length) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }

      // Load state (must exist — seeded at run creation).
      const state = await loadOpRunState(connection, runId);
      if (!state) {
        return Response.json(
          { error: 'Run state not found. Re-create the run to initialize state.' },
          { status: 400 },
        );
      }

      // Fetch concept info for the LLM prompt.
      const conceptRows = await exec(
        connection,
        `SELECT c.concept_key, COALESCE(c.description, '') AS concept_description
         FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS r
         JOIN STAND_DB.STAND_INTERNAL.CONCEPTS c ON c.concept_id = r.concept_id
         WHERE r.run_id = ?`,
        [runId],
      );
      const conceptName = conceptRows.length > 0
        ? String((conceptRows[0] as any).CONCEPT_KEY ?? '')
        : '';
      const conceptDef  = conceptRows.length > 0
        ? String((conceptRows[0] as any).CONCEPT_DESCRIPTION ?? '')
        : '';

      // Determine which items to process.
      let itemsToProcess: OpStateItem[];
      if (requestedIds && requestedIds.length > 0) {
        const requestedSet = new Set(requestedIds);
        itemsToProcess = state.items.filter(
          (it) => it.run_item_id != null && requestedSet.has(it.run_item_id),
        );
      } else {
        // Default: all items not currently in any group.
        const groupedLiterals = new Set(
          state.groups.flatMap((g) => g.items.map((gi) => gi.literal_value)),
        );
        itemsToProcess = state.items.filter(
          (it) => !groupedLiterals.has(it.literal_value),
        );
      }

      if (itemsToProcess.length === 0) {
        return Response.json({
          data: {
            run_id:             runId,
            groups_created:     0,
            items_committed:    0,
            lookup_matched:     0,
            llm_grouped:        0,
            llm_elapsed_ms:     0,
            estimated_cost_usd: 0,
            chunk_count:        0,
          },
        });
      }

      // ── Lookup pass ───────────────────────────────────────────────────────────
      const literals = itemsToProcess.map((it) => it.literal_value);
      const lookupMap = new Map<string, string>();
      if (literals.length > 0) {
        const placeholders = literals.map(() => '?').join(', ');
        const lookupRows = await exec(
          connection,
          `SELECT literal_value, alias_name
           FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
           WHERE literal_value IN (${placeholders})`,
          literals,
        );
        for (const row of lookupRows) {
          const lv = String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? '');
          const an = String((row as any).ALIAS_NAME    ?? (row as any).alias_name    ?? '');
          if (lv && an) lookupMap.set(lv, an);
        }
      }

      const matchedItems   = itemsToProcess.filter((it) =>  lookupMap.has(it.literal_value));
      const unmatchedItems = itemsToProcess.filter((it) => !lookupMap.has(it.literal_value));

      // ── LLM grouping for unmatched items ───────────────────────────────────
      let llmElapsedMs  = 0;
      let estimatedCost = 0;
      let chunkCount    = 0;

      // Groups being added to state in this call.
      // Map: alias_name → { items, from_lookup }
      const pendingGroupMap = new Map<string, { items: OpGroupItem[]; from_lookup: boolean }>();

      // Collect lookup-matched groups.
      for (const item of matchedItems) {
        const alias = lookupMap.get(item.literal_value)!;
        const entry = pendingGroupMap.get(alias) ?? { items: [], from_lookup: true };
        entry.items.push({ literal_value: item.literal_value, matched_from_lookup: true });
        pendingGroupMap.set(alias, entry);
      }

      // Collect LLM groups.
      const ungroupedFromLLM: string[] = [];
      if (unmatchedItems.length > 0) {
        // Build RunItemForPairing from state items (no token data available).
        const runItems: RunItemForPairing[] = unmatchedItems.map((it) => ({
          run_item_id:         it.run_item_id ?? 0,
          literal_value:       it.literal_value,
          cleaned_value:       null,
          normalization_value: null,
          std_tokens:          [],
          norm_tokens:         [],
        }));

        const onePromptResult = await runOnePromptGrouping(runItems, conceptName, conceptDef);
        llmElapsedMs  = onePromptResult.llm_elapsed_ms;
        estimatedCost = onePromptResult.estimated_cost_usd;
        chunkCount    = onePromptResult.chunk_count;

        // Write diagnostic JSON.
        onePromptResult.breakdown.meta.run_id = runId;
        onePromptResult.breakdown.meta.lookup_matched = matchedItems.length;
        writeOnePromptBreakdown(runId, onePromptResult.breakdown);

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

          // If another pending group already has this alias name, merge into it.
          const existing = pendingGroupMap.get(displayName);
          if (existing) {
            existing.items.push(...items);
          } else {
            pendingGroupMap.set(displayName, { items, from_lookup: false });
          }
        }

        // Items the LLM left unassigned.
        for (const id of onePromptResult.unassigned_ids ?? []) {
          const ri = runItemsById.get(id);
          if (ri) ungroupedFromLLM.push(ri.literal_value);
        }
      }

      // ── Assign group_ids and build new state ───────────────────────────────
      const existingMaxGroupId = Math.max(0, ...state.groups.map((g) => g.group_id));
      let nextGroupId = existingMaxGroupId + 1;

      const newGroups = [...pendingGroupMap.entries()].map(([aliasName, info]) => ({
        group_id:          nextGroupId++,
        alias_name:        aliasName,
        alias_name_source: (info.from_lookup ? 'lookup_validated' : 'llm_proposed') as
          'lookup_validated' | 'llm_proposed',
        confidence:        'h' as const,
        from_lookup_chunk: info.from_lookup,
        items:             info.items,
      }));

      // Update the items array to reflect lookup flags.
      const updatedItems = state.items.map((item) => {
        const alias = lookupMap.get(item.literal_value);
        return alias !== undefined
          ? { ...item, matched_from_lookup: true, alias_name: alias }
          : item;
      });

      // Items that were processed but ended up ungrouped.
      const processedLiterals = new Set(itemsToProcess.map((it) => it.literal_value));
      const groupedLiterals   = new Set(newGroups.flatMap((g) => g.items.map((gi) => gi.literal_value)));

      const newUngrouped = [
        // Keep existing ungrouped items that weren't in this batch.
        ...state.ungrouped.filter((u) => !processedLiterals.has(u.literal_value)),
        // Items the LLM left ungrouped.
        ...ungroupedFromLLM
          .filter((lv) => !groupedLiterals.has(lv))
          .map((lv) => ({
            literal_value:       lv,
            matched_from_lookup: false,
          })),
      ];

      const newState: OpRunState = {
        status:    'running',
        items:     updatedItems,
        groups:    [...state.groups, ...newGroups],
        ungrouped: newUngrouped,
      };

      await saveOpRunState(connection, runId, newState);

      return Response.json({
        data: {
          run_id:             runId,
          groups_created:     newGroups.length,
          items_committed:    itemsToProcess.length - ungroupedFromLLM.length,
          lookup_matched:     matchedItems.length,
          llm_grouped:        unmatchedItems.length,
          llm_elapsed_ms:     llmElapsedMs,
          estimated_cost_usd: estimatedCost,
          chunk_count:        chunkCount,
        },
      }, { status: 200 });
    });
  } catch (error) {
    console.error(`[one-prompt] Auto-group error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Auto-grouping failed');
  }
}
