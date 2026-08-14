/**
 * Standardized export-table/view builder for Premium pipelines.
 *
 * When a pipeline has an export_table_fqn set, Prism maintains a Snowflake
 * object that mirrors the source table but with the watched column replaced by
 * the confirmed canonical alias name.  Only rows whose raw value has a
 * confirmed mapping in LITERAL_ALIAS_MATCHES are included — unmapped rows are
 * intentionally excluded.
 *
 * export_kind = 'table' (default): a materialized copy, rebuilt with
 * CREATE OR REPLACE TABLE … AS SELECT … after each standardization pass so it
 * is always a complete, consistent snapshot. Costs storage + rebuild compute
 * on every pass, but reads are fast and it supports downstream streams.
 *
 * export_kind = 'view': a live Snowflake VIEW, created once with
 * CREATE OR REPLACE VIEW … AS SELECT … . It always reflects the current
 * source + lookup data with zero storage and zero rebuild compute — the join
 * cost is paid at query time by whoever reads it instead. Callers should only
 * invoke this for a view on initial creation/reactivation or from the
 * refresh-export route (the user-facing repair path for a missing/dropped
 * view), not on every poll cycle (see pipeline-poller.ts /
 * pipeline-hourly-processor.ts). Activation failures are flagged on the card
 * via flagPipelineMessage — a view has no periodic retry, so a silent failure
 * there means the view simply never exists.
 *
 * Required Snowflake privileges for the service role:
 *   - SELECT on the source table
 *   - USAGE on the source database and schema (for INFORMATION_SCHEMA access)
 *   - CREATE TABLE on the export schema (table kind) and/or CREATE VIEW on
 *     the export schema (view kind)
 *   - USAGE on the internal schema's PRISM_NORMALIZE (the join calls it by its
 *     fully qualified name — see the comment on the join clause below for why
 *     it must never be written bare)
 */

import 'server-only';
import { withWarehouse, withUserWarehouse, hasUserWarehouseConfig, executeQuery as exec, getWarehouseAdapter, isWarehouseAccessError } from './warehouse';
// Defined in the neutral adapter-contract module so BOTH builders can throw it.
import { ColumnModeAccessError } from './warehouse/types';
export { ColumnModeAccessError };
import {
  refreshExportTableMssql, refreshStandardizedColumnsMssql, computeMappedCountsMssql, listSourceColumnsMssql,
  hasTableModePermissions, grantTableModePermissions, tableModeSetupSql,
  columnModeSetupSqlMssql,
} from './warehouse/mssql/export';
import {
  refreshExportTablePg, refreshStandardizedColumnsPg, computeMappedCountsPg, listSourceColumnsPg,
  columnModeSetupSqlPg,
} from './warehouse/postgres/export';
import { quoteIdent as pgQuoteIdent } from './warehouse/postgres/dialect';
import { getServiceRoleName } from './warehouse/postgres/connection';
import { pgTableRef } from './warehouse/postgres/detection';
import {
  refreshExportTableMysql, refreshStandardizedColumnsMysql, computeMappedCountsMysql, listSourceColumnsMysql,
  columnModeSetupSqlMysql,
} from './warehouse/mysql/export';
import { quoteIdent as myQuoteIdent } from './warehouse/mysql/dialect';
import { getServiceAccountName as myServiceAccount } from './warehouse/mysql/connection';
import { myTableRef } from './warehouse/mysql/detection';

/** schema-qualified pg reference (cross-database FQNs rejected inside). */
const pgRefOf = (fqn: string): string => pgTableRef(fqn).ref;
import { quoteIdent as msQuoteIdent, parseFqn as msParseFqn } from './warehouse/mssql/dialect';
import { getServiceLoginName } from './warehouse/mssql/connection';
import { loadOpRunState } from './op-auto-group';
import { getDb } from './sqlite';
import { sqlStringLiteral, normalizeLiteral } from './normalize';
import { internalTable, prismNormalizeFn } from './warehouse-tables';
import { type ExportKind, standardizedColumnName, assertCompanionColumnSafe } from './export-kind';
import { pausePipelineWithMessage } from './pipeline-alerts';

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string): { db: string; schema: string; table: string } {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

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
  tier:      'pk' | 'unique' | 'cluster';
  /** ORDER BY expression referencing `src.<col>` columns. */
  orderExpr: string;
}

/** Key columns from a SHOW PRIMARY KEYS / SHOW UNIQUE KEYS result, in key
 *  sequence. Multiple unique constraints → the first by constraint name
 *  (deterministic). Returns [] when the table has none. */
function keyColumnsFromShow(rows: any[]): string[] {
  if (!rows.length) return [];
  const constraint = (r: any) => String(r.CONSTRAINT_NAME ?? r.constraint_name ?? '');
  const first = rows.map(constraint).sort()[0];
  return rows
    .filter(r => constraint(r) === first)
    .sort((a, b) =>
      Number(a.KEY_SEQUENCE ?? a.key_sequence ?? 0) - Number(b.KEY_SEQUENCE ?? b.key_sequence ?? 0))
    .map(r => String(r.COLUMN_NAME ?? r.column_name ?? ''))
    .filter(Boolean);
}

