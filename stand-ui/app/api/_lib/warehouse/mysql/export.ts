/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// MySQL export builder (docs/MYSQL_PORT_PLAN.md Phase M3).
//
// Same staging-join design as the mssql/pg builders (no SQL-side normalize):
// distinct raw values → app-side normalizeLiteral + alias resolve →
// exact-match staging table (utf8mb4_bin) → source LEFT JOIN staging on
// byte equality via binaryCompare. MySQL differences, all deliberate:
//   * DDL is NOT transactional, but `RENAME TABLE a TO b, c TO a` is ATOMIC
//     across multiple renames — the swap is: build `_new` → one RENAME moving
//     current out and new in → DROP the old. A crash between rename and drop
//     leaves a stray `__prism_old` table, never a missing export; each
//     rebuild sweeps stale `__prism_old_*`/`__prism_new_*` leftovers first.
//   * ACLs: no COPY GRANTS, no DENY concept — captured from
//     information_schema.TABLE_PRIVILEGES (+ COLUMN_PRIVILEGES, deduped
//     against table-level like the pg capture) and re-applied. ⚠️ Grantees
//     are 'user'@'host' ACCOUNTS — replayed verbatim from the catalog's
//     GRANTEE column; a naive re-grant to 'name' (implicit @'%') can
//     silently address a DIFFERENT account (plan risk #4).
//   * export_kind 'view' IS supported, pg-style: CREATE OR REPLACE VIEW over
//     PERSISTENT per-column mapping tables refreshed transactionally (DML
//     transactions are fine — only DDL auto-commits).
import 'server-only';

import crypto from 'node:crypto';

import { getDb } from '../../sqlite';
import { normalizeLiteral } from '../../normalize';
import { standardizedColumnName, assertCompanionColumnSafe } from '../../export-kind';
import { executeQuery as exec, getServiceAccountName } from './connection';
import { ColumnModeAccessError } from '../types';
import { quoteIdent, binaryCompare, isBlankPredicate } from './dialect';
import { myTableRef, getPrimaryKeyColumns } from './detection';

const STAGING_VALUE_LEN = 800;
const EXPORT_MAX_DISTINCT = 100_000;
const IN_BATCH = 5_000;
const STAGING_INSERT_BATCH = 5_000;

export interface MysqlExportResult { rows_written: number; }

// ── The staging builder (shared by table, view and column modes) ─────────────

