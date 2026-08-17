/**
 * One-Time Standardization.
 *
 * A throwaway, one-shot flow: standardize a source table's columns and write the
 * result to a standalone Snowflake table. Unlike the domain pipeline path, this
 * NEVER reads or writes the shared lookup (LITERAL_ALIAS_MATCHES /
 * APPROVED_ALIAS_NAMES) — every value is grouped purely by the LLM, optionally
 * subject to a naming convention. Working state lives in RUNS (run_type =
 * 'one_time'); the durable archive row is written to ONE_TIME_STANDARDIZATIONS
 * on export.
 *
 * Reuses the grouping engine (runOnePromptGrouping), the run state blob
 * (OpRunState), and the CREATE OR REPLACE TABLE … AS SELECT write pattern.
 */

import 'server-only';

import { getDb } from './sqlite';

import {
  loadOpRunState,
  saveOpRunState,
  type OpRunState,
  type OpGroup,
  type OpGroupItem,
} from './op-auto-group';
import { runOnePromptGrouping, type NamingConvention } from './llm-one-prompt-grouping';
import { hasAnyRule } from './convention-rules';
import { pickBestAliasName } from './namescore';
import type { RunItemForPairing } from './grouping-types';
import { normalizeLiteral } from './normalize';
import { internalObject, prismNormalizeFn } from './warehouse-tables';
import { recordStandardizedUnits } from './billing-meter';
import { executeQuery as exec, getWarehouseAdapter, withWarehouse } from './warehouse';
import { isNativeEdition } from './edition';
import { reportError } from './report-error';
import { diffScan, DIFF_SCAN_MAX_DISTINCT } from './warehouse/mssql/detection';
import {
  diffScan as pgDiffScan,
  DIFF_SCAN_MAX_DISTINCT as PG_DIFF_SCAN_MAX_DISTINCT,
  pgTableRef,
} from './warehouse/postgres/detection';
import { quoteIdent as pgQuoteIdent } from './warehouse/postgres/dialect';
import {
  diffScan as myDiffScan,
  DIFF_SCAN_MAX_DISTINCT as MY_DIFF_SCAN_MAX_DISTINCT,
  myTableRef,
} from './warehouse/mysql/detection';
import { quoteIdent as myQuoteIdent, binaryCompare } from './warehouse/mysql/dialect';
import { readOneTimeDistinctValues } from './op-one-time-file';

// ---------------------------------------------------------------------------
// Identifier helpers (mirror auto-export/source + export-table)
// ---------------------------------------------------------------------------

export function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