/**
 * Resolve how to order the export so it mirrors the source — ONLY when the
 * source table declares an ordering basis of its own:
 *   1. PRIMARY KEY columns
 *   2. else UNIQUE KEY columns (first constraint by name when several exist)
 *   3. else CLUSTERING KEY columns (the persistent "order by" a Snowflake
 *      table can carry), if they are plain columns
 *
 * Returns null when the table has none of these: the export is then built
 * unordered, with NO synthetic ordering column (product decision 2026-07 —
 * the old PRISM_ROW_ORDER column and its ingest-order fallback are gone).
 * Because the key columns exist in the export itself, consumers who need
 * source order can ORDER BY those columns directly.
 */
async function resolveSourceOrdering(
  conn:      any,
  src:       { db: string; schema: string; table: string },
  sourceRef: string,
): Promise<SourceOrdering | null> {
  // ── Tiers 1 + 2: primary key, then unique key (SHOW = metadata-layer) ──
  for (const { tier, sql } of [
    { tier: 'pk' as const,     sql: `SHOW PRIMARY KEYS IN TABLE ${sourceRef}` },
    { tier: 'unique' as const, sql: `SHOW UNIQUE KEYS IN TABLE ${sourceRef}` },
  ]) {
    try {
      const cols = keyColumnsFromShow(await exec(conn, sql));
      if (cols.length > 0) {
        return { tier, orderExpr: cols.map(c => `src.${quoteIdent(c)}`).join(', ') };
      }
    } catch { /* not permitted / unavailable — fall through */ }
  }

  // ── Tier 3: clustering key ─────────────────────────────────────────────
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

  return null;
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
  exportKind:   ExportKind = 'table',
): Promise<ExportTableResult> {
  return await withWarehouse(async (conn) => {
    if (getWarehouseAdapter().kind === 'mssql') {
      if (exportKind === 'column') {
        return await withColumnModeFailureSurfaced(
          pipelineId, source_fqn, column_name,
          () => refreshStandardizedColumnsMssql(conn, source_fqn, column_name, domain_id, pipelineId),
        );
      }
      try {
        return await refreshExportTableMssql(conn, source_fqn, column_name, export_fqn, domain_id, pipelineId, exportKind);
      } catch (err) {
        // Table-mode rebuilds need CREATE TABLE (database-scoped) + ALTER ON
        // SCHEMA (destination schema) — permissions the mssql onboarding
        // wizard doesn't grant up front (unlike Snowflake's Part D). Pause
        // with a fixable reason so the UI can offer the auto-grant instead of
        // just leaving a generic error banner on an otherwise-"active" card
        // that will keep failing every cycle until someone notices.
        if (pipelineId != null && isWarehouseAccessError(err)) {
          await pausePipelineWithMessage(
            pipelineId,
            `Prism needs CREATE TABLE and ALTER ON SCHEMA permissions to build ${export_fqn} — see the card for a one-click fix or the exact SQL to run yourself.`,
            'error',
            'table_mode_access',
          );
        }
        throw err;
      }
    }
    if (getWarehouseAdapter().kind === 'postgres') {
      if (exportKind === 'column') {
        return await withColumnModeFailureSurfaced(
          pipelineId, source_fqn, column_name,
          () => refreshStandardizedColumnsPg(conn, source_fqn, column_name, domain_id, pipelineId),
        );
      }
      // Table AND view kinds — the pg builder handles both (views are live
      // over persistent mapping tables; see warehouse/postgres/export.ts).
      return await refreshExportTablePg(conn, source_fqn, column_name, export_fqn, domain_id, pipelineId, exportKind === 'view' ? 'view' : 'table');
    }
    if (getWarehouseAdapter().kind === 'mysql') {
      if (exportKind === 'column') {
        return await withColumnModeFailureSurfaced(
          pipelineId, source_fqn, column_name,
          () => refreshStandardizedColumnsMysql(conn, source_fqn, column_name, domain_id, pipelineId),
        );
      }
      // Table AND view kinds — the mysql builder handles both (views are live
      // over persistent mapping tables; see warehouse/mysql/export.ts).
      return await refreshExportTableMysql(conn, source_fqn, column_name, export_fqn, domain_id, pipelineId, exportKind === 'view' ? 'view' : 'table');
    }
    if (exportKind === 'column') {
      return await withColumnModeFailureSurfaced(
        pipelineId, source_fqn, column_name,
        () => refreshStandardizedColumnsSnowflake(conn, source_fqn, column_name, domain_id, pipelineId),
      );
    }
    const src = parseFqn(source_fqn);
    const exp = parseFqn(export_fqn);

    // SAFETY: the table/view path must NEVER target the source table itself —
    // CREATE OR REPLACE would destroy the customer's data. (Column-mode
    // pipelines store export_table_fqn = table_fqn and are dispatched above;
    // this guard turns any mis-parsed kind into a loud error instead.)
    if (
      src.db.toUpperCase() === exp.db.toUpperCase() &&
      src.schema.toUpperCase() === exp.schema.toUpperCase() &&
      src.table.toUpperCase() === exp.table.toUpperCase()
    ) {
      throw new Error(
        `[ExportTable] Refusing to build an export over the source table itself (${source_fqn}). ` +
        `If this pipeline should write standardized columns onto the source, its export_kind must be 'column'.`,
      );
    }

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
    const siblingRows = getDb()
      .prepare(
        `SELECT pipeline_id, column_name, domain_id, export_unmapped_rows
         FROM pipelines
         WHERE table_fqn = ? AND export_table_fqn = ?`,
      )
      .all(source_fqn, export_fqn) as any[];

    // export_unmapped_rows is consistent across a table's columns (set at
    // creation). When TRUE every source row appears, with unmapped values shown
    // in raw form; when FALSE (the default) only rows whose values all have a
    // confirmed mapping appear. Applies to EVERY update schedule — 24/7
    // pipelines also hold unmapped values between ticks, during 5k-installment
    // backlog drains, and while paused (the old schedule-type gate that forced
    // mapped-only for 24/7 was removed 2026-07-22).
    const firstSibling = siblingRows[0] as any;
    const rawUnmapped = firstSibling
      ? (firstSibling.EXPORT_UNMAPPED_ROWS ?? firstSibling.export_unmapped_rows)
      : false;
    const includeUnmapped =
      rawUnmapped === true || rawUnmapped === 1 || rawUnmapped === 'true';

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
    //   TRUE requires the pipeline's export_unmapped_rows setting (any schedule).
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
      // PRISM_NORMALIZE must be FULLY QUALIFIED here, not left to the session
      // schema. This same SELECT body is used for `CREATE VIEW`, and Snowflake
      // resolves unqualified names in a stored view body against the VIEW's own
      // schema — not the schema the session had when the view was created. An
      // unqualified call therefore worked for the table build (which runs in
      // the session, schema = INTERNAL) but failed every view build whose
      // destination lived outside the internal schema — i.e. every realistic
      // customer destination — with "Unknown function PRISM_NORMALIZE".
      joinClauses.push(
        `LEFT JOIN ${internalTable('LITERAL_ALIAS_MATCHES')} ${lam}
        ON ${lam}.normalized_value = ${prismNormalizeFn()}(TO_VARCHAR(src.${quoteIdent(w.columnName)}))
        ${domainFilter}
      LEFT JOIN ${internalTable('APPROVED_ALIAS_NAMES')} ${aan}
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

    // ── Resolve source ordering ────────────────────────────────────────────
    // When the source declares its own ordering basis (PK / unique key /
    // clustering key), the TABLE build is physically sorted by it so a plain
    // SELECT * reads back mirroring the source, and consumers can ORDER BY the
    // same key columns (they exist in the export) for a guaranteed order. A
    // source with no such basis gets an unordered export — no synthetic
    // ordering column is added (the old PRISM_ROW_ORDER is gone).
    const ordering = await resolveSourceOrdering(conn, src, sourceRef);

    // ── Create / replace the export table or view ──────────────────────────
    // COPY GRANTS preserves consumers' privileges (e.g. SELECT granted to
    // downstream roles) across the rebuild — without it every CREATE OR REPLACE
    // drops all grants on the export object.
    // The trailing physical ORDER BY only applies to the TABLE case: a VIEW is
    // never materialized, so an ORDER BY there would force every consumer query
    // to re-sort at read time for no benefit.
    const selectBody =
      `SELECT
           ${selectList}
         FROM ${sourceRef} src
         ${joinClauses.join('\n      ')}
         ${whereClause}`;
    const createStmt = exportKind === 'view'
      ? `CREATE OR REPLACE VIEW ${exportRef} COPY GRANTS AS
         ${selectBody}`
      : `CREATE OR REPLACE TABLE ${exportRef} COPY GRANTS AS
         ${selectBody}
         ${ordering ? `ORDER BY ${ordering.orderExpr}` : ''}`;
    await exec(conn, createStmt);

    const countRows = await exec(conn, `SELECT COUNT(*) AS cnt FROM ${exportRef}`);
    const rows_written = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

    // Write each sibling pipeline its OWN per-column metrics — total non-null
    // rows and rows with a confirmed mapping for THAT column/domain. (Previously
    // every sibling got the shared export-table row count, which made the UI's
    // per-card aggregation, which sums across columns, double/garble the totals.)
    // The export table itself still reflects rows where ALL columns map (the
    // INNER JOINs above); only these per-pipeline counters are per-column.
    await refreshSnowflakeSiblingMetrics(conn, sourceRef, siblings);

    console.log(
      `[ExportTable] Rebuilt ${export_fqn} (${exportKind}) ← ${source_fqn} ` +
      `(columns: ${watched.map(w => w.columnName).join(', ')}; order: ${ordering?.tier ?? 'none'}) — ${rows_written} rows`,
    );

    return { rows_written };
  });
}

/** Thrown when a column-mode pipeline would target a companion-column name
 *  that ALREADY exists on the source table. Prism cannot tell a column it
 *  created apart from one the customer owns, so it refuses at creation time —
 *  the only moment the distinction is knowable. */
export class CompanionColumnConflictError extends Error {
  constructor(table_fqn: string, companionName: string) {
    super(
      `A column named "${companionName}" already exists on ${table_fqn}. Prism only writes ` +
      `to companion columns it creates itself, so it can't use the Column output for this ` +
      `column. If a previous Prism pipeline created "${companionName}", drop it and reconnect; ` +
      `otherwise rename the existing column or choose a different output mode.`,
    );
    this.name = 'CompanionColumnConflictError';
  }
}

/**
 * GUARDRAIL (creation-time) — refuse to create a column-mode pipeline whose
 * `<col>_STANDARDIZED` companion already exists on the source table. After
 * creation, an existing-but-missing-at-creation companion is by construction
 * Prism's own. Uses metadata-layer listing on both warehouses.
 */
export async function assertCompanionColumnAvailable(
  conn:        any,
  table_fqn:   string,
  column_name: string,
): Promise<void> {
  const companion = standardizedColumnName(column_name);
  let cols: string[];
  if (getWarehouseAdapter().kind === 'mssql') {
    cols = await listSourceColumnsMssql(conn, table_fqn);
  } else if (getWarehouseAdapter().kind === 'postgres') {
    cols = await listSourceColumnsPg(conn, table_fqn);
  } else if (getWarehouseAdapter().kind === 'mysql') {
    cols = await listSourceColumnsMysql(conn, table_fqn);
  } else {
    const src = parseFqn(table_fqn);
    const ref = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
    const rows = await exec(conn, `SHOW COLUMNS IN TABLE ${ref}`);
    cols = rows.map((r: any) => String(r['column_name'] ?? r.COLUMN_NAME ?? ''));
  }
  if (cols.some(c => c.toUpperCase() === companion.toUpperCase())) {
    throw new CompanionColumnConflictError(table_fqn, companion);
  }
}

/**
 * Runs a column-mode sync and SURFACES a permission failure on the pipeline
 * instead of letting it die in a server log (KI-123 / KI-145).
 *
 * Column mode writes onto the CUSTOMER's source table, so it depends on grants
 * that can disappear underneath it — the table gets recreated, or UPDATE/ALTER
 * is revoked. Every recurring caller of refreshExportTable catches and
 * console.logs; runOpExportDirect swallows it internally so it never reaches
 * processPipelineQueue's recordStandardizationFailure either, meaning the
 * 5-consecutive-failure auto-pause could not fire. Net effect, live-proven on
 * both warehouses with a genuine REVOKE: the pipeline stayed 'active' with no
 * status_message while silently no longer maintaining <col>_STANDARDIZED.
 *
 * Pausing with the exact fix SQL matches what the mssql table-mode branch and
 * the activation path already do. Rethrows so existing callers keep whatever
 * behaviour they had — this only adds the missing user-visible signal.
 */
/**
 * Why an ALTER/UPDATE against a column-mode source failed, and therefore what
 * remedy to offer.
 *
 * Every failure used to be reported as "adding a column requires ownership of
 * the table", which is only sometimes true. Live testing (OUT-08) hit two cases
 * where it was actively misleading: the object was a VIEW, and the table did
 * not exist — in both the user was sent to fix a permission that was not the
 * problem. The write still aborts safely either way, so this costs a support
 * round trip rather than data, but the message IS the entire remedy a customer
 * gets (ERR-DIAG-01).
 */
type ColumnModeFailure = 'missing' | 'not_a_table' | 'privilege';

function classifyColumnModeFailure(err: unknown): ColumnModeFailure {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? '').toLowerCase();
  // Order matters: Snowflake's "does not exist or not authorized" mentions
  // authorization too, but a missing object is the more actionable reading —
  // granting on something that isn't there cannot help.
  if (/does not exist|invalid identifier|cannot be found|object .* not found/.test(msg)) return 'missing';
  if (/is not a table|cannot alter view|not supported on view|is a view/.test(msg))      return 'not_a_table';
  return 'privilege';
}

