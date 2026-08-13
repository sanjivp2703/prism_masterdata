/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// SQL Server export-table builder (docs/MSSQL_PORT_PLAN.md Phase 5).
//
// The Snowflake version joins the source against the lookup with the
// PRISM_NORMALIZE UDF. This warehouse has NO SQL-side normalize (decision
// 2.2), so the join is materialized instead:
//   1. read the watched column's DISTINCT raw values (bounded — categorical),
//   2. normalize + resolve aliases in the app (normalizeLiteral, the ONE
//      normalization implementation),
//   3. write an exact-match staging table (raw_value → alias_name, BIN2
//      collation so 'AT&T' ≠ 'at&t'),
//   4. build the export as source LEFT JOIN staging on raw equality,
//   5. swap it in transactionally (build `_new` → DROP old → sp_rename) and
//      re-apply captured permissions (no COPY GRANTS on this warehouse).
import 'server-only';

import { getDb } from '../../sqlite';
import { normalizeLiteral } from '../../normalize';
import { internalObject, internalTable } from '../../warehouse-tables';
import { standardizedColumnName, assertCompanionColumnSafe } from '../../export-kind';
import { executeQuery as exec, getServiceLoginName } from './connection';
import { flagPipelineMessage } from '../../pipeline-alerts';
import { ColumnModeAccessError } from '../types';
import { quoteIdent, parseFqn } from './dialect';
import { getPrimaryKeyColumns } from './detection';

const BIN2 = 'Latin1_General_100_BIN2';
// Lookup literal_value is NVARCHAR(800) — longer source values can never be
// mapped, so staging skips them and the join misses them (⇒ unmapped).
const STAGING_VALUE_LEN = 800;
// Distinct-value ceiling per watched column (values pass through app memory).
const EXPORT_MAX_DISTINCT = 100_000;
const IN_BATCH = 900;        // 1 bind/value (+1 scope/spec_id) per lookup batch
const STAGING_INSERT_BATCH = 800; // 2 binds/row

