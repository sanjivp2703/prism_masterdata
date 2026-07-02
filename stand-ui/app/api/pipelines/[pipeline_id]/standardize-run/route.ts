/**
 * POST /api/pipelines/[pipeline_id]/standardize-run
 *
 * Premium only. Builds a REVIEW run from a pipeline's current PIPELINE_QUEUE so
 * the user can inspect/adjust the proposed groupings on the mappings page before
 * accepting. Used by manual-mode pipelines: the poller exports new values raw and
 * queues them; this turns the queued (new) values into a reviewable run.
 *
 *   1. Fetch the pipeline's queued literals (with their accumulated frequencies).
 *   2. Create a run via createRunFromQueue and auto-group for LLM suggestions.
 *   3. Return { run_id } — the caller navigates to /run/:run_id for review.
 *
 * Contrast with create-initial-run (scans the full source) and process-queue
 * (drains the queue without review). If the queue is empty, returns { run_id: null }.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import {
  fetchPipelineById,
  fetchQueueLiteralsWithFreq,
} from '@/app/api/_lib/pipeline-hourly-processor';
import { createRunFromQueue } from '@/app/api/_lib/pipeline-hourly-processor';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';

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

    const runId = await withSnowflake(async (conn) => {
      const queued = await fetchQueueLiteralsWithFreq(conn, pid);
      if (queued.length === 0) return null;

      const literals    = queued.map(q => q.literal_value);
      const frequencies = new Map(queued.map(q => [q.literal_value, q.source_frequency]));

      const id = await createRunFromQueue(conn, pipeline, literals, frequencies);
      await runAutoGroupForRun(conn, id, apiKey, { writeBreakdown: false });
      return id;
    });

    if (runId == null) {
      return Response.json({ run_id: null, message: 'Queue is empty — nothing to standardize.' });
    }
    return Response.json({ run_id: runId });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create standardization run');
  }
}
