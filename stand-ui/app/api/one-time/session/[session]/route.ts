/**
 * GET /api/one-time/session/[session]
 *
 * Lists every column (working run) of a one-time session for the current user,
 * so the review page can hydrate from a session id alone (survives refresh).
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse, executeQuery as exec } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { loadOpRunStatesBatch } from '@/app/api/_lib/op-auto-group';
import { getDb } from '@/app/api/_lib/sqlite';
import { countOneTimeFileRows } from '@/app/api/_lib/op-one-time-file';

function safeJson(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function GET(_request: Request, { params }: { params: Promise<{ session: string }> }) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { session: sessionNonce } = await params;
  if (!sessionNonce) return Response.json({ error: 'Invalid session' }, { status: 400 });

  try {
    return await withWarehouse(async (conn) => {
      const rows = getDb()
        .prepare(
          `SELECT run_id, source_relation, source_column, run_status, stats_snapshot
           FROM runs
           WHERE run_type = 'one_time' AND created_by = ?
             AND json_extract(stats_snapshot, '$.one_time_session') = ?
           ORDER BY run_id`,
        )
        .all(Number(session.accountId), sessionNonce) as any[];
      if (!rows.length) return Response.json({ error: 'Session not found' }, { status: 404 });

      // The grouping state lives warehouse-side (INTERNAL.RUN_STATE — data
      // residency); batch-load it on the open connection to derive "grouped".
      const runIds = rows.map((r) => Number((r as any).RUN_ID ?? (r as any).run_id)).filter(Number.isFinite);
      const states = await loadOpRunStatesBatch(runIds, conn);

      const source_relation = String((rows[0] as any).SOURCE_RELATION ?? (rows[0] as any).source_relation ?? '');
      // Which connection this session runs on — recorded at creation when the
      // service login couldn't see the source. The review UI needs it to
      // suggest a destination the session can actually write (finding #28):
      // PRISM_OUT is the service login's granted output schema, but a
      // personal-credentials session writes with the USER's rights instead.
      const firstMeta = safeJson((rows[0] as any).STATS_SNAPSHOT ?? (rows[0] as any).stats_snapshot) ?? {};
      const uses_user_connection = String(firstMeta.connection ?? 'service') === 'user';
      let exported = false;
      const columns = rows.map((r) => {
        const a = r as any;
        const meta = safeJson(a.STATS_SNAPSHOT ?? a.stats_snapshot) ?? {};
        const status = String(a.RUN_STATUS ?? a.run_status ?? '');
        if (status === 'complete') exported = true;
        const runId = Number(a.RUN_ID ?? a.run_id);
        return {
          run_id:        runId,
          column_name:   String(a.SOURCE_COLUMN ?? a.source_column ?? ''),
          grouped:       (states.get(runId)?.groups?.length ?? 0) > 0,
          accepted:      meta.accepted === true,
          convention:    meta.convention ?? null,
        };
      });

      // Whether the source was an uploaded file / pasted list rather than a
      // warehouse table. Reported explicitly rather than inferred from
      // source_relation, which is a DISPLAY label for file sessions ("sales.csv")
      // and would be guesswork to pattern-match. The review UI keys its export
      // options on this: a file session can be exported as CSV/Excel/Sheets/table,
      // a warehouse session writes a table as it always has.
      const isFileSession = (await countOneTimeFileRows(conn, sessionNonce)) > 0;
      return Response.json({ session: sessionNonce, source_relation, exported, columns, is_file_session: isFileSession, uses_user_connection });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to load one-time session');
  }
}