function ref3(fqn: string): string {
  const { db, schema, table } = parseFqn(fqn);
  return `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export interface MssqlExportResult { rows_written: number; }

// ── Table-mode export permissions ────────────────────────────────────────────
// A table-export rebuild does a SELECT INTO (needs database-scoped CREATE
// TABLE) followed by DROP + sp_rename in the destination schema (needs
// ALTER ON SCHEMA there). Neither is granted by the mssql onboarding wizard's
// Part B (source databases only get prism_svc + SELECT) — unlike the
// Snowflake wizard's Part D, which already includes CREATE TABLE/CREATE VIEW.
// These three functions close that gap: verify, grant, and the exact SQL text
// for a customer admin to run by hand if the automatic grant can't (mirrors
// columnModeSetupSql's role for the Column output mode).

/** Metadata-only check (HAS_PERMS_BY_NAME) — never needs elevated rights. */
export async function hasTableModePermissions(conn: any, export_fqn: string): Promise<boolean> {
  const { db, schema } = parseFqn(export_fqn);
  const rows = await exec(
    conn,
    `USE ${quoteIdent(db)}; SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create, HAS_PERMS_BY_NAME(?, 'SCHEMA', 'ALTER') AS can_alter`,
    [schema],
  );
  const r = rows[0] as any;
  return Number(r?.can_create ?? r?.CAN_CREATE ?? 0) === 1 && Number(r?.can_alter ?? r?.CAN_ALTER ?? 0) === 1;
}

/** Requires elevated rights to run (ALTER/CONTROL or similar) — called with
 *  the pipeline creator's saved personal credentials, never the service
 *  connection (which is exactly the login this grants access TO). */
export async function grantTableModePermissions(conn: any, export_fqn: string): Promise<void> {
  const { db, schema } = parseFqn(export_fqn);
  // Grantee resolved from the CONFIGURED service login, never the literal
  // 'prism_svc' — see getServiceLoginName(). Granting to a hardcoded name made
  // this report success while the real login stayed unable to write.
  const grantee = quoteIdent(getServiceLoginName());
  await exec(conn, `USE ${quoteIdent(db)}; GRANT CREATE TABLE TO ${grantee};`);
  await exec(conn, `USE ${quoteIdent(db)}; GRANT ALTER ON SCHEMA::${quoteIdent(schema)} TO ${grantee};`);
}

/** The exact statements a customer admin runs by hand when the automatic
 *  grant isn't possible (no saved personal credentials, or the attempt
 *  failed) — shown verbatim in the fix-it disclosure. */
export function tableModeSetupSql(export_fqn: string): string {
  const { db, schema } = parseFqn(export_fqn);
  // Must name the SAME grantee the automatic path uses — an admin following
  // this SQL verbatim has to end up with a login that can actually write.
  const grantee = quoteIdent(getServiceLoginName());
  return `USE ${quoteIdent(db)}; GRANT CREATE TABLE TO ${grantee}; GRANT ALTER ON SCHEMA::${quoteIdent(schema)} TO ${grantee};`;
}

export async function refreshExportTableMssql(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  export_fqn:  string,
  domain_id:   number | null,
  pipelineId?: number,
  exportKind:  'table' | 'view' = 'table',
): Promise<MssqlExportResult> {
  if (exportKind === 'view') {
    // A view can't reference per-rebuild staging tables. Deliberate refusal
    // (loud, never silent) until a live-view strategy exists for mssql.
    throw new Error('[ExportTable/mssql] export_kind "view" is not supported on SQL Server — use a table export.');
  }

  const src = parseFqn(source_fqn);
  const exp = parseFqn(export_fqn);
  const sourceRef = ref3(source_fqn);
  const exportRef = ref3(export_fqn);

  // SAFETY: the table path must NEVER target the source table itself — the
  // swap would DROP the customer's data. (Column-mode pipelines store
  // export_table_fqn = table_fqn but are dispatched to
  // refreshStandardizedColumnsMssql before reaching here.)
  if (
    src.db.toUpperCase() === exp.db.toUpperCase() &&
    src.schema.toUpperCase() === exp.schema.toUpperCase() &&
    src.table.toUpperCase() === exp.table.toUpperCase()
  ) {
    throw new Error(
      `[ExportTable/mssql] Refusing to build an export over the source table itself (${source_fqn}). ` +
      `If this pipeline should write standardized columns onto the source, its export_kind must be 'column'.`,
    );
  }

  // ── Source columns (ordinal order) ─────────────────────────────────────────
  const colRows = await exec(
    conn,
    `SELECT c.name AS col
     FROM ${quoteIdent(src.db)}.sys.columns c
     WHERE c.object_id = OBJECT_ID(?)
     ORDER BY c.column_id`,
    [sourceRef],
  );
  if (!colRows.length) {
    throw new Error(`[ExportTable/mssql] No columns found for ${source_fqn}. Verify the table exists and the service login can read ${src.db}.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.col));

  // ── Sibling pipelines sharing this export (same logic as the Snowflake
  //    builder — app-state in SQLite) ─────────────────────────────────────────
  const siblingRows = getDb()
    .prepare(
      `SELECT pipeline_id, column_name, domain_id, export_unmapped_rows
       FROM pipelines
       WHERE table_fqn = ? AND export_table_fqn = ?`,
    )
    .all(source_fqn, export_fqn) as any[];

  // Same semantics as the Snowflake builder: the setting applies to EVERY
  // update schedule (the 24/7 mapped-only override was removed 2026-07-22),
  // and defaults OFF.
  const firstSibling = siblingRows[0];
  const rawUnmapped = firstSibling ? firstSibling.export_unmapped_rows : false;
  const includeUnmapped =
    rawUnmapped === true || rawUnmapped === 1 || rawUnmapped === 'true';

  interface Watched { columnName: string; domainId: number | null }
  const watchedByCol = new Map<string, Watched>();
  interface SiblingMeta { pipelineId: number; columnName: string; domainId: number | null }
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
  const watched = Array.from(watchedByCol.values());

  // ── Staging tables: one per watched column ─────────────────────────────────
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const stagingRefs: string[] = [];

  try {
    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    const whereConds: string[] = [];

    for (let i = 0; i < watched.length; i++) {
      const w = watched[i];
      const colRef = quoteIdent(w.columnName);
      const stgName = `EXPORT_STG_${pipelineId ?? 0}_${i}_${nonce}`;
      const stgRef = `${internalObject(quoteIdent(stgName))}`;
      stagingRefs.push(stgRef);

      // 1–3. Distinct read (bounded) → app-side normalize + alias resolve →
      //       exact-match staging table (shared with the column-mode sync).
      await materializeAliasStaging(conn, sourceRef, w.columnName, w.domainId, stgRef);

      // 4. SELECT-list replacement + join for this column. Source side gets an
      //    explicit BIN2 collation cast so the exact-match promise holds even
      //    against case-insensitive source columns.
      const stg = `stg_${i}`;
      // COALESCE arms forced to one collation (staging is BIN2; source
      // columns carry arbitrary collations — conflict otherwise).
      const colSql = includeUnmapped
        ? `COALESCE(${stg}.alias_name COLLATE DATABASE_DEFAULT, src.${colRef} COLLATE DATABASE_DEFAULT) AS ${colRef}`
        : `${stg}.alias_name AS ${colRef}`;
      replaceMap.set(w.columnName.toUpperCase(), colSql);
      joinClauses.push(
        `LEFT JOIN ${stgRef} ${stg}
          ON src.${colRef} COLLATE ${BIN2} = ${stg}.raw_value`,
      );
      if (!includeUnmapped) {
        whereConds.push(`(src.${colRef} IS NULL OR ${stg}.raw_value IS NOT NULL)`);
      }
    }

    const selectList = sourceCols
      .map(col => replaceMap.get(col.toUpperCase()) ?? `src.${quoteIdent(col)}`)
      .join(',\n         ');
    const whereClause = whereConds.length ? `WHERE ${whereConds.join('\n        AND ')}` : '';

    // ── Ordering: PK → unique key → clustered index (best-effort physical
    //    order; guaranteed order = consumers ORDER BY these key columns) ──────
    const ordering = await resolveSourceOrderingMssql(conn, source_fqn);

    // ── Build the replacement table ─────────────────────────────────────────
    const newTable = `${exp.table}__prism_new_${nonce}`;
    const newRef = `${quoteIdent(exp.db)}.${quoteIdent(exp.schema)}.${quoteIdent(newTable)}`;
    await exec(conn, `DROP TABLE IF EXISTS ${newRef}`);
    // TOP is what makes the ORDER BY actually apply.
    //
    // SQL Server SILENTLY DISCARDS `ORDER BY` on a `SELECT … INTO` whose
    // destination is a heap unless a TOP is present — it is not an error, the
    // rows simply land unordered. So this statement looked like it preserved
    // source order and never did: live-reproduced with a PK-keyed source whose
    // rows were inserted 5,3,1,4,2,8,6,7 and came back in that same scrambled
    // order (OUT-03). The Snowflake builder's ordering tier worked, so the two
    // warehouses silently disagreed about a documented behaviour.
    //
    // TOP with the max BIGINT selects every row (it is a cap, not a limit) and
    // is the standard way to force the sort to be honoured. Only emitted when
    // there is an ordering to apply, so an unordered rebuild is unchanged.
    //
    // As on Snowflake, this only affects the PHYSICAL order rows are written
    // in — consumers who need guaranteed order must still ORDER BY the key
    // columns themselves, which are present in the export.
    const topClause = ordering ? 'TOP (9223372036854775807) ' : '';
    await exec(
      conn,
      `SELECT ${topClause}${selectList}
       INTO ${newRef}
       FROM ${sourceRef} src
       ${joinClauses.join('\n       ')}
       ${whereClause}
       ${ordering ? `ORDER BY ${ordering.orderExpr}` : ''}`,
    );

    // ── Capture existing permissions, then swap transactionally ─────────────
    // Grantee names resolved via the EXPORT database's principals — USER_NAME()
    // would resolve the ids against the connection's current database instead.
    // minor_id is load-bearing: for a class=1 permission it is 0 for a
    // TABLE-level grant and the column_id for a COLUMN-level grant. Capturing
    // only (grantee, perm) and re-issuing a table-level GRANT silently WIDENS a
    // column-scoped grant to the whole table — a customer who deliberately
    // exposed one non-sensitive column would lose that restriction on the first
    // rebuild. Resolve minor_id to a column name so it can be re-granted at the
    // same scope.
    // Can we actually SEE the access list? SQL Server hides permission
    // metadata for objects the caller has no rights over — and crucially it
    // does NOT raise an error, it reports the list as EMPTY. So without this
    // check a rebuild under an unprivileged login concludes "there were no
    // permissions to preserve", swaps the table in, and silently revokes
    // everyone. Onboarding now grants Prism ownership of the export schema
    // (GRANT CONTROL ON SCHEMA::<export_schema>), which is what makes
    // both reading and re-granting possible; this verifies it was actually
    // done rather than trusting it. See KI-117.
    const ownerRows = await exec(
      conn,
      `SELECT HAS_PERMS_BY_NAME(?, 'OBJECT', 'VIEW DEFINITION') AS can_see,
              HAS_PERMS_BY_NAME(?, 'OBJECT', 'CONTROL')         AS can_grant`,
      [exportRef, exportRef],
    ).catch(() => [] as any[]);
    const canPreserveGrants =
      Number((ownerRows[0] as any)?.can_see ?? 0) === 1 &&
      Number((ownerRows[0] as any)?.can_grant ?? 0) === 1;

    if (!canPreserveGrants && pipelineId != null) {
      await flagPipelineMessage(
        pipelineId,
        `Prism cannot preserve access permissions on ${export_fqn}: rebuilding the standardized table ` +
        `will drop any access you granted others on it. Run this once as a SQL Server administrator to fix it — ` +
        `GRANT CONTROL ON SCHEMA::${exp.schema} TO ${getServiceLoginName()}; — which lets Prism carry ` +
        `permissions across each rebuild. It gives Prism control of that one schema only, and does not ` +
        `disturb any access you have already granted others.`,
        'warning',
      ).catch(() => {});
      console.warn(
        `[ExportTable/mssql] Pipeline ${pipelineId}: cannot read/re-grant permissions on ${export_fqn} — ` +
        `they will NOT survive this rebuild.`,
      );
    }

    // LEFT JOIN, not JOIN — and the unresolved rows are reported, not dropped.
    //
    // Seeing a permission row and seeing the PRINCIPAL it was granted to are
    // two separate privileges in SQL Server. CONTROL on the export table (what
    // the ALTER AUTHORIZATION fix above confers) makes sys.database_permissions
    // rows visible, but resolving an arbitrary grantee's NAME additionally
    // needs VIEW DEFINITION on that specific principal. With an inner JOIN,
    // every grant to a principal Prism couldn't resolve silently vanished from
    // this result set — so the rebuild dropped a downstream consumer's access
    // and reported nothing, while HAS_PERMS_BY_NAME said everything was fine
    // (OUT-13, live-reproduced: admin follows our exact fix SQL, grants SELECT
    // to a consumer login, next rebuild silently revokes it).
    //
    // Now: keep the row, and let the re-grant loop below skip the unresolvable
    // ones while we tell the operator exactly which access is about to be lost
    // and how to stop it.
    const grants = await exec(
      conn,
      `SELECT dp.name AS grantee, p.permission_name AS perm, p.state AS state, p.minor_id AS minor_id, c.name AS col_name
       FROM ${quoteIdent(exp.db)}.sys.database_permissions p
       LEFT JOIN ${quoteIdent(exp.db)}.sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
       LEFT JOIN ${quoteIdent(exp.db)}.sys.columns c
              ON c.object_id = p.major_id AND c.column_id = p.minor_id AND p.minor_id <> 0
       WHERE p.major_id = OBJECT_ID(?) AND p.class = 1 AND p.state IN ('G', 'W', 'D')`,
      [exportRef],
    ).catch(() => [] as any[]);

    const unresolvedGrants = grants.filter((g: any) => g.grantee == null).length;
    if (unresolvedGrants > 0 && pipelineId != null) {
      await flagPipelineMessage(
        pipelineId,
        `Prism can see ${unresolvedGrants} access permission(s) on ${export_fqn} but cannot read who they were ` +
        `granted to, so rebuilding the standardized table will drop them. Run this once as a SQL Server ` +
        `administrator to fix it — GRANT VIEW ANY DEFINITION TO ${getServiceLoginName()}; — which lets Prism ` +
        `see account names so it can restore their access after each rebuild. It grants no access to your data.`,
        'warning',
      ).catch(() => {});
      console.warn(
        `[ExportTable/mssql] Pipeline ${pipelineId}: ${unresolvedGrants} permission(s) on ${export_fqn} have an ` +
        `unresolvable grantee (needs VIEW ANY DEFINITION) — they will NOT survive this rebuild.`,
      );
    }

    await exec(
      conn,
      `USE ${quoteIdent(exp.db)};
       BEGIN TRAN;
       DROP TABLE IF EXISTS ${quoteIdent(exp.schema)}.${quoteIdent(exp.table)};
       EXEC sp_rename ?, ?;
       COMMIT;`,
      [`${quoteIdent(exp.schema)}.${quoteIdent(newTable)}`, exp.table],
    );

    // Re-apply captured permissions (no COPY GRANTS equivalent). Best-effort:
    // a failed grant is logged, never fails the rebuild.
    for (const g of grants) {
      const grantee = String((g as any).grantee ?? '');
      const perm = String((g as any).perm ?? '');
      if (!grantee || !perm || !/^[A-Za-z ]+$/.test(perm)) continue;

      const minorId = Number((g as any).minor_id ?? 0);
      const colName = (g as any).col_name != null ? String((g as any).col_name) : '';

      // A column-scoped grant whose column we could not resolve must NOT fall
      // back to a table-level grant — that is the privilege escalation. Skip it
      // loudly and leave the customer to re-grant deliberately.
      if (minorId !== 0 && !colName) {
        console.warn(
          `[ExportTable/mssql] Skipping re-grant of ${perm} to ${grantee} on ${export_fqn}: ` +
          `it was scoped to column_id ${minorId}, which no longer resolves in the rebuilt table. ` +
          `NOT re-granting at table scope — re-apply the column grant manually if it is still wanted.`,
        );
        continue;
      }

      const target = `${quoteIdent(exp.schema)}.${quoteIdent(exp.table)}`;
      const scoped = minorId !== 0 ? `${target} (${quoteIdent(colName)})` : target;

      // Re-issue each permission in the STATE it was captured in:
      //   'G' → GRANT, 'W' → GRANT … WITH GRANT OPTION, 'D' → DENY.
      // Previously every row was replayed as a plain GRANT and DENY rows were
      // not captured at all, so a rebuild silently rewrote the access model:
      // a DENY (which overrides any GRANT in SQL Server) simply vanished,
      // turning an explicit "this account must NOT read this" into no rule at
      // all; and WITH GRANT OPTION was downgraded, quietly stripping a
      // delegated administrator's ability to re-grant. Both are security
      // posture changes made silently by a routine rebuild.
      const state = String((g as any).state ?? 'G').trim().toUpperCase();
      const stmt =
        state === 'D' ? `DENY ${perm} ON ${scoped} TO ${quoteIdent(grantee)}`
      : state === 'W' ? `GRANT ${perm} ON ${scoped} TO ${quoteIdent(grantee)} WITH GRANT OPTION`
      :                 `GRANT ${perm} ON ${scoped} TO ${quoteIdent(grantee)}`;
      try {
        await exec(conn, `USE ${quoteIdent(exp.db)}; ${stmt}`);
      } catch (e) {
        console.warn(`[ExportTable/mssql] Could not re-apply ${state === 'D' ? 'DENY' : 'GRANT'} ${perm} to ${grantee} on ${export_fqn}:`, (e as any)?.message ?? e);
      }
    }

    const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${exportRef}`);
    const rows_written = Number(countRows[0]?.c ?? 0);

    // ── Per-sibling metrics (same SQLite stamps as the Snowflake builder) ────
    // fully_synced_at's FIRST-EVER stamp (still NULL going in) uses created_at
    // instead of now(): this rebuild's data is the initial baseline scan's
    // snapshot, which happened back at pipeline creation, not "just now" —
    // review can sit for a while before Accept/activate actually runs this.
    // Every later rebuild still stamps the real current time, as before.
    for (const s of siblings) {
      const { totalSource, totalMapped } = await computeMappedCountsMssql(conn, source_fqn, s.columnName, s.domainId);
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

    console.log(
      `[ExportTable/mssql] Rebuilt ${export_fqn} ← ${source_fqn} ` +
      `(columns: ${watched.map(w => w.columnName).join(', ')}; order: ${ordering?.tier ?? 'none'}) — ${rows_written} rows`,
    );
    return { rows_written };
  } finally {
    for (const stgRef of stagingRefs) {
      await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`).catch(() => {});
    }
  }
}

