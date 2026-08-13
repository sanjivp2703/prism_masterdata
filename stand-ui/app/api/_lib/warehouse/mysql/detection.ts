/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// MySQL change detection — tiered diff scans gated by the
// information_schema.TABLES.UPDATE_TIME heartbeat (docs/MYSQL_PORT_PLAN.md
// §2.2). No binlog/CDC (needs REPLICATION privileges and server config —
// wrong trust profile for a plain service user), no triggers (DDL on customer
// tables), so every MySQL pipeline runs diff mode.
//
// ⚠️ THE HEARTBEAT'S LOAD-BEARING SESSION VARIABLE: MySQL 8.0 caches
// statistics-backed information_schema columns — UPDATE_TIME and TABLE_ROWS
// included — for `information_schema_stats_expiry` seconds, DEFAULT 86400
// (24 HOURS). A heartbeat read through that cache would report "unchanged"
// for up to a day after a write, silently freezing detection. Every
// connection this adapter opens runs `SET SESSION
// information_schema_stats_expiry = 0` (connection.ts) so these reads come
// fresh from InnoDB's dynamic metadata — still cheap, never a table scan.
//
// UPDATE_TIME caveats the poller design absorbs: second-granularity (fine at
// minute cadence), server-restart resets it to NULL, and it cannot
// distinguish deletes from inserts — so unlike the pg heartbeat there is NO
// free same-cycle delete flag; deletes surface via the hourly safety rebuild
// (the mssql diff-mode story).
//
// PURE warehouse operations: every function takes a connection + state and
// returns data/new state. Persistence, pausing, alerts and SSE live in
// _lib/pipeline-poller-mysql.ts.
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { executeQuery as exec } from './connection';
import { quoteIdent, parseFqn, binaryCompare, classifyMysqlPollError } from './dialect';
// Tier constants/thresholds are deliberately SHARED with the other diff-scan
// engines (same scan shape, same self-tuning semantics).
import { computeScanTier, retuneScanTier } from '../mssql/dialect';

export { computeScanTier, retuneScanTier, classifyMysqlPollError };

// ── State ────────────────────────────────────────────────────────────────────

export interface MysqlDetectionState {
  mode: 'diff';
  /** MySQL always runs diff mode; drives the UI's (nudge-free) hint. */
  diff_reason: 'mysql_diff';
  /** Last seen UPDATE_TIME marker ("never" = NULL — unwritten or post-restart). */
  heartbeat?: string | null;
  /** Run the real scan every N poll passes (tier). */
  scan_every?: number;
  /** Poll passes since the last real scan. */
  passes_since_scan?: number;
  /** Duration of the last real scan (ms) — drives tier retuning. */
  last_scan_ms?: number;
  /** Sleep-on-idle provider (PlanetScale) — cadence multiplier applies. */
  serverless?: boolean;
}

// Same cap as the other diff engines (values pass through app memory; the
// queue drains in 5k installments anyway).
export const DIFF_SCAN_MAX_DISTINCT = 20_000;

// ── FQN handling ─────────────────────────────────────────────────────────────

/** database.table reference (MySQL has no schema level). */
export function myTableRef(fqn: string): { ref: string; db: string; table: string } {
  const { db, table } = parseFqn(fqn);
  return { ref: `${quoteIdent(db)}.${quoteIdent(table)}`, db, table };
}

// ── Catalog probes ────────────────────────────────────────────────────────────

/** Approximate row count from InnoDB stats (fresh — stats_expiry=0 on every
 *  connection; see the module header). */
export async function getApproxRowCount(conn: any, fqn: string): Promise<number> {
  const { db, table } = myTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT COALESCE(TABLE_ROWS, 0) AS c FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ?`,
    [db, table],
  );
  return Number(rows[0]?.c ?? 0);
}

/** PK columns in key order ([] = no primary key) — used by the export
 *  builder's ordering tiers (Phase M3), not by detection itself. */
export async function getPrimaryKeyColumns(conn: any, fqn: string): Promise<string[]> {
  const { db, table } = myTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT column_name AS col FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = 'PRIMARY'
     ORDER BY seq_in_index`,
    [db, table],
  );
  return rows.map((r: any) => String(r.col));
}

// ── Health check (catalog-only, cheap) ───────────────────────────────────────

export type MysqlSourceHealth =
  | { ok: true; masked: false }
  | { ok: false; reason: 'table_missing' | 'column_missing' | 'column_not_text'; message: string };

