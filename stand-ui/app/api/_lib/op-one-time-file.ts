/* eslint-disable @typescript-eslint/no-explicit-any -- warehouse connections and
   driver row shapes are untyped at the facade boundary; same convention as
   pipeline-poller-mssql.ts. */
/**
 * One-time standardization from a FILE or GOOGLE SHEET source.
 *
 * The one-time flow historically read only a warehouse table
 * (`source_relation` = DB.SCHEMA.TABLE). Files and Sheets are inherently
 * one-shot — you clean a list once — which is why they belong here rather than
 * on a pipeline, where a Google Sheet had to be polled every 60 seconds to
 * pretend it was a live source.
 *
 * Rows live in the warehouse (`INTERNAL.ONE_TIME_FILE_ROWS`), keyed by the
 * session nonce, for two reasons:
 *   1. DATA RESIDENCY — they are customer values, and the rule is that values
 *      live in the customer's warehouse while SQLite keeps only metadata.
 *   2. A session spans upload → review → export, often with a long review in
 *      the middle, so the rows must outlive the request that uploaded them.
 *      The export reproduces EVERY source row with the standardized columns
 *      substituted, so distinct values alone are not enough.
 *
 * Deliberately a separate module from `op-file-pipeline.ts`: that one is the
 * pipeline-side file machinery (polling, output-tab sync, per-column pipeline
 * metrics), which has since been removed. Sharing a module would have coupled
 * the code that stayed to the code that went.
 */

import 'server-only';

import { executeQuery as execSql, getWarehouseAdapter } from './warehouse';
import { normalizeLiteral, sqlStringLiteral } from './normalize';
import { internalTable } from './warehouse-tables';

/** Matches the pipeline-side batch size — 200 keeps each statement well under
 *  Snowflake's ~65k bind ceiling while staying a single round trip per batch. */
const INSERT_BATCH = 200;

/**
 * Write the uploaded rows for a session.
 *
 * Snowflake note: `PARSE_JSON(?)` is INVALID inside a VALUES clause, so the
 * insert uses the `SELECT column1, … PARSE_JSON(column3) FROM VALUES (…)`
 * form. Do not "simplify" it back — it fails at runtime, not at compile time.
 */
export async function insertOneTimeFileRows(
  conn: any,
  sessionNonce: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const kind = getWarehouseAdapter().kind;
  for (let b = 0; b < rows.length; b += INSERT_BATCH) {
    const chunk = rows.slice(b, b + INSERT_BATCH);
    // Postgres: column_data is JSONB — the bound JSON string needs an explicit
    // cast (`?::jsonb`; the bind translator rewrites ? to $n, so the cast
    // survives). Plain VALUES is fine there — the PARSE_JSON restriction is
    // Snowflake-only.
    const tuple = kind === 'postgres' ? `(?, %ROW%, ?::jsonb)` : `(?, %ROW%, ?)`;
    const vals  = chunk.map((_, i) => tuple.replace('%ROW%', String(b + i))).join(', ');
    const binds: unknown[] = [];
    for (const r of chunk) { binds.push(sessionNonce, JSON.stringify(r)); }
    await execSql(
      conn,
      kind === 'snowflake'
        ? `INSERT INTO ${internalTable('ONE_TIME_FILE_ROWS')} (session_nonce, row_num, column_data)
           SELECT column1, column2, PARSE_JSON(column3) FROM VALUES ${vals}`
        : `INSERT INTO ${internalTable('ONE_TIME_FILE_ROWS')} (session_nonce, row_num, column_data)
           VALUES ${vals}`,
      binds,
    );
  }
}

/** JSON path member for mssql reads — escape for the JSON string, then for the
 *  SQL literal. Mirrors op-file-pipeline's helper. */
function mssqlJsonPath(columnName: string): string {
  const jsonEscaped = columnName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return sqlStringLiteral(`$."${jsonEscaped}"`);
}

/** Postgres string-literal content escaping. NOT sqlStringLiteral: that also
 *  doubles backslashes, which is right for Snowflake but corrupts the value on
 *  Postgres (standard_conforming_strings treats backslashes literally). */