/** The remedy sentence for a column-mode failure, matched to its actual cause. */
function columnModeRemedy(kind: ColumnModeFailure, source_fqn: string, column_name: string): string {
  switch (kind) {
    case 'missing':
      return `Prism can no longer find ${source_fqn}. It may have been dropped, renamed, or had access ` +
             `revoked. Point the pipeline at the current table, or restore it, then resume.`;
    case 'not_a_table':
      return `${source_fqn} is not a table, so a standardized column cannot be added to it. ` +
             `Column output writes onto the source itself — for a view, use Table or View output instead.`;
    default:
      return `Prism can no longer maintain the standardized column for "${column_name}" on ${source_fqn} — ` +
             `the required permissions are missing. Run this to restore it: ${columnModeSetupSql(source_fqn, column_name)}`;
  }
}

async function withColumnModeFailureSurfaced<T>(
  pipelineId:  number | null | undefined,
  source_fqn:  string,
  column_name: string,
  run:         () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // Classify on the TYPE and on the ORIGINAL error, not only on this error's
    // own text — a curated rethrow otherwise slips past every pattern.
    const isAccessFailure =
      err instanceof ColumnModeAccessError ||
      isWarehouseAccessError(err) ||
      isWarehouseAccessError((err as { cause?: unknown } | null)?.cause);
    if (pipelineId != null && isAccessFailure) {
      // Diagnose before prescribing: the underlying error, not the curated
      // rethrow, carries the real cause.
      const cause = (err as { cause?: unknown } | null)?.cause ?? err;
      await pausePipelineWithMessage(
        pipelineId,
        columnModeRemedy(classifyColumnModeFailure(cause), source_fqn, column_name),
        'error',
        'column_mode_access',
      ).catch(() => {});
    }
    throw err;
  }
}

