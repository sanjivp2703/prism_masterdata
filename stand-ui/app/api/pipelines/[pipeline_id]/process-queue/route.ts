/**
 * POST /api/pipelines/[pipeline_id]/process-queue
 *
 * Premium only.  On-demand bulk standardization.  Handles two modes:
 *
 *   pending_baseline  — fetches all distinct non-null values directly from the
 *                       source Snowflake column, runs the full auto-group + LLM
 *                       pipeline, exports results to the lookup tables, then
 *                       advances the pipeline from pending_baseline → paused.
 *
 *   active | paused   — drains the current PIPELINE_QUEUE through the same
 *                       auto-group + LLM + export pipeline, then removes
 *                       successfully processed items from the queue.
 *
 * In both cases the standardized export table is rebuilt fire-and-forget if
 * the pipeline has export_table_fqn configured.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import {
  fetchPipelineById,
  fetchQueueLiterals,
  bulkProcessPipelineQueue,
  type PipelineForProcessing,
} from '@/app/api/_lib/pipeline-hourly-processor';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

/** Fetch all distinct non-null values from the pipeline's source column. */
async function fetchSourceLiterals(
  conn: any,
  pipeline: PipelineForProcessing,
): Promise<string[]> {
  const parts = pipeline.table_fqn.split('.');
  if (parts.length !== 3) return [];
  const tableRef = parts.map(p => quoteIdent(p.trim())).join('.');
  const colRef   = quoteIdent(pipeline.column_name);

  const rows = await exec(conn, `
    SELECT DISTINCT ${colRef} AS val
    FROM ${tableRef}
    WHERE ${colRef} IS NOT NULL
    LIMIT 5000
  `);
  return rows.map((r: any) => String(r.VAL ?? r.val ?? '')).filter(Boolean);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore = await cookies();
  const session     = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const modeBlocked = premiumModeGuard();
  if (modeBlocked) return modeBlocked;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });
  }

  try {
    // ── Fetch pipeline ───────────────────────────────────────────────────────
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const isInitial = pipeline.status === 'pending_baseline';

    // ── Collect literals to process ──────────────────────────────────────────
    const literals = await withSnowflake(async (conn) => {
      if (isInitial) {
        return fetchSourceLiterals(conn, pipeline);
      }
      return fetchQueueLiterals(conn, pid);
    });

    if (literals.length === 0) {
      // Nothing to do — for initial pipelines still advance the status.
      if (isInitial) {
        await withSnowflake(async (conn) => {
          await exec(conn, `
            UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
            SET status              = 'paused',
                last_queue_empty_at = CURRENT_TIMESTAMP(),
                updated_at          = CURRENT_TIMESTAMP()
            WHERE pipeline_id = ? AND status = 'pending_baseline'
          `, [pid]);
        });
      }
      return Response.json({
        ok: true,
        items_written: 0,
        literals_processed: 0,
        message: isInitial ? 'No values found in source table.' : 'Queue is empty.',
      });
    }

    // ── Run auto-group + LLM + direct export ─────────────────────────────────
    const result = await bulkProcessPipelineQueue(pipeline, literals, apiKey);

    // ── Update pipeline state ────────────────────────────────────────────────
    await withSnowflake(async (conn) => {
      if (isInitial) {
        // Advance pending_baseline → paused.
        await exec(conn, `
          UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
          SET status              = 'paused',
              total_new_values    = ?,
              queue_size          = 0,
              last_queue_empty_at = CURRENT_TIMESTAMP(),
              updated_at          = CURRENT_TIMESTAMP()
          WHERE pipeline_id = ?
        `, [result.literals_processed, pid]);
      } else {
        // Remove successfully exported items from the queue.
        if (result.exported_literals.length > 0) {
          const ph = result.exported_literals.map(() => '?').join(',');
          await exec(
            conn,
            `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
             WHERE pipeline_id = ? AND literal_value IN (${ph})`,
            [pid, ...result.exported_literals],
          );
        }

        // Update queue_size and last_queue_empty_at.
        const countRows = await exec(
          conn,
          `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
          [pid],
        );
        const queueSize = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);
        const setClauses = ['queue_size = ?', 'updated_at = CURRENT_TIMESTAMP()'];
        const binds: any[] = [queueSize];
        if (queueSize === 0) setClauses.push('last_queue_empty_at = CURRENT_TIMESTAMP()');
        binds.push(pid);
        await exec(
          conn,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES SET ${setClauses.join(', ')} WHERE pipeline_id = ?`,
          binds,
        );
      }
    });

    // Export table refresh is handled inside runOpExportDirect after writes commit.

    return Response.json({
      ok:                 true,
      run_id:             result.run_id,
      groups_created:     result.groups_created,
      items_written:      result.items_written,
      lookup_matched:     result.lookup_matched,
      llm_grouped:        result.llm_grouped,
      literals_processed: result.literals_processed,
      pipeline_advanced:  isInitial,
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to process pipeline queue');
  }
}
