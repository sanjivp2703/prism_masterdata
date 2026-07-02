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

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => (err ? reject(err) : resolve(rows ?? [])),
    });
  });
}

// ---------------------------------------------------------------------------
// stats_snapshot helpers — one-time metadata lives here (not in the lookup)
// ---------------------------------------------------------------------------

export interface OneTimeMeta {
  one_time_session: string;
  convention:       NamingConvention | null;
  accepted:         boolean;
}

function safeJsonParse(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function loadOneTimeMeta(connection: any, runId: number): Promise<OneTimeMeta | null> {
  const rows = await exec(
    connection,
    `SELECT stats_snapshot FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ? AND run_type = 'one_time'`,
    [runId],
  );
  if (!rows.length) return null;
  const raw = (rows[0] as any).STATS_SNAPSHOT ?? (rows[0] as any).stats_snapshot;
  const parsed = safeJsonParse(raw) ?? {};
  return {
    one_time_session: String(parsed.one_time_session ?? ''),
    convention:       parsed.convention ?? null,
    accepted:         parsed.accepted === true,
  };
}

export async function saveOneTimeMeta(connection: any, runId: number, meta: OneTimeMeta): Promise<void> {
  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS
     SET stats_snapshot = PARSE_JSON(?), updated_at = CURRENT_TIMESTAMP()
     WHERE run_id = ?`,
    [JSON.stringify(meta), runId],
  );
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
}

/**
 * Probes the source column for distinct (normalized-deduped) values and inserts a
 * RUNS row with run_type = 'one_time', domain_id = NULL. Returns the new run_id.
 */
export async function createOneTimeRun(connection: any, args: CreateOneTimeRunArgs): Promise<number> {
  const { source_relation, column_name, createdBy, sessionNonce, convention } = args;
  const { db, schema, table } = parseFqn(source_relation);

  if (![db, schema, table, column_name].every(isSimpleIdent)) {
    throw new Error('Table or column name contains unsupported characters.');
  }

  const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colRef   = quoteIdent(column_name);

  // Dedupe by the normalized form (a representative original kept via ANY_VALUE)
  // so byte-variant spellings collapse to one item — and so the export's
  // normalized join key is unique (no last-write-wins collision).
  const valueRows = await exec(
    connection,
    `SELECT ANY_VALUE(TO_VARCHAR(${colRef})) AS literal_value,
            COUNT(*) AS source_frequency
     FROM ${tableRef}
     WHERE ${colRef} IS NOT NULL
     GROUP BY STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(TO_VARCHAR(${colRef}))
     ORDER BY source_frequency DESC`,
  );

  const nonce = `ot_${sessionNonce}_${column_name}`;
  await exec(
    connection,
    `INSERT INTO STAND_DB.STAND_INTERNAL.RUNS
       (concept_key, source_relation, source_column, mode, domain_id, run_type, created_by,
        run_status, creation_nonce, created_at, updated_at)
     VALUES ('one_time', ?, ?, 'manual', NULL, 'one_time', ${Number(createdBy)},
             'created', ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    [source_relation, column_name, nonce],
  );

  const idRows = await exec(
    connection,
    `SELECT run_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE creation_nonce = ? ORDER BY run_id DESC LIMIT 1`,
    [nonce],
  );
  if (!idRows.length) throw new Error('One-time run was created but the run ID could not be retrieved.');
  const runId = Number((idRows[0] as any).RUN_ID ?? (idRows[0] as any).run_id);

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
  await saveOpRunState(connection, runId, initialState);
  await saveOneTimeMeta(connection, runId, { one_time_session: sessionNonce, convention, accepted: false });

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
  const state = await loadOpRunState(connection, runId);
  if (!state) throw new Error(`Run state not found for run_id=${runId}.`);
  const meta = await loadOneTimeMeta(connection, runId);

  const convention: NamingConvention | null =
    meta?.convention && (meta.convention.type || hasAnyRule(meta.convention.rules))
      ? meta.convention
      : null;

  const items = state.items ?? [];
  if (items.length === 0) {
    const empty: OpRunState = { status: 'complete', items: [], groups: [], ungrouped: [] };
    await saveOpRunState(connection, runId, empty);
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

  // No domain context, no existing alias names, no standardization rules — just
  // the LLM's world knowledge plus the optional naming convention.
  const result = await runOnePromptGrouping(runItems, '', '', [], convention, null);

  const runItemsById = new Map(runItems.map((ri) => [ri.run_item_id, ri]));
  const ordered = [
    ...result.groups.filter((g) => !g.is_singleton),
    ...result.groups.filter((g) =>  g.is_singleton),
  ];

  let nextGroupId = 1;
  const groups: OpGroup[] = [];
  const groupedLiterals = new Set<string>();

  for (const g of ordered) {
    const groupItems: OpGroupItem[] = g.member_ids
      .map((id) => runItemsById.get(id))
      .filter((ri): ri is RunItemForPairing => ri != null)
      .map((ri) => ({ literal_value: ri.literal_value, matched_from_lookup: false }));
    if (groupItems.length === 0) continue;

    const proposed = (g.proposed_name ?? '').trim();
    const name = proposed || pickBestAliasName(
      g.member_ids.map((id) => runItemsById.get(id)).filter((m): m is RunItemForPairing => m != null),
    ).literal_value || groupItems[0].literal_value;

    for (const gi of groupItems) groupedLiterals.add(gi.literal_value);
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
  await saveOpRunState(connection, runId, newState);

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
}

/**
 * Writes a standalone copy of the source table to `target_fqn`, with each watched
 * column's values replaced by their accepted standardized name. Unmapped/NULL
 * values fall through to their raw value. Builds a temporary mapping table, joins
 * the source against it per column, then drops it. Touches no lookup tables.
 */
export async function exportOneTimeToSnowflake(connection: any, args: ExportOneTimeArgs): Promise<{ rows_written: number }> {
  const { source_relation, target_fqn, mode, columns, nonce } = args;

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

  const mapTable = `STAND_DB.STAND_INTERNAL.${quoteIdent(`OTS_MAP_${nonce}`)}`;

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
          AND ${alias}.normalized_value = STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(TO_VARCHAR(src.${quoteIdent(w.column_name)}))`,
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
      // DELETE + INSERT when STAND_ADMIN doesn't own the existing table —
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

        // Build staging table in STAND_INTERNAL (always writable), then
        // overwrite target rows. Target schema must match the source.
        const stageRef = `STAND_DB.STAND_INTERNAL.${quoteIdent(`OTS_FALLBACK_${nonce}`)}`;
        try {
          await exec(connection, `CREATE OR REPLACE TEMPORARY TABLE ${stageRef} AS ${selectSQL}`);
          await exec(connection, `DELETE FROM ${targetRef} WHERE TRUE`);
          await exec(connection, `INSERT INTO ${targetRef} SELECT * FROM ${stageRef}`);
        } finally {
          await exec(connection, `DROP TABLE IF EXISTS ${stageRef}`).catch(() => {});
        }
      }
    } else {
      await exec(connection, `CREATE OR REPLACE TABLE ${targetRef} AS ${selectSQL}`);
    }

    const cntRows = await exec(connection, `SELECT COUNT(*) AS cnt FROM ${targetRef}`);
    const rows_written = Number((cntRows[0] as any)?.CNT ?? (cntRows[0] as any)?.cnt ?? 0);

    console.log(
      `[OneTime] Wrote ${target_fqn} ← ${source_relation} ` +
      `(${mode}; columns: ${watched.map((w) => w.column_name).join(', ')}) — ${rows_written} rows`,
    );
    return { rows_written };
  } finally {
    await exec(connection, `DROP TABLE IF EXISTS ${mapTable}`).catch(() => {});
  }
}
