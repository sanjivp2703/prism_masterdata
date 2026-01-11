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

type AliasMap = Record<
  string,
  {
    group_id: number;
    items: Array<{ run_item_id: number; raw_value: string }>;
  }
>;

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

    const groups = await new Promise<Array<{ GROUP_ID: number; ALIAS_NAME: string }>>(
      (resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              group_id,
              COALESCE(alias_name, initial_alias_name) AS alias_name
            FROM STAND_DB.STAND_INTERNAL.RUN_GROUPS
            WHERE run_id = ?
            ORDER BY group_id
          `,
          binds: [run_id],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve((rows || []) as any);
          },
        });
      }
    );

    const items = await new Promise<Array<{ RUN_ITEM_ID: number; GROUP_ID: number; RAW_VALUE: string }>>(
      (resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              run_item_id,
              group_id,
              raw_value
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
            WHERE run_id = ?
            ORDER BY group_id, run_item_id
          `,
          binds: [run_id],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve((rows || []) as any);
          },
        });
      }
    );

    const groupKeyById = new Map<number, string>();
    const aliasMap: AliasMap = {};

    for (const g of groups) {
      const key = g.ALIAS_NAME ?? `group_${g.GROUP_ID}`;
      groupKeyById.set(g.GROUP_ID, key);
      aliasMap[key] = { group_id: g.GROUP_ID, items: [] };
    }

    for (const it of items) {
      const key = groupKeyById.get(it.GROUP_ID) ?? `group_${it.GROUP_ID}`;
      if (!aliasMap[key]) {
        aliasMap[key] = { group_id: it.GROUP_ID, items: [] };
      }
      aliasMap[key].items.push({
        run_item_id: it.RUN_ITEM_ID,
        raw_value: it.RAW_VALUE,
      });
    }

    return Response.json(
      { data: aliasMap },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  } catch (error) {
    console.error('Database error:', error);
    return Response.json(
      { error: 'Failed to fetch alias mapping' },
      { status: 500 }
    );
  } finally {
    connection.destroy((err) => {
      if (err) console.error('Error closing connection:', err);
    });
  }
}