/** Column names of a source table (metadata-layer). Shared by the column-mode
 *  sync and the creation-time companion-conflict guard in export-table.ts. */
export async function listSourceColumnsMssql(conn: any, source_fqn: string): Promise<string[]> {
  const src = parseFqn(source_fqn);
  const rows = await exec(
    conn,
    `SELECT c.name AS col
     FROM ${quoteIdent(src.db)}.sys.columns c
     WHERE c.object_id = OBJECT_ID(?)`,
    [ref3(source_fqn)],
  );
  return rows.map((r: any) => String(r.col));
}

// ── Alias staging (shared by the table rebuild and the column-mode sync) ─────

/**
 * Materializes the exact-match staging table for one watched column:
 * distinct raw values (bounded at EXPORT_MAX_DISTINCT), normalized app-side
 * (normalizeLiteral — the ONE normalization implementation), aliases resolved
 * from the lookup in bind-batched IN queries, written as raw_value → alias_name
 * rows under BIN2 collation. The caller owns dropping stgRef.
 */
async function materializeAliasStaging(
  conn:      any,
  sourceRef: string,
  colName:   string,
  domainId:  number | null,
  stgRef:    string,
): Promise<void> {
  const colRef = quoteIdent(colName);

  // 1. Distinct raw values (bounded).
  //
  // The COLLATE is load-bearing — do not remove it. SQL Server's default
  // collation is case-insensitive (SQL_Latin1_General_CP1_CI_AS), so an
  // uncollated SELECT DISTINCT collapses 'ATT' and 'att' to ONE arbitrary
  // representative. Every consumer of this staging table then joins back with
  // an explicit `COLLATE Latin1_General_100_BIN2` binary comparison, so the
  // variants that lost the collapse match NOTHING: with export_unmapped_rows=0
  // their rows were silently DROPPED from the standardized table, and with =1
  // they appeared with raw unstandardized values even though the lookup mapped
  // them. Distinct-ing under the same BIN2 collation the join uses keeps the
  // two halves consistent — byte-distinct values each get their own staging row.
  //
  // Mixed-case spellings of one value are the exact input this product exists
  // to standardize, so this is a mainline path, not an edge case.
  const distinctRows = await exec(
    conn,
    `SELECT DISTINCT TOP (${EXPORT_MAX_DISTINCT + 1}) ${colRef} COLLATE ${BIN2} AS v
     FROM ${sourceRef} WHERE ${colRef} IS NOT NULL`,
  );
  if (distinctRows.length > EXPORT_MAX_DISTINCT) {
    throw new Error(
      `[ExportTable/mssql] Column "${colName}" has more than ${EXPORT_MAX_DISTINCT.toLocaleString()} distinct values — not a standardizable categorical column.`,
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
       FROM ${internalTable('LITERAL_ALIAS_MATCHES')} lam
       JOIN ${internalTable('APPROVED_ALIAS_NAMES')} aan ON aan.alias_id = lam.alias_id
       WHERE lam.normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const r of rows) aliasByNorm.set(String(r.nv), String(r.an));
  }

  // 3. Materialize the exact-match staging table.
  await exec(
    conn,
    // PRIMARY KEY NONCLUSTERED is load-bearing, not a style choice.
    //
    // A bare PRIMARY KEY defaults to CLUSTERED, and a clustered index key is
    // capped at 900 bytes = 450 NVARCHAR chars. raw_value is NVARCHAR(800) to
    // match LITERAL_ALIAS_MATCHES, so any legitimately-stored mapped literal
    // longer than 450 characters threw "index entry ... exceeds the maximum
    // length of 900 bytes for clustered indexes" and aborted the ENTIRE
    // table's export rebuild — not just that one value. One long value took
    // the whole standardized output down. Live-reproduced with a 500-char
    // mapped literal (OUT-14).
    //
    // NONCLUSTERED raises the key limit to 1700 bytes, which covers the full
    // NVARCHAR(800). Values longer than that are filtered out above (they
    // cannot be in the lookup at all), so the key can never be overrun.
    `CREATE TABLE ${stgRef} (
       raw_value  NVARCHAR(${STAGING_VALUE_LEN}) COLLATE ${BIN2} NOT NULL PRIMARY KEY NONCLUSTERED,
       alias_name NVARCHAR(450) COLLATE ${BIN2} NOT NULL
     )`,
  );
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

// ── Standardized-column sync (export_kind = 'column') ────────────────────────

/**
 * export_kind = 'column' — maintain a `<col>_STANDARDIZED` companion column on
 * the SOURCE table: canonical name where the raw value has a confirmed
 * mapping, NULL otherwise. Never creates/drops/replaces any table.
 *
 * Both UPDATEs are guarded so a steady-state sync touches 0 rows — Change
 * Tracking (or the diff scan) watches this table, so an unguarded rewrite
 * would re-detect Prism's own writes every cycle; the guarded version settles
 * after one echo cycle (echoed values are already in the lookup — no LLM
 * cost, and the follow-up sync updates nothing).
 *
 * Required permissions beyond SELECT: ALTER on the source table (one-time
 * ADD COLUMN) and UPDATE (every sync). Failures throw with the exact SQL the
 * customer's admin must run.
 */
/**
 * The exact T-SQL a customer admin runs to enable Column output mode for one
 * table+column on SQL Server.
 *
 * Lives HERE, not in export-table.ts, purely to keep the dependency direction
 * sane: export-table.ts already imports from this file, so importing back the
 * other way would be circular. `columnModeSetupSql` in export-table.ts calls
 * this for its mssql branch, so there is exactly ONE generator — the previous
 * arrangement had this file hand-rolling its own copy, and that copy emitted
 * `GRANT UPDATE ON <fqn> TO the Prism service login's role;`, which is prose,
 * not SQL. An admin pasting it got Msg 102 "Incorrect syntax near 'Prism'"
 * (PIPE-09 / OUT-15). The same failure produced correct SQL on other surfaces,
 * which is exactly the drift a single generator prevents.
 *
 * SET XACT_ABORT ON + an explicit transaction are load-bearing — T-SQL does not
 * abort a batch on an ordinary runtime error, so without them a failed GRANT
 * would let the ALTER run anyway and strand a companion column.
 */
export function columnModeSetupSqlMssql(table_fqn: string, column_name: string): string {
  const p = parseFqn(table_fqn);
  const obj = `${quoteIdent(p.schema)}.${quoteIdent(p.table)}`;
  const companion = standardizedColumnName(column_name);
  return (
    `USE ${quoteIdent(p.db)}; ` +
    `SET XACT_ABORT ON; ` +
    `BEGIN TRANSACTION; ` +
    `GRANT UPDATE ON OBJECT::${obj} TO ${quoteIdent(getServiceLoginName())}; ` +
    `IF COL_LENGTH('${p.schema}.${p.table}', '${companion.replace(/'/g, "''")}') IS NULL ` +
    `ALTER TABLE ${obj} ADD ${quoteIdent(companion)} NVARCHAR(450) NULL; ` +
    `COMMIT TRANSACTION;`
  );
}

export async function refreshStandardizedColumnsMssql(
  conn:        any,
  source_fqn:  string,
  column_name: string,
  domain_id:   number | null,
  pipelineId?: number,
): Promise<MssqlExportResult> {
  const src = parseFqn(source_fqn);
  const sourceRef = ref3(source_fqn);

  // ── Watched columns on this table (column mode: export_table_fqn = table_fqn) ──
  const siblingRows = getDb()
    .prepare(
      `SELECT pipeline_id, column_name, domain_id
       FROM pipelines
       WHERE table_fqn = ? AND export_table_fqn = ? AND export_kind = 'column'`,
    )
    .all(source_fqn, source_fqn) as any[];

  interface Watched { columnName: string; domainId: number | null }
  const watchedByCol = new Map<string, Watched>();
  interface SiblingMeta { pipelineId: number; columnName: string; domainId: number | null }
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
  const watched = Array.from(watchedByCol.values());

  // GUARDRAIL — every identifier this function will ALTER/UPDATE must be a
  // companion of a watched column and must not be a watched raw column.
  // Throws before ANY SQL runs; do not remove (see docs/PRELAUNCH_CHECKLIST.md).
  const watchedRawNames = watched.map(w => w.columnName);
  for (const w of watched) {
    assertCompanionColumnSafe(standardizedColumnName(w.columnName), watchedRawNames);
  }

  // ── Ensure the companion columns exist ─────────────────────────────────────
  const existingCols = new Set(
    (await listSourceColumnsMssql(conn, source_fqn)).map(c => c.toUpperCase()),
  );
  for (const w of watched) {
    const stdName = standardizedColumnName(w.columnName);
    if (existingCols.has(stdName.toUpperCase())) continue;
    try {
      await exec(conn, `ALTER TABLE ${sourceRef} ADD ${quoteIdent(stdName)} NVARCHAR(450) NULL`);
    } catch (err) {
      // Typed, with the driver error preserved as `cause`.
      //
      // A bare `throw new Error(<curated text>)` here discarded the real driver
      // error, and the curated text matches none of isMssqlAccessError's
      // patterns and carries no `.number` — so withColumnModeFailureSurfaced
      // classified it as "not an access error" and never paused the pipeline.
      // The pause worked for other column-mode failures on this warehouse and
      // for this same failure on Snowflake, so a denied ALTER was the one case
      // that stayed silent (OUT-15). Same root cause as the Snowflake bug this
      // class was created for: classification must travel by TYPE, never by
      // matching text across a rethrow.
      throw new ColumnModeAccessError(
        `Prism could not add the standardized column "${stdName}" to ${source_fqn}. ` +
        `Run this as a SQL Server admin: ${columnModeSetupSqlMssql(source_fqn, w.columnName)}`,
        { cause: err },
      );
    }
  }

  // ── Sync each companion column via an alias staging table ─────────────────
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const stagingRefs: string[] = [];
  try {
    for (let i = 0; i < watched.length; i++) {
      const w = watched[i];
      const stdName = standardizedColumnName(w.columnName);
      assertCompanionColumnSafe(stdName, watchedRawNames); // guardrail — write target only
      const colRef = quoteIdent(w.columnName);
      const stdRef = quoteIdent(stdName);
      const stgRef = `${internalObject(quoteIdent(`COLSYNC_STG_${pipelineId ?? 0}_${i}_${nonce}`))}`;
      stagingRefs.push(stgRef);

      await materializeAliasStaging(conn, sourceRef, w.columnName, w.domainId, stgRef);

      // Mapped values whose standardized value is missing or stale.
      await exec(
        conn,
        `UPDATE src SET ${stdRef} = stg.alias_name
         FROM ${sourceRef} src
         JOIN ${stgRef} stg ON src.${colRef} COLLATE ${BIN2} = stg.raw_value
         WHERE src.${stdRef} IS NULL OR src.${stdRef} COLLATE ${BIN2} <> stg.alias_name`,
      );
      // Rows no longer mapped (raw value changed/cleared, or mapping removed).
      await exec(
        conn,
        `UPDATE src SET ${stdRef} = NULL
         FROM ${sourceRef} src
         LEFT JOIN ${stgRef} stg ON src.${colRef} COLLATE ${BIN2} = stg.raw_value
         WHERE src.${stdRef} IS NOT NULL AND stg.raw_value IS NULL`,
      );
    }
  } finally {
    for (const stgRef of stagingRefs) {
      await exec(conn, `DROP TABLE IF EXISTS ${stgRef}`).catch(() => {});
    }
  }

  // rows_written = source rows that currently carry a standardized value.
  const anyStd = watched
    .map(w => `${quoteIdent(standardizedColumnName(w.columnName))} IS NOT NULL`)
    .join(' OR ');
  const countRows = await exec(conn, `SELECT COUNT(*) AS c FROM ${sourceRef} WHERE ${anyStd}`);
  const rows_written = Number(countRows[0]?.c ?? 0);

  // ── Per-sibling metrics (same SQLite stamps as the table rebuild, incl. the
  //    first-ever-stamp → created_at special case; see its comment there) ──
  for (const s of siblings) {
    const { totalSource, totalMapped } = await computeMappedCountsMssql(conn, source_fqn, s.columnName, s.domainId);
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

  console.log(
    `[ExportTable/mssql] Synced standardized columns on ${source_fqn} ` +
    `(columns: ${watched.map(w => w.columnName).join(', ')}) — ${rows_written} rows standardized`,
  );
  return { rows_written };
}

// ── Ordering resolution: PK → unique key → clustered index ───────────────────

interface MssqlOrdering { tier: 'pk' | 'unique' | 'clustered'; orderExpr: string; }

export async function resolveSourceOrderingMssql(conn: any, fqn: string): Promise<MssqlOrdering | null> {
  const pk = await getPrimaryKeyColumns(conn, fqn).catch(() => [] as string[]);
  if (pk.length) return { tier: 'pk', orderExpr: pk.map(c => `src.${quoteIdent(c)}`).join(', ') };

  const { db } = parseFqn(fqn);
  const keyRows = await exec(
    conn,
    `SELECT i.index_id, i.is_unique_constraint, i.type AS index_type, c.name AS col, ic.key_ordinal
     FROM ${quoteIdent(db)}.sys.indexes i
     JOIN ${quoteIdent(db)}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
     JOIN ${quoteIdent(db)}.sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
     WHERE i.object_id = OBJECT_ID(?) AND (i.is_unique_constraint = 1 OR i.type = 1)
     ORDER BY i.is_unique_constraint DESC, i.index_id, ic.key_ordinal`,
    [ref3(fqn)],
  ).catch(() => [] as any[]);
  if (!keyRows.length) return null;

  const firstId = Number(keyRows[0].index_id);
  const cols = keyRows.filter((r: any) => Number(r.index_id) === firstId).map((r: any) => String(r.col));
  const tier = Number(keyRows[0].is_unique_constraint) === 1 ? 'unique' as const : 'clustered' as const;
  return { tier, orderExpr: cols.map(c => `src.${quoteIdent(c)}`).join(', ') };
}

// ── Mapped-count metrics ──────────────────────────────────────────────────────

/** total_source = non-null source ROWS; total_mapped = rows whose normalized
 *  value has a confirmed mapping (normalization app-side, lookup batched). */
export async function computeMappedCountsMssql(
  conn:       any,
  source_fqn: string,
  column:     string,
  domainId:   number | null,
): Promise<{ totalSource: number; totalMapped: number }> {
  const colRef = quoteIdent(column);
  const rows = await exec(
    conn,
    // Same BIN2 collation as the staging distinct read and the export join.
    // Grouping under the database's case-insensitive default folded 'ATT' and
    // 'att' into one bucket and SUMmed their counts, so rows the export had
    // silently dropped were still counted as mapped — the pipeline reported
    // total_mapped == total_source_values and stamped fully_synced_at while the
    // physical export table was short. That is what kept the data loss
    // invisible to operators. Counting the same byte-distinct units the export
    // writes keeps the metric honest.
    //
    // Note the app-side normalizeLiteral below still folds case for LOOKUP
    // matching, which is correct and unaffected: that decides which alias a
    // value maps to, not how many distinct source values exist.
    `SELECT ${colRef} COLLATE ${BIN2} AS v, COUNT(*) AS freq
     FROM ${ref3(source_fqn)}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${colRef} COLLATE ${BIN2}`,
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
       FROM ${internalTable('LITERAL_ALIAS_MATCHES')}
       WHERE normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const m of mapped) totalMapped += freqByNorm.get(String(m.nv)) ?? 0;
  }
  return { totalSource, totalMapped };
}
