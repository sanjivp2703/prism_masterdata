/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// PostgreSQL export builder (docs/POSTGRES_PORT_PLAN.md Phase P3).
//
// Same staging-join design as the mssql builder (no SQL-side normalize —
// decision 2.3): distinct raw values → app-side normalizeLiteral + alias
// resolve → exact-match staging table (COLLATE "C") → source LEFT JOIN staging
// on raw equality. Postgres differences, all deliberate:
//   * The swap is genuinely transactional (DDL participates in transactions):
//     BEGIN; DROP old; ALTER new RENAME; COMMIT — no sp_rename dance.
//   * export_kind 'view' IS supported (refused on mssql): the view reads
//     source LEFT JOIN PERSISTENT per-column mapping tables whose CONTENT is
//     refreshed each rebuild — the view object itself is stable, so new rows
//     of already-mapped values appear through it immediately.
//   * No DENY concept and no grant-visibility trap: ACLs are readable from
//     information_schema by the object owner (Prism creates these objects, so
//     it owns them), captured and re-applied after each swap.
import 'server-only';

import crypto from 'node:crypto';

import { getDb } from '../../sqlite';
import { normalizeLiteral } from '../../normalize';
import { standardizedColumnName, assertCompanionColumnSafe } from '../../export-kind';
import { executeQuery as exec, getServiceRoleName } from './connection';
import { ColumnModeAccessError } from '../types';
import { quoteIdent } from './dialect';
import { pgTableRef, getPrimaryKeyColumns } from './detection';

// Lookup literal_value is VARCHAR(800) — longer source values can never be
// mapped, so staging skips them and the join misses them (⇒ unmapped).
const STAGING_VALUE_LEN = 800;
// Distinct-value ceiling per watched column (values pass through app memory).
const EXPORT_MAX_DISTINCT = 100_000;
const IN_BATCH = 5_000;             // 1 bind/value (+1 scope) per lookup batch
const STAGING_INSERT_BATCH = 5_000; // 2 binds/row

export interface PgExportResult { rows_written: number; }

function exportRefOf(fqn: string): { ref: string; schema: string; table: string } {
  return pgTableRef(fqn);
}

// ── The staging builder (shared by table, view and column modes) ─────────────

/**
 * Fill `stgRef` (which must already exist with raw_value/alias_name columns)
 * with the exact-match mapping for one watched column: distinct raw values
 * (bounded at EXPORT_MAX_DISTINCT, read under COLLATE "C" so byte-distinct
 * variants each get their own row — the join is byte-exact too), normalized
 * app-side, aliases resolved from the lookup in batched IN queries.
 */