/** The exact statements a customer admin runs to enable column mode for one
 *  table+column — also what the consent-time provisioning below executes.
 *  Onboarding deliberately grants NO write access on existing tables; this is
 *  the case-by-case consent setup. */
export function columnModeSetupSql(table_fqn: string, column_name: string): string {
  const companion = standardizedColumnName(column_name);
  if (getWarehouseAdapter().kind === 'mssql') {
    // ONE generator, defined in warehouse/mssql/export.ts. It lives there rather
    // than here only to keep the import direction sane (this file already
    // imports from that one). Previously each side hand-rolled its own copy and
    // they drifted: the copy inside the mssql builder emitted
    // `GRANT UPDATE ON <fqn> TO the Prism service login's role;` — prose, not
    // SQL — so an admin pasting the message from THAT surface got Msg 102 while
    // the same failure produced correct SQL elsewhere (PIPE-09 / OUT-15).
    return columnModeSetupSqlMssql(table_fqn, column_name);
  }
  if (getWarehouseAdapter().kind === 'postgres') {
    // Same one-generator rule as mssql — defined in warehouse/postgres/export.ts.
    return columnModeSetupSqlPg(table_fqn, column_name);
  }
  if (getWarehouseAdapter().kind === 'mysql') {
    // Same one-generator rule — defined in warehouse/mysql/export.ts.
    return columnModeSetupSqlMysql(table_fqn, column_name);
  }

  // Same ordering rule as the mssql branch above — see that comment.
  return (
    `GRANT UPDATE ON TABLE ${table_fqn} TO ROLE PRISM_SERVICE; ` +
    `ALTER TABLE ${table_fqn} ADD COLUMN IF NOT EXISTS "${companion}" VARCHAR;`
  );
}

