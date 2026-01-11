import { NextRequest } from 'next/server';
import snowflake from 'snowflake-sdk';

const ALLOWED_TABLES = [
  'SEMANTIC_CONCEPTS',
  'CONCEPT_ALIASES',
  'NORMALIZED_VALUES_ALIAS_VARIANTS',
  'RAW_VALUE_NORMALIZED_VARIANTS',
  'USERS',
  'RUNS',
  'RUN_GROUPS',
  'RUN_ITEMS',
  'RUN_APPLIED_TARGETS',
  'AUDIT_LOG',
];

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
  { params }: { params: Promise<{ tableName: string }> }
) {
  const { tableName } = await params;

  if (!ALLOWED_TABLES.includes(tableName)) {
    return Response.json(
      { error: 'Table not allowed' },
      { status: 400 }
    );
  }

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
        sqlText: `SELECT * FROM STAND_DB.STAND_INTERNAL.${tableName} LIMIT 1000`,
        complete: (err, stmt, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      });
    });

    return Response.json({ data: rows }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    console.error('Database error:', error);
    return Response.json(
      { error: 'Failed to fetch data' },
      { 
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      }
    );
  } finally {
    connection.destroy((err) => {
      if (err) console.error('Error closing connection:', err);
    });
  }
}