async function fillAliasStaging(
  conn:      any,
  sourceRef: string,
  colName:   string,
  domainId:  number | null,
  stgRef:    string,
): Promise<void> {
  const colRef = quoteIdent(colName);

  // 1. Distinct raw values (bounded). COLLATE "C" keeps byte-distinct
  //    variants distinct even under a nondeterministic database collation —
  //    the same two-halves consistency rule as the mssql BIN2 comment.
  const distinctRows = await exec(
    conn,
    `SELECT DISTINCT ${colRef} COLLATE "C" AS v
     FROM ${sourceRef} WHERE ${colRef} IS NOT NULL
     LIMIT ${EXPORT_MAX_DISTINCT + 1}`,
  );
  if (distinctRows.length > EXPORT_MAX_DISTINCT) {
    throw new Error(
      `[ExportTable/pg] Column "${colName}" has more than ${EXPORT_MAX_DISTINCT.toLocaleString()} distinct values — not a standardizable categorical column.`,
    );
  }

  // 2. Normalize app-side and resolve aliases from the lookup (batched).
  const rawByNorm = new Map<string, string[]>();
  for (const r of distinctRows) {
    const raw = String(r.v);
    if (raw.length > STAGING_VALUE_LEN) continue; // can never be in the lookup
    const norm = normalizeLiteral(raw);
    if (!norm) continue;
    const arr = rawByNorm.get(norm) ?? [];
    arr.push(raw);
    rawByNorm.set(norm, arr);
  }
  const norms = [...rawByNorm.keys()];
  const aliasByNorm = new Map<string, string>();
  const domainFilter = domainId != null ? `AND lam.domain_id = ?` : `AND lam.domain_id IS NULL`;
  for (let j = 0; j < norms.length; j += IN_BATCH) {
    const batch = norms.slice(j, j + IN_BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const binds: any[] = [...batch];
    if (domainId != null) binds.push(domainId);
    const rows = await exec(
      conn,
      `SELECT lam.normalized_value AS nv, aan.alias_name AS an
       FROM prism_internal.literal_alias_matches lam
       JOIN prism_internal.approved_alias_names aan ON aan.alias_id = lam.alias_id
       WHERE lam.normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const r of rows) aliasByNorm.set(String(r.nv), String(r.an));
  }

  // 3. Insert the mapping rows.
  const stagingRows: Array<[string, string]> = [];
  for (const [norm, raws] of rawByNorm) {
    const alias = aliasByNorm.get(norm);
    if (!alias) continue;
    for (const raw of raws) stagingRows.push([raw, alias]);
  }
  for (let j = 0; j < stagingRows.length; j += STAGING_INSERT_BATCH) {
    const batch = stagingRows.slice(j, j + STAGING_INSERT_BATCH);
    const valuesRows = batch.map(() => '(?, ?)').join(', ');
    await exec(conn, `INSERT INTO ${stgRef} (raw_value, alias_name) VALUES ${valuesRows}`, batch.flat());
  }
}

const STAGING_DDL = (stgRef: string) =>
  `CREATE TABLE ${stgRef} (
     raw_value  VARCHAR(${STAGING_VALUE_LEN}) COLLATE "C" NOT NULL PRIMARY KEY,
     alias_name VARCHAR(450) COLLATE "C" NOT NULL
   )`;

/** Per-rebuild throwaway staging (table mode). Caller owns dropping it. */
async function materializeTempStaging(
  conn: any, sourceRef: string, colName: string, domainId: number | null, stgRef: string,
): Promise<void> {
  await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`);
  await exec(conn, STAGING_DDL(stgRef));
  await fillAliasStaging(conn, sourceRef, colName, domainId, stgRef);
}

/** Persistent per-column mapping table (view mode) — stable name derived from
 *  the export FQN + column, refreshed transactionally so the live view never
 *  sees a half-empty mapping. */
export function viewMapRef(export_fqn: string, columnName: string): string {
  const hash = crypto.createHash('md5').update(`${export_fqn}::${columnName}`).digest('hex').slice(0, 16);
  return `prism_internal.${quoteIdent(`viewmap_${hash}`)}`;
}

async function refreshPersistentStaging(
  conn: any, sourceRef: string, colName: string, domainId: number | null, stgRef: string,
): Promise<void> {
  const exists = await exec(
    conn,
    `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = 'prism_internal' AND table_name = ?`,
    [stgRef.split('.')[1].replace(/^"|"$/g, '').replace(/""/g, '"')],
  );
  if (!exists.length) await exec(conn, STAGING_DDL(stgRef));
  await exec(conn, `BEGIN`);
  try {
    await exec(conn, `DELETE FROM ${stgRef}`);
    await fillAliasStaging(conn, sourceRef, colName, domainId, stgRef);
    await exec(conn, `COMMIT`);
  } catch (err) {
    await exec(conn, `ROLLBACK`).catch(() => {});
    throw err;
  }
}

// ── Sibling resolution (same SQLite logic as the other builders) ─────────────

interface Watched { columnName: string; domainId: number | null }
interface SiblingMeta { pipelineId: number; columnName: string; domainId: number | null }

function resolveSiblings(
  source_fqn: string, export_fqn: string, column_name: string, domain_id: number | null,
  pipelineId: number | undefined, columnModeOnly: boolean,
): { watched: Watched[]; siblings: SiblingMeta[]; includeUnmapped: boolean } {
  const siblingRows = getDb()
    .prepare(
      `SELECT pipeline_id, column_name, domain_id, export_unmapped_rows
       FROM pipelines
       WHERE table_fqn = ? AND export_table_fqn = ?${columnModeOnly ? ` AND export_kind = 'column'` : ''}`,
    )
    .all(source_fqn, export_fqn) as any[];

  const firstSibling = siblingRows[0];
  const rawUnmapped = firstSibling ? firstSibling.export_unmapped_rows : false;
  const includeUnmapped = rawUnmapped === true || rawUnmapped === 1 || rawUnmapped === 'true';

  const watchedByCol = new Map<string, Watched>();
  const siblings: SiblingMeta[] = [];
  for (const r of siblingRows) {
    const col = String(r.column_name ?? '').trim();
    if (!col) continue;
    const dom = r.domain_id == null ? null : Number(r.domain_id);
    watchedByCol.set(col.toUpperCase(), { columnName: col, domainId: dom });
    const pid = Number(r.pipeline_id);
    if (Number.isFinite(pid)) siblings.push({ pipelineId: pid, columnName: col, domainId: dom });
  }
  if (!watchedByCol.has(column_name.toUpperCase())) {
    watchedByCol.set(column_name.toUpperCase(), { columnName: column_name, domainId: domain_id });
  }
  if (pipelineId != null && !siblings.some(s => s.pipelineId === pipelineId)) {
    siblings.push({ pipelineId, columnName: column_name, domainId: domain_id });
  }
  return { watched: Array.from(watchedByCol.values()), siblings, includeUnmapped };
}

function stampSiblingMetrics(siblings: SiblingMeta[], counts: Map<number, { totalSource: number; totalMapped: number }>): void {
  // Same SQLite stamps as the other builders, incl. the first-ever-stamp →
  // created_at special case (baseline data predates activation).
  for (const s of siblings) {
    const c = counts.get(s.pipelineId);
    if (!c) continue;
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
      .run(c.totalMapped, c.totalSource, s.pipelineId);
  }
}

// ── Table + view rebuild ─────────────────────────────────────────────────────

export async function refreshExportTablePg(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  export_fqn:  string,
  domain_id:   number | null,
  pipelineId?: number,
  exportKind:  'table' | 'view' = 'table',
): Promise<PgExportResult> {
  const src = pgTableRef(source_fqn);
  const exp = exportRefOf(export_fqn);

  // SAFETY: never target the source table itself — the swap would DROP the
  // customer's data. (Column-mode pipelines are dispatched to
  // refreshStandardizedColumnsPg before reaching here.)
  if (src.schema.toLowerCase() === exp.schema.toLowerCase() && src.table.toLowerCase() === exp.table.toLowerCase()) {
    throw new Error(
      `[ExportTable/pg] Refusing to build an export over the source table itself (${source_fqn}). ` +
      `If this pipeline should write standardized columns onto the source, its export_kind must be 'column'.`,
    );
  }

  // ── Source columns (ordinal order) ─────────────────────────────────────────
  const colRows = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [src.schema, src.table],
  );
  if (!colRows.length) {
    throw new Error(`[ExportTable/pg] No columns found for ${source_fqn}. Verify the table exists and the service role can read it.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.col));

  const { watched, siblings, includeUnmapped } = resolveSiblings(source_fqn, export_fqn, column_name, domain_id, pipelineId, false);

  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const tempStagingRefs: string[] = [];

  try {
    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    const whereConds: string[] = [];

    for (let i = 0; i < watched.length; i++) {
      const w = watched[i];
      const colRef = quoteIdent(w.columnName);
      let stgRef: string;
      if (exportKind === 'view') {
        stgRef = viewMapRef(export_fqn, w.columnName);
        await refreshPersistentStaging(conn, src.ref, w.columnName, w.domainId, stgRef);
      } else {
        stgRef = `prism_internal.${quoteIdent(`export_stg_${pipelineId ?? 0}_${i}_${nonce}`)}`;
        tempStagingRefs.push(stgRef);
        await materializeTempStaging(conn, src.ref, w.columnName, w.domainId, stgRef);
      }

      const stg = `stg_${i}`;
      const colSql = includeUnmapped
        ? `COALESCE(${stg}.alias_name, src.${colRef}) AS ${colRef}`
        : `${stg}.alias_name AS ${colRef}`;
      replaceMap.set(w.columnName.toUpperCase(), colSql);
      joinClauses.push(
        `LEFT JOIN ${stgRef} ${stg}
          ON src.${colRef} COLLATE "C" = ${stg}.raw_value`,
      );
      if (!includeUnmapped) {
        whereConds.push(`(src.${colRef} IS NULL OR ${stg}.raw_value IS NOT NULL)`);
      }
    }

    const selectList = sourceCols
      .map(col => replaceMap.get(col.toUpperCase()) ?? `src.${quoteIdent(col)}`)
      .join(',\n         ');
    const whereClause = whereConds.length ? `WHERE ${whereConds.join('\n        AND ')}` : '';
    const bodySql =
      `SELECT ${selectList}
       FROM ${src.ref} src
       ${joinClauses.join('\n       ')}
       ${whereClause}`;

    let rows_written = 0;

    if (exportKind === 'view') {
      // The view object is created once and kept; its mapping tables were just
      // refreshed above. CREATE OR REPLACE fails when the output column set
      // changed (source schema drift) — fall back to DROP + CREATE with ACL
      // capture/re-apply so consumer grants survive.
      const viewSql = `CREATE OR REPLACE VIEW ${exp.ref} AS ${bodySql}`;
      try {
        await exec(conn, viewSql);
      } catch {
        const acl = await captureAcl(conn, exp.schema, exp.table);
        await exec(conn, `BEGIN`);
        try {
          await exec(conn, `DROP VIEW IF EXISTS ${exp.ref}`);
          await exec(conn, viewSql);
          await exec(conn, `COMMIT`);
        } catch (err) {
          await exec(conn, `ROLLBACK`).catch(() => {});
          throw err;
        }
        await reapplyAcl(conn, exp.ref, acl, export_fqn);
      }
      const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${exp.ref}`);
      rows_written = Number(countRows[0]?.c ?? 0);
    } else {
      // ── Ordering: PK → unique index (Postgres has no clustering keys) ──────
      const ordering = await resolveSourceOrderingPg(conn, source_fqn);

      const newTable = `${exp.table}__prism_new_${nonce}`;
      const newRef = `${quoteIdent(exp.schema)}.${quoteIdent(newTable)}`;
      await exec(conn, `DROP TABLE IF EXISTS ${newRef}`);
      // CTAS honours ORDER BY for the physical write order. As everywhere:
      // physical order is best-effort — consumers who need guaranteed order
      // ORDER BY the key columns themselves.
      await exec(
        conn,
        `CREATE TABLE ${newRef} AS
         ${bodySql}
         ${ordering ? `ORDER BY ${ordering.orderExpr}` : ''}`,
      );

      // Capture ACLs, then swap — genuinely atomic (transactional DDL).
      const acl = await captureAcl(conn, exp.schema, exp.table);
      await exec(conn, `BEGIN`);
      try {
        await exec(conn, `DROP TABLE IF EXISTS ${exp.ref}`);
        await exec(conn, `ALTER TABLE ${newRef} RENAME TO ${quoteIdent(exp.table)}`);
        await exec(conn, `COMMIT`);
      } catch (err) {
        await exec(conn, `ROLLBACK`).catch(() => {});
        throw err;
      }
      await reapplyAcl(conn, exp.ref, acl, export_fqn);

      const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${exp.ref}`);
      rows_written = Number(countRows[0]?.c ?? 0);

      if (ordering) {
        console.log(`[ExportTable/pg] Rebuilt ${export_fqn} ← ${source_fqn} (order: ${ordering.tier}) — ${rows_written} rows`);
      }
    }

    // ── Per-sibling metrics ────────────────────────────────────────────────
    const counts = new Map<number, { totalSource: number; totalMapped: number }>();
    for (const s of siblings) {
      counts.set(s.pipelineId, await computeMappedCountsPg(conn, source_fqn, s.columnName, s.domainId));
    }
    stampSiblingMetrics(siblings, counts);

    console.log(
      `[ExportTable/pg] ${exportKind === 'view' ? 'Refreshed view mappings for' : 'Rebuilt'} ${export_fqn} ← ${source_fqn} ` +
      `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows`,
    );
    return { rows_written };
  } finally {
    for (const stgRef of tempStagingRefs) {
      await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`).catch(() => {});
    }
  }
}