/**
 * Case-by-case consent provisioning for the Column output mode, executed with
 * the pipeline CREATOR'S personal warehouse credentials (same pattern as the
 * change-tracking auto-fix — the service role deliberately cannot grant its
 * way onto customer tables, and adding a column needs table ownership, which
 * UPDATE does not confer). Two statements, scoped to ONE table:
 *   1. create the `<col>_STANDARDIZED` companion column (IF NOT EXISTS)
 *   2. GRANT UPDATE on that table to the service role
 * Returns 'granted' on success, 'manual_required' when the creator has no
 * saved personal credentials or either statement fails (caller surfaces
 * columnModeSetupSql() for the admin to run). The companion-conflict guard
 * (assertCompanionColumnAvailable) must have passed before this runs, so the
 * ADD COLUMN can only ever create Prism's own column.
 */
export async function provisionColumnModeAccess(
  table_fqn:        string,
  column_name:      string,
  creatorAccountId: number,
): Promise<'granted' | 'manual_required'> {
  if (!Number.isFinite(creatorAccountId) || !(await hasUserWarehouseConfig(creatorAccountId))) {
    return 'manual_required';
  }
  const companion = standardizedColumnName(column_name);
  assertCompanionColumnSafe(companion, [column_name]); // guardrail — creator-cred path too
  try {
    await withUserWarehouse(creatorAccountId, async (conn) => {
      if (getWarehouseAdapter().kind === 'mssql') {
        // TWO separate round trips, deliberately NOT columnModeSetupSql's
        // single batch string. Sending them as one batch let the ALTER run
        // even after the GRANT failed (T-SQL continues past a statement-level
        // runtime error), which is what stranded an orphan companion column on
        // the customer's table. As separate calls, a failed GRANT throws here
        // and the ALTER is never reached — the guarantee we actually want, and
        // it does not depend on transaction semantics at all.
        const p = msParseFqn(table_fqn);
        const obj = `${msQuoteIdent(p.schema)}.${msQuoteIdent(p.table)}`;
        await exec(conn, `USE ${msQuoteIdent(p.db)}; GRANT UPDATE ON OBJECT::${obj} TO ${msQuoteIdent(getServiceLoginName())};`);
        await exec(
          conn,
          `USE ${msQuoteIdent(p.db)}; IF COL_LENGTH('${p.schema}.${p.table}', '${companion.replace(/'/g, "''")}') IS NULL ` +
          `ALTER TABLE ${obj} ADD ${msQuoteIdent(companion)} NVARCHAR(450) NULL;`,
        );
      } else if (getWarehouseAdapter().kind === 'postgres') {
        const ref = pgRefOf(table_fqn);
        // GRANT first — same ordering rule as the other warehouses: a failed
        // GRANT must not leave an orphan companion column behind.
        await exec(conn, `GRANT UPDATE ON ${ref} TO ${pgQuoteIdent(getServiceRoleName())}`);
        await exec(conn, `ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS ${pgQuoteIdent(companion)} VARCHAR(450)`);
      } else if (getWarehouseAdapter().kind === 'mysql') {
        const { ref } = myTableRef(table_fqn);
        // GRANT first (same ordering rule); no ADD COLUMN IF NOT EXISTS on
        // MySQL — duplicate-column (errno 1060) reads as already-provisioned.
        await exec(conn, `GRANT UPDATE ON ${ref} TO '${myServiceAccount().replace(/'/g, "''")}'@'%'`);
        try {
          await exec(conn, `ALTER TABLE ${ref} ADD COLUMN ${myQuoteIdent(companion)} VARCHAR(450) NULL`);
        } catch (e) {
          if (Number((e as { errno?: number } | null)?.errno) !== 1060) throw e;
        }
      } else {
        const src = parseFqn(table_fqn);
        const ref = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
        // GRANT first — see columnModeSetupSql's ordering comment. A failed
        // GRANT must not leave an orphan companion column behind that the
        // creation-time conflict guard will later refuse to work with.
        await exec(conn, `GRANT UPDATE ON TABLE ${ref} TO ROLE PRISM_SERVICE`);
        await exec(conn, `ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS ${quoteIdent(companion)} VARCHAR`);
      }
    });
    console.log(`[ColumnMode] Provisioned "${companion}" + UPDATE grant on ${table_fqn} via account ${creatorAccountId}'s credentials`);
    return 'granted';
  } catch (e) {
    console.warn(`[ColumnMode] Consent provisioning failed for ${table_fqn}:`, (e as any)?.message ?? e);
    return 'manual_required';
  }
}

