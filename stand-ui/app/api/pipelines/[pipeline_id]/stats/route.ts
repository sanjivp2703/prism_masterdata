/**
 * GET /api/pipelines/[pipeline_id]/stats
 *
 * Returns three metrics from the PIPELINES row (no source-table queries):
 *   source_row_count       — total non-null rows in the source column (updated each poll)
 *   standardized_row_count — source rows with a confirmed mapping (updated on standardization)
 *   needs_standardization  — source_row_count - standardized_row_count
 */

import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';

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
        `SELECT total_source_values, total_mapped
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE pipeline_id = ? LIMIT 1`,
        [pid],
      );
      if (!rows.length) {
        return Response.json({ error: 'Pipeline not found' }, { status: 404 });
      }
      const row = rows[0] as any;
      const source_row_count       = Number(row.TOTAL_SOURCE_VALUES ?? row.total_source_values ?? 0);
      const standardized_row_count = Number(row.TOTAL_MAPPED        ?? row.total_mapped        ?? 0);
      const needs_standardization  = Math.max(0, source_row_count - standardized_row_count);

      return Response.json({ source_row_count, standardized_row_count, needs_standardization });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to compute pipeline stats');
  }
}
