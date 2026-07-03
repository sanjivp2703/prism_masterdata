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
import { sqlStringLiteral } from './normalize';

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

/** Name of the explicit ordering column added to every export table. */
const ORDER_COLUMN_BASE = 'PRISM_ROW_ORDER';

/**
 * Parse the column list out of a Snowflake CLUSTERING_KEY value, e.g.
 * "LINEAR(C1, C2)" → ["C1","C2"].  Returns [] when the key is absent or
 * contains expressions/functions (which we can't safely qualify), so the
 * caller falls through to the next ordering tier.
 */
function parseClusteringColumns(clusteringKey: string): string[] {
  const m = clusteringKey.match(/^\s*LINEAR\s*\((.*)\)\s*$/i);
  if (!m) return [];
  const parts = m[1].split(',').map(p => p.trim()).filter(Boolean);
  const cols: string[] = [];
  for (const p of parts) {
    const bare = p.replace(/^"(.*)"$/, '$1');
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(bare)) return []; // expression — skip this tier
    cols.push(bare);
  }
  return cols;
}

interface SourceOrdering {
  tier:      'cluster' | 'ingest';
  /** ORDER BY expression: references `src.<col>` (cluster) or a lam alias (ingest). */
  orderExpr: string;
}

/**
 * Resolve how to order the export table:
 *   1. Source CLUSTERING KEY columns (the persistent "order by" a Snowflake table
 *      can carry), if they are plain columns.
 *   2. Else ingest order: the sequence in which each value was first confirmed
 *      (LITERAL_ALIAS_MATCHES.match_id, a monotonic autoincrement).  A clustering-
 *      keyless Snowflake table has no recoverable physical row order and Prism
 *      cannot add a column to the customer's source, so this value-ingest order is
 *      the fallback — rows cluster by when their value entered the system.
 *
 * (Primary keys are intentionally NOT used: a natural/non-sequential PK would sort
 * the export by the key's value rather than any meaningful row order.)
 *
 * `firstLamAlias` is the join alias of the first watched column, used for the
 * ingest tier.
 */
async function resolveSourceOrdering(
  conn:          any,
  src:           { db: string; schema: string; table: string },
  _sourceRef:    string,
  firstLamAlias: string,
): Promise<SourceOrdering> {
  // ── Tier 1: clustering key ─────────────────────────────────────────────
  try {
    const [ckRow] = await exec(
      conn,
      `SELECT CLUSTERING_KEY
       FROM ${quoteIdent(src.db)}.INFORMATION_SCHEMA.TABLES
       WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)`,
      [src.schema, src.table],
    );
    const clusteringKey = String((ckRow as any)?.CLUSTERING_KEY ?? (ckRow as any)?.clustering_key ?? '').trim();
    const cols = parseClusteringColumns(clusteringKey);
    if (cols.length > 0) {
      return { tier: 'cluster', orderExpr: cols.map(c => `src.${quoteIdent(c)}`).join(', ') };
    }
  } catch { /* no clustering key / not permitted — fall through */ }

  // ── Tier 2: ingest order (value first-confirmed sequence) ──────────────
  return { tier: 'ingest', orderExpr: `${firstLamAlias}.match_id` };
}

export interface ExportTableResult {
  rows_written: number;
}