// ── ACL capture / re-apply (no COPY GRANTS equivalent) ───────────────────────
// Prism owns the objects it creates, so information_schema shows their full
// grant lists to it — no mssql-style visibility trap. Postgres has no DENY.

interface CapturedGrant { grantee: string; privilege: string; grantable: boolean; column: string | null }

async function captureAcl(conn: any, schema: string, table: string): Promise<CapturedGrant[]> {
  const tableGrants = await exec(
    conn,
    `SELECT grantee, privilege_type AS privilege, is_grantable AS grantable
     FROM information_schema.role_table_grants
     WHERE table_schema = ? AND table_name = ? AND grantee NOT IN ('PUBLIC') AND grantor != grantee`,
    [schema, table],
  ).catch(() => [] as any[]);
  const colGrants = await exec(
    conn,
    `SELECT grantee, privilege_type AS privilege, is_grantable AS grantable, column_name AS col
     FROM information_schema.column_privileges
     WHERE table_schema = ? AND table_name = ? AND grantee NOT IN ('PUBLIC') AND grantor != grantee`,
    [schema, table],
  ).catch(() => [] as any[]);

  const grants: CapturedGrant[] = [];
  const tableLevel = new Set<string>();
  for (const g of tableGrants) {
    const key = `${g.grantee}::${g.privilege}`;
    tableLevel.add(key);
    grants.push({ grantee: String(g.grantee), privilege: String(g.privilege), grantable: String(g.grantable).toUpperCase() === 'YES', column: null });
  }
  for (const g of colGrants) {
    // information_schema.column_privileges expands table-level grants to every
    // column — only keep genuinely column-scoped ones (no table-level twin),
    // otherwise a re-grant would widen nothing but spam per-column grants.
    if (tableLevel.has(`${g.grantee}::${g.privilege}`)) continue;
    grants.push({ grantee: String(g.grantee), privilege: String(g.privilege), grantable: String(g.grantable).toUpperCase() === 'YES', column: String(g.col) });
  }
  return grants;
}

