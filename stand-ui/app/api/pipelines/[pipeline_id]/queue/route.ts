/**
 * GET    /api/pipelines/[pipeline_id]/queue  — list queued items
 * DELETE /api/pipelines/[pipeline_id]/queue  — clear the queue (after export)
 */

import { withWarehouse, warehouseErrorResponse, executeQuery as exec } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { internalTable } from '@/app/api/_lib/warehouse-tables';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  try {
    return await withWarehouse(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT literal_value, detected_at
         FROM ${internalTable('PIPELINE_QUEUE')}
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
    return warehouseErrorResponse(err, 'Failed to fetch queue');
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  try {
    return await withWarehouse(async (conn) => {
      await exec(conn, `DELETE FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`, [pid]);
      getDb()
        .prepare(
          `UPDATE pipelines
           SET queue_size = 0, last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE pipeline_id = ?`,
        )
        .run(pid);
      return Response.json({ ok: true });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to clear queue');
  }
}
