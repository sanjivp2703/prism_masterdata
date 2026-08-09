/**
 * POST /api/pipelines/[pipeline_id]/commit-standardizations
 *
 * Premium only. Performs the DEFERRED lookup writes for one column at the
 * "Begin Pipeline Standardization" step. The review wizard accepts each column
 * with `defer: true` (no lookup writes, run marked 'approved'); this endpoint
 * finds that approved run and runs the export (upserting LITERAL_ALIAS_MATCHES +
 * APPROVED_ALIAS_NAMES), then advances the pipeline pending_baseline → paused and
 * clears its queue. Begin then activates the columns together.
 *
 * Idempotent: an already-committed run ('completed') is skipped.
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { runOpExport } from '@/app/api/_lib/op-export';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
import { appendTiming } from '@/app/api/_lib/timing';

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
  if (!apiKey) return Response.json({ error: 'No Anthropic API key configured — add one on the setup page.' }, { status: 500 });

  try {
    await withWarehouse(async (conn) => {
      const _t0 = Date.now();

      const plRowDb = getDb()
        .prepare(
          `SELECT domain_id, column_name, table_fqn
           FROM pipelines WHERE pipeline_id = ?`,
        )
        .get(pid) as any;
      const plRows = plRowDb ? [plRowDb] : [];
      if (plRows.length === 0) {
        appendTiming(`[Timing] commit.standardizations: ${Date.now() - _t0}ms (pipeline ${pid} not found)`);
        return;
      }

      const pr = plRows[0] as any;
      const tableFqn = String(pr.TABLE_FQN ?? pr.table_fqn ?? '');

      // One column per pipeline row. Multi-column setups are multiple rows
      // sharing an export table — the single-row-holds-many-columns shape was
      // the file/Sheets arrangement, which no longer exists.
      const colConfigs: { column_name: string; domain_id: number | null }[] = [{
        column_name: String(pr.COLUMN_NAME ?? pr.column_name ?? ''),
        domain_id:   pr.DOMAIN_ID != null ? Number(pr.DOMAIN_ID) : (pr.domain_id != null ? Number(pr.domain_id) : null),
      }];

      // Export the most-recent review run for each column.
      for (const col of colConfigs) {
        if (!col.column_name) continue;
        const runRow = getDb()
          .prepare(
            `SELECT run_id, run_status
             FROM runs
             WHERE source_relation = ?
               AND source_column   = ?
               AND (domain_id = ? OR (? IS NULL AND domain_id IS NULL))
             ORDER BY run_id DESC LIMIT 1`,
          )
          .get(tableFqn, col.column_name, col.domain_id, col.domain_id) as any;
        if (runRow) {
          const runId     = Number(runRow.run_id);
          const runStatus = String(runRow.run_status ?? '').toLowerCase();
          await runOpExport(conn, runId, apiKey, runStatus, { awaitWrite: true });
        }
      }

      // NO blanket `DELETE FROM PIPELINE_QUEUE WHERE pipeline_id = ?` here, and
      // no hard `queue_size = 0`.
      //
      // That wiped the pipeline's ENTIRE queue, not just the literals this run
      // standardized — a value queued by the poller but never part of any run
      // was silently destroyed, and the card then reported an empty queue.
      // It also contradicted CLAUDE.md's invariant that queue cleanup is
      // "scoped to the run's normalized literals only — never a blanket
      // pipeline-wide delete".
      //
      // runOpExport (awaited above, once per column) already does the correct
      // thing: it removes ONLY the literals it just wrote and recomputes
      // queue_size from a real COUNT(*). So the fix is to delete this block
      // rather than re-scope it — re-scoping would just duplicate work that
      // already happened, and drift from it later.
      //
      // Advance pending_baseline → paused (ready to activate). No-op if already
      // paused/active. queue_size / last_queue_empty_at are deliberately left to
      // runOpExport's own accurate update.
      getDb().prepare(
        `UPDATE pipelines
         SET status     = CASE WHEN status = 'pending_baseline' THEN 'paused' ELSE status END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ?`,
      ).run(pid);

      appendTiming(`[Timing] commit.standardizations: ${Date.now() - _t0}ms (pipeline ${pid})`);
    });

    return Response.json({ ok: true, pipeline_id: pid }, { status: 200 });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to commit standardizations');
  }
}