/**
 * mssql only — table-mode export provisioning, executed with the pipeline
 * CREATOR'S personal credentials (same "service role can't grant its own way
 * onto customer schemas" reasoning as the Column-mode and Change-Tracking
 * auto-fixes). Grants prism_svc CREATE TABLE (database-scoped) and ALTER ON
 * SCHEMA (the destination schema) — required for the table-rebuild's
 * SELECT INTO + DROP/sp_rename swap. No-op on Snowflake: its onboarding
 * wizard's Part D already includes CREATE TABLE/CREATE VIEW for configured
 * schemas, so this gap doesn't exist there.
 * Returns 'granted' on success, 'manual_required' when the creator has no
 * saved personal credentials or the grant fails (caller surfaces
 * tableModeSetupSql() for the admin to run).
 */
export async function provisionTableModeAccess(
  export_table_fqn: string,
  creatorAccountId:  number,
): Promise<'granted' | 'manual_required' | 'not_applicable'> {
  if (getWarehouseAdapter().kind !== 'mssql') return 'not_applicable';
  if (!Number.isFinite(creatorAccountId) || !(await hasUserWarehouseConfig(creatorAccountId))) {
    return 'manual_required';
  }
  try {
    await withUserWarehouse(creatorAccountId, async (conn) => {
      await grantTableModePermissions(conn, export_table_fqn);
    });
    console.log(`[TableMode] Granted CREATE TABLE + ALTER ON SCHEMA for ${export_table_fqn} via account ${creatorAccountId}'s credentials`);
    return 'granted' as const;
  } catch (e) {
    console.warn(`[TableMode] Provisioning failed for ${export_table_fqn}:`, (e as any)?.message ?? e);
    return 'manual_required' as const;
  }
}

/** Metadata-only pre-check (no elevated rights needed) — lets callers decide
 *  whether to bother attempting provisioning at all. Always true on
 *  Snowflake (no such gap there). */
export async function checkTableModeAccess(export_table_fqn: string): Promise<boolean> {
  if (getWarehouseAdapter().kind !== 'mssql') return true;
  return await withWarehouse((conn) => hasTableModePermissions(conn, export_table_fqn));
}

export { tableModeSetupSql };

interface SiblingMetric { pipelineId: number; columnName: string; domainId: number | null }

/**
 * Per-sibling metric refresh shared by the table/view rebuild and the
 * standardized-column sync: recomputes total_source_values / total_mapped for
 * each pipeline's OWN column and stamps export_updated_at (+ fully_synced_at
 * when the queue is empty). fully_synced_at's FIRST-EVER stamp (still NULL
 * going in) uses created_at instead of now(): that rebuild's data is the
 * initial baseline scan's snapshot, taken back at pipeline creation, not
 * "just now" — review can sit for a while before Accept/activate actually
 * runs this. Every later rebuild still stamps the real current time.
 * Aggregates the source ONCE by normalized value,
 * then counts mapped via a semi-join (IN) against the DISTINCT lookup keys —
 * no per-row UDF on the lookup side and no row fan-out.
 */
