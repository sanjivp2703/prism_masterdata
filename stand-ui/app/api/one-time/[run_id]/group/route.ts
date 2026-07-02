/**
 * POST /api/one-time/[run_id]/group
 *
 * Runs LLM grouping (no lookup) over the run's items, applying its optional
 * naming convention, and returns the grouped mappings. Idempotent enough to
 * re-run — it regroups from the items each time.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';
import { groupOneTimeRun } from '@/app/api/_lib/op-one-time';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (e: any, _s: any, r: any[]) => (e ? reject(e) : resolve(r || [])) });
  });
}

export async function POST(_request: Request, { params }: { params: Promise<{ run_id: string }> }) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'LLM grouping is not configured (ANTHROPIC_API_KEY missing).' }, { status: 503 });
  }

  const { run_id } = await params;
  const runId = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runId)) return Response.json({ error: 'Invalid run_id' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      const ownRows = await exec(
        conn,
        `SELECT source_column FROM STAND_DB.STAND_INTERNAL.RUNS
         WHERE run_id = ? AND run_type = 'one_time' AND created_by = ?`,
        [runId, Number(session.accountId)],
      );
      if (!ownRows.length) return Response.json({ error: 'Not found' }, { status: 404 });

      await groupOneTimeRun(conn, runId);
      const state = await loadOpRunState(conn, runId);
      const groups = (state?.groups ?? []).map((g) => ({
        group_id:     g.group_id,
        alias_name:   g.alias_name,
        confidence:   g.confidence,
        needs_review: g.needs_review === true,
        items:        g.items.map((it) => ({ literal_value: it.literal_value })),
      }));
      return Response.json({
        run_id: runId,
        source_column: String((ownRows[0] as any).SOURCE_COLUMN ?? (ownRows[0] as any).source_column ?? ''),
        grouped: true,
        accepted: false,
        groups,
      });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to group one-time run');
  }
}
