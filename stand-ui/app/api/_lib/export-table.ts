/**
 * Standardized export-table builder for Premium pipelines.
 *
 * When a pipeline has an export_table_fqn set, Prism maintains a Snowflake
 * table that mirrors the source table but with the watched column replaced by
 * the confirmed canonical alias name.  Only rows whose raw value has a
 * confirmed mapping in LITERAL_ALIAS_MATCHES are included — unmapped rows are
 * intentionally excluded.
 *
 * The table is rebuilt with CREATE OR REPLACE TABLE … AS SELECT … so it is
 * always a complete, consistent snapshot after each standardization pass.
 *
 * Required Snowflake privileges for the service role:
 *   - SELECT on the source table
 *   - USAGE on the source database and schema (for INFORMATION_SCHEMA access)
 *   - CREATE TABLE on the export schema (or CREATE TABLE ON DATABASE if
 *     creating in a new schema)
 */

import 'server-only';
import { withSnowflake } from './snowflake';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _s: any, rows: any[]) =>
        err ? reject(err) : resolve(rows || []),
    });
  });
}

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string): { db: string; schema: string; table: string } {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

export interface ExportTableResult {
  rows_written: number;
}

/**
 * Rebuilds the export table for a pipeline.
 *
 * Uses INFORMATION_SCHEMA to discover the source table's column list so the
 * SELECT replaces only the watched column, preserving every other column
 * exactly as-is.  Non-destructive: the destination table is created fresh via
 * CREATE OR REPLACE TABLE … AS SELECT.
 *
 * When pipelineId is supplied the PIPELINES.total_mapped column is updated with
 * the resulting row count — so the pipeline list always shows source-row counts
 * rather than a distinct-literal count.
 */
export async function refreshExportTable(
  source_fqn:   string,
  column_name:  string,
  export_fqn:   string,
  domain_id:    number | null,
  pipelineId?:  number,
): Promise<ExportTableResult> {
  return await withSnowflake(async (conn) => {
    const src = parseFqn(source_fqn);
    const exp = parseFqn(export_fqn);

    const sourceRef = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
    const exportRef = `${quoteIdent(exp.db)}.${quoteIdent(exp.schema)}.${quoteIdent(exp.table)}`;

    // ── Discover source columns ────────────────────────────────────────────
    const colRows = await exec(
      conn,
      `SELECT COLUMN_NAME
       FROM ${quoteIdent(src.db)}.INFORMATION_SCHEMA.COLUMNS
       WHERE UPPER(TABLE_SCHEMA) = UPPER(?)
         AND UPPER(TABLE_NAME)   = UPPER(?)
       ORDER BY ORDINAL_POSITION`,
      [src.schema, src.table],
    );

    if (!colRows.length) {
      throw new Error(
        `[ExportTable] No columns found for ${source_fqn}. ` +
        `Verify the table exists and that the service role has USAGE on ${src.db}.`,
      );
    }

    // ── Build SELECT list ──────────────────────────────────────────────────
    // The watched column is replaced with the canonical alias_name from the
    // APPROVED_ALIAS_NAMES lookup.  All other columns come straight from the
    // source row via the "src" alias.
    const domainFilter = domain_id != null
      ? `AND lam.domain_id = ${Number(domain_id)}`
      : `AND lam.domain_id IS NULL`;

    const selectList = colRows.map((r: any) => {
      const col = String(r.COLUMN_NAME ?? r.column_name ?? '');
      if (col.toUpperCase() === column_name.toUpperCase()) {
        return `aan.alias_name AS ${quoteIdent(col)}`;
      }
      return `src.${quoteIdent(col)}`;
    }).join(',\n    ');

    // ── Create / replace the export table ─────────────────────────────────
    await exec(conn, `
      CREATE OR REPLACE TABLE ${exportRef} AS
      SELECT
        ${selectList}
      FROM ${sourceRef} src
      JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
        ON lam.literal_value = src.${quoteIdent(column_name)}
        ${domainFilter}
      JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES aan
        ON aan.alias_id = lam.alias_id
    `);

    const countRows = await exec(conn, `SELECT COUNT(*) AS cnt FROM ${exportRef}`);
    const rows_written = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

    // Persist rows_written as the pipeline's standardized-row count so the
    // pipeline list can display source-row counts without an extra live query.
    if (pipelineId != null) {
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET total_mapped = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [rows_written, pipelineId],
      );
    }

    console.log(
      `[ExportTable] Rebuilt ${export_fqn} ← ${source_fqn}.${column_name} ` +
      `(domain_id=${domain_id ?? 'null'}) — ${rows_written} rows`,
    );

    return { rows_written };
  });
}

/**
 * For pipelines that have no export table, computes the number of source rows
 * with a confirmed mapping and writes it to PIPELINES.total_mapped.
 *
 * This mirrors what refreshExportTable does via `rows_written` — just without
 * the CREATE OR REPLACE TABLE step.
 */
export async function updatePipelineMappedCount(
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId:  number,
): Promise<void> {
  return await withSnowflake(async (conn) => {
    const src = parseFqn(source_fqn);
    const tableRef = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
    const colRef   = quoteIdent(column_name);
    const domainFilter = domain_id != null
      ? `AND lam.domain_id = ${Number(domain_id)}`
      : `AND lam.domain_id IS NULL`;

    const countRows = await exec(
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
    const mapped = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

    await exec(
      conn,
      `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
       SET total_mapped = ?, updated_at = CURRENT_TIMESTAMP()
       WHERE pipeline_id = ?`,
      [mapped, pipelineId],
    );
  });
}
