import { warehouseErrorResponse, withWarehouse } from '@/app/api/_lib/warehouse';
import { runOpExport } from '@/app/api/_lib/op-export';
import { appendTiming } from '@/app/api/_lib/timing';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
import { getDb } from '@/app/api/_lib/sqlite';
import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
} from '@/app/api/_lib/op-auto-group';

// Apply pending UI state changes (new groups, item moves, alias renames) to
// the state blob before running the export.
function applyStatePatch(
  state: OpRunState,
  newGroups:        Array<{ temp_group_id: number; alias_name_literal_value: string }>,
  moves:            Array<{ run_item_id: number; group_id: number | null }>,
  aliasNameChanges: Array<{ group_id: number; alias_name_literal_value: string }>,
): OpRunState {
  let groups    = state.groups.map((g) => ({ ...g, items: [...g.items] }));
  let ungrouped = [...state.ungrouped];
  const items   = state.items;

  // 1. Create new groups (client uses negative temp IDs).
  const tempToReal = new Map<number, number>();
  let nextGroupId = Math.max(0, ...groups.map((g) => g.group_id)) + 1;
  for (const ng of newGroups) {
    const realId = nextGroupId++;
    tempToReal.set(ng.temp_group_id, realId);
    groups.push({
      group_id:          realId,
      alias_name:        ng.alias_name_literal_value,
      alias_name_source: 'user_override',
      confidence:        'h',
      from_lookup_chunk: false,
      items:             [],
    });
  }

  // 2. Apply item moves.
  for (const mv of moves) {
    const targetGroupId = typeof mv.group_id === 'number' && mv.group_id < 0
      ? tempToReal.get(mv.group_id) ?? null
      : mv.group_id;

    // Find the item's literal_value from the flat items list.
    const item = items.find((it) => it.run_item_id === mv.run_item_id);
    if (!item) continue;
    const { literal_value } = item;

    // Remove from current group or ungrouped.
    for (const g of groups) {
      g.items = g.items.filter((gi) => gi.literal_value !== literal_value);
    }
    ungrouped = ungrouped.filter((u) => u.literal_value !== literal_value);

    if (targetGroupId === null) {
      ungrouped.push({ literal_value, matched_from_lookup: item.matched_from_lookup });
    } else {
      const target = groups.find((g) => g.group_id === targetGroupId);
      if (target) {
        target.items.push({ literal_value, matched_from_lookup: item.matched_from_lookup });
      }
    }
  }

  // 3. Rename groups.
  for (const chg of aliasNameChanges) {
    const g = groups.find((gr) => gr.group_id === chg.group_id);
    if (g) {
      g.alias_name = chg.alias_name_literal_value;
      g.alias_name_source = 'user_override';
    }
  }

  // Drop empty groups created by moves.
  groups = groups.filter((g) => g.items.length > 0);

  return { ...state, groups, ungrouped };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { run_id } = await params;
  const runId = Number(run_id);

  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return Response.json(
      { error: 'No Anthropic API key configured — add one on the setup page.' },
      { status: 500 },
    );
  }

  // Parse optional state-patch body.
  let newGroups:        Array<{ temp_group_id: number; alias_name_literal_value: string }> = [];
  let moves:            Array<{ run_item_id: number; group_id: number | null }> = [];
  let aliasNameChanges: Array<{ group_id: number; alias_name_literal_value: string }> = [];
  // When true, block the response until the lookup writes + export rebuild +
  // metric refresh are committed (used by the pipeline-creation wizard so it
  // doesn't open the pipelines view before standardization finishes).
  let waitForWrite = false;
  // When true (premium review wizard), DON'T write to the lookup here — just
  // persist the reviewed state and mark the run approved. The slow lookup upserts
  // are deferred to the "Begin Pipeline Standardization" step (commit endpoint).
  let deferWrite = false;
  try {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body?.new_groups))          newGroups        = body.new_groups;
    if (Array.isArray(body?.moves))               moves            = body.moves;
    if (Array.isArray(body?.alias_name_changes))  aliasNameChanges = body.alias_name_changes;
    if (body?.wait === true)                      waitForWrite     = true;
    if (body?.defer === true)                     deferWrite       = true;
  } catch { /* no body — fire-and-forget callers */ }

  try {
    return await withWarehouse(async (connection) => {
      const runRowDb = getDb().prepare(`SELECT run_status FROM runs WHERE run_id = ?`).get(runId) as any;
      if (!runRowDb) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }
      const runStatus = String(runRowDb.run_status ?? '').toLowerCase();

      // Apply any pending UI state changes before exporting.
      const hasPatch = newGroups.length > 0 || moves.length > 0 || aliasNameChanges.length > 0;
      if (hasPatch) {
        const state = await loadOpRunState(runId);
        if (state) {
          const patched = applyStatePatch(state, newGroups, moves, aliasNameChanges);
          await saveOpRunState(runId, patched);
        }
      }

      // ── Deferred mode: persist the approval, write nothing to the lookup ──────
      // The lookup upserts (the slow part) happen later at the "Begin Pipeline
      // Standardization" step via the commit-standardizations endpoint. Here we
      // just mark the run approved and return its pipeline so the activation card
      // can drive the commit. The pipeline stays pending_baseline (hidden from the
      // pipelines list) until Begin commits + activates it.
      if (deferWrite) {
        getDb()
          .prepare(`UPDATE runs SET run_status = 'approved', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id = ?`)
          .run(runId);
        const pipelineRow = getDb()
          .prepare(
            `SELECT p.pipeline_id
             FROM pipelines p
             JOIN runs r ON r.run_id = ?
             WHERE p.table_fqn = r.source_relation
               AND p.column_name = r.source_column
               AND ((p.domain_id IS NULL AND r.domain_id IS NULL) OR p.domain_id = r.domain_id)
             LIMIT 1`,
          )
          .get(runId) as any;
        const pid = pipelineRow
          ? Number(pipelineRow.pipeline_id)
          : null;
        return Response.json({ deferred: true, pipeline_id: pid }, { status: 200 });
      }

      const _acceptStart = Date.now();
      const result = await runOpExport(connection, runId, apiKey, runStatus, { awaitWrite: waitForWrite });
      appendTiming(`[Timing] accept.runOpExport_TOTAL: ${Date.now() - _acceptStart}ms (run ${runId}, awaitWrite=${waitForWrite})`);

      // Clear the queue for the matching pipeline (look up by source + domain).
      //
      // Guarded on `already_in_progress`: if no write pass ran on this call the
      // mappings were NOT (re)written, so emptying PIPELINE_QUEUE and advancing
      // pending_baseline -> paused would discard the queued values and mark the
      // pipeline ready on the strength of an export that never happened. That
      // is exactly what made a 'failed' run unrecoverable before KI-202 — the
      // retry returned success-shaped counts and the queue was cleared anyway.
      if (result.already_in_progress) {
        console.warn(
          `[export] run ${runId}: no write pass ran on this call (run was already ` +
          `'validating' or 'completed') — leaving PIPELINE_QUEUE and pipeline status untouched.`,
        );
      } else {
       try {
        const pipelineRow = getDb()
          .prepare(
            `SELECT p.pipeline_id
             FROM pipelines p
             JOIN runs r ON r.run_id = ?
             WHERE p.table_fqn = r.source_relation
               AND p.column_name = r.source_column
               AND ((p.domain_id IS NULL AND r.domain_id IS NULL) OR p.domain_id = r.domain_id)
             LIMIT 1`,
          )
          .get(runId) as any;
        if (pipelineRow) {
          const pid = Number(pipelineRow.pipeline_id);

          // Second copy of the same destructive pattern as the one removed from
          // commit-standardizations — see KI-101. The blanket queue DELETE and
          // hard `queue_size = 0` destroyed values that were never part of this
          // run; runOpExport (called just above) already removes exactly the
          // literals it wrote and recomputes queue_size from a real COUNT(*).
          //
          // Advance pipeline from pending_baseline → paused so it's ready to
          // activate. The user explicitly starts polling from the activation
          // card on the home page. Queue counters are left to runOpExport.
          getDb()
            .prepare(
              `UPDATE pipelines
               SET status     = CASE WHEN status = 'pending_baseline' THEN 'paused' ELSE status END,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE pipeline_id = ?`,
            )
            .run(pid);

          // Export table refresh is handled inside runWriteAndValidatePass (op-export.ts)
          // AFTER the literal writes commit — not here, where the writes are still in flight.

          return Response.json({ data: result, pipeline_id: pid }, { status: 200 });
        }
       } catch (qErr) {
        console.warn(`[export] Could not clear pipeline queue for run ${runId}:`, qErr);
       }
      }

      return Response.json({ data: result }, { status: 200 });
    });
  } catch (error) {
    console.error(`[export] Error for run ${runId}:`, error);
    return warehouseErrorResponse(error, 'Export failed');
  }
}
