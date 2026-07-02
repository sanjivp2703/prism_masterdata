/**
 * PATCH  /api/pipelines/[pipeline_id]  — update status / poll stats / name
 * DELETE /api/pipelines/[pipeline_id]  — remove pipeline
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { dropPipelineStream } from '@/app/api/_lib/pipeline-poller';
import { refreshExportTable } from '@/app/api/_lib/export-table';
import { reconcilePipelineQueue } from '@/app/api/_lib/pipeline-hourly-processor';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

/**
 * PATCH /api/pipelines/[pipeline_id]
 * Partial update. Accepts any subset of:
 *   { status, name, mode, export_table_fqn, total_new_values, last_polled_at, increment_new_values }
 *
 * increment_new_values: number — adds to the running total rather than setting it
 * last_polled_at: ISO string | 'now' (default when status changes to 'active')
 */
export async function PATCH(
  request: Request,
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

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const setClauses: string[]  = [];
  const binds:      any[]     = [];

  if (body?.name !== undefined) {
    setClauses.push('name = ?');
    binds.push(body.name ? String(body.name).trim() : null);
  }
  if (body?.mode !== undefined && ['auto', 'manual'].includes(body.mode)) {
    setClauses.push('mode = ?');
    binds.push(body.mode);
  }
  if (body?.export_table_fqn !== undefined) {
    setClauses.push('export_table_fqn = ?');
    binds.push(body.export_table_fqn ? String(body.export_table_fqn).trim() : null);
  }
  if (body?.status !== undefined && ['active', 'paused', 'pending_baseline'].includes(body.status)) {
    setClauses.push('status = ?');
    binds.push(body.status);
    // Resuming clears any block reason; the next healthy poll would clear it too,
    // but doing it here avoids showing a stale message in the gap before that poll.
    if (body.status === 'active') {
      setClauses.push('status_message = NULL');
      // Automatically stamp last_polled_at when transitioning to active
      if (body?.last_polled_at === undefined) {
        setClauses.push('last_polled_at = CURRENT_TIMESTAMP()');
      }
    }
  }
  if (body?.last_polled_at !== undefined) {
    setClauses.push('last_polled_at = CURRENT_TIMESTAMP()');
  }
  if (body?.clear_queue === true) {
    setClauses.push('queue_size = 0');
    setClauses.push('last_queue_empty_at = CURRENT_TIMESTAMP()');
  }
  if (typeof body?.increment_new_values === 'number' && body.increment_new_values > 0) {
    setClauses.push(`total_new_values = total_new_values + ${Math.floor(body.increment_new_values)}`);
    setClauses.push(`queue_size = queue_size + ${Math.floor(body.increment_new_values)}`);
  } else if (typeof body?.total_new_values === 'number') {
    setClauses.push('total_new_values = ?');
    binds.push(Math.max(0, Math.floor(body.total_new_values)));
  }

  if (setClauses.length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP()');
  binds.push(pid);

  const activating = body?.status === 'active';

  interface PipelineRef {
    table_fqn:        string;
    column_name:      string;
    export_table_fqn: string | null;
    domain_id:        number | null;
  }

  try {
    const { httpResponse, pfe } = await withSnowflake(async (conn) => {
      const sql = `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
                   SET ${setClauses.join(', ')}
                   WHERE pipeline_id = ?`;
      await exec(conn, sql, binds);

      let pfe: PipelineRef | null = null;
      if (activating) {
        const rows = await exec(
          conn,
          `SELECT table_fqn, column_name, export_table_fqn, domain_id
           FROM STAND_DB.STAND_INTERNAL.PIPELINES
           WHERE pipeline_id = ?`,
          [pid],
        );
        if (rows.length > 0) {
          const r = rows[0] as any;
          pfe = {
            table_fqn:        String(r.TABLE_FQN        ?? r.table_fqn        ?? ''),
            column_name:      String(r.COLUMN_NAME      ?? r.column_name      ?? ''),
            export_table_fqn: r.EXPORT_TABLE_FQN ?? r.export_table_fqn ?? null,
            domain_id:        (r.DOMAIN_ID ?? r.domain_id) != null
              ? Number(r.DOMAIN_ID ?? r.domain_id)
              : null,
          };
        }
      }

      return { httpResponse: Response.json({ ok: true }), pfe };
    });

    // Refresh the export table fire-and-forget when the pipeline is re-activated.
    if (pfe && pfe.export_table_fqn) {
      refreshExportTable(pfe.table_fqn, pfe.column_name, pfe.export_table_fqn, pfe.domain_id, pid).catch(err => {
        console.error(`[ExportTable] Background refresh failed for pipeline ${pid}:`, err);
      });
    }

    // On re-activation, recover any source values that arrived while the
    // pipeline was paused.  The APPEND_ONLY stream may have gone stale (and be
    // recreated empty) over a long pause, so reconcile from the source table
    // directly instead of waiting for the next hourly sweep.  Fire-and-forget.
    if (pfe) {
      reconcilePipelineQueue({
        pipeline_id: pid,
        table_fqn:   pfe.table_fqn,
        column_name: pfe.column_name,
        domain_id:   pfe.domain_id,
      }).catch(err => {
        console.error(`[Reconcile] Reactivation reconcile failed for pipeline ${pid}:`, err);
      });
    }

    return httpResponse;
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to update pipeline');
  }
}

/**
 * DELETE /api/pipelines/[pipeline_id]
 * Permanently removes the pipeline record. Auth required.
 */
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
    const response = await withSnowflake(async (conn) => {
      // For Sheets pipelines: all columns for the same tab share the same
      // table_fqn (created in one batch). Delete all siblings so the per-tab
      // duplicate check doesn't block re-creation after a delete.
      const fqnRows = await exec(
        conn,
        `SELECT table_fqn, source_type FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ?`,
        [pid],
      );
      const fqn        = String(fqnRows[0]?.TABLE_FQN ?? fqnRows[0]?.table_fqn ?? '');
      const sourceType = String(fqnRows[0]?.SOURCE_TYPE ?? fqnRows[0]?.source_type ?? '');
      if (fqn && sourceType === 'sheets') {
        await exec(conn, `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE table_fqn = ?`, [fqn]);
      } else {
        await exec(conn, `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ?`, [pid]);
      }
      return Response.json({ ok: true });
    });

    dropPipelineStream(pid);

    return response;
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to delete pipeline');
  }
}