function pgStringLiteral(s: string): string {
  return String(s).replace(/'/g, "''");
}

/**
 * Distinct values of one column, with real summed frequencies.
 *
 * Deduped APP-SIDE on `normalizeLiteral` rather than in SQL. Snowflake could
 * `GROUP BY PRISM_NORMALIZE(...)`, but SQL Server has no equivalent UDF, and
 * the two must agree exactly or a session created on one warehouse would group
 * differently from the other. Doing it in TS once is the only way to guarantee
 * that, and the row counts here are bounded by the upload caps anyway.
 *
 * `source_frequency` is the real number of source rows that collapsed into the
 * value (decision REV-01) — not 1. A file genuinely knows this, unlike the
 * pipeline-side PIPELINE_FILE_ROWS path where it was never available.
 */
export async function readOneTimeDistinctValues(
  conn: any,
  sessionNonce: string,
  columnName: string,
): Promise<{ literal_value: string; source_frequency: number }[]> {
  const kind = getWarehouseAdapter().kind;
  const rows = await execSql(
    conn,
    // NOTE the quotes around every interpolation. sqlStringLiteral (and
    // mssqlJsonPath, which wraps it) returns ESCAPED CONTENT, not a quoted
    // literal — every existing caller supplies the quotes itself. Without
    // them Snowflake parses the column name as an identifier and fails with
    // "invalid identifier 'CARRIER'". Caught by the live test, not by tsc.
    kind === 'mssql'
      ? `SELECT JSON_VALUE(column_data, '${mssqlJsonPath(columnName)}') AS v
         FROM ${internalTable('ONE_TIME_FILE_ROWS')}
         WHERE session_nonce = ?`
      : kind === 'mysql'
      // Same $."…" JSON-path shape as mssql, read via ->>. mssqlJsonPath's
      // escaping (JSON-escape, then backslash-doubling + quote-escaping) is
      // valid MySQL string-literal escaping too (backslash IS an escape in
      // MySQL strings, unlike Postgres) — one helper, not a drifting copy.
      ? `SELECT column_data->>'${mssqlJsonPath(columnName)}' AS v
         FROM ${internalTable('ONE_TIME_FILE_ROWS')}
         WHERE session_nonce = ?`
      : kind === 'postgres'
      ? `SELECT column_data->>'${pgStringLiteral(columnName)}' AS v
         FROM ${internalTable('ONE_TIME_FILE_ROWS')}
         WHERE session_nonce = ?`
      : `SELECT column_data['${sqlStringLiteral(columnName)}']::STRING AS v
         FROM ${internalTable('ONE_TIME_FILE_ROWS')}
         WHERE session_nonce = ?`,
    [sessionNonce],
  );

  // first-seen original wins, so the LLM sees real casing
  const byNorm = new Map<string, { literal_value: string; source_frequency: number }>();
  for (const r of rows) {
    const raw = String((r as any).V ?? (r as any).v ?? '');
    if (!raw.trim()) continue;
    const key = normalizeLiteral(raw);
    const hit = byNorm.get(key);
    if (hit) hit.source_frequency += 1;
    else byNorm.set(key, { literal_value: raw, source_frequency: 1 });
  }
  return [...byNorm.values()].sort((a, b) => b.source_frequency - a.source_frequency);
}

/** Every row of the session, in source order — the export rebuilds the full
 *  table/file from these, substituting the standardized columns. */
export async function readOneTimeFileRows(
  conn: any,
  sessionNonce: string,
): Promise<Record<string, string>[]> {
  const rows = await execSql(
    conn,
    `SELECT column_data FROM ${internalTable('ONE_TIME_FILE_ROWS')}
     WHERE session_nonce = ? ORDER BY row_num`,
    [sessionNonce],
  );
  return rows.map((r: any) => {
    const raw = r.COLUMN_DATA ?? r.column_data;
    if (raw && typeof raw === 'object') return raw as Record<string, string>;
    try { return JSON.parse(String(raw)) as Record<string, string>; } catch { return {}; }
  });
}

/** Column names present in the session's rows, in first-seen order. */
export async function readOneTimeFileColumns(conn: any, sessionNonce: string): Promise<string[]> {
  const rows = await readOneTimeFileRows(conn, sessionNonce);
  const seen: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    if (seen.length && rows.length > 50) break; // headers are uniform; don't scan the whole file
  }
  return seen;
}

