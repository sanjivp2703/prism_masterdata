/**
 * GET /api/columns?table_fqn=DB.SCHEMA.TABLE
 *
 * Returns column ordinal positions from Snowflake INFORMATION_SCHEMA.COLUMNS
 * for the given fully-qualified table. Used to sort pipeline rows by column order.
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const table_fqn = searchParams.get('table_fqn')?.trim() ?? '';

  if (!table_fqn) {
    return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  }

  const parts = table_fqn.split('.');
  if (parts.length !== 3) {
    return Response.json({ error: 'table_fqn must be DATABASE.SCHEMA.TABLE' }, { status: 400 });
  }

  const [db, schema, table] = parts.map(p => p.trim().replace(/^"|"$/g, '').toUpperCase());

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(conn,
        `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE
         FROM ${db}.INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [schema, table],
      );
      // `columns` (name → ordinal) is kept for existing callers; `fields` carries
      // the type info the pipeline-creation column picker needs. Snowflake reports
      // VARCHAR/CHAR/STRING all as 'TEXT' — only those are standardizable.
      const columns: Record<string, number> = {};
      const fields: { name: string; type: string; isText: boolean }[] = [];
      for (const row of rows) {
        const name = String(row.COLUMN_NAME ?? row.column_name ?? '').toUpperCase();
        const pos  = Number(row.ORDINAL_POSITION ?? row.ordinal_position ?? 0);
        const type = String(row.DATA_TYPE ?? row.data_type ?? '').toUpperCase();
        if (name) {
          columns[name] = pos;
          fields.push({ name, type, isText: type === 'TEXT' });
        }
      }
      return Response.json({ columns, fields });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch column order');
  }
}