async function refreshSnowflakeSiblingMetrics(
  conn:      any,
  sourceRef: string,
  siblings:  SiblingMetric[],
): Promise<void> {
  for (const s of siblings) {
    const colRef = quoteIdent(s.columnName);
    const domainFilter = s.domainId != null
      ? `AND lam.domain_id = ${Number(s.domainId)}`
      : `AND lam.domain_id IS NULL`;
    const [statsRow] = await exec(conn,
      `WITH src_agg AS (
         SELECT ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef})) AS nv, COUNT(*) AS freq
         FROM ${sourceRef} src
         WHERE src.${colRef} IS NOT NULL
         GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef}))
       )
       SELECT
         COALESCE(SUM(sa.freq), 0) AS total_source,
         COALESCE(SUM(CASE WHEN sa.nv IN (
           SELECT lam.normalized_value
           FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
           WHERE 1=1 ${domainFilter}
         ) THEN sa.freq ELSE 0 END), 0) AS total_mapped
       FROM src_agg sa`);
    const totalSource = Number((statsRow as any)?.TOTAL_SOURCE ?? (statsRow as any)?.total_source ?? 0);
    const totalMapped = Number((statsRow as any)?.TOTAL_MAPPED  ?? (statsRow as any)?.total_mapped  ?? 0);
    getDb()
      .prepare(
        `UPDATE pipelines
         SET total_mapped = ?, total_source_values = ?,
             export_updated_at = CASE WHEN fully_synced_at IS NULL THEN created_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
             fully_synced_at   = CASE WHEN queue_size != 0 THEN fully_synced_at
                                      WHEN fully_synced_at IS NULL THEN created_at
                                      ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
             updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ?`,
      )
      .run(totalMapped, totalSource, s.pipelineId);
  }
}

/**
 * export_kind = 'column' — maintain a `<col>_STANDARDIZED` companion column on
 * the SOURCE table itself: canonical name where the raw value has a confirmed
 * mapping, NULL where it doesn't (or where the raw value is NULL).
 *
 * Never creates/drops/replaces any table. First run adds the missing companion
 * column(s) via ALTER TABLE; every run then applies two guarded UPDATEs per
 * watched column. Both UPDATEs only touch rows whose standardized value
 * actually CHANGES — critical, because the pipeline's own stream watches this
 * table: an unguarded rewrite would re-detect its own writes every cycle and
 * churn forever, while the guarded version settles after one echo cycle (the
 * echoed values are already in the lookup, so re-queuing them costs no LLM
 * calls and the follow-up sync updates 0 rows).
 *
 * Required privileges beyond SELECT: UPDATE on the source table (every sync),
 * and table ownership for the one-time ALTER TABLE ADD COLUMN. Failures throw
 * with the exact SQL the customer's admin must run — callers surface it
 * (poller pause status_message / refresh-export error).
 */
