/**
 * GET /api/one-time/archive
 *
 * Returns the current user's completed one-time standardization sessions
 * (newest first), with their selected raw → standardized mappings.
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

export async function GET() {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT ots_id, source_relation, columns, export_target, export_mode, mappings, exported_at
         FROM STAND_DB.STAND_INTERNAL.ONE_TIME_STANDARDIZATIONS
         WHERE created_by = ?
         ORDER BY exported_at DESC, ots_id DESC
         LIMIT 200`,
        [Number(session.accountId)],
      );

      const archive = rows.map((r) => {
        const a = r as any;
        return {
          ots_id:          Number(a.OTS_ID ?? a.ots_id),
          source_relation: String(a.SOURCE_RELATION ?? a.source_relation ?? ''),
          columns:         safeJson(a.COLUMNS ?? a.columns) ?? [],
          export_target:   String(a.EXPORT_TARGET ?? a.export_target ?? ''),
          export_mode:     String(a.EXPORT_MODE ?? a.export_mode ?? ''),
          mappings:        safeJson(a.MAPPINGS ?? a.mappings) ?? {},
          exported_at:     a.EXPORTED_AT ?? a.exported_at ?? null,
        };
      });

      return Response.json({ archive });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load one-time archive');
  }
}
