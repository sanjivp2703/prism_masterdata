import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  try {
    return await withSnowflake(async (connection) => {
      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              r.run_id,
              r.run_status,
              r.mode,
              r.source_relation,
              r.source_column,
              r.created_at,
              r.updated_at,
              r.concept_key
            FROM STAND_DB.STAND_INTERNAL.RUNS r
            WHERE r.run_id = ?
          `,
          binds: [run_id],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      if (rows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      return Response.json({ data: rows[0] });
    });
  } catch (error) {
    console.error('Database error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch run data');
  }
}
