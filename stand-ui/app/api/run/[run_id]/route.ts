import { NextRequest } from 'next/server';
import snowflake from 'snowflake-sdk';

function createConnection() {
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT || '',
    username: process.env.SNOWFLAKE_USER || '',
    password: process.env.SNOWFLAKE_PASSWORD || '',
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || '',
    database: process.env.SNOWFLAKE_DATABASE || 'STAND_DB',
    schema: process.env.SNOWFLAKE_SCHEMA || 'STAND_INTERNAL',
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  const connection = createConnection();

  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const rows = await new Promise<any[]>((resolve, reject) => {
      connection.execute({
        sqlText: `
          SELECT 
            r.run_id,
            r.run_status,
            r.mode,
            r.created_at,
            r.started_at,
            r.completed_at,
            r.source_relation,
            r.source_column,
            r.error_message,
            sc.concept_key,
            sc.description AS concept_description,
            u.display_name AS created_by_name
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          LEFT JOIN STAND_DB.STAND_INTERNAL.SEMANTIC_CONCEPTS sc 
            ON r.concept_id = sc.concept_id
          LEFT JOIN STAND_DB.STAND_INTERNAL.USERS u 
            ON r.created_by = u.user_id
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
  } catch (error) {
    console.error('Database error:', error);
    return Response.json(
      { error: 'Failed to fetch run data' },
      { status: 500 }
    );
  } finally {
    connection.destroy((err) => {
      if (err) console.error('Error closing connection:', err);
    });
  }
}

