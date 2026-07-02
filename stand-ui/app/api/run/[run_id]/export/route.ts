import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { runOpExport } from '@/app/api/_lib/op-export';
import { appendTiming } from '@/app/api/_lib/timing';
import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
} from '@/app/api/_lib/op-auto-group';

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
  const { run_id } = await params;
  const runId = Number(run_id);

  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
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
    return await withSnowflake(async (connection) => {
      const runRows = await exec(
        connection,
        `SELECT run_status FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
        [runId],
      );

      if (!runRows.length) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }

      const runStatus = String(
        (runRows[0] as any).RUN_STATUS ?? (runRows[0] as any).run_status ?? '',
      ).toLowerCase();

      // Apply any pending UI state changes before exporting.
      const hasPatch = newGroups.length > 0 || moves.length > 0 || aliasNameChanges.length > 0;
      if (hasPatch) {
        const state = await loadOpRunState(connection, runId);
        if (state) {
          const patched = applyStatePatch(state, newGroups, moves, aliasNameChanges);
          await saveOpRunState(connection, runId, patched);
        }
      }

      // ── Deferred mode: persist the approval, write nothing to the lookup ──────
      // The lookup upserts (the slow part) happen later at the "Begin Pipeline
      // Standardization" step via the commit-standardizations endpoint. Here we
      // just mark the run approved and return its pipeline so the activation card
      // can drive the commit. The pipeline stays pending_baseline (hidden from the
      // pipelines list) until Begin commits + activates it.
      if (deferWrite) {
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
          [runId],
        );
        const pipelineRows = await exec(
          connection,
          `SELECT p.pipeline_id
           FROM STAND_DB.STAND_INTERNAL.PIPELINES p
           JOIN STAND_DB.STAND_INTERNAL.RUNS r ON r.run_id = ?
           WHERE p.table_fqn = r.source_relation
             AND (
               -- Sheets: one pipeline per tab stores all columns; match by table_fqn only.
               p.source_type = 'sheets'
               OR (
                 p.column_name = r.source_column
                 AND ((p.domain_id IS NULL AND r.domain_id IS NULL) OR p.domain_id = r.domain_id)
               )
             )
           LIMIT 1`,
          [runId],
        );
        const pid = pipelineRows.length
          ? Number((pipelineRows[0] as any).PIPELINE_ID ?? (pipelineRows[0] as any).pipeline_id)
          : null;
        return Response.json({ deferred: true, pipeline_id: pid }, { status: 200 });
      }

      const _acceptStart = Date.now();
      const result = await runOpExport(connection, runId, apiKey, runStatus, { awaitWrite: waitForWrite });
      appendTiming(`[Timing] accept.runOpExport_TOTAL: ${Date.now() - _acceptStart}ms (run ${runId}, awaitWrite=${waitForWrite})`);

      // Clear the queue for the matching pipeline (look up by source + domain)
      try {
        const pipelineRows = await exec(
          connection,
          `SELECT p.pipeline_id
           FROM STAND_DB.STAND_INTERNAL.PIPELINES p
           JOIN STAND_DB.STAND_INTERNAL.RUNS r ON r.run_id = ?
           WHERE p.table_fqn = r.source_relation
             AND (
               p.source_type = 'sheets'
               OR (
                 p.column_name = r.source_column
                 AND ((p.domain_id IS NULL AND r.domain_id IS NULL) OR p.domain_id = r.domain_id)
               )
             )
           LIMIT 1`,
          [runId],
        );
        if (pipelineRows.length > 0) {
          const pr  = pipelineRows[0] as any;
          const pid = Number(pr.PIPELINE_ID ?? pr.pipeline_id);

          await exec(
            connection,
            `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
            [pid],
          );
          // Advance pipeline from pending_baseline → paused so it's ready to activate.
          // The user explicitly starts polling from the activation card on the home page.
          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
             SET status              = CASE WHEN status = 'pending_baseline' THEN 'paused' ELSE status END,
                 queue_size          = 0,
                 last_queue_empty_at = CURRENT_TIMESTAMP(),
                 updated_at          = CURRENT_TIMESTAMP()
             WHERE pipeline_id = ?`,
            [pid],
          );

          // Export table refresh is handled inside runWriteAndValidatePass (op-export.ts)
          // AFTER the literal writes commit — not here, where the writes are still in flight.

          return Response.json({ data: result, pipeline_id: pid }, { status: 200 });
        }
      } catch (qErr) {
        console.warn(`[export] Could not clear pipeline queue for run ${runId}:`, qErr);
      }

      return Response.json({ data: result }, { status: 200 });
    });
  } catch (error) {
    console.error(`[export] Error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Export failed');
  }
}