export function parseFqn(fqn: string): { db: string; schema: string; table: string } {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

export function isSimpleIdent(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 34 || c === 39 || c === 92) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// stats_snapshot helpers — one-time metadata lives here (not in the lookup)
// ---------------------------------------------------------------------------

export interface OneTimeMeta {
  one_time_session: string;
  convention:       NamingConvention | null;
  standardization_rules: string[] | null;
  /** Optional free-text description of what the column's values are — fed to the
   *  grouping LLM as the concept definition (the one-time analog of a spec/domain
   *  description). */
  description?:     string | null;
  accepted:         boolean;
  /** Which Snowflake connection this run reads/writes with: the workspace
   *  service connection (default) or the creator's PERSONAL credentials
   *  (tables PRISM_SERVICE can't see). Export must use the same one. */
  connection?:      'service' | 'user';
}

function safeJsonParse(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function loadOneTimeMeta(connection: any, runId: number): Promise<OneTimeMeta | null> {
  const row = getDb()
    .prepare(`SELECT stats_snapshot FROM runs WHERE run_id = ? AND run_type = 'one_time'`)
    .get(runId) as { stats_snapshot?: string | null } | undefined;
  if (!row) return null;
  const raw = row.stats_snapshot;
  const parsed = safeJsonParse(raw) ?? {};
  const stdRules = Array.isArray(parsed.standardization_rules) ? parsed.standardization_rules : null;
  return {
    one_time_session: String(parsed.one_time_session ?? ''),
    convention:       parsed.convention ?? null,
    standardization_rules: stdRules,
    description:      parsed.description != null ? String(parsed.description) : null,
    accepted:         parsed.accepted === true,
    connection:       parsed.connection === 'user' ? 'user' : 'service',
  };
}

export async function saveOneTimeMeta(connection: any, runId: number, meta: OneTimeMeta): Promise<void> {
  getDb()
    .prepare(
      `UPDATE runs
       SET stats_snapshot = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE run_id = ?`,
    )
    .run(JSON.stringify(meta), runId);
}

// ---------------------------------------------------------------------------
// Size guard
// ---------------------------------------------------------------------------

/** Max distinct (normalized) values a one-time column may have. */
export const ONE_TIME_MAX_DISTINCT = 20_000;

/** Thrown when a one-time column exceeds ONE_TIME_MAX_DISTINCT — the create
 *  route converts it to a clear 400 instead of a sanitized Snowflake error. */
export class OneTimeTooLargeError extends Error {
  constructor(public columnName: string, public distinctCount: number) {
    super(
      `Column "${columnName}" has ${distinctCount.toLocaleString()} distinct values — ` +
      `more than the ${ONE_TIME_MAX_DISTINCT.toLocaleString()} a one-time standardization supports. ` +
      `Connect this column as a pipeline instead: it processes large columns automatically in batches.`,
    );
    this.name = 'OneTimeTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Mapping extraction
// ---------------------------------------------------------------------------

export interface OneTimeMapping { raw: string; standardized: string }

/** Flatten a run's groups into raw → standardized mappings. */
export function mappingsFromState(state: OpRunState | null): OneTimeMapping[] {
  if (!state) return [];
  const out: OneTimeMapping[] = [];
  for (const g of state.groups ?? []) {
    for (const it of g.items ?? []) {
      out.push({ raw: it.literal_value, standardized: g.alias_name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Create a one-time run (skeleton state) for a single column
// ---------------------------------------------------------------------------

export interface CreateOneTimeRunArgs {
  source_relation: string;   // DB.SCHEMA.TABLE
  column_name:     string;
  createdBy:       number;
  sessionNonce:    string;
  convention:      NamingConvention | null;
  standardization_rules?: string[] | null;
  /** Optional description of the column's values (grouping concept definition). */
  description?:    string | null;
  /** Connection the caller scanned the source with — recorded so the export
   *  uses the same one. Default 'service'. */
  connectionSource?: 'service' | 'user';
  /**
   * FILE/SHEET sessions: read the column's distinct values from
   * INTERNAL.ONE_TIME_FILE_ROWS (already uploaded under this nonce) instead of
   * scanning a warehouse table. `source_relation` then carries a display label
   * rather than a real FQN, so the identifier checks and the table scan below
   * are both skipped.
   */
  fileSession?: boolean;
}

/**
 * Probes the source column for distinct (normalized-deduped) values and inserts a
 * RUNS row with run_type = 'one_time', domain_id = NULL. Returns the new run_id.
 */
export async function createOneTimeRun(connection: any, args: CreateOneTimeRunArgs): Promise<number> {
  const { source_relation, column_name, createdBy, sessionNonce, convention } = args;

  // A file/sheet session has no source table: values were uploaded under this
  // nonce and source_relation is a display label (a file name or sheet tab),
  // which would fail parseFqn and isSimpleIdent for perfectly legitimate names.
  const isFileSession = args.fileSession === true;

  let tableRef = '';
  let colRef   = '';
  // Kept in the outer scope: the mssql scan below addresses the source by its
  // unquoted three-part name, so it needs the parts too.
  let parts: { db: string; schema: string; table: string } = { db: '', schema: '', table: '' };
  if (!isFileSession) {
    if (getWarehouseAdapter().kind === 'postgres' || getWarehouseAdapter().kind === 'mysql') {
      // Postgres FQNs may be 2-part (schema.table) and MySQL FQNs ARE 2-part
      // (database.table — no schema level) — the strict 3-part parse below
      // would reject them. pgTableRef/myTableRef inside each scan parse,
      // validate and quote the table name themselves; only the column name
      // needs the character check here.
      if (!isSimpleIdent(column_name)) {
        throw new Error('Table or column name contains unsupported characters.');
      }
    } else {
      parts = parseFqn(source_relation);
      if (![parts.db, parts.schema, parts.table, column_name].every(isSimpleIdent)) {
        throw new Error('Table or column name contains unsupported characters.');
      }
      tableRef = `${quoteIdent(parts.db)}.${quoteIdent(parts.schema)}.${quoteIdent(parts.table)}`;
      colRef   = quoteIdent(column_name);
    }
  }

  // Dedupe by the normalized form (a representative original kept via ANY_VALUE)
  // so byte-variant spellings collapse to one item — and so the export's
  // normalized join key is unique (no last-write-wins collision).
  // SQL Server: the detection engine's diff scan does the same dedup with
  // app-side normalizeLiteral (no SQL normalize exists there); its 20k cap
  // equals ONE_TIME_MAX_DISTINCT, so truncation ⇒ over the cap.
  let valueRows: any[];
  if (isFileSession) {
    // Uploaded rows: dedup happens app-side in readOneTimeDistinctValues so
    // both warehouses group identically (SQL Server has no PRISM_NORMALIZE).
    valueRows = await readOneTimeDistinctValues(connection, sessionNonce, column_name);
  } else if (getWarehouseAdapter().kind === 'mssql') {
    const scan = await diffScan(connection, `${parts.db}.${parts.schema}.${parts.table}`, column_name);
    if (scan.truncated) throw new OneTimeTooLargeError(column_name, DIFF_SCAN_MAX_DISTINCT + 1);
    valueRows = scan.values.map(v => ({ literal_value: v.literal_value, source_frequency: v.frequency }));
  } else if (getWarehouseAdapter().kind === 'postgres') {
    // Same shape as the mssql branch: the pg diff scan dedupes app-side on
    // normalizeLiteral (no SQL normalize on this warehouse either), and its
    // 20k cap equals ONE_TIME_MAX_DISTINCT, so truncation ⇒ over the cap.
    const scan = await pgDiffScan(connection, source_relation, column_name);
    if (scan.truncated) throw new OneTimeTooLargeError(column_name, PG_DIFF_SCAN_MAX_DISTINCT + 1);
    valueRows = scan.values.map(v => ({ literal_value: v.literal_value, source_frequency: v.frequency }));
  } else if (getWarehouseAdapter().kind === 'mysql') {
    // Same shape again: the mysql diff scan dedupes app-side (binaryCompare
    // grouping — byte-distinct even on legacy-charset columns) and shares the
    // 20k cap, so truncation ⇒ over the cap.
    const scan = await myDiffScan(connection, source_relation, column_name);
    if (scan.truncated) throw new OneTimeTooLargeError(column_name, MY_DIFF_SCAN_MAX_DISTINCT + 1);
    valueRows = scan.values.map(v => ({ literal_value: v.literal_value, source_frequency: v.frequency }));
  } else {
    valueRows = await exec(
      connection,
      `SELECT ANY_VALUE(TO_VARCHAR(${colRef})) AS literal_value,
              COUNT(*) AS source_frequency
       FROM ${tableRef}
       WHERE ${colRef} IS NOT NULL
       GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(${colRef}))
       ORDER BY source_frequency DESC`,
    );
  }

  // Hard cap: the one-time flow assumes a single review sitting and a single
  // merge pass — neither holds for tens of thousands of distinct values (and
  // the merge prompt would exceed the model context). Columns this large
  // belong on a pipeline, which processes in 5 000-value installments.
  if (valueRows.length > ONE_TIME_MAX_DISTINCT) {
    throw new OneTimeTooLargeError(column_name, valueRows.length);
  }

  const nonce = `ot_${sessionNonce}_${column_name}`;
  const insertRes = getDb()
    .prepare(
      `INSERT INTO runs
         (concept_key, source_relation, source_column, mode, domain_id, run_type, created_by,
          run_status, creation_nonce)
       VALUES ('one_time', ?, ?, 'manual', NULL, 'one_time', ?, 'created', ?)`,
    )
    .run(source_relation, column_name, Number(createdBy), nonce);
  const runId = Number(insertRes.lastInsertRowid);

  const initialState: OpRunState = {
    status: 'created',
    items: valueRows.map((row, idx) => ({
      run_item_id:         idx + 1,
      literal_value:       String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? ''),
      source_frequency:    Number((row as any).SOURCE_FREQUENCY ?? (row as any).source_frequency ?? 1),
      matched_from_lookup: false,
    })),
    groups: [],
    ungrouped: valueRows.map((row) => ({
      literal_value:       String((row as any).LITERAL_VALUE ?? (row as any).literal_value ?? ''),
      matched_from_lookup: false,
    })),
  };
  await saveOpRunState(runId, initialState);
  await saveOneTimeMeta(connection, runId, {
    one_time_session: sessionNonce,
    connection: args.connectionSource === 'user' ? 'user' : 'service',
    convention,
    standardization_rules: args.standardization_rules ?? null,
    description: args.description ?? null,
    accepted: false,
  });

  return runId;
}

// ---------------------------------------------------------------------------
// 2. Group a one-time run (LLM only — no lookup)
// ---------------------------------------------------------------------------

/**
 * Runs LLM grouping over ALL of a one-time run's items (no lookup pass), applying
 * the run's optional naming convention, and persists the grouped state. Returns
 * the resulting raw → standardized mappings.
 */
export async function groupOneTimeRun(
  connection: any,
  runId:      number,
): Promise<OneTimeMapping[]> {
  const state = await loadOpRunState(runId);
  if (!state) throw new Error(`Run state not found for run_id=${runId}.`);
  const meta = await loadOneTimeMeta(connection, runId);

  const convention: NamingConvention | null =
    meta?.convention && (meta.convention.type || hasAnyRule(meta.convention.rules))
      ? meta.convention
      : null;

  const items = state.items ?? [];
  if (items.length === 0) {
    const empty: OpRunState = { status: 'complete', items: [], groups: [], ungrouped: [] };
    await saveOpRunState(runId, empty);
    return [];
  }

  const runItems: RunItemForPairing[] = items.map((it, i) => ({
    run_item_id:         it.run_item_id ?? i + 1,
    literal_value:       it.literal_value,
    cleaned_value:       null,
    normalization_value: null,
    std_tokens:          [],
    norm_tokens:         [],
  }));

  const stdRules = meta?.standardization_rules ?? null;
  // The optional description is fed as the grouping concept definition.
  const conceptDef = meta?.description?.trim() || '';
  const result = await runOnePromptGrouping(runItems, '', conceptDef, [], convention, stdRules);

  const runItemsById = new Map(runItems.map((ri) => [ri.run_item_id, ri]));
  const ordered = [
    ...result.groups.filter((g) => !g.is_singleton),
    ...result.groups.filter((g) =>  g.is_singleton),
  ];

  let nextGroupId = 1;
  const groups: OpGroup[] = [];
  const groupedLiterals = new Set<string>();

  for (const g of ordered) {
    // Each literal must land in exactly one group. A merge that concatenates
    // member_ids (or an LLM that repeats an index) can otherwise place the same
    // value twice — duplicating it in the blob, which collides React keys in the
    // review UI. First placement wins; later duplicates are dropped here.
    const groupItems: OpGroupItem[] = [];
    for (const id of g.member_ids) {
      const ri = runItemsById.get(id);
      if (!ri || groupedLiterals.has(ri.literal_value)) continue;
      groupedLiterals.add(ri.literal_value);
      groupItems.push({ literal_value: ri.literal_value, matched_from_lookup: false });
    }
    if (groupItems.length === 0) continue;

    const proposed = (g.proposed_name ?? '').trim();
    const name = proposed || pickBestAliasName(
      g.member_ids.map((id) => runItemsById.get(id)).filter((m): m is RunItemForPairing => m != null),
    ).literal_value || groupItems[0].literal_value;

    groups.push({
      group_id:          nextGroupId++,
      alias_name:        name,
      alias_name_source: 'llm_proposed',
      confidence:        'h',
      from_lookup_chunk: false,
      items:             groupItems,
    });
  }

  // Items the LLM left unassigned become self-mapped singletons flagged for review
  // so nothing is dropped — the user confirms or renames them before export.
  for (const id of result.unassigned_ids ?? []) {
    const ri = runItemsById.get(id);
    if (!ri || groupedLiterals.has(ri.literal_value)) continue;
    groupedLiterals.add(ri.literal_value);
    groups.push({
      group_id:          nextGroupId++,
      alias_name:        ri.literal_value,
      alias_name_source: 'llm_proposed',
      confidence:        'l',
      from_lookup_chunk: false,
      needs_review:      true,
      items:             [{ literal_value: ri.literal_value, matched_from_lookup: false }],
    });
  }

  const newState: OpRunState = {
    status:    'running',
    items:     state.items,
    groups,
    ungrouped: [],
  };
  await saveOpRunState(runId, newState);

  return mappingsFromState(newState);
}

// ---------------------------------------------------------------------------
// 3. Export a session's mappings to a standalone Snowflake table
// ---------------------------------------------------------------------------

export interface OneTimeExportColumn {
  column_name: string;
  mappings:    OneTimeMapping[];
}

export interface ExportOneTimeArgs {
  source_relation: string;
  target_fqn:      string;
  mode:            'create' | 'overwrite';
  columns:         OneTimeExportColumn[];
  nonce:           string;   // simple ident fragment for the temp map table
  /** True when `connection` is the USER's own access (personal credentials,
   *  or the native caller's-rights session — §2.9). That connection cannot
   *  touch the app-internal schema, so scratch tables go to the TARGET
   *  schema (session-scoped TEMPORARY; the export already requires CREATE
   *  TABLE there) and metering runs on a separate service connection
   *  (live-found 2026-08-13: internal-schema scratch + metering both failed
   *  on the caller session). */
  usedUserConnection?: boolean;
}

/**
 * Writes a standalone copy of the source table to `target_fqn`, with each watched
 * column's values replaced by their accepted standardized name. Unmapped/NULL
 * values fall through to their raw value. Builds a temporary mapping table, joins
 * the source against it per column, then drops it. Touches no lookup tables.
 */
export async function exportOneTimeToSnowflake(connection: any, args: ExportOneTimeArgs): Promise<{ rows_written: number }> {
  const { source_relation, target_fqn, mode, columns, nonce } = args;

  // Postgres branches at the top: its FQNs may be 2-part, and the
  // INFORMATION_SCHEMA discovery below addresses another database (invalid on
  // pg, which cannot query across databases).
  if (getWarehouseAdapter().kind === 'postgres') {
    return await exportOneTimeToPgTarget(connection, args);
  }
  // MySQL too: its FQNs ARE 2-part (database.table — no schema level), so the
  // strict 3-part parse below would reject every valid mysql name.
  if (getWarehouseAdapter().kind === 'mysql') {
    return await exportOneTimeToMysqlTarget(connection, args);
  }

  const src = parseFqn(source_relation);
  const tgt = parseFqn(target_fqn);
  for (const p of [src.db, src.schema, src.table, tgt.db, tgt.schema, tgt.table]) {
    if (!isSimpleIdent(p)) throw new Error('Source or target table name contains unsupported characters.');
  }
  for (const c of columns) {
    if (!isSimpleIdent(c.column_name)) throw new Error('Column name contains unsupported characters.');
  }
  if (!isSimpleIdent(nonce)) throw new Error('Invalid session identifier.');

  const sourceRef = `${quoteIdent(src.db)}.${quoteIdent(src.schema)}.${quoteIdent(src.table)}`;
  const targetRef = `${quoteIdent(tgt.db)}.${quoteIdent(tgt.schema)}.${quoteIdent(tgt.table)}`;

  // ── Discover source columns (export mirrors source column names/order) ──────
  const colRows = await exec(
    connection,
    `SELECT COLUMN_NAME
     FROM ${quoteIdent(src.db)}.INFORMATION_SCHEMA.COLUMNS
     WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)
     ORDER BY ORDINAL_POSITION`,
    [src.schema, src.table],
  );
  if (!colRows.length) {
    throw new Error(`No columns found for ${source_relation}. Verify it exists and the service role has USAGE on ${src.db}.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.COLUMN_NAME ?? r.column_name ?? ''));
  const sourceColsUpper = new Set(sourceCols.map((c) => c.toUpperCase()));

  // Only standardize columns that actually exist on the source.
  const watched = columns.filter((c) => sourceColsUpper.has(c.column_name.toUpperCase()));

  if (getWarehouseAdapter().kind === 'mssql') {
    return await exportOneTimeToMssqlTarget(connection, { source_relation, target_fqn, mode, nonce, sourceRef, targetRef, sourceCols, watched });
  }

  // Scratch home: internal schema for the service connection (always
  // writable by it); the TARGET schema for a user/caller connection (the one
  // place that connection is guaranteed CREATE TABLE — the export needs it
  // anyway). TEMPORARY = session-scoped either way, dropped in finally.
  const scratchName = (n: string) =>
    args.usedUserConnection
      ? `${quoteIdent(tgt.db)}.${quoteIdent(tgt.schema)}.${quoteIdent(n)}`
      : `${internalObject(quoteIdent(n))}`;
  const mapTable = scratchName(`OTS_MAP_${nonce}`);

  try {
    // ── Build the transient mapping table ──────────────────────────────────
    await exec(
      connection,
      `CREATE OR REPLACE TEMPORARY TABLE ${mapTable} (
         column_name        VARCHAR,
         normalized_value   VARCHAR,
         standardized_value VARCHAR
       )`,
    );

    // Bulk-insert all mappings, batched. normalized_value is computed by the same
    // PRISM_NORMALIZE used on the join side so the keys agree.
    const BATCH = 200;
    for (const w of watched) {
      const rows = w.mappings.filter((m) => m.raw != null && m.standardized != null && m.standardized !== '');
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        // UDFs are not allowed in a VALUES clause — pre-normalize in TS instead
        // (normalizeLiteral is the exact mirror of PRISM_NORMALIZE).
        const valuesSql = slice.map(() => `(?, ?, ?)`).join(', ');
        const binds: any[] = [];
        for (const m of slice) binds.push(w.column_name, normalizeLiteral(m.raw), m.standardized);
        await exec(
          connection,
          `INSERT INTO ${mapTable} (column_name, normalized_value, standardized_value)
           SELECT column1, column2, column3 FROM VALUES ${valuesSql}`,
          binds,
        );
      }
    }

    // ── Build SELECT list + JOINs ──────────────────────────────────────────
    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    watched.forEach((w, i) => {
      const alias = `m_${i}`;
      // column_name is isSimpleIdent-validated (no quotes/backslash/control), so
      // embedding it as a string literal is safe.
      const literal = `'${w.column_name}'`;
      replaceMap.set(
        w.column_name.toUpperCase(),
        `COALESCE(${alias}.standardized_value, TO_VARCHAR(src.${quoteIdent(w.column_name)})) AS ${quoteIdent(w.column_name)}`,
      );
      joinClauses.push(
        `LEFT JOIN ${mapTable} ${alias}
           ON ${alias}.column_name = ${literal}
          AND ${alias}.normalized_value = ${prismNormalizeFn()}(TO_VARCHAR(src.${quoteIdent(w.column_name)}))`,
      );
    });

    const selectList = sourceCols
      .map((c) => replaceMap.get(c.toUpperCase()) ?? `src.${quoteIdent(c)}`)
      .join(',\n      ');

    // ── Create / replace the target table ──────────────────────────────────
    const selectSQL =
      `SELECT\n         ${selectList}\n       FROM ${sourceRef} src\n       ${joinClauses.join('\n       ')}`;

    if (mode === 'overwrite') {
      // Prefer CREATE OR REPLACE (atomic schema + data swap). Falls back to
      // DELETE + INSERT when PRISM_SERVICE doesn't own the existing table —
      // that path only needs INSERT/DELETE privileges, not OWNERSHIP.
      try {
        await exec(connection, `CREATE OR REPLACE TABLE ${targetRef} AS ${selectSQL}`);
      } catch (replaceErr: any) {
        const m = String(replaceErr?.message ?? '').toLowerCase();
        const isPermErr =
          m.includes('insufficient privileges') || m.includes('insufficient privilege') ||
          m.includes('not authorized') || m.includes('does not exist or not authorized') ||
          m.includes('access control error') || m.includes('sql access control');
        if (!isPermErr) throw replaceErr;

        // Build a session-scoped staging table (internal schema for the
        // service connection; target schema for a user/caller one), then
        // overwrite target rows. Target schema must match the source.
        const stageRef = scratchName(`OTS_FALLBACK_${nonce}`);
        try {
          await exec(connection, `CREATE OR REPLACE TEMPORARY TABLE ${stageRef} AS ${selectSQL}`);
          await exec(connection, `DELETE FROM ${targetRef} WHERE TRUE`);
          await exec(connection, `INSERT INTO ${targetRef} SELECT * FROM ${stageRef}`);
        } finally {
          await exec(connection, `DROP TABLE IF EXISTS ${stageRef}`).catch(() => {});
        }
      }
    } else {
      // 'create' must FAIL on an existing table — plain CREATE TABLE does
      // (same rule the pg/mysql/mssql paths already implement; the route's
      // 409 branch turns "already exists" into the honest collision message).
      // The old CREATE OR REPLACE silently replaced visible tables, and under
      // native caller's rights errored as a baffling "must have CALLER
      // OWNERSHIP" that misclassified as needs-grants (live-found 2026-08-14).
      await exec(connection, `CREATE TABLE ${targetRef} AS ${selectSQL}`);
    }

    // Native (owner decision 2026-08-17): the export is readable by every
    // role in the account. The terms disclose exactly this ("every user
    // within your company's Snowflake account can view … standardized
    // values"), and without it a caller-path export is visible only to the
    // creator's primary role — live-found when a SYSADMIN-default user's
    // exports were invisible to everyone else. Best-effort: on the caller
    // path the session owns the fresh table so the grant always works; an
    // app-owned (service-path) table may refuse, which the export's
    // access_note already covers.
    if (isNativeEdition()) {
      await exec(connection, `GRANT SELECT ON TABLE ${targetRef} TO ROLE PUBLIC`).catch(() => {});
    }

    const cntRows = await exec(connection, `SELECT COUNT(*) AS cnt FROM ${targetRef}`);
    const rows_written = Number((cntRows[0] as any)?.CNT ?? (cntRows[0] as any)?.cnt ?? 0);

    console.log(
      `[OneTime] Wrote ${target_fqn} ← ${source_relation} ` +
      `(${mode}; columns: ${watched.map((w) => w.column_name).join(', ')}) — ${rows_written} rows`,
    );

    // §2.8 billing: one-time sessions never touch the shared lookup, so the
    // billable unit here is each distinct value standardized in this export
    // (leaving them free would make the one-time flow a billing bypass).
    // A deliberate re-export of the SAME session re-counts — accepted edge
    // (sessions export once in practice; the archive row marks completion).
    const standardizedDistinct = watched.reduce(
      (n, w) => n + w.mappings.filter((m) => m.raw != null && m.standardized != null && m.standardized !== '').length,
      0,
    );
    // The user/caller connection cannot write the internal BILLING_METER —
    // meter on a service connection instead (a caller-path export must never
    // be a billing bypass). Failures never block the export either way.
    if (args.usedUserConnection) {
      try {
        await withWarehouse((sconn) => recordStandardizedUnits(sconn, standardizedDistinct, 'one_time_export'));
      } catch (meterErr) {
        reportError(meterErr, { where: 'one-time export metering (service conn)' });
      }
    } else {
      await recordStandardizedUnits(connection, standardizedDistinct, 'one_time_export');
    }

    return { rows_written };
  } finally {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`).catch(() => {});
  }
}

// ── PostgreSQL one-time export (port Phase P3) ───────────────────────────────
// Same raw-keyed mapping-table design as the mssql writer below: no SQL-side
// normalize exists on this warehouse, so each watched column's distinct raw
// values are read under COLLATE "C" (byte-distinct variants each keep their own
// row), normalized app-side, resolved from the run's mappings, and joined on
// raw equality. Same fall-through semantics: unmapped/NULL values keep their
// raw value.
async function exportOneTimeToPgTarget(
  connection: any,
  args: ExportOneTimeArgs,
): Promise<{ rows_written: number }> {
  const { source_relation, target_fqn, mode, columns, nonce } = args;

  // pgTableRef parses 2- or 3-part FQNs, rejects cross-database references and
  // control characters (via quoteIdent); the column/nonce checks mirror the
  // other writers.
  const src = pgTableRef(source_relation);
  const tgt = pgTableRef(target_fqn);
  for (const c of columns) {
    if (!isSimpleIdent(c.column_name)) throw new Error('Column name contains unsupported characters.');
  }
  if (!isSimpleIdent(nonce)) throw new Error('Invalid session identifier.');
  const sourceRef = src.ref;
  const targetRef = tgt.ref;

  // ── Discover source columns (export mirrors source column names/order) ─────
  const colRows = await exec(
    connection,
    `SELECT column_name AS col
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?
     ORDER BY ordinal_position`,
    [src.schema, src.table],
  );
  if (!colRows.length) {
    throw new Error(`No columns found for ${source_relation}. Verify it exists and the service role has USAGE on its schema.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.col ?? ''));
  const sourceColsUpper = new Set(sourceCols.map((c) => c.toUpperCase()));
  const watched = columns.filter((c) => sourceColsUpper.has(c.column_name.toUpperCase()));

  const mapTable = `prism_internal.${pgQuoteIdent(`ots_map_${nonce}`)}`;
  const stageTable = `prism_internal.${pgQuoteIdent(`ots_stage_${nonce}`)}`;

  try {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`);
    await exec(
      connection,
      `CREATE TABLE ${mapTable} (
         column_name        VARCHAR(200) COLLATE "C" NOT NULL,
         raw_value          VARCHAR(800) COLLATE "C" NOT NULL,
         standardized_value VARCHAR(800) NOT NULL,
         PRIMARY KEY (column_name, raw_value)
       )`,
    );

    for (const w of watched) {
      const stdByNorm = new Map<string, string>();
      for (const m of w.mappings) {
        if (m.raw != null && m.standardized != null && m.standardized !== '') {
          stdByNorm.set(normalizeLiteral(m.raw), m.standardized);
        }
      }
      if (stdByNorm.size === 0) continue;

      const colRef = pgQuoteIdent(w.column_name);
      // COLLATE "C" on the DISTINCT is load-bearing for the same reason as the
      // mssql BIN2 (KI-82 there): the join below compares byte-exact, so the
      // distinct pass must keep byte-distinct variants distinct too — a
      // nondeterministic database collation would otherwise collapse them to
      // one representative and every other spelling would export raw.
      const distinctRows = await exec(
        connection,
        `SELECT DISTINCT ${colRef} COLLATE "C" AS v FROM ${sourceRef} WHERE ${colRef} IS NOT NULL`,
      );
      const stagingRows: Array<[string, string, string]> = [];
      const seenRaw = new Set<string>();
      for (const r of distinctRows) {
        const raw = String((r as any).v);
        if (raw.length > 800 || seenRaw.has(raw)) continue;
        const std = stdByNorm.get(normalizeLiteral(raw));
        if (std == null) continue;
        seenRaw.add(raw);
        stagingRows.push([w.column_name, raw, std]);
      }
      const BATCH = 5_000; // 3 binds/row → 15k, well inside pg's ~65k ceiling
      for (let i = 0; i < stagingRows.length; i += BATCH) {
        const slice = stagingRows.slice(i, i + BATCH);
        const valuesSql = slice.map(() => '(?, ?, ?)').join(', ');
        await exec(
          connection,
          `INSERT INTO ${mapTable} (column_name, raw_value, standardized_value) VALUES ${valuesSql}`,
          slice.flat(),
        );
      }
    }

    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    watched.forEach((w, i) => {
      const alias = `m_${i}`;
      const literal = `'${w.column_name}'`; // isSimpleIdent-validated upstream
      replaceMap.set(
        w.column_name.toUpperCase(),
        // No collation overrides needed on the COALESCE arms: the staging
        // columns carry the explicit collation; the result is just selected.
        `COALESCE(${alias}.standardized_value, src.${pgQuoteIdent(w.column_name)}::text) AS ${pgQuoteIdent(w.column_name)}`,
      );
      joinClauses.push(
        `LEFT JOIN ${mapTable} ${alias}
           ON ${alias}.column_name = ${literal}
          AND ${alias}.raw_value = src.${pgQuoteIdent(w.column_name)} COLLATE "C"`,
      );
    });

    const selectList = sourceCols
      .map((c) => replaceMap.get(c.toUpperCase()) ?? `src.${pgQuoteIdent(c)}`)
      .join(',\n      ');
    const selectSQL =
      `SELECT\n         ${selectList}\n       FROM ${sourceRef} src\n       ${joinClauses.join('\n       ')}`;

    if (mode === 'overwrite') {
      const existsRows = await exec(connection, `SELECT to_regclass(?) AS oid`, [targetRef]);
      if ((existsRows[0] as any)?.oid != null) {
        // Preserve the target's identity/permissions: stage the result, then
        // DELETE + INSERT inside one transaction (needs only DELETE/INSERT on
        // the target — the same privilege bar as the other writers). The
        // transaction is what guarantees a mid-write failure never leaves the
        // target emptied — Postgres DDL/DML is fully transactional.
        await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`);
        await exec(connection, `CREATE TABLE ${stageTable} AS ${selectSQL}`);
        await exec(connection, `BEGIN`);
        try {
          await exec(connection, `DELETE FROM ${targetRef}`);
          await exec(connection, `INSERT INTO ${targetRef} SELECT * FROM ${stageTable}`);
          await exec(connection, `COMMIT`);
        } catch (err) {
          await exec(connection, `ROLLBACK`).catch(() => {});
          throw err;
        }
      } else {
        await exec(connection, `CREATE TABLE ${targetRef} AS ${selectSQL}`);
      }
    } else {
      // 'create' must FAIL on an existing table (that is what distinguishes it
      // from overwrite) — plain CREATE TABLE does exactly that.
      await exec(connection, `CREATE TABLE ${targetRef} AS ${selectSQL}`);
    }

    const cntRows = await exec(connection, `SELECT COUNT(*) AS cnt FROM ${targetRef}`);
    const rows_written = Number((cntRows[0] as any)?.cnt ?? 0);
    console.log(
      `[OneTime] Wrote ${target_fqn} ← ${source_relation} ` +
      `(${mode}; columns: ${watched.map((w) => w.column_name).join(', ')}) — ${rows_written} rows`,
    );

    // §2.8 billing: one-time sessions never touch the shared lookup, so the
    // billable unit here is each distinct value standardized in this export
    // (leaving them free would make the one-time flow a billing bypass).
    // A deliberate re-export of the SAME session re-counts — accepted edge
    // (sessions export once in practice; the archive row marks completion).
    const standardizedDistinct = watched.reduce(
      (n, w) => n + w.mappings.filter((m) => m.raw != null && m.standardized != null && m.standardized !== '').length,
      0,
    );
    await recordStandardizedUnits(connection, standardizedDistinct, 'one_time_export');

    return { rows_written };
  } finally {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`).catch(() => {});
    await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`).catch(() => {});
  }
}

// ── MySQL one-time export (port Phase M3) ────────────────────────────────────
// Mirrors the pg writer: raw-keyed map table (utf8mb4_bin — byte-exact),
// app-side normalization, per-column LEFT JOINs, CTAS create / staged
// transactional DELETE+INSERT overwrite. MySQL specifics: 2-part FQNs
// (database.table), binaryCompare on the source side of every byte-exact
// join/distinct (legacy-charset columns cannot take a bare COLLATE — M1
// live-proven), CONVERT on both COALESCE arms (mixing utf8mb4_bin with a
// source column's collation raises "illegal mix of collations"), and NO
// primary key on the map table — a (200+800)-char utf8mb4 composite key
// exceeds InnoDB's 3072-byte limit, so dedup stays app-side (seenRaw) with a
// prefix KEY for join speed.
async function exportOneTimeToMysqlTarget(
  connection: any,
  args: ExportOneTimeArgs,
): Promise<{ rows_written: number }> {
  const { source_relation, target_fqn, mode, columns, nonce } = args;

  const src = myTableRef(source_relation);
  const tgt = myTableRef(target_fqn);
  for (const c of columns) {
    if (!isSimpleIdent(c.column_name)) throw new Error('Column name contains unsupported characters.');
  }
  if (!isSimpleIdent(nonce)) throw new Error('Invalid session identifier.');
  const sourceRef = src.ref;
  const targetRef = tgt.ref;

  // ── Discover source columns (export mirrors source column names/order) ─────
  const colRows = await exec(
    connection,
    `SELECT column_name AS col
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?
     ORDER BY ordinal_position`,
    [src.db, src.table],
  );
  if (!colRows.length) {
    throw new Error(`No columns found for ${source_relation}. Verify it exists and the service account can read its database.`);
  }
  const sourceCols = colRows.map((r: any) => String(r.col ?? ''));
  const sourceColsUpper = new Set(sourceCols.map((c) => c.toUpperCase()));
  const watched = columns.filter((c) => sourceColsUpper.has(c.column_name.toUpperCase()));

  const mapTable = `prism_internal.${myQuoteIdent(`ots_map_${nonce}`)}`;
  const stageTable = `prism_internal.${myQuoteIdent(`ots_stage_${nonce}`)}`;

  try {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`);
    await exec(
      connection,
      `CREATE TABLE ${mapTable} (
         column_name        VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
         raw_value          VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
         standardized_value VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
         KEY ix_map (column_name, raw_value(191))
       ) ENGINE=InnoDB`,
    );

    for (const w of watched) {
      const stdByNorm = new Map<string, string>();
      for (const m of w.mappings) {
        if (m.raw != null && m.standardized != null && m.standardized !== '') {
          stdByNorm.set(normalizeLiteral(m.raw), m.standardized);
        }
      }
      if (stdByNorm.size === 0) continue;

      const colRef = myQuoteIdent(w.column_name);
      // binaryCompare on the DISTINCT is load-bearing for the same reason as
      // the mssql BIN2 / pg COLLATE "C" reads: the join below compares
      // byte-exact, so the distinct pass must keep byte-distinct variants
      // distinct too.
      const distinctRows = await exec(
        connection,
        `SELECT DISTINCT ${binaryCompare(colRef)} AS v FROM ${sourceRef} WHERE ${colRef} IS NOT NULL`,
      );
      const stagingRows: Array<[string, string, string]> = [];
      const seenRaw = new Set<string>();
      for (const r of distinctRows) {
        const raw = String((r as any).v);
        if (raw.length > 800 || seenRaw.has(raw)) continue;
        const std = stdByNorm.get(normalizeLiteral(raw));
        if (std == null) continue;
        seenRaw.add(raw);
        stagingRows.push([w.column_name, raw, std]);
      }
      const BATCH = 5_000;
      for (let i = 0; i < stagingRows.length; i += BATCH) {
        const slice = stagingRows.slice(i, i + BATCH);
        const valuesSql = slice.map(() => '(?, ?, ?)').join(', ');
        await exec(
          connection,
          `INSERT INTO ${mapTable} (column_name, raw_value, standardized_value) VALUES ${valuesSql}`,
          slice.flat(),
        );
      }
    }

    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    watched.forEach((w, i) => {
      const alias = `m_${i}`;
      const literal = `'${w.column_name}'`; // isSimpleIdent-validated upstream
      const colRef = myQuoteIdent(w.column_name);
      replaceMap.set(
        w.column_name.toUpperCase(),
        // CONVERT on BOTH arms: the staging column is utf8mb4_bin and the
        // source column carries its own collation — COALESCE across them
        // raises "illegal mix of collations" without the normalization.
        `COALESCE(CONVERT(${alias}.standardized_value USING utf8mb4), CONVERT(src.${colRef} USING utf8mb4)) AS ${colRef}`,
      );
      joinClauses.push(
        `LEFT JOIN ${mapTable} ${alias}
           ON ${alias}.column_name = ${literal}
          AND ${alias}.raw_value = ${binaryCompare(`src.${colRef}`)}`,
      );
    });

    const selectList = sourceCols
      .map((c) => replaceMap.get(c.toUpperCase()) ?? `src.${myQuoteIdent(c)}`)
      .join(',\n      ');
    const selectSQL =
      `SELECT\n         ${selectList}\n       FROM ${sourceRef} src\n       ${joinClauses.join('\n       ')}`;

    if (mode === 'overwrite') {
      const existsRows = await exec(
        connection,
        `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [tgt.db, tgt.table],
      );
      if (Number((existsRows[0] as any)?.c ?? 0) > 0) {
        // Preserve the target's identity/permissions: stage the result (DDL —
        // auto-commits, deliberately OUTSIDE the transaction), then DELETE +
        // INSERT inside one InnoDB transaction so a mid-write failure never
        // leaves the target emptied.
        await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`);
        await exec(connection, `CREATE TABLE ${stageTable} AS ${selectSQL}`);
        await exec(connection, `BEGIN`);
        try {
          await exec(connection, `DELETE FROM ${targetRef}`);
          await exec(connection, `INSERT INTO ${targetRef} SELECT * FROM ${stageTable}`);
          await exec(connection, `COMMIT`);
        } catch (err) {
          await exec(connection, `ROLLBACK`).catch(() => {});
          throw err;
        }
      } else {
        await exec(connection, `CREATE TABLE ${targetRef} AS ${selectSQL}`);
      }
    } else {
      // 'create' must FAIL on an existing table — plain CREATE TABLE does.
      await exec(connection, `CREATE TABLE ${targetRef} AS ${selectSQL}`);
    }

    const cntRows = await exec(connection, `SELECT COUNT(*) AS cnt FROM ${targetRef}`);
    const rows_written = Number((cntRows[0] as any)?.cnt ?? 0);
    console.log(
      `[OneTime] Wrote ${target_fqn} ← ${source_relation} ` +
      `(${mode}; columns: ${watched.map((w) => w.column_name).join(', ')}) — ${rows_written} rows`,
    );

    // §2.8 billing: one-time sessions never touch the shared lookup, so the
    // billable unit here is each distinct value standardized in this export
    // (leaving them free would make the one-time flow a billing bypass).
    // A deliberate re-export of the SAME session re-counts — accepted edge
    // (sessions export once in practice; the archive row marks completion).
    const standardizedDistinct = watched.reduce(
      (n, w) => n + w.mappings.filter((m) => m.raw != null && m.standardized != null && m.standardized !== '').length,
      0,
    );
    await recordStandardizedUnits(connection, standardizedDistinct, 'one_time_export');

    return { rows_written };
  } finally {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`).catch(() => {});
    await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`).catch(() => {});
  }
}

// ── SQL Server one-time export (port Phase 7) ────────────────────────────────
// No SQL-side normalize exists on this warehouse, so the mapping table is
// keyed by RAW value: read each watched column's distinct raw values,
// normalize app-side, resolve the standardized name from the run's mappings,
// and join on raw equality (BIN2 — exact match). Same fall-through semantics
// as the Snowflake writer: unmapped/NULL values keep their raw value.
async function exportOneTimeToMssqlTarget(
  connection: any,
  args: {
    source_relation: string; target_fqn: string; mode: 'create' | 'overwrite';
    nonce: string; sourceRef: string; targetRef: string; sourceCols: string[];
    watched: OneTimeExportColumn[];
  },
): Promise<{ rows_written: number }> {
  const { source_relation, target_fqn, mode, nonce, sourceRef, targetRef, sourceCols, watched } = args;
  const BIN2 = 'Latin1_General_100_BIN2';
  const mapTable = `${internalObject(quoteIdent(`OTS_MAP_${nonce}`))}`;
  const stageTable = `${internalObject(quoteIdent(`OTS_STAGE_${nonce}`))}`;

  try {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`);
    await exec(
      connection,
      `CREATE TABLE ${mapTable} (
         column_name        NVARCHAR(200) COLLATE ${BIN2} NOT NULL,
         raw_value          NVARCHAR(800) COLLATE ${BIN2} NOT NULL,
         standardized_value NVARCHAR(800) NOT NULL,
         CONSTRAINT ${quoteIdent(`PK_OTS_MAP_${nonce}`)} PRIMARY KEY (column_name, raw_value)
       )`,
    );

    for (const w of watched) {
      const stdByNorm = new Map<string, string>();
      for (const m of w.mappings) {
        if (m.raw != null && m.standardized != null && m.standardized !== '') {
          stdByNorm.set(normalizeLiteral(m.raw), m.standardized);
        }
      }
      if (stdByNorm.size === 0) continue;

      const colRef = quoteIdent(w.column_name);
      // COLLATE is load-bearing — same defect as KI-138 in the pipeline export
      // path, filed separately here as KI-82 because the one-time flow builds
      // its own staging table. Without it this DISTINCT runs under the SOURCE
      // database's collation, which is case-insensitive by default
      // (SQL_Latin1_General_CP1_CI_AS), so 'ATT' and 'att' collapse to one
      // representative — while the join that applies the mapping below is
      // explicitly BIN2 (`m.raw_value = src.<col> COLLATE ${BIN2}`). Every row
      // whose bytes differ from the surviving representative then matches
      // nothing and exports unstandardized. Distinct-ing under the SAME
      // collation the join uses keeps the two halves consistent.
      const distinctRows = await exec(
        connection,
        `SELECT DISTINCT ${colRef} COLLATE ${BIN2} AS v FROM ${sourceRef} WHERE ${colRef} IS NOT NULL`,
      );
      const stagingRows: Array<[string, string, string]> = [];
      const seenRaw = new Set<string>();
      for (const r of distinctRows) {
        const raw = String(r.v);
        if (raw.length > 800 || seenRaw.has(raw)) continue;
        const std = stdByNorm.get(normalizeLiteral(raw));
        if (std == null) continue;
        seenRaw.add(raw);
        stagingRows.push([w.column_name, raw, std]);
      }
      const BATCH = 500; // 3 binds/row → 1500, inside the ~2.1k ceiling
      for (let i = 0; i < stagingRows.length; i += BATCH) {
        const slice = stagingRows.slice(i, i + BATCH);
        const valuesSql = slice.map(() => '(?, ?, ?)').join(', ');
        await exec(
          connection,
          `INSERT INTO ${mapTable} (column_name, raw_value, standardized_value) VALUES ${valuesSql}`,
          slice.flat(),
        );
      }
    }

    const replaceMap = new Map<string, string>();
    const joinClauses: string[] = [];
    watched.forEach((w, i) => {
      const alias = `m_${i}`;
      const literal = `'${w.column_name}'`; // isSimpleIdent-validated upstream
      replaceMap.set(
        w.column_name.toUpperCase(),
        // Both COALESCE arms forced to one collation — staging is BIN2 while
        // source columns carry arbitrary collations (conflict otherwise).
        `COALESCE(${alias}.standardized_value COLLATE DATABASE_DEFAULT, src.${quoteIdent(w.column_name)} COLLATE DATABASE_DEFAULT) AS ${quoteIdent(w.column_name)}`,
      );
      joinClauses.push(
        `LEFT JOIN ${mapTable} ${alias}
           ON ${alias}.column_name = ${literal}
          AND ${alias}.raw_value = src.${quoteIdent(w.column_name)} COLLATE ${BIN2}`,
      );
    });

    const selectList = sourceCols
      .map((c) => replaceMap.get(c.toUpperCase()) ?? `src.${quoteIdent(c)}`)
      .join(',\n      ');
    const fromClause = `FROM ${sourceRef} src\n       ${joinClauses.join('\n       ')}`;
    const selectInto = (dest: string) =>
      `SELECT\n         ${selectList}\n       INTO ${dest}\n       ${fromClause}`;

    if (mode === 'overwrite') {
      const tgt = parseFqn(target_fqn);
      const bracketRef = `[${tgt.db.replace(/]/g, ']]')}].[${tgt.schema.replace(/]/g, ']]')}].[${tgt.table.replace(/]/g, ']]')}]`;
      const existsRows = await exec(connection, `SELECT OBJECT_ID(?) AS oid`, [bracketRef]);
      if (existsRows[0]?.oid != null) {
        // Preserve the target's identity/permissions: stage the result, then
        // DELETE + INSERT (needs only DELETE/INSERT on the target — the same
        // privilege bar as the Snowflake fallback path).
        await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`);
        await exec(connection, selectInto(stageTable));
        await exec(connection, `DELETE FROM ${targetRef}`);
        await exec(connection, `INSERT INTO ${targetRef} SELECT * FROM ${stageTable}`);
      } else {
        await exec(connection, selectInto(targetRef));
      }
    } else {
      await exec(connection, selectInto(targetRef));
    }

    const cntRows = await exec(connection, `SELECT COUNT(*) AS cnt FROM ${targetRef}`);
    const rows_written = Number(cntRows[0]?.cnt ?? 0);
    console.log(
      `[OneTime] Wrote ${target_fqn} ← ${source_relation} ` +
      `(${mode}; columns: ${watched.map((w) => w.column_name).join(', ')}) — ${rows_written} rows`,
    );

    // §2.8 billing: one-time sessions never touch the shared lookup, so the
    // billable unit here is each distinct value standardized in this export
    // (leaving them free would make the one-time flow a billing bypass).
    // A deliberate re-export of the SAME session re-counts — accepted edge
    // (sessions export once in practice; the archive row marks completion).
    const standardizedDistinct = watched.reduce(
      (n, w) => n + w.mappings.filter((m) => m.raw != null && m.standardized != null && m.standardized !== '').length,
      0,
    );
    await recordStandardizedUnits(connection, standardizedDistinct, 'one_time_export');

    return { rows_written };
  } finally {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`).catch(() => {});
    await exec(connection, `DROP TABLE IF EXISTS ${stageTable}`).catch(() => {});
  }
}