async function reapplyAcl(conn: any, targetRef: string, grants: CapturedGrant[], displayFqn: string): Promise<void> {
  for (const g of grants) {
    if (!/^[A-Z ]+$/i.test(g.privilege)) continue;
    const scope = g.column != null ? `${g.privilege} (${quoteIdent(g.column)})` : g.privilege;
    const stmt = `GRANT ${scope} ON ${targetRef} TO ${quoteIdent(g.grantee)}${g.grantable ? ' WITH GRANT OPTION' : ''}`;
    try {
      await exec(conn, stmt);
    } catch (e) {
      console.warn(`[ExportTable/pg] Could not re-apply GRANT ${g.privilege} to ${g.grantee} on ${displayFqn}:`, (e as any)?.message ?? e);
    }
  }
}

// ── Standardized-column sync (export_kind = 'column') ────────────────────────

/** The exact SQL a customer admin runs to enable Column output mode for one
 *  table+column on Postgres. ADD COLUMN requires table OWNERSHIP (which
 *  UPDATE does not confer), hence the admin-run block; the transaction makes
 *  it all-or-nothing. */
export function columnModeSetupSqlPg(table_fqn: string, column_name: string): string {
  const { ref } = pgTableRef(table_fqn);
  const companion = standardizedColumnName(column_name);
  return (
    `BEGIN; ` +
    `GRANT UPDATE ON ${ref} TO ${quoteIdent(getServiceRoleName())}; ` +
    `ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS ${quoteIdent(companion)} VARCHAR(450); ` +
    `COMMIT;`
  );
}

