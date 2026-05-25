/**
 * POST /api/pipelines/[pipeline_id]/create-initial-run
 *
 * Premium only. Creates a review run for the pipeline's initial baseline
 * mapping so the user can inspect and adjust groupings before accepting.
 *
 *   1. Fetch all distinct non-null values from the source column (up to 5 000).
 *   2. Create a run via createRunFromQueue and run auto-group for LLM suggestions.
 *   3. Return { run_id } — the caller navigates to /run/:run_id for review.
 *
 * Contrast with process-queue, which auto-exports without user review.
 * If the source table is empty the pipeline is advanced directly to 'paused'
 * and { run_id: null } is returned so the UI can skip the review step.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import {
  fetchPipelineById,
  createRunFromQueue,
  type PipelineForProcessing,
} from '@/app/api/_lib/pipeline-hourly-processor';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';

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
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const literals = await withSnowflake((conn) => fetchSourceLiterals(conn, pipeline));

    // Empty source table — advance directly to paused, no run needed.
    if (literals.length === 0) {
      await withSnowflake(async (conn) => {
        await exec(conn, `
          UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
          SET status              = 'paused',
              last_queue_empty_at = CURRENT_TIMESTAMP(),
              updated_at          = CURRENT_TIMESTAMP()
          WHERE pipeline_id = ? AND status = 'pending_baseline'
        `, [pid]);
      });
      return Response.json({ run_id: null, message: 'No values found in source table — pipeline is ready.' });
    }

    // Create run and run auto-group for initial suggestions.
    const runId = await withSnowflake(async (conn) => {
      const id = await createRunFromQueue(conn, pipeline, literals);
      await runAutoGroupForRun(conn, id, apiKey, { writeBreakdown: false });
      return id;
    });

    return Response.json({ run_id: runId });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create initial mapping run');
  }
}