// ENUM included deliberately: it holds exactly the categorical strings Prism
// standardizes. SET excluded (comma-joined multi-values are not one value).
const TEXT_TYPES = new Set(['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum']);

/** MySQL has NO masking/RLS analog — `masked` is always false here, so the
 *  policy-skip machinery the other warehouses need never engages. */
export async function checkSourceHealthMysql(conn: any, fqn: string, column: string): Promise<MysqlSourceHealth> {
  const { db, table } = myTableRef(fqn);

  const tRows = await exec(
    conn,
    `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    [db, table],
  );
  if (!tRows.length) {
    return { ok: false, reason: 'table_missing', message: `Source table ${fqn} no longer exists or is not accessible.` };
  }

  const colRows = await exec(
    conn,
    `SELECT column_name AS col, data_type AS type_name
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?`,
    [db, table],
  );
  const col = colRows.find((r: any) => String(r.col).toLowerCase() === column.toLowerCase());
  if (!col) {
    return { ok: false, reason: 'column_missing', message: `Watched column "${column}" no longer exists on ${fqn}.` };
  }
  if (!TEXT_TYPES.has(String(col.type_name).toLowerCase())) {
    return { ok: false, reason: 'column_not_text', message: `Watched column "${column}" on ${fqn} is no longer a text type (now ${col.type_name}).` };
  }
  return { ok: true, masked: false };
}

// ── Mode selection / init ─────────────────────────────────────────────────────

/** MySQL pipelines always run diff mode (see the module header). */
export async function initDetection(
  conn: any,
  fqn: string,
  opts: { serverless?: boolean } = {},
): Promise<MysqlDetectionState> {
  const serverless = opts.serverless ?? false;
  const rowCount = await getApproxRowCount(conn, fqn).catch(() => 0);
  return {
    mode: 'diff',
    diff_reason: 'mysql_diff',
    heartbeat: null,
    scan_every: computeScanTier(rowCount, serverless),
    passes_since_scan: 0,
    serverless,
  };
}

// ── Diff-scan path ────────────────────────────────────────────────────────────

/**
 * Free heartbeat: the table's last write time from InnoDB metadata (fresh —
 * stats_expiry=0). "never" = NULL (unwritten table, or ANY server restart —
 * UPDATE_TIME is not crash-persistent), which the caller treats as "changed":
 * fail open into a scan rather than miss a write.
 */
export async function diffHeartbeat(conn: any, fqn: string): Promise<string | 'unavailable'> {
  const { db, table } = myTableRef(fqn);
  try {
    const rows = await exec(
      conn,
      `SELECT DATE_FORMAT(UPDATE_TIME, '%Y-%m-%dT%H:%i:%s') AS lu
       FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [db, table],
    );
    if (!rows.length) return 'unavailable'; // table gone — health check will pause
    return String(rows[0]?.lu ?? 'never');
  } catch {
    return 'unavailable';
  }
}

/** The real scan: byte-distinct non-null values + frequencies, capped at
 *  DIFF_SCAN_MAX_DISTINCT (+1 sentinel to detect truncation).
 *
 *  The GROUP BY runs under binaryCompare (CONVERT … utf8mb4_bin) — the same
 *  distinct-read collation rule the mssql port learned as KI-138: grouping
 *  under the default case-insensitive collation would collapse 'ATT'/'att'
 *  into one representative that byte-exact staging joins then cannot match.
 *  The CONVERTed value IS the value (charset conversion preserves content),
 *  so selecting the group key doubles as the representative and satisfies
 *  ONLY_FULL_GROUP_BY. */
export async function diffScan(
  conn: any,
  fqn: string,
  column: string,
): Promise<{ values: Array<{ literal_value: string; frequency: number }>; truncated: boolean; durationMs: number }> {
  const { ref } = myTableRef(fqn);
  const colRef = quoteIdent(column);
  const started = Date.now();
  const rows = await exec(
    conn,
    `SELECT ${binaryCompare(colRef)} AS v, COUNT(*) AS freq
     FROM ${ref}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${binaryCompare(colRef)}
     ORDER BY COUNT(*) DESC
     LIMIT ${DIFF_SCAN_MAX_DISTINCT + 1}`,
  );
  const durationMs = Date.now() - started;
  const truncated = rows.length > DIFF_SCAN_MAX_DISTINCT;
  const slice = truncated ? rows.slice(0, DIFF_SCAN_MAX_DISTINCT) : rows;

  // Dedup on the normalized form (representative original + summed freq) —
  // mirrors the Snowflake GROUP BY PRISM_NORMALIZE scan.
  const byNorm = new Map<string, { literal_value: string; frequency: number }>();
  for (const r of slice) {
    const literal = String(r.v);
    const norm = normalizeLiteral(literal);
    if (!norm) continue;
    const cur = byNorm.get(norm);
    if (cur) cur.frequency += Number(r.freq ?? 1);
    else byNorm.set(norm, { literal_value: literal, frequency: Number(r.freq ?? 1) });
  }
  return { values: [...byNorm.values()], truncated, durationMs };
}

