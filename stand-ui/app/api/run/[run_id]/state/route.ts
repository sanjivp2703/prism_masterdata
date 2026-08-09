/**
 * GET  /api/run/[run_id]/state
 *   Fetch the full state blob for a run. Called on page load to hydrate the UI
 *   and by the client to refetch after a save conflict. One query, no joins.
 *
 * PUT  /api/run/[run_id]/state
 *   Optimistic-concurrency save. Body: { state: <full blob>, expectedRev: number }.
 *   The blob carries an integer `rev` field (missing = 0). The UPDATE only lands
 *   when the stored rev still equals expectedRev; on conflict the route returns
 *   409 { error: 'conflict', currentRev } so the client can refetch and rebase.
 *   Success returns 200 { rev: expectedRev + 1 }.
 *   Does not touch the run status column.
 */

import { warehouseErrorResponse, withWarehouse } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import {
  loadOpRunState,
  saveOpRunStateWithRev,
  type OpRunState,
} from '@/app/api/_lib/op-auto-group';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { run_id } = await params;
  const runId = Number(run_id);
  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  try {
    return await withWarehouse(async (connection) => {
      const state = await loadOpRunState(runId);
      if (!state) {
        return Response.json({ error: `No state found for run ${runId}` }, { status: 404 });
      }
      // `data` kept for existing hydrate callers; `state` for refetch-on-conflict.
      return Response.json({ data: state, state }, { status: 200 });
    });
  } catch (error) {
    console.error(`[state] GET error for run ${runId}:`, error);
    return warehouseErrorResponse(error, 'Failed to load run state');
  }
}

export async function PUT(
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

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  // New contract: { state, expectedRev }. Legacy fallback: the body IS the blob
  // (expectedRev then comes from the blob's own rev, defaulting to 0).
  let state: OpRunState | null = null;
  let expectedRev = 0;
  if (body && typeof body === 'object' && body.state && typeof body.state === 'object') {
    state       = body.state as OpRunState;
    expectedRev = Number.isFinite(Number(body.expectedRev)) ? Number(body.expectedRev) : Number(state.rev ?? 0);
  } else if (body && typeof body === 'object' && Array.isArray(body.items) && Array.isArray(body.groups)) {
    state       = body as OpRunState;
    expectedRev = Number(state.rev ?? 0);
  }

  if (!state) {
    return Response.json(
      { error: 'Body must be { state: <blob>, expectedRev: number }' },
      { status: 400 },
    );
  }
  if (!Number.isFinite(expectedRev) || expectedRev < 0) expectedRev = 0;

  try {
    return await withWarehouse(async (connection) => {
      const saved = await saveOpRunStateWithRev(runId, state!, expectedRev);
      if (saved) {
        return Response.json({ data: { saved: true }, rev: expectedRev + 1 }, { status: 200 });
      }

      // 0 rows updated: either a rev conflict or the run doesn't exist.
      const current = await loadOpRunState(runId);
      if (!current) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }
      return Response.json(
        { error: 'conflict', currentRev: Number(current.rev ?? 0) },
        { status: 409 },
      );
    });
  } catch (error) {
    console.error(`[state] PUT error for run ${runId}:`, error);
    return warehouseErrorResponse(error, 'Failed to save run state');
  }
}