export async function refreshStandardizedColumnsPg(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId?: number,
): Promise<PgExportResult> {
  const src = pgTableRef(source_fqn);
  const { watched, siblings } = resolveSiblings(source_fqn, source_fqn, column_name, domain_id, pipelineId, true);

  // GUARDRAIL — every identifier this function will ALTER/UPDATE must be a
  // companion of a watched column and must not be a watched raw column.
  const watchedRawNames = watched.map(w => w.columnName);
  for (const w of watched) {
    assertCompanionColumnSafe(standardizedColumnName(w.columnName), watchedRawNames);
  }

  // ── Ensure the companion columns exist ─────────────────────────────────────
  const existing = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
    [src.schema, src.table],
  );
  const existingCols = new Set(existing.map((r: any) => String(r.col).toUpperCase()));
  for (const w of watched) {
    const stdName = standardizedColumnName(w.columnName);
    if (existingCols.has(stdName.toUpperCase())) continue;
    try {
      await exec(conn, `ALTER TABLE ${src.ref} ADD COLUMN IF NOT EXISTS ${quoteIdent(stdName)} VARCHAR(450)`);
    } catch (err) {
      // Typed, with the driver error preserved as `cause` — classification
      // travels by TYPE, never by matching text across a rethrow (OUT-15).
      throw new ColumnModeAccessError(
        `Prism could not add the standardized column "${stdName}" to ${source_fqn}. ` +
        `Run this as a Postgres admin: ${columnModeSetupSqlPg(source_fqn, w.columnName)}`,
        { cause: err },
      );
    }
  }

  // ── Sync each companion column via a temp staging table ────────────────────
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const stagingRefs: string[] = [];
  try {
    for (let i = 0; i < watched.length; i++) {
      const w = watched[i];
      const stdName = standardizedColumnName(w.columnName);
      assertCompanionColumnSafe(stdName, watchedRawNames); // write target only
      const colRef = quoteIdent(w.columnName);
      const stdRef = quoteIdent(stdName);
      const stgRef = `prism_internal.${quoteIdent(`colsync_stg_${pipelineId ?? 0}_${i}_${nonce}`)}`;
      stagingRefs.push(stgRef);

      await materializeTempStaging(conn, src.ref, w.columnName, w.domainId, stgRef);

      // The change guards are load-bearing (stream-echo settling — see
      // CLAUDE.md → Standardized-Column Output). A steady-state sync must
      // touch 0 rows.
      await exec(
        conn,
        `UPDATE ${src.ref} src SET ${stdRef} = stg.alias_name
         FROM ${stgRef} stg
         WHERE src.${colRef} COLLATE "C" = stg.raw_value
           AND (src.${stdRef} IS NULL OR src.${stdRef} COLLATE "C" <> stg.alias_name)`,
      );
      await exec(
        conn,
        `UPDATE ${src.ref} src SET ${stdRef} = NULL
         WHERE src.${stdRef} IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${stgRef} stg WHERE src.${colRef} COLLATE "C" = stg.raw_value)`,
      );
    }
  } finally {
    for (const stgRef of stagingRefs) {
      await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`).catch(() => {});
    }
  }

  const anyStd = watched
    .map(w => `${quoteIdent(standardizedColumnName(w.columnName))} IS NOT NULL`)
    .join(' OR ');
  const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${src.ref} WHERE ${anyStd}`);
  const rows_written = Number(countRows[0]?.c ?? 0);

  const counts = new Map<number, { totalSource: number; totalMapped: number }>();
  for (const s of siblings) {
    counts.set(s.pipelineId, await computeMappedCountsPg(conn, source_fqn, s.columnName, s.domainId));
  }
  stampSiblingMetrics(siblings, counts);

  console.log(
    `[ExportTable/pg] Synced standardized columns on ${source_fqn} ` +
    `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows standardized`,
  );
  return { rows_written };
}

