/**
 * GET    /api/pipelines/[pipeline_id]/queue  — list queued items
 * DELETE /api/pipelines/[pipeline_id]/queue  — clear the queue (after export)
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT literal_value, detected_at
         FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
         WHERE pipeline_id = ?
         ORDER BY detected_at ASC`,
        [pid],
      );
      const items = rows.map(r => ({
        literal_value: String((r as any).LITERAL_VALUE ?? (r as any).literal_value ?? ''),
        detected_at:   (r as any).DETECTED_AT ?? (r as any).detected_at ?? null,
      }));
      return Response.json({ items, count: items.length });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch queue');
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (conn) => {
      await exec(conn, `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [pid]);
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET queue_size = 0, last_queue_empty_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [pid],
      );
      return Response.json({ ok: true });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to clear queue');
  }
}
