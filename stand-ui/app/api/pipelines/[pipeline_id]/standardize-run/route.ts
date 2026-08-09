/**
 * POST /api/pipelines/[pipeline_id]/standardize-run
 *
 * Premium only. Builds a REVIEW run from a pipeline's current PIPELINE_QUEUE so
 * the user can inspect/adjust the proposed groupings on the mappings page before
 * accepting. Used by pipelines that aren't updating automatically right now
 * (manual-only or outside their update window): the poller exports new values
 * raw and queues them; this turns the queued (new) values into a reviewable run.
 *
 *   1. Fetch the pipeline's queued literals (with their accumulated frequencies).
 *   2. Create a run via createRunFromQueue and auto-group for LLM suggestions.
 *   3. Return { run_id } — the caller navigates to /run/:run_id for review.
 *
 * Contrast with create-initial-run (scans the full source) and process-queue
 * (drains the queue without review). If the queue is empty, returns { run_id: null }.
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import { llmErrorResponse } from '@/app/api/_lib/llm-one-prompt-grouping';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
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
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return Response.json({ error: 'No Anthropic API key configured — add one on the setup page.' }, { status: 500 });
  }

  try {
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const runId = await withWarehouse(async (conn) => {
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
    // Classify AI-provider failures BEFORE the warehouse sanitizer, which is
    // tuned for Snowflake/SQL Server shapes and would discard the provider's
    // own actionable message (rate-limit retry hints, rejected-key detail).
    // This is the user-facing "Update Standardizations" button, so a quota
    // error surfacing as a bare "Failed to create standardization run" gives
    // the owner nothing to act on. Matches create-initial-run, one-time/create
    // and propose-groupings, which already do this; this route was the only
    // LLM-triggering path still missing it (LLM-04).
    const llmResp = llmErrorResponse(err);
    if (llmResp) return llmResp;
    return warehouseErrorResponse(err, 'Failed to create standardization run');
  }
}