/**
 * Filter scan results down to values needing the queue: NOT already queued
 * and NOT already mapped in the lookup (diff mode cannot tell "new row of a
 * known value" from an old row — known values surface via the hourly safety
 * rebuild; see WAREHOUSES.md).
 */
export async function filterUnknownValues(
  conn: any,
  pipelineId: number,
  domainId: number | null,
  candidates: Array<{ literal_value: string; frequency: number }>,
): Promise<Array<{ literal_value: string; frequency: number }>> {
  if (!candidates.length) return [];

  const queuedRows = await exec(
    conn,
    `SELECT literal_value FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`,
    [pipelineId],
  );
  const queuedNorms = new Set(queuedRows.map((r: any) => normalizeLiteral(String(r.literal_value))));

  const unqueued = candidates.filter(c => !queuedNorms.has(normalizeLiteral(c.literal_value)));
  if (!unqueued.length) return [];

  const mappedNorms = new Set<string>();
  const domainFilter = domainId != null ? `AND domain_id = ?` : `AND domain_id IS NULL`;
  const BATCH = 5_000;
  for (let i = 0; i < unqueued.length; i += BATCH) {
    const batch = unqueued.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const binds: any[] = batch.map(c => normalizeLiteral(c.literal_value));
    if (domainId != null) binds.push(domainId);
    const rows = await exec(
      conn,
      `SELECT DISTINCT normalized_value AS nv
       FROM prism_internal.literal_alias_matches
       WHERE normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const r of rows) mappedNorms.add(String(r.nv));
  }

  return unqueued.filter(c => !mappedNorms.has(normalizeLiteral(c.literal_value)));
}

// ── Queue write ───────────────────────────────────────────────────────────────

/** Idempotent upsert into pipeline_queue via INSERT … ON DUPLICATE KEY UPDATE
 *  with the 8.0.19+ row-alias form (`VALUES()` is deprecated in 8.0.20 and
 *  removed in 8.4 — the alias form is the only spelling valid across the
 *  supported range, which is why the version floor is 8.0.19). The conflict
 *  target is the functional (pipeline_id, SHA2(literal_value)) unique key.
 *  Guards mirror every other queueValues: over-long values dropped loudly
 *  (KI-121) and in-batch normalized duplicates collapsed (KI-106). */
export async function queueValues(
  conn: any,
  pipelineId: number,
  values: Array<{ literal_value: string; frequency: number }>,
): Promise<number> {
  const MAX_LEN = 800;
  const seenNorm = new Set<string>();
  const oversized: number[] = [];
  const safeValues: Array<{ literal_value: string; frequency: number }> = [];
  for (const v of values) {
    if (v.literal_value.length > MAX_LEN) { oversized.push(v.literal_value.length); continue; }
    const key = normalizeLiteral(v.literal_value);
    if (seenNorm.has(key)) continue;
    seenNorm.add(key);
    safeValues.push(v);
  }
  if (oversized.length > 0) {
    console.warn(
      `[mysql/detection] Pipeline ${pipelineId}: skipped ${oversized.length} source value(s) longer than ` +
      `${MAX_LEN} chars (lengths: ${oversized.slice(0, 5).join(', ')}${oversized.length > 5 ? ', …' : ''}) — ` +
      `they exceed the lookup column width and can never be standardized.`,
    );
  }
  values = safeValues;

  const BATCH = 5_000; // 3 binds/row — client-side interpolation, packet-bounded
  let queued = 0;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const rowsSql = batch.map(() => '(?, ?, ?)').join(', ');
    const binds: any[] = [];
    for (const v of batch) binds.push(pipelineId, v.literal_value, v.frequency);
    await exec(
      conn,
      `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency)
       VALUES ${rowsSql} AS new_rows
       ON DUPLICATE KEY UPDATE source_frequency = new_rows.source_frequency`,
      binds,
    );
    queued += batch.length;
  }
  return queued;
}

export async function getQueueSize(conn: any, pipelineId: number): Promise<number> {
  const rows = await exec(conn, `SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [pipelineId]);
  return Number(rows[0]?.c ?? 0);
}
