import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

const ALLOWED_TABLES = [
  'RUNS',
  'LITERAL_ALIAS_MATCHES',
  'APPROVED_ALIAS_NAMES',
  'VALIDATION_LOG',
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tableName: string }> }
) {
  // Operator-only debug tooling — the route does not exist in customer
  // deployments unless PRISM_DEBUG_TOOLS is explicitly enabled.
  if (process.env.PRISM_DEBUG_TOOLS !== 'true') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const { tableName } = await params;

  if (!ALLOWED_TABLES.includes(tableName)) {
    return Response.json(
      { error: 'Table not allowed' },
      { status: 400 }
    );
  }

  const sqlText = `SELECT * FROM STAND_DB.STAND_INTERNAL.${tableName} LIMIT 1000`;

  try {
    return await withSnowflake(async (connection) => {
      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText,
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      return Response.json(
        { data: rows },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      );
    });
  } catch (error) {
    console.error('Database error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch data');
  }
}