// ── Ordering resolution: PK → unique index (two tiers on Postgres) ───────────

interface PgOrdering { tier: 'pk' | 'unique'; orderExpr: string; }

export async function resolveSourceOrderingPg(conn: any, fqn: string): Promise<PgOrdering | null> {
  const pk = await getPrimaryKeyColumns(conn, fqn).catch(() => [] as string[]);
  if (pk.length) return { tier: 'pk', orderExpr: pk.map(c => `src.${quoteIdent(c)}`).join(', ') };

  const { schema, table } = pgTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT i.indexrelid::regclass::text AS idx, a.attname AS col, k.ord
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE i.indisunique AND NOT i.indisprimary AND n.nspname = ? AND c.relname = ?
     ORDER BY i.indexrelid::regclass::text, k.ord`,
    [schema, table],
  ).catch(() => [] as any[]);
  if (!rows.length) return null;

  const firstIdx = String(rows[0].idx);
  const cols = rows.filter((r: any) => String(r.idx) === firstIdx).map((r: any) => String(r.col));
  return { tier: 'unique', orderExpr: cols.map(c => `src.${quoteIdent(c)}`).join(', ') };
}

// ── Mapped-count metrics ──────────────────────────────────────────────────────

/** total_source = non-null source ROWS; total_mapped = rows whose normalized
 *  value has a confirmed mapping. Grouping under COLLATE "C" counts the same
 *  byte-distinct units the export writes (the mssql metric-honesty rule). */
export async function computeMappedCountsPg(
  conn:       any,
  source_fqn: string,
  column:     string,
  domainId:   number | null,
): Promise<{ totalSource: number; totalMapped: number }> {
  const { ref } = pgTableRef(source_fqn);
  const colRef = quoteIdent(column);
  const rows = await exec(
    conn,
    `SELECT ${colRef} COLLATE "C" AS v, COUNT(*) AS freq
     FROM ${ref}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${colRef} COLLATE "C"`,
  );

  const freqByNorm = new Map<string, number>();
  let totalSource = 0;
  for (const r of rows) {
    const freq = Number(r.freq ?? 0);
    totalSource += freq;
    const norm = normalizeLiteral(String(r.v));
    if (!norm) continue;
    freqByNorm.set(norm, (freqByNorm.get(norm) ?? 0) + freq);
  }

  const norms = [...freqByNorm.keys()];
  const domainFilter = domainId != null ? `AND domain_id = ?` : `AND domain_id IS NULL`;
  let totalMapped = 0;
  for (let i = 0; i < norms.length; i += IN_BATCH) {
    const batch = norms.slice(i, i + IN_BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const binds: any[] = [...batch];
    if (domainId != null) binds.push(domainId);
    const mapped = await exec(
      conn,
      `SELECT DISTINCT normalized_value AS nv
       FROM prism_internal.literal_alias_matches
       WHERE normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const m of mapped) totalMapped += freqByNorm.get(String(m.nv)) ?? 0;
  }
  return { totalSource, totalMapped };
}

/** Column names of a source table (catalog). Shared by the column-mode
 *  creation-time companion-conflict guard in export-table.ts. */
export async function listSourceColumnsPg(conn: any, source_fqn: string): Promise<string[]> {
  const { schema, table } = pgTableRef(source_fqn);
  const rows = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
    [schema, table],
  );
  return rows.map((r: any) => String(r.col));
}
