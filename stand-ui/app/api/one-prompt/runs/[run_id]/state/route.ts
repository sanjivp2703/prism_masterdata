/**
 * GET  /api/one-prompt/runs/[run_id]/state
 *   Fetch the full state blob for a run. Called on page load to hydrate the UI.
 *   One query, no joins.
 *
 * PUT  /api/one-prompt/runs/[run_id]/state
 *   Replace the state blob with the client's current in-memory state.
 *   Called by a debounced timer every 30 s (if unsaved changes exist) and
 *   immediately via beforeunload. Does not touch the run status column.
 */

import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { loadOpRunState, saveOpRunState, type OpRunState } from '@/app/api/_lib/op-auto-group';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const runId = Number(run_id);
  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (connection) => {
      const state = await loadOpRunState(connection, runId);
      if (!state) {
        return Response.json({ error: `No state found for run ${runId}` }, { status: 404 });
      }
      return Response.json({ data: state }, { status: 200 });
    });
  } catch (error) {
    console.error(`[one-prompt] GET state error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Failed to load run state');
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const runId = Number(run_id);
  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  let state: OpRunState;
  try {
    state = await request.json() as OpRunState;
  } catch {
    return Response.json({ error: 'Request body must be a valid JSON state blob' }, { status: 400 });
  }

  if (!state || typeof state !== 'object') {
    return Response.json({ error: 'State must be an object' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (connection) => {
      await saveOpRunState(connection, runId, state);
      return Response.json({ data: { saved: true } }, { status: 200 });
    });
  } catch (error) {
    console.error(`[one-prompt] PUT state error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Failed to save run state');
  }
}
