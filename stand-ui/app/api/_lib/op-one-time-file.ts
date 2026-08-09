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
 * metrics) and is being retired. Sharing a module would have coupled the code
 * that stays to the code that goes.
 */

import 'server-only';

import { executeQuery as execSql, getWarehouseAdapter } from './warehouse';
import { normalizeLiteral, sqlStringLiteral } from './normalize';

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
  const isMssql = getWarehouseAdapter().kind === 'mssql';
  for (let b = 0; b < rows.length; b += INSERT_BATCH) {
    const chunk = rows.slice(b, b + INSERT_BATCH);
    const vals  = chunk.map((_, i) => `(?, ${b + i}, ?)`).join(', ');
    const binds: unknown[] = [];
    for (const r of chunk) { binds.push(sessionNonce, JSON.stringify(r)); }
    await execSql(
      conn,
      isMssql
        ? `INSERT INTO PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS (session_nonce, row_num, column_data)
           VALUES ${vals}`
        : `INSERT INTO PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS (session_nonce, row_num, column_data)
           SELECT column1, column2, PARSE_JSON(column3) FROM VALUES ${vals}`,
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
  const isMssql = getWarehouseAdapter().kind === 'mssql';
  const rows = await execSql(
    conn,
    isMssql
      // NOTE the quotes around both interpolations. sqlStringLiteral (and
      // mssqlJsonPath, which wraps it) returns ESCAPED CONTENT, not a quoted
      // literal — every existing caller supplies the quotes itself. Without
      // them Snowflake parses the column name as an identifier and fails with
      // "invalid identifier 'CARRIER'". Caught by the live test, not by tsc.
      ? `SELECT JSON_VALUE(column_data, '${mssqlJsonPath(columnName)}') AS v
         FROM PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS
         WHERE session_nonce = ?`
      : `SELECT column_data['${sqlStringLiteral(columnName)}']::STRING AS v
         FROM PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS
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
    `SELECT column_data FROM PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS
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
    `DELETE FROM PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS WHERE session_nonce = ?`,
    [sessionNonce],
  );
}

/** Row count for a session — used by the create route's size guard. */
export async function countOneTimeFileRows(conn: any, sessionNonce: string): Promise<number> {
  const rows = await execSql(
    conn,
    `SELECT COUNT(*) AS n FROM PRISM_DB.INTERNAL.ONE_TIME_FILE_ROWS WHERE session_nonce = ?`,
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
  const isMssql = getWarehouseAdapter().kind === 'mssql';
  const colType = isMssql ? 'NVARCHAR(MAX)' : 'VARCHAR';
  const quoted  = headers.map(h => `"${String(h).replace(/"/g, '""')}"`);
  const colDefs = quoted.map(q => `${q} ${colType}`).join(', ');

  if (isMssql) {
    // T-SQL has no CREATE OR REPLACE. 'create' must FAIL on an existing table
    // (that is what distinguishes it from overwrite), so only overwrite drops.
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