/**
 * Rebuilds the export table for a pipeline.
 *
 * The export table is shared across all pipelines that point to the same
 * (source table, export table). This function looks up every sibling pipeline
 * and replaces ALL their watched columns in a single CREATE OR REPLACE, so the
 * destination always reflects every standardized column on the source table.
 *
 * The caller passes its own (column_name, domain_id) so the function still
 * works during initial setup, where the calling pipeline may not yet be fully
 * committed.
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

    // ── Gather all watched columns sharing this export table ─────────────
    // Multiple pipelines can write to the same destination — each one
    // standardizes a different source column. Union the caller in case its
    // PIPELINES row isn't visible yet (e.g. setup hasn't committed).
    const siblingRows = await exec(conn,
      `SELECT pipeline_id, column_name, domain_id, mode, export_unmapped_rows
       FROM STAND_DB.STAND_INTERNAL.PIPELINES
       WHERE table_fqn = ? AND export_table_fqn = ?`,
      [source_fqn, export_fqn],
    );

    // Mode and export_unmapped_rows are consistent across a table's columns.
    const isManual = siblingRows.some(r =>
      String((r as any).MODE ?? (r as any).mode ?? '').toLowerCase() === 'manual');
    // export_unmapped_rows (manual only): when TRUE every source row appears with
    // unmapped values shown in raw form; when FALSE only mapped rows appear (same as auto).
    const firstSibling = siblingRows[0] as any;
    const rawUnmapped = firstSibling
      ? (firstSibling.EXPORT_UNMAPPED_ROWS ?? firstSibling.export_unmapped_rows)
      : true;
    const exportUnmappedRowsSetting = rawUnmapped !== false && rawUnmapped !== 'false';
    // Effective "include-unmapped" behaviour: only when manual AND the setting is on.
    const includeUnmapped = isManual && exportUnmappedRowsSetting;

    interface Watched { columnName: string; domainId: number | null }
    const watchedByCol = new Map<string, Watched>();
    const siblingPipelineIds: number[] = [];
    // Per-pipeline column + domain so we can write each sibling its OWN per-column
    // metrics (not a single shared count) — see the metric refresh below.
    interface SiblingMeta { pipelineId: number; columnName: string; domainId: number | null }
    const siblings: SiblingMeta[] = [];

    for (const r of siblingRows) {
      const col   = String((r as any).COLUMN_NAME ?? (r as any).column_name ?? '').trim();
      const domR  = (r as any).DOMAIN_ID ?? (r as any).domain_id;
      const pidR  = Number((r as any).PIPELINE_ID ?? (r as any).pipeline_id);
      if (!col) continue;
      watchedByCol.set(col.toUpperCase(), { columnName: col, domainId: domR == null ? null : Number(domR) });
      if (Number.isFinite(pidR)) {
        siblingPipelineIds.push(pidR);
        siblings.push({ pipelineId: pidR, columnName: col, domainId: domR == null ? null : Number(domR) });
      }
    }

    if (!watchedByCol.has(column_name.toUpperCase())) {
      watchedByCol.set(column_name.toUpperCase(), { columnName: column_name, domainId: domain_id });
    }

    const watched = Array.from(watchedByCol.values());
    if (pipelineId != null && !siblingPipelineIds.includes(pipelineId)) {
      siblingPipelineIds.push(pipelineId);
      siblings.push({ pipelineId, columnName: column_name, domainId: domain_id });
    }

    // ── Build SELECT list and JOIN clauses ─────────────────────────────────
    // Each watched column LEFT JOINs to its own LITERAL_ALIAS_MATCHES /
    // APPROVED_ALIAS_NAMES alias pair so different columns can use different
    // domains. A NULL value in a watched column is "standardized as-is": it
    // exports as NULL and never blocks its row. Differences by includeUnmapped:
    //   • FALSE — a row appears only when every watched column is NULL or mapped
    //     (a non-null UNMAPPED value excludes the row, via the WHERE below). NULLs
    //     pass through as NULL; mapped values export the canonical name.
    //   • TRUE  — every source row appears; unmapped non-null values COALESCE to
    //     the raw value, NULLs stay NULL, mapped values export the canonical name.
    //   TRUE only applies to manual pipelines with export_unmapped_rows = true.
    const aliasFor = (i: number) => ({ lam: `lam_${i}`, aan: `aan_${i}` });

    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    const whereConds: string[] = [];

    watched.forEach((w, i) => {
      const { lam, aan } = aliasFor(i);
      const domainFilter = w.domainId != null
        ? `AND ${lam}.domain_id = ${Number(w.domainId)}`
        : `AND ${lam}.domain_id IS NULL`;

      const colSql = includeUnmapped
        ? `COALESCE(${aan}.alias_name, TO_VARCHAR(src.${quoteIdent(w.columnName)})) AS ${quoteIdent(w.columnName)}`
        : `${aan}.alias_name AS ${quoteIdent(w.columnName)}`;
      replaceMap.set(w.columnName.toUpperCase(), colSql);
      joinClauses.push(
        `LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES ${lam}
        ON ${lam}.normalized_value = PRISM_NORMALIZE(TO_VARCHAR(src.${quoteIdent(w.columnName)}))
        ${domainFilter}
      LEFT JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES ${aan}
        ON ${aan}.alias_id = ${lam}.alias_id`,
      );
      // Exclude rows where this column has a non-null unmapped value.
      if (!includeUnmapped) {
        whereConds.push(`(src.${quoteIdent(w.columnName)} IS NULL OR ${lam}.literal_value IS NOT NULL)`);
      }
    });

    const whereClause = whereConds.length > 0 ? `WHERE ${whereConds.join('\n        AND ')}` : '';

    const selectList = colRows.map((r: any) => {
      const col = String(r.COLUMN_NAME ?? r.column_name ?? '');
      const replacement = replaceMap.get(col.toUpperCase());
      return replacement ?? `src.${quoteIdent(col)}`;
    }).join(',\n    ');

    // ── Resolve source ordering and add an explicit order column ───────────
    // Export rows are ordered to mirror the source table.  Because the table is
    // fully rebuilt each refresh, a row that was missing (not yet standardized)
    // automatically slots into its correct position once its value is mapped.
    // The explicit ORDER_COLUMN guarantees the order survives being queried
    // (Snowflake does not return stored order without ORDER BY); the CTAS is
    // also physically sorted so a plain SELECT * reads back in order.
    const ordering = await resolveSourceOrdering(conn, src, sourceRef, aliasFor(0).lam);

    // Avoid colliding with a source column of the same name.
    const sourceColsUpper = new Set(
      colRows.map((r: any) => String(r.COLUMN_NAME ?? r.column_name ?? '').toUpperCase()),
    );
    let orderColName = ORDER_COLUMN_BASE;
    while (sourceColsUpper.has(orderColName.toUpperCase())) orderColName = `_${orderColName}`;

    // ── Create / replace the export table ─────────────────────────────────
    // COPY GRANTS preserves consumers' privileges (e.g. SELECT granted to
    // downstream roles) across the rebuild — without it every CREATE OR REPLACE
    // drops all grants on the export table.
    await exec(conn, `
      CREATE OR REPLACE TABLE ${exportRef} COPY GRANTS AS
      SELECT
        ${selectList},
        ROW_NUMBER() OVER (ORDER BY ${ordering.orderExpr}) AS ${quoteIdent(orderColName)}
      FROM ${sourceRef} src
      ${joinClauses.join('\n      ')}
      ${whereClause}
      ORDER BY ${ordering.orderExpr}
    `);

    const countRows = await exec(conn, `SELECT COUNT(*) AS cnt FROM ${exportRef}`);
    const rows_written = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

    // Write each sibling pipeline its OWN per-column metrics — total non-null
    // rows and rows with a confirmed mapping for THAT column/domain. (Previously
    // every sibling got the shared export-table row count, which made the UI's
    // per-card aggregation, which sums across columns, double/garble the totals.)
    // The export table itself still reflects rows where ALL columns map (the
    // INNER JOINs above); only these per-pipeline counters are per-column.
    for (const s of siblings) {
      const colRef = quoteIdent(s.columnName);
      const domainFilter = s.domainId != null
        ? `AND lam.domain_id = ${Number(s.domainId)}`
        : `AND lam.domain_id IS NULL`;
      // Aggregate the source ONCE by normalized value, then count mapped via a
      // semi-join (IN) against the DISTINCT lookup keys. This replaces the old
      // per-row LEFT JOIN of the entire source against LITERAL_ALIAS_MATCHES:
      //   • total_source is a plain frequency sum (no join at all),
      //   • total_mapped joins only the deduped source values to a plain stored
      //     column — so no per-row UDF on the lookup side and no row fan-out.
      const [statsRow] = await exec(conn,
        `WITH src_agg AS (
           SELECT PRISM_NORMALIZE(TO_VARCHAR(src.${colRef})) AS nv, COUNT(*) AS freq
           FROM ${sourceRef} src
           WHERE src.${colRef} IS NOT NULL
           GROUP BY PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
         )
         SELECT
           COALESCE(SUM(sa.freq), 0) AS total_source,
           COALESCE(SUM(CASE WHEN sa.nv IN (
             SELECT lam.normalized_value
             FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
             WHERE 1=1 ${domainFilter}
           ) THEN sa.freq ELSE 0 END), 0) AS total_mapped
         FROM src_agg sa`);
      const totalSource = Number((statsRow as any)?.TOTAL_SOURCE ?? (statsRow as any)?.total_source ?? 0);
      const totalMapped = Number((statsRow as any)?.TOTAL_MAPPED  ?? (statsRow as any)?.total_mapped  ?? 0);
      await exec(conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET total_mapped = ?, total_source_values = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [totalMapped, totalSource, s.pipelineId]);
    }

    console.log(
      `[ExportTable] Rebuilt ${export_fqn} ← ${source_fqn} ` +
      `(columns: ${watched.map(w => w.columnName).join(', ')}; order: ${ordering.tier}) — ${rows_written} rows`,
    );

    return { rows_written };
  });
}


/**
 * For pipelines that have no export table, computes the number of source rows
 * with a confirmed mapping and writes it to PIPELINES.total_mapped.
 *
 * Handles both Snowflake pipelines (queries the live source table) and file
 * pipelines (queries PIPELINE_FILE_ROWS for CSV/Excel, or RUNS state for Sheets).
 */