/** Discard a session's rows (session abandoned, or its archive row deleted). */
export async function deleteOneTimeFileRows(conn: any, sessionNonce: string): Promise<void> {
  await execSql(
    conn,
    `DELETE FROM ${internalTable('ONE_TIME_FILE_ROWS')} WHERE session_nonce = ?`,
    [sessionNonce],
  );
  // The original-file blob shares the rows' lifecycle exactly.
  await execSql(
    conn,
    `DELETE FROM ${internalTable('ONE_TIME_FILE_BLOBS')} WHERE session_nonce = ?`,
    [sessionNonce],
  ).catch(() => { /* table absent on a pre-blob install — rows cleanup still succeeded */ });
}

// ── Original-file blob (edit-in-place round trip; see _lib/file-inplace.ts) ──
//
// The ORIGINAL uploaded file's bytes, base64-chunked: Snowflake caps a VARCHAR
// value at 16 MB and a 20 MB upload is ~27 MB of base64, so chunks keep every
// warehouse inside one uniform shape. Customer values → warehouse-side (data
// residency), same lifecycle as the row snapshot above.

const BLOB_CHUNK_CHARS = 6 * 1024 * 1024; // 6 MB of base64 per chunk

export interface OneTimeFileBlobMeta {
  file_name:  string;
  file_kind:  'csv' | 'xlsx';
  sheet_name: string | null;
  header_row: number;
}

