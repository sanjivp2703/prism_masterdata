/**
 * POST /api/one-time/[run_id]/group
 *
 * Runs LLM grouping (no lookup) over the run's items, applying its optional
 * naming convention, and returns the grouped mappings. Idempotent enough to
 * re-run — it regroups from the items each time.
 */

import { warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';
import { groupOneTimeRun } from '@/app/api/_lib/op-one-time';

export async function POST(_request: Request, { params }: { params: Promise<{ run_id: string }> }) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  if (!getAnthropicApiKey()) {
    return Response.json({ error: 'LLM grouping is not configured — add an Anthropic API key on the setup page.' }, { status: 503 });
  }

  const { run_id } = await params;
  const runId = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runId)) return Response.json({ error: 'Invalid run_id' }, { status: 400 });

  try {
    {
      const ownRow = getDb()
        .prepare(
          `SELECT source_column FROM runs
           WHERE run_id = ? AND run_type = 'one_time' AND created_by = ?`,
        )
        .get(runId, Number(session.accountId));
      if (!ownRow) return Response.json({ error: 'Not found' }, { status: 404 });

      await groupOneTimeRun(null, runId);
      const state = await loadOpRunState(runId);
      const groups = (state?.groups ?? []).map((g) => ({
        group_id:     g.group_id,
        alias_name:   g.alias_name,
        confidence:   g.confidence,
        needs_review: g.needs_review === true,
        items:        g.items.map((it) => ({ literal_value: it.literal_value })),
      }));
      return Response.json({
        run_id: runId,
        source_column: String((ownRow as any)?.source_column ?? ''),
        grouped: true,
        accepted: false,
        groups,
      });
    }
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to group one-time run');
  }
}
