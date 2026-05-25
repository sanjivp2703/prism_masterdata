/**
 * POST /api/run/[run_id]/auto-group
 *
 * Runs the grouping pipeline on the ungrouped items in the run state blob.
 * All results are written back to RUNS.state.
 *
 * Request body (JSON, optional):
 *   run_item_ids  number[]  Explicit list of run_item_ids to cluster.
 *                           When omitted, all currently-ungrouped items are used.
 */

import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';

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

  let requestedIds: number[] | undefined;
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
      const runRows = await exec(
        connection,
        `SELECT run_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ? LIMIT 1`,
        [runId],
      );
      if (!runRows.length) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }

      const result = await runAutoGroupForRun(connection, runId, apiKey, {
        runItemIds: requestedIds,
      });

      return Response.json({
        data: {
          run_id:             runId,
          groups_created:     result.groups_created,
          items_committed:    result.items_committed,
          lookup_matched:     result.lookup_matched,
          llm_grouped:        result.llm_grouped,
          llm_elapsed_ms:     result.llm_elapsed_ms,
          estimated_cost_usd: result.estimated_cost_usd,
          chunk_count:        result.chunk_count,
        },
      }, { status: 200 });
    });
  } catch (error) {
    console.error(`[auto-group] Error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Auto-grouping failed');
  }
}