async function fillAliasStaging(
  conn:      any,
  sourceRef: string,
  colName:   string,
  domainId:  number | null,
  stgRef:    string,
): Promise<void> {
  const colRef = quoteIdent(colName);

  // 1. Byte-distinct raw values (bounded). The GROUP BY runs under
  //    binaryCompare — the KI-138 distinct-collation rule: a default-collation
  //    DISTINCT collapses 'ATT'/'att' into one representative the byte-exact
  //    join then cannot match. The CONVERTed value IS the value.
  const distinctRows = await exec(
    conn,
    `SELECT ${binaryCompare(colRef)} AS v
     FROM ${sourceRef} WHERE ${colRef} IS NOT NULL
     GROUP BY ${binaryCompare(colRef)}
     LIMIT ${EXPORT_MAX_DISTINCT + 1}`,
  );
  if (distinctRows.length > EXPORT_MAX_DISTINCT) {
    throw new Error(
      `[ExportTable/mysql] Column "${colName}" has more than ${EXPORT_MAX_DISTINCT.toLocaleString()} distinct values — not a standardizable categorical column.`,
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

// Functional SHA2 PK — same InnoDB 3072-byte key-limit reason as the install
// script's unique keys (an 800-char utf8mb4 key is 3200 bytes).
const STAGING_DDL = (stgRef: string) =>
  `CREATE TABLE ${stgRef} (
     raw_value  VARCHAR(${STAGING_VALUE_LEN}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
     alias_name VARCHAR(450) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
     UNIQUE KEY uq_stg ((SHA2(raw_value, 256)))
   ) ENGINE=InnoDB`;

async function materializeTempStaging(
  conn: any, sourceRef: string, colName: string, domainId: number | null, stgRef: string,
): Promise<void> {
  await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`);
  await exec(conn, STAGING_DDL(stgRef));
  await fillAliasStaging(conn, sourceRef, colName, domainId, stgRef);
}

/** Persistent per-column mapping table (view mode) — stable name from the
 *  export FQN + column, content refreshed inside a DML transaction so the
 *  live view never sees a half-empty mapping. */
export function viewMapRef(export_fqn: string, columnName: string): string {
  const hash = crypto.createHash('md5').update(`${export_fqn}::${columnName}`).digest('hex').slice(0, 16);
  return `prism_internal.${quoteIdent(`viewmap_${hash}`)}`;
}

async function refreshPersistentStaging(
  conn: any, sourceRef: string, colName: string, domainId: number | null, stgRef: string, export_fqn: string, colIdx: string,
): Promise<void> {
  const bareName = `viewmap_${crypto.createHash('md5').update(`${export_fqn}::${colIdx}`).digest('hex').slice(0, 16)}`;
  void bareName; // name derivation lives in viewMapRef; existence check below uses the ref's table part
  const tableName = stgRef.split('.')[1].replace(/^`|`$/g, '').replace(/``/g, '`');
  const exists = await exec(
    conn,
    `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = 'prism_internal' AND table_name = ?`,
    [tableName],
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

export async function refreshExportTableMysql(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  export_fqn:  string,
  domain_id:   number | null,
  pipelineId?: number,
  exportKind:  'table' | 'view' = 'table',
): Promise<MysqlExportResult> {
  const src = myTableRef(source_fqn);
  const exp = myTableRef(export_fqn);

  // SAFETY: never target the source table itself — the swap would DROP the
  // customer's data. (Column-mode pipelines are dispatched to
  // refreshStandardizedColumnsMysql before reaching here.)
  if (src.db.toLowerCase() === exp.db.toLowerCase() && src.table.toLowerCase() === exp.table.toLowerCase()) {
    throw new Error(
      `[ExportTable/mysql] Refusing to build an export over the source table itself (${source_fqn}). ` +
      `If this pipeline should write standardized columns onto the source, its export_kind must be 'column'.`,
    );
  }

  const colRows = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [src.db, src.table],
  );
  if (!colRows.length) {
    throw new Error(`[ExportTable/mysql] No columns found for ${source_fqn}. Verify the table exists and the service account can read it.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.col));

  const { watched, siblings, includeUnmapped } = resolveSiblings(source_fqn, export_fqn, column_name, domain_id, pipelineId, false);

  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const tempStagingRefs: string[] = [];

  // Sweep stale swap leftovers (a crash between RENAME and DROP strands
  // `__prism_old_*`; a crash mid-build strands `__prism_new_*`).
  const stale = await exec(
    conn,
    `SELECT table_name AS t FROM information_schema.tables
     WHERE table_schema = ? AND (table_name LIKE ? OR table_name LIKE ?)`,
    [exp.db, `${exp.table}__prism_old_%`, `${exp.table}__prism_new_%`],
  ).catch(() => [] as any[]);
  for (const s of stale) {
    await exec(conn, `DROP TABLE IF EXISTS ${quoteIdent(exp.db)}.${quoteIdent(String(s.t))}`).catch(() => {});
  }

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
        await refreshPersistentStaging(conn, src.ref, w.columnName, w.domainId, stgRef, export_fqn, w.columnName);
      } else {
        stgRef = `prism_internal.${quoteIdent(`export_stg_${pipelineId ?? 0}_${i}_${nonce}`)}`;
        tempStagingRefs.push(stgRef);
        await materializeTempStaging(conn, src.ref, w.columnName, w.domainId, stgRef);
      }

      const stg = `stg_${i}`;
      // COALESCE in BOTH modes (2026-10-04): mapped-only rows are already
      // blank-or-mapped via the WHERE below, so the fallback only fires for a
      // blank cell, which must export as its own blank — not NULL.
      const colSql = `COALESCE(${stg}.alias_name, src.${colRef}) AS ${colRef}`;
      replaceMap.set(w.columnName.toUpperCase(), colSql);
      joinClauses.push(
        `LEFT JOIN ${stgRef} ${stg}
          ON ${binaryCompare(`src.${colRef}`)} = ${stg}.raw_value`,
      );
      // NULL/blank passes through as-is (blank = trims to '' — '' IS NOT NULL,
      // so a plain IS NULL test dropped blank rows from mapped-only exports).
      if (!includeUnmapped) {
        whereConds.push(`(${isBlankPredicate(`src.${colRef}`)} OR ${stg}.raw_value IS NOT NULL)`);
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
      const viewSql = `CREATE OR REPLACE VIEW ${exp.ref} AS ${bodySql}`;
      try {
        await exec(conn, viewSql);
      } catch {
        // Output-shape change (source schema drift) — drop + recreate with
        // ACL capture/re-apply so consumer grants survive.
        const acl = await captureAcl(conn, exp.db, exp.table);
        await exec(conn, `DROP VIEW IF EXISTS ${exp.ref}`);
        await exec(conn, viewSql);
        await reapplyAcl(conn, exp.ref, acl, export_fqn);
      }
      const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${exp.ref}`);
      rows_written = Number(countRows[0]?.c ?? 0);
    } else {
      // ── Ordering: PK → unique key (two tiers on MySQL) ─────────────────────
      const ordering = await resolveSourceOrderingMysql(conn, source_fqn);

      const newTable = `${exp.table}__prism_new_${nonce}`;
      const newRef = `${quoteIdent(exp.db)}.${quoteIdent(newTable)}`;
      await exec(conn, `DROP TABLE IF EXISTS ${newRef}`);
      // InnoDB writes CTAS rows in ORDER BY order (physical best-effort only,
      // as on every warehouse — consumers ORDER BY the key columns).
      await exec(
        conn,
        `CREATE TABLE ${newRef} AS
         ${bodySql}
         ${ordering ? `ORDER BY ${ordering.orderExpr}` : ''}`,
      );

      // Capture ACLs, then the ATOMIC multi-RENAME swap, then drop the old.
      const acl = await captureAcl(conn, exp.db, exp.table);
      const existing = await exec(
        conn,
        `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [exp.db, exp.table],
      );
      if (existing.length) {
        const oldTable = `${exp.table}__prism_old_${nonce}`;
        await exec(
          conn,
          `RENAME TABLE ${exp.ref} TO ${quoteIdent(exp.db)}.${quoteIdent(oldTable)}, ${newRef} TO ${exp.ref}`,
        );
        await exec(conn, `DROP TABLE IF EXISTS ${quoteIdent(exp.db)}.${quoteIdent(oldTable)}`).catch(() => {});
      } else {
        await exec(conn, `RENAME TABLE ${newRef} TO ${exp.ref}`);
      }
      await reapplyAcl(conn, exp.ref, acl, export_fqn);

      const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${exp.ref}`);
      rows_written = Number(countRows[0]?.c ?? 0);

      if (ordering) {
        console.log(`[ExportTable/mysql] Rebuilt ${export_fqn} ← ${source_fqn} (order: ${ordering.tier}) — ${rows_written} rows`);
      }
    }

    const counts = new Map<number, { totalSource: number; totalMapped: number }>();
    for (const s of siblings) {
      counts.set(s.pipelineId, await computeMappedCountsMysql(conn, source_fqn, s.columnName, s.domainId));
    }
    stampSiblingMetrics(siblings, counts);

    console.log(
      `[ExportTable/mysql] ${exportKind === 'view' ? 'Refreshed view mappings for' : 'Rebuilt'} ${export_fqn} ← ${source_fqn} ` +
      `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows`,
    );
    return { rows_written };
  } finally {
    for (const stgRef of tempStagingRefs) {
      await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`).catch(() => {});
    }
  }
}

// ── ACL capture / re-apply (no COPY GRANTS; no DENY concept) ─────────────────
// Grantees come back as 'user'@'host' account strings — replayed VERBATIM
// (plan risk #4: a bare 'name' re-grant implicitly means @'%', which can be a
// DIFFERENT account than the captured one).

interface CapturedGrant { grantee: string; privilege: string; grantable: boolean; column: string | null }

async function captureAcl(conn: any, db: string, table: string): Promise<CapturedGrant[]> {
  const tableGrants = await exec(
    conn,
    `SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable
     FROM information_schema.TABLE_PRIVILEGES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  ).catch(() => [] as any[]);
  const colGrants = await exec(
    conn,
    `SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable, COLUMN_NAME AS col
     FROM information_schema.COLUMN_PRIVILEGES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  ).catch(() => [] as any[]);

  const grants: CapturedGrant[] = [];
  const tableLevel = new Set<string>();
  for (const g of tableGrants) {
    tableLevel.add(`${g.grantee}::${g.privilege}`);
    grants.push({ grantee: String(g.grantee), privilege: String(g.privilege), grantable: String(g.grantable).toUpperCase() === 'YES', column: null });
  }
  for (const g of colGrants) {
    if (tableLevel.has(`${g.grantee}::${g.privilege}`)) continue;
    grants.push({ grantee: String(g.grantee), privilege: String(g.privilege), grantable: String(g.grantable).toUpperCase() === 'YES', column: String(g.col) });
  }
  return grants;
}

async function reapplyAcl(conn: any, targetRef: string, grants: CapturedGrant[], displayFqn: string): Promise<void> {
  for (const g of grants) {
    if (!/^[A-Z ]+$/i.test(g.privilege)) continue;
    // GRANTEE arrives catalog-quoted ('user'@'host' with single quotes) —
    // valid GRANT syntax as-is; never reconstruct it.
    const grantee = g.grantee;
    if (!/^'[^']*'@'[^']*'$/.test(grantee)) {
      console.warn(`[ExportTable/mysql] Skipping re-grant to unexpected grantee shape on ${displayFqn}: ${grantee}`);
      continue;
    }
    const scope = g.column != null ? `${g.privilege} (${quoteIdent(g.column)})` : g.privilege;
    const stmt = `GRANT ${scope} ON ${targetRef} TO ${grantee}${g.grantable ? ' WITH GRANT OPTION' : ''}`;
    try {
      await exec(conn, stmt);
    } catch (e) {
      console.warn(`[ExportTable/mysql] Could not re-apply GRANT ${g.privilege} to ${grantee} on ${displayFqn}:`, (e as any)?.message ?? e);
    }
  }
}

// ── Standardized-column sync (export_kind = 'column') ────────────────────────

/** The exact SQL a customer admin runs to enable Column output mode for one
 *  table+column on MySQL. No ownership concept — ALTER + UPDATE privileges
 *  per table. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, so the ADD is
 *  guarded by the caller's catalog check (and errno 1060 duplicate-column is
 *  treated as already-provisioned, not a failure). */
export function columnModeSetupSqlMysql(table_fqn: string, column_name: string): string {
  const { ref } = myTableRef(table_fqn);
  const companion = standardizedColumnName(column_name);
  return (
    `GRANT UPDATE ON ${ref} TO '${getServiceAccountName().replace(/'/g, "''")}'@'%'; ` +
    `ALTER TABLE ${ref} ADD COLUMN ${quoteIdent(companion)} VARCHAR(450) NULL;`
  );
}

export async function refreshStandardizedColumnsMysql(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId?: number,
): Promise<MysqlExportResult> {
  const src = myTableRef(source_fqn);
  const { watched, siblings } = resolveSiblings(source_fqn, source_fqn, column_name, domain_id, pipelineId, true);

  const watchedRawNames = watched.map(w => w.columnName);
  for (const w of watched) {
    assertCompanionColumnSafe(standardizedColumnName(w.columnName), watchedRawNames);
  }

  // ── Ensure the companion columns exist (catalog check — no IF NOT EXISTS) ──
  const existing = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
    [src.db, src.table],
  );
  const existingCols = new Set(existing.map((r: any) => String(r.col).toUpperCase()));
  for (const w of watched) {
    const stdName = standardizedColumnName(w.columnName);
    if (existingCols.has(stdName.toUpperCase())) continue;
    try {
      await exec(conn, `ALTER TABLE ${src.ref} ADD COLUMN ${quoteIdent(stdName)} VARCHAR(450) NULL`);
    } catch (err) {
      // errno 1060 = duplicate column (raced/provisioned elsewhere) — fine.
      if (Number((err as any)?.errno) === 1060) continue;
      // Typed, with the driver error preserved as `cause` — classification
      // travels by TYPE, never by matching text across a rethrow (OUT-15).
      throw new ColumnModeAccessError(
        `Prism could not add the standardized column "${stdName}" to ${source_fqn}. ` +
        `Run this as a MySQL admin: ${columnModeSetupSqlMysql(source_fqn, w.columnName)}`,
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

      // The change guards are load-bearing (steady-state sync touches 0 rows;
      // see CLAUDE.md → Standardized-Column Output).
      await exec(
        conn,
        `UPDATE ${src.ref} src
         JOIN ${stgRef} stg ON ${binaryCompare(`src.${colRef}`)} = stg.raw_value
         SET src.${stdRef} = stg.alias_name
         WHERE src.${stdRef} IS NULL OR ${binaryCompare(`src.${stdRef}`)} <> stg.alias_name`,
      );
      await exec(
        conn,
        `UPDATE ${src.ref} src
         LEFT JOIN ${stgRef} stg ON ${binaryCompare(`src.${colRef}`)} = stg.raw_value
         SET src.${stdRef} = NULL
         WHERE src.${stdRef} IS NOT NULL AND stg.raw_value IS NULL`,
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
    counts.set(s.pipelineId, await computeMappedCountsMysql(conn, source_fqn, s.columnName, s.domainId));
  }
  stampSiblingMetrics(siblings, counts);

  console.log(
    `[ExportTable/mysql] Synced standardized columns on ${source_fqn} ` +
    `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows standardized`,
  );
  return { rows_written };
}

// ── Ordering resolution: PK → unique key (two tiers on MySQL) ────────────────

interface MysqlOrdering { tier: 'pk' | 'unique'; orderExpr: string; }

export async function resolveSourceOrderingMysql(conn: any, fqn: string): Promise<MysqlOrdering | null> {
  const pk = await getPrimaryKeyColumns(conn, fqn).catch(() => [] as string[]);
  if (pk.length) return { tier: 'pk', orderExpr: pk.map(c => `src.${quoteIdent(c)}`).join(', ') };

  const { db, table } = myTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT index_name AS idx, column_name AS col, seq_in_index AS ord
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND non_unique = 0 AND index_name != 'PRIMARY'
       AND column_name IS NOT NULL
     ORDER BY index_name, seq_in_index`,
    [db, table],
  ).catch(() => [] as any[]);
  if (!rows.length) return null;

  const firstIdx = String(rows[0].idx);
  const cols = rows.filter((r: any) => String(r.idx) === firstIdx).map((r: any) => String(r.col));
  return { tier: 'unique', orderExpr: cols.map(c => `src.${quoteIdent(c)}`).join(', ') };
}

// ── Mapped-count metrics ──────────────────────────────────────────────────────

/** total_source = non-null source ROWS; total_mapped = rows whose normalized
 *  value has a confirmed mapping. Grouping under binaryCompare counts the
 *  same byte-distinct units the export writes (the KI-138 metric-honesty
 *  rule — a default-collation GROUP BY would fold 'ATT'/'att' and overcount
 *  mapped rows the export actually dropped). */
export async function computeMappedCountsMysql(
  conn:       any,
  source_fqn: string,
  column:     string,
  domainId:   number | null,
): Promise<{ totalSource: number; totalMapped: number }> {
  const { ref } = myTableRef(source_fqn);
  const colRef = quoteIdent(column);
  const rows = await exec(
    conn,
    `SELECT ${binaryCompare(colRef)} AS v, COUNT(*) AS freq
     FROM ${ref}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${binaryCompare(colRef)}`,
  );

  const freqByNorm = new Map<string, number>();
  let totalSource = 0;
  for (const r of rows) {
    const freq = Number(r.freq ?? 0);
    const norm = normalizeLiteral(String(r.v));
    // Blank (normalizes to '') is not a source VALUE: it passes through the
    // export as-is and must not count toward "Unstandardized" (source minus
    // lookup) — it can never be in the lookup (2026-09-14).
    if (!norm) continue;
    totalSource += freq;
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
export async function listSourceColumnsMysql(conn: any, source_fqn: string): Promise<string[]> {
  const { db, table } = myTableRef(source_fqn);
  const rows = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
    [db, table],
  );
  return rows.map((r: any) => String(r.col));
}
