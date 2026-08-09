/**
 * GET /api/one-time/archive
 *
 * Returns the current user's completed one-time standardization sessions
 * (newest first), with their selected raw → standardized mappings.
 *
 * DATA RESIDENCY: the mappings are customer values and are not stored in the
 * SQLite archive row. They are reconstructed here, on demand, from the
 * session's run state blobs in the warehouse (INTERNAL.RUN_STATE) — a
 * user-initiated read, never a recurring one. If the warehouse read fails
 * (or the blobs were reset by a re-run of 01_internal_tables), the archive
 * still renders with empty mappings.
 */

import { getDb } from '@/app/api/_lib/sqlite';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { loadOpRunStatesBatch } from '@/app/api/_lib/op-auto-group';
import { mappingsFromState } from '@/app/api/_lib/op-one-time';

function safeJson(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  try {
    const rows = getDb()
      .prepare(
        `SELECT ots_id, session_nonce, source_relation, columns, export_target, export_mode, exported_at
         FROM one_time_standardizations
         WHERE created_by = ?
         ORDER BY exported_at DESC, ots_id DESC
         LIMIT 200`,
      )
      .all(Number(auth.accountId)) as any[];

    // Map each session's working runs (SQLite metadata) so we can pull their
    // state blobs from the warehouse in one batch.
    const nonces = rows.map((r) => String(r.session_nonce ?? '')).filter(Boolean);
    const runsByNonce = new Map<string, { run_id: number; source_column: string }[]>();
    const allRunIds: number[] = [];
    if (nonces.length) {
      const runRows = getDb()
        .prepare(
          `SELECT run_id, source_column,
                  json_extract(stats_snapshot, '$.one_time_session') AS nonce
           FROM runs
           WHERE run_type = 'one_time'
             AND json_extract(stats_snapshot, '$.one_time_session')
                 IN (${nonces.map(() => '?').join(', ')})`,
        )
        .all(...nonces) as any[];
      for (const r of runRows) {
        const nonce = String(r.nonce ?? '');
        if (!nonce) continue;
        const entry = { run_id: Number(r.run_id), source_column: String(r.source_column ?? '') };
        if (!runsByNonce.has(nonce)) runsByNonce.set(nonce, []);
        runsByNonce.get(nonce)!.push(entry);
        allRunIds.push(entry.run_id);
      }
    }

    // One batched warehouse read for all sessions' blobs. Best-effort: an
    // unreachable warehouse degrades to an archive without mappings.
    let states = new Map<number, any>();
    if (allRunIds.length) {
      try {
        states = await loadOpRunStatesBatch(allRunIds);
      } catch (err) {
        console.error('[one-time] archive mappings load failed (degrading to empty):', err);
      }
    }

    const archive = rows.map((a) => {
      // Object.create(null) — keyed by the customer's own column names.
      const mappings: Record<string, { raw: string; standardized: string }[]> = Object.create(null);
      for (const run of runsByNonce.get(String(a.session_nonce ?? '')) ?? []) {
        const state = states.get(run.run_id) ?? null;
        if (state) mappings[run.source_column] = mappingsFromState(state);
      }
      return {
        ots_id:          Number(a.ots_id),
        source_relation: String(a.source_relation ?? ''),
        columns:         safeJson(a.columns) ?? [],
        export_target:   String(a.export_target ?? ''),
        export_mode:     String(a.export_mode ?? ''),
        mappings,
        exported_at:     a.exported_at ?? null,
      };
    });

    return Response.json({ archive });
  } catch (err) {
    console.error('[one-time] archive load failed:', err);
    return Response.json({ error: 'Failed to load one-time archive' }, { status: 500 });
  }
}