async function refreshStandardizedColumnsSnowflake(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId?: number,
): Promise<ExportTableResult> {
  const src = parseFqn(source_fqn);
  const sourceRef = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;

  // ── Gather all watched columns on this table (column-mode pipelines store
  //    export_table_fqn = table_fqn, so siblings share both) ────────────────
  const siblingRows = getDb()
    .prepare(
      `SELECT pipeline_id, column_name, domain_id
       FROM pipelines
       WHERE table_fqn = ? AND export_table_fqn = ? AND export_kind = 'column'`,
    )
    .all(source_fqn, source_fqn) as any[];

  interface Watched { columnName: string; domainId: number | null }
  const watchedByCol = new Map<string, Watched>();
  const siblings: SiblingMetric[] = [];
  for (const r of siblingRows) {
    const col = String(r.COLUMN_NAME ?? r.column_name ?? '').trim();
    if (!col) continue;
    const domR = r.DOMAIN_ID ?? r.domain_id;
    const dom  = domR == null ? null : Number(domR);
    watchedByCol.set(col.toUpperCase(), { columnName: col, domainId: dom });
    const pid = Number(r.PIPELINE_ID ?? r.pipeline_id);
    if (Number.isFinite(pid)) siblings.push({ pipelineId: pid, columnName: col, domainId: dom });
  }
  if (!watchedByCol.has(column_name.toUpperCase())) {
    watchedByCol.set(column_name.toUpperCase(), { columnName: column_name, domainId: domain_id });
  }
  if (pipelineId != null && !siblings.some(s => s.pipelineId === pipelineId)) {
    siblings.push({ pipelineId, columnName: column_name, domainId: domain_id });
  }
  const watched = Array.from(watchedByCol.values());

  // GUARDRAIL — every identifier this function will ALTER/UPDATE must be a
  // companion of a watched column and must not be a watched raw column.
  // Throws before ANY SQL runs; do not remove (see docs/PRELAUNCH_CHECKLIST.md).
  const watchedRawNames = watched.map(w => w.columnName);
  for (const w of watched) {
    assertCompanionColumnSafe(standardizedColumnName(w.columnName), watchedRawNames);
  }

  // ── Ensure the companion columns exist (SHOW COLUMNS is metadata-layer) ──
  const showRows = await exec(conn, `SHOW COLUMNS IN TABLE ${sourceRef}`);
  const existingCols = new Set(
    showRows.map((r: any) => String(r['column_name'] ?? r.COLUMN_NAME ?? '').toUpperCase()),
  );
  for (const w of watched) {
    const stdName = standardizedColumnName(w.columnName);
    if (existingCols.has(stdName.toUpperCase())) continue;
    try {
      await exec(conn, `ALTER TABLE ${sourceRef} ADD COLUMN ${quoteIdent(stdName)} VARCHAR`);
    } catch (err) {
      const kind = classifyColumnModeFailure(err);
      throw new ColumnModeAccessError(
        kind === 'privilege'
          ? `Prism could not add the standardized column "${stdName}" to ${source_fqn} — ` +
            `adding a column requires ownership of the table. Run in Snowflake as the table owner: ` +
            `ALTER TABLE ${source_fqn} ADD COLUMN "${stdName}" VARCHAR; ` +
            `GRANT UPDATE ON TABLE ${source_fqn} TO ROLE PRISM_SERVICE;`
          : columnModeRemedy(kind, source_fqn, w.columnName),
        { cause: err },
      );
    }
  }

  // ── Sync each companion column (guarded — steady state touches 0 rows) ───
  for (const w of watched) {
    const stdName = standardizedColumnName(w.columnName);
    assertCompanionColumnSafe(stdName, watchedRawNames); // guardrail — write target only
    const colRef = quoteIdent(w.columnName);
    const stdRef = quoteIdent(stdName);
    const domainFilter = w.domainId != null
      ? `AND lam.domain_id = ${Number(w.domainId)}`
      : `AND lam.domain_id IS NULL`;
    try {
      // Mapped values whose standardized value is missing or stale.
      await exec(conn,
        `UPDATE ${sourceRef}
         SET ${stdRef} = m.prism_alias_name
         FROM (
           SELECT lam.normalized_value AS prism_nv, MAX(aan.alias_name) AS prism_alias_name
           FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
           JOIN ${internalTable('APPROVED_ALIAS_NAMES')} aan ON aan.alias_id = lam.alias_id
           WHERE 1=1 ${domainFilter}
           GROUP BY lam.normalized_value
         ) m
         WHERE ${prismNormalizeFn()}(TO_VARCHAR(${sourceRef}.${colRef})) = m.prism_nv
           AND NOT EQUAL_NULL(${sourceRef}.${stdRef}, m.prism_alias_name)`);
      // Rows no longer mapped (raw value changed/cleared, or mapping removed).
      await exec(conn,
        `UPDATE ${sourceRef}
         SET ${stdRef} = NULL
         WHERE ${stdRef} IS NOT NULL
           AND (${colRef} IS NULL OR ${prismNormalizeFn()}(TO_VARCHAR(${colRef})) NOT IN (
             SELECT lam.normalized_value
             FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
             WHERE 1=1 ${domainFilter}
           ))`);
    } catch (err) {
      if (isWarehouseAccessError(err)) {
        throw new ColumnModeAccessError(
          `Prism does not have update access on ${source_fqn}, which the standardized-column ` +
          `output requires. Run in Snowflake: GRANT UPDATE ON TABLE ${source_fqn} TO ROLE PRISM_SERVICE;`,
        );
      }
      throw err;
    }
  }

  // rows_written = source rows that currently carry a standardized value.
  const anyStd = watched
    .map(w => `${quoteIdent(standardizedColumnName(w.columnName))} IS NOT NULL`)
    .join(' OR ');
  const countRows = await exec(conn, `SELECT COUNT(*) AS cnt FROM ${sourceRef} WHERE ${anyStd}`);
  const rows_written = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

  await refreshSnowflakeSiblingMetrics(conn, sourceRef, siblings);

  console.log(
    `[ExportTable] Synced standardized columns on ${source_fqn} ` +
    `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows standardized`,
  );
  return { rows_written };
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
  return await withWarehouse(async (conn) => {
    if (getWarehouseAdapter().kind === 'mssql' || getWarehouseAdapter().kind === 'postgres' || getWarehouseAdapter().kind === 'mysql') {
      const kind = getWarehouseAdapter().kind;
      const compute = kind === 'mssql' ? computeMappedCountsMssql : kind === 'mysql' ? computeMappedCountsMysql : computeMappedCountsPg;
      const { totalSource, totalMapped } = await compute(conn, source_fqn, column_name, domain_id);
      getDb()
        .prepare(
          `UPDATE pipelines
           SET total_mapped = ?, total_source_values = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE pipeline_id = ?`,
        )
        .run(totalMapped, totalSource, pipelineId);
      return;
    }
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
         SELECT ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef})) AS nv, COUNT(*) AS freq
         FROM ${tableRef} src
         WHERE src.${colRef} IS NOT NULL
         GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef}))
       )
       SELECT
         COALESCE(SUM(sa.freq), 0) AS total_source,
         COALESCE(SUM(CASE WHEN sa.nv IN (
           SELECT lam.normalized_value
           FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
           WHERE 1=1 ${domainFilter}
         ) THEN sa.freq ELSE 0 END), 0) AS total_mapped
       FROM src_agg sa`,
    );
    const mapped             = Number(statsRow?.TOTAL_MAPPED  ?? statsRow?.total_mapped  ?? 0);
    const totalSourceValues  = Number(statsRow?.TOTAL_SOURCE  ?? statsRow?.total_source  ?? 0);

    getDb()
      .prepare(
        `UPDATE pipelines
         SET total_mapped = ?, total_source_values = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ?`,
      )
      .run(mapped, totalSourceValues, pipelineId);
  });
}

