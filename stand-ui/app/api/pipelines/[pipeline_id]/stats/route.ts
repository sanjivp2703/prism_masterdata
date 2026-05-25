/**
 * GET /api/pipelines/[pipeline_id]/stats
 *
 * Returns three live row-counts queried from the source table:
 *   source_row_count       — COUNT(*) of all non-null values in the source column
 *   standardized_row_count — COUNT of source rows whose literal value already
 *                            has a mapping in LITERAL_ALIAS_MATCHES for this domain
 *   needs_standardization  — COUNT of source rows whose literal value is currently
 *                            sitting in PIPELINE_QUEUE (not yet LLM-processed)
 */

import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';

function quoteIdent(ident: string) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = fqn.split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

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
      // Look up pipeline metadata
      const pRows = await exec(
        conn,
        `SELECT table_fqn, column_name, domain_id
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE pipeline_id = ? LIMIT 1`,
        [pid],
      );
      if (!pRows.length) {
        return Response.json({ error: 'Pipeline not found' }, { status: 404 });
      }
      const row = pRows[0] as any;
      const tableFqn   = String(row.TABLE_FQN   ?? row.table_fqn   ?? '');
      const columnName = String(row.COLUMN_NAME ?? row.column_name ?? '');
      const domainId: number | null = (row.DOMAIN_ID ?? row.domain_id) != null
        ? Number(row.DOMAIN_ID ?? row.domain_id)
        : null;

      // Validate identifiers before building dynamic SQL
      let db: string, schema: string, table: string;
      try {
        const fqn = parseFqn(tableFqn);
        db = fqn.db; schema = fqn.schema; table = fqn.table;
      } catch {
        return Response.json({ error: `Invalid table_fqn: ${tableFqn}` }, { status: 400 });
      }
      if (!isSimpleIdent(db) || !isSimpleIdent(schema) || !isSimpleIdent(table) || !isSimpleIdent(columnName)) {
        return Response.json({ error: 'Table or column name contains unsupported characters.' }, { status: 400 });
      }

      const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const colRef   = quoteIdent(columnName);
      const domainFilter = domainId != null
        ? `AND lam.domain_id = ${Number(domainId)}`
        : `AND lam.domain_id IS NULL`;

      // 1. Total non-null values in the source column (all rows, not distinct)
      const [totalRows] = await exec(
        conn,
        `SELECT COUNT(*) AS cnt
         FROM ${tableRef}
         WHERE ${colRef} IS NOT NULL`,
      );
      const source_row_count = Number(totalRows?.CNT ?? totalRows?.cnt ?? 0);

      // 2. Rows whose literal value has a confirmed mapping in LITERAL_ALIAS_MATCHES
      const [stdRows] = await exec(
        conn,
        `SELECT COUNT(*) AS cnt
         FROM ${tableRef} src
         WHERE src.${colRef} IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
             WHERE lam.literal_value = TO_VARCHAR(src.${colRef})
               ${domainFilter}
           )`,
      );
      const standardized_row_count = Number(stdRows?.CNT ?? stdRows?.cnt ?? 0);

      // 3. Rows whose literal value is currently in the pipeline queue
      const [queueRows] = await exec(
        conn,
        `SELECT COUNT(*) AS cnt
         FROM ${tableRef} src
         WHERE src.${colRef} IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE q
             WHERE q.pipeline_id = ?
               AND q.literal_value = TO_VARCHAR(src.${colRef})
           )`,
        [pid],
      );
      const needs_standardization = Number(queueRows?.CNT ?? queueRows?.cnt ?? 0);

      return Response.json({ source_row_count, standardized_row_count, needs_standardization });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to compute pipeline stats');
  }
}
