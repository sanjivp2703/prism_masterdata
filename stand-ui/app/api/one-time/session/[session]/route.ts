/**
 * GET /api/one-time/session/[session]
 *
 * Lists every column (working run) of a one-time session for the current user,
 * so the review page can hydrate from a session id alone (survives refresh).
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (e: any, _s: any, r: any[]) => (e ? reject(e) : resolve(r || [])) });
  });
}

function safeJson(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function GET(_request: Request, { params }: { params: Promise<{ session: string }> }) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { session: sessionNonce } = await params;
  if (!sessionNonce) return Response.json({ error: 'Invalid session' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT run_id, source_relation, source_column, run_status, stats_snapshot,
                ARRAY_SIZE(state:groups) AS group_count
         FROM STAND_DB.STAND_INTERNAL.RUNS
         WHERE run_type = 'one_time' AND created_by = ?
           AND stats_snapshot:one_time_session::string = ?
         ORDER BY run_id`,
        [Number(session.accountId), sessionNonce],
      );
      if (!rows.length) return Response.json({ error: 'Session not found' }, { status: 404 });

      const source_relation = String((rows[0] as any).SOURCE_RELATION ?? (rows[0] as any).source_relation ?? '');
      let exported = false;
      const columns = rows.map((r) => {
        const a = r as any;
        const meta = safeJson(a.STATS_SNAPSHOT ?? a.stats_snapshot) ?? {};
        const status = String(a.RUN_STATUS ?? a.run_status ?? '');
        if (status === 'complete') exported = true;
        return {
          run_id:        Number(a.RUN_ID ?? a.run_id),
          column_name:   String(a.SOURCE_COLUMN ?? a.source_column ?? ''),
          grouped:       Number(a.GROUP_COUNT ?? a.group_count ?? 0) > 0,
          accepted:      meta.accepted === true,
          convention:    meta.convention ?? null,
        };
      });

      return Response.json({ session: sessionNonce, source_relation, exported, columns });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load one-time session');
  }
}