export async function updatePipelineMappedCount(
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId:  number,
): Promise<void> {
  // File pipelines store a synthetic FQN — route to the appropriate handler.
  if (source_fqn.startsWith('FILE:') || source_fqn.startsWith('SHEETS:')) {
    return updateFilePipelineMappedCount(source_fqn, column_name, domain_id, pipelineId);
  }

  return await withSnowflake(async (conn) => {
    const src = parseFqn(source_fqn);
    const tableRef = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
    const colRef   = quoteIdent(column_name);
    const domainFilter = domain_id != null
      ? `AND lam.domain_id = ${Number(domain_id)}`
      : `AND lam.domain_id IS NULL`;

    // Aggregate the source ONCE by normalized value, then count mapped via a
    // semi-join against the DISTINCT lookup keys (plain stored column, no per-row
    // UDF on the lookup side, no row fan-out). total_source is a plain freq sum.
    const [statsRow] = await exec(
      conn,
      `WITH src_agg AS (
         SELECT PRISM_NORMALIZE(TO_VARCHAR(src.${colRef})) AS nv, COUNT(*) AS freq
         FROM ${tableRef} src
         WHERE src.${colRef} IS NOT NULL
         GROUP BY PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
       )
       SELECT
         COALESCE(SUM(sa.freq), 0) AS total_source,
         COALESCE(SUM(CASE WHEN sa.nv IN (
           SELECT lam.normalized_value
           FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
           WHERE 1=1 ${domainFilter}
         ) THEN sa.freq ELSE 0 END), 0) AS total_mapped
       FROM src_agg sa`,
    );
    const mapped             = Number(statsRow?.TOTAL_MAPPED  ?? statsRow?.total_mapped  ?? 0);
    const totalSourceValues  = Number(statsRow?.TOTAL_SOURCE  ?? statsRow?.total_source  ?? 0);

    await exec(
      conn,
      `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
       SET total_mapped = ?, total_source_values = ?, updated_at = CURRENT_TIMESTAMP()
       WHERE pipeline_id = ?`,
      [mapped, totalSourceValues, pipelineId],
    );
  });
}

