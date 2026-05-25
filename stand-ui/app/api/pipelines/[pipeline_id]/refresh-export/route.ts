/**
 * POST /api/pipelines/[pipeline_id]/refresh-export
 *
 * Synchronously rebuilds the standardized export table for a pipeline.
 * Returns the row count written so the caller can confirm it worked.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { refreshExportTable } from '@/app/api/_lib/export-table';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function POST(
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
    // Fetch the pipeline so we have all the info needed for the refresh.
    const row = await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT table_fqn, column_name, export_table_fqn, domain_id
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE pipeline_id = ?
         LIMIT 1`,
        [pid],
      );
      return rows[0] as any ?? null;
    });

    if (!row) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const exportTableFqn = row.EXPORT_TABLE_FQN ?? row.export_table_fqn ?? null;
    if (!exportTableFqn) {
      return Response.json(
        { error: 'This pipeline does not have an export table configured.' },
        { status: 400 },
      );
    }

    const tableFqn   = String(row.TABLE_FQN   ?? row.table_fqn   ?? '');
    const columnName = String(row.COLUMN_NAME ?? row.column_name ?? '');
    const domainId   = (row.DOMAIN_ID ?? row.domain_id) != null
      ? Number(row.DOMAIN_ID ?? row.domain_id) : null;

    // Run the refresh synchronously so any error is surfaced to the caller.
    const result = await refreshExportTable(tableFqn, columnName, exportTableFqn, domainId, pid);

    return Response.json({ ok: true, rows_written: result.rows_written, export_table_fqn: exportTableFqn });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to refresh export table');
  }
}
