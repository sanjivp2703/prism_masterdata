import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

const ALLOWED_TABLES = [
  'CLASSIFICATION_METADATA_PROFILES',
  'CONCEPTS',
  'ALIASES',
  'ALIAS_SUMMARY',
  'TOKENS_SUMMARY',
  'RAW_VALUES',
  'USERS',
  'RUNS',
  'RUN_GROUPS',
  'RUN_ITEMS',
  'RUN_APPLIED_TARGETS',
  'AUDIT_LOG',
];

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

      // Backward-compatible admin projection for TOKENS_SUMMARY:
      // - If DB still has IS_NORMALIZED, expose TOKEN_TYPE derived from it.
      // - Hide IS_NORMALIZED in API output so UI consistently shows TOKEN_TYPE.
      const data =
        tableName === 'TOKENS_SUMMARY'
          ? rows.map((row: any) => {
              const hasTokenType = row.TOKEN_TYPE !== undefined && row.TOKEN_TYPE !== null;
              const tokenType = hasTokenType
                ? String(row.TOKEN_TYPE)
                : row.IS_NORMALIZED === true || row.IS_NORMALIZED === 'true'
                  ? 'normalized'
                  : row.IS_NORMALIZED === false || row.IS_NORMALIZED === 'false'
                    ? 'standard'
                    : null;

              const { IS_NORMALIZED, ...rest } = row;
              return {
                ...rest,
                TOKEN_TYPE: tokenType,
              };
            })
          : rows;

      return Response.json(
        { data },
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