/**
 * Variant of updatePipelineMappedCount for file-based pipelines (CSV, Excel, Sheets)
 * whose table_fqn is a synthetic key, not a real Snowflake table reference.
 *
 * - CSV/Excel (FILE: prefix): counts from PIPELINE_FILE_ROWS.
 * - Sheets (SHEETS: prefix): counts items from the most recent RUNS state blob.
 *
 * In both cases total_mapped is determined by a semi-join against LITERAL_ALIAS_MATCHES.
 */
async function updateFilePipelineMappedCount(
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId:  number,
): Promise<void> {
  return await withSnowflake(async (conn) => {
    const domainFilter = domain_id != null
      ? `AND lam.domain_id = ${Number(domain_id)}`
      : `AND lam.domain_id IS NULL`;

    let totalSource = 0;
    let totalMapped = 0;

    if (source_fqn.startsWith('FILE:')) {
      // CSV/Excel: PIPELINE_FILE_ROWS holds all source rows for this pipeline.
      const safeCol = sqlStringLiteral(column_name);
      const [statsRow] = await exec(conn, `
        WITH src AS (
          SELECT PRISM_NORMALIZE(column_data['${safeCol}']::VARCHAR) AS nv,
                 COUNT(*) AS freq
          FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS
          WHERE pipeline_id = ?
            AND column_data['${safeCol}']::VARCHAR IS NOT NULL
          GROUP BY PRISM_NORMALIZE(column_data['${safeCol}']::VARCHAR)
        )
        SELECT
          COALESCE(SUM(freq), 0) AS total_source,
          COALESCE(SUM(CASE WHEN nv IN (
            SELECT lam.normalized_value
            FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
            WHERE 1=1 ${domainFilter}
          ) THEN freq ELSE 0 END), 0) AS total_mapped
        FROM src
      `, [pipelineId]);
      totalSource = Number(statsRow?.TOTAL_SOURCE ?? statsRow?.total_source ?? 0);
      totalMapped = Number(statsRow?.TOTAL_MAPPED ?? statsRow?.total_mapped ?? 0);
    } else {
      // Sheets: the source values live in the most recent RUNS state blob.
      // Each item in state.items is one distinct raw value (1 occurrence each).
      const [statsRow] = await exec(conn, `
        WITH latest_run AS (
          SELECT state FROM STAND_DB.STAND_INTERNAL.RUNS
          WHERE source_relation = ? AND source_column = ?
          ORDER BY run_id DESC LIMIT 1
        ),
        run_items AS (
          SELECT f.value:literal_value::VARCHAR AS lv
          FROM latest_run r, LATERAL FLATTEN(r.state:items) f
        )
        SELECT
          COUNT(*) AS total_source,
          COUNT(CASE WHEN PRISM_NORMALIZE(lv) IN (
            SELECT lam.normalized_value
            FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
            WHERE 1=1 ${domainFilter}
          ) THEN 1 END) AS total_mapped
        FROM run_items
      `, [source_fqn, column_name]);
      totalSource = Number(statsRow?.TOTAL_SOURCE ?? statsRow?.total_source ?? 0);
      totalMapped = Number(statsRow?.TOTAL_MAPPED ?? statsRow?.total_mapped ?? 0);
    }

    await exec(conn, `
      UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
      SET total_mapped = ?, total_source_values = ?, updated_at = CURRENT_TIMESTAMP()
      WHERE pipeline_id = ?
    `, [totalMapped, totalSource, pipelineId]);
  });
}