export async function storeOneTimeFileBlob(
  conn: any,
  sessionNonce: string,
  meta: OneTimeFileBlobMeta,
  dataB64: string,
): Promise<void> {
  await execSql(conn, `DELETE FROM ${internalTable('ONE_TIME_FILE_BLOBS')} WHERE session_nonce = ?`, [sessionNonce]);
  for (let i = 0, chunk = 0; i < dataB64.length; i += BLOB_CHUNK_CHARS, chunk++) {
    await execSql(
      conn,
      `INSERT INTO ${internalTable('ONE_TIME_FILE_BLOBS')}
         (session_nonce, chunk_num, file_name, file_kind, sheet_name, header_row, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionNonce, chunk, meta.file_name, meta.file_kind, meta.sheet_name, meta.header_row, dataB64.slice(i, i + BLOB_CHUNK_CHARS)],
    );
  }
}

export async function loadOneTimeFileBlob(
  conn: any,
  sessionNonce: string,
): Promise<(OneTimeFileBlobMeta & { dataB64: string }) | null> {
  let rows: any[];
  try {
    rows = await execSql(
      conn,
      `SELECT chunk_num, file_name, file_kind, sheet_name, header_row, data
       FROM ${internalTable('ONE_TIME_FILE_BLOBS')}
       WHERE session_nonce = ?
       ORDER BY chunk_num`,
      [sessionNonce],
    );
  } catch { return null; } // table absent on a pre-blob install
  if (!rows?.length) return null;
  const first = rows[0] as any;
  return {
    file_name:  String(first.FILE_NAME ?? first.file_name ?? ''),
    file_kind:  (String(first.FILE_KIND ?? first.file_kind ?? 'csv') === 'xlsx' ? 'xlsx' : 'csv'),
    sheet_name: (first.SHEET_NAME ?? first.sheet_name) != null ? String(first.SHEET_NAME ?? first.sheet_name) : null,
    header_row: Number(first.HEADER_ROW ?? first.header_row ?? 0),
    dataB64:    rows.map((r: any) => String(r.DATA ?? r.data ?? '')).join(''),
  };
}

/** Row count for a session — used by the create route's size guard. */
export async function countOneTimeFileRows(conn: any, sessionNonce: string): Promise<number> {
  const rows = await execSql(
    conn,
    `SELECT COUNT(*) AS n FROM ${internalTable('ONE_TIME_FILE_ROWS')} WHERE session_nonce = ?`,
    [sessionNonce],
  );
  return Number((rows[0] as any)?.N ?? (rows[0] as any)?.n ?? 0);
}

/**
 * Apply confirmed mappings to every row, returning the full output grid.
 *
 * Shared by every file-source export format (CSV, Excel, Sheets, warehouse
 * table) so they cannot drift: one place decides what a standardized row looks
 * like. Unmapped and empty values pass through unchanged, matching the
 * pipeline-side export's "NULLs are standardized as-is" behaviour.
 */
export function applyMappingsToRows(
  rows: Record<string, string>[],
  headers: string[],
  mappingsByColumn: Record<string, { raw: string; standardized: string }[]>,
): string[][] {
  // Normalized lookup per standardized column. Object.create(null) because the
  // keys are customer literal values — a value of `__proto__` on a plain object
  // is silently swallowed by the prototype setter and read back as an object.
  const lookup: Record<string, Record<string, string>> = Object.create(null);
  for (const [col, maps] of Object.entries(mappingsByColumn)) {
    const m: Record<string, string> = Object.create(null);
    for (const { raw, standardized } of maps) m[normalizeLiteral(raw)] = standardized;
    lookup[col] = m;
  }
  return rows.map((row) =>
    headers.map((h) => {
      const raw = String(row[h] ?? '');
      const m   = lookup[h];
      if (!m || !raw) return raw;
      return m[normalizeLiteral(raw)] ?? raw;
    }),
  );
}

/**
 * Materialize a standardized grid as a standalone warehouse table.
 *
 * Every column is created as text: the source was a file, so Prism has no type
 * information beyond "string", and inventing types would silently coerce values
 * (a leading-zero account id becoming a number is the classic loss). The user
 * asked to clean a list, not to have it retyped.
 *
 * `mode: 'overwrite'` replaces the table wholesale rather than appending —
 * matching the warehouse-source one-time export, where overwrite means
 * "this table now holds this result", not "add to it".
 */
export async function writeGridToWarehouseTable(
  conn: any,
  args: { targetFqn: string; mode: 'create' | 'overwrite'; headers: string[]; grid: string[][] },
): Promise<number> {
  const { targetFqn, mode, headers, grid } = args;
  const kind = getWarehouseAdapter().kind;
  const isMssql = kind === 'mssql';
  const colType = isMssql ? 'NVARCHAR(MAX)' : kind === 'postgres' || kind === 'mysql' ? 'TEXT' : 'VARCHAR';
  // MySQL quotes identifiers with backticks — double quotes are STRING
  // literals there (without ANSI_QUOTES), so the "…" form would create a
  // table of string-named nonsense columns.
  const quoted  = kind === 'mysql'
    ? headers.map(h => `\`${String(h).replace(/`/g, '``')}\``)
    : headers.map(h => `"${String(h).replace(/"/g, '""')}"`);
  const colDefs = quoted.map(q => `${q} ${colType}`).join(', ');

  if (isMssql || kind === 'postgres' || kind === 'mysql') {
    // None of T-SQL, Postgres or MySQL has CREATE OR REPLACE TABLE. 'create'
    // must FAIL on an existing table (that is what distinguishes it from
    // overwrite), so only overwrite drops.
    if (mode === 'overwrite') await execSql(conn, `DROP TABLE IF EXISTS ${targetFqn}`);
    await execSql(conn, `CREATE TABLE ${targetFqn} (${colDefs})`);
  } else {
    await execSql(
      conn,
      mode === 'overwrite'
        ? `CREATE OR REPLACE TABLE ${targetFqn} (${colDefs})`
        : `CREATE TABLE ${targetFqn} (${colDefs})`,
    );
  }

  // Batched multi-row INSERT. 200 rows x N columns stays far below Snowflake's
  // ~65k bind ceiling for any realistic column count.
  const BATCH = 200;
  let written = 0;
  for (let b = 0; b < grid.length; b += BATCH) {
    const chunk = grid.slice(b, b + BATCH);
    const tuple = `(${headers.map(() => '?').join(', ')})`;
    const binds: unknown[] = [];
    for (const row of chunk) {
      for (let i = 0; i < headers.length; i++) binds.push(row[i] ?? null);
    }
    await execSql(
      conn,
      `INSERT INTO ${targetFqn} (${quoted.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`,
      binds,
    );
    written += chunk.length;
  }
  return written;
}
