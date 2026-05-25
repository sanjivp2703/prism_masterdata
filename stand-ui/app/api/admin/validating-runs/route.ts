import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

export async function GET(request: NextRequest) {
  try {
    return await withSnowflake(async (connection) => {
      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT run_id, source_relation, source_column, run_status, updated_at
            FROM STAND_DB.STAND_INTERNAL.RUNS
            WHERE run_status IN ('validating', 'created', 'running')
            ORDER BY updated_at DESC
            LIMIT 1000
          `,
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const data = rows.map((r: any) => ({
        run_id:          Number(r?.RUN_ID         ?? r?.run_id),
        source_relation: String(r?.SOURCE_RELATION ?? r?.source_relation ?? ''),
        source_column:   String(r?.SOURCE_COLUMN   ?? r?.source_column   ?? ''),
        run_status:      String(r?.RUN_STATUS      ?? r?.run_status      ?? ''),
        updated_at:      String(r?.UPDATED_AT      ?? r?.updated_at      ?? ''),
      }));

      return Response.json(
        { data },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma:          'no-cache',
            Expires:         '0',
          },
        }
      );
    });
  } catch (error) {
    console.error('Database error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch validating runs');
  }
}
