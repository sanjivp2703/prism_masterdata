/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// PostgreSQL change detection — tiered diff scans gated by a free pg_stat
// heartbeat (docs/POSTGRES_PORT_PLAN.md Phase P2, decision 2.2).
//
// Postgres has no stream/Change-Tracking analog Prism can use under a plain
// service role (logical replication needs near-superuser setup; triggers need
// DDL on customer tables), so every pipeline runs DIFF mode. The heartbeat is
// better than mssql's, though: pg_stat_user_tables' write counters need NO
// special grant, and their delete counter lets the poller flag hygiene
// rebuilds (deletes) for free — something mssql diff mode cannot see at all.
//
// PURE warehouse operations: every function takes a connection + state and
// returns data/new state. Persistence (SQLite pipelines.detection_state),
// pausing, alerts and SSE live in _lib/pipeline-poller-postgres.ts.
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { executeQuery as exec, getConnectedPgDatabase } from './connection';
import { quoteIdent, parseFqn, assertFqnInDatabase, classifyPgPollError } from './dialect';
// The tier constants/thresholds are deliberately SHARED with the mssql
// diff-scan engine (same scan shape, same self-tuning semantics).
import { computeScanTier, retuneScanTier } from '../mssql/dialect';

export { computeScanTier, retuneScanTier, classifyPgPollError };

// ── State ────────────────────────────────────────────────────────────────────

export interface PgDetectionState {
  mode: 'diff';
  /** Postgres always runs diff mode; this drives the UI's (nudge-free) hint. */
  diff_reason: 'pg_diff';
  /** Last seen pg_stat write-counter marker "<ins>:<upd>:<del>" (null = never). */
  heartbeat?: string | null;
  /** Run the real scan every N poll passes (tier). */
  scan_every?: number;
  /** Poll passes since the last real scan. */
  passes_since_scan?: number;
  /** Duration of the last real scan (ms) — drives tier retuning. */
  last_scan_ms?: number;
  /** Scale-to-zero provider (Neon) — cadence multiplier applies (§2.4). */
  serverless?: boolean;
}

// Diff scans hard-cap the distinct values read per scan (values pass through
// app memory; the queue drains in 5k installments anyway). Same cap as mssql.
export const DIFF_SCAN_MAX_DISTINCT = 20_000;

// ── FQN handling ─────────────────────────────────────────────────────────────

/** schema-qualified reference for the CONNECTED database. A 3-part FQN naming
 *  another database is rejected loudly (Postgres cannot query across DBs). */
export function pgTableRef(fqn: string): { ref: string; schema: string; table: string } {
  const parsed = parseFqn(fqn);
  const connected = getConnectedPgDatabase();
  if (connected) assertFqnInDatabase(parsed, connected);
  return {
    ref: `${quoteIdent(parsed.schema)}.${quoteIdent(parsed.table)}`,
    schema: parsed.schema,
    table: parsed.table,
  };
}

// ── Catalog probes ────────────────────────────────────────────────────────────

/** Approximate row count from planner stats (catalog read, no table scan).
 *  reltuples is -1 on a never-analyzed table — treated as 0 (fast tier). */
export async function getApproxRowCount(conn: any, fqn: string): Promise<number> {
  const { schema, table } = pgTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT GREATEST(c.reltuples, 0)::bigint AS c
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ? AND c.relname = ?`,
    [schema, table],
  );
  return Number(rows[0]?.c ?? 0);
}

/** PK columns in key order ([] = no primary key) — used by the export
 *  builder's ordering tiers (Phase P3), not by detection itself. */
export async function getPrimaryKeyColumns(conn: any, fqn: string): Promise<string[]> {
  const { schema, table } = pgTableRef(fqn);
  const rows = await exec(
    conn,
    `SELECT a.attname AS col
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE i.indisprimary AND n.nspname = ? AND c.relname = ?
     ORDER BY k.ord`,
    [schema, table],
  );
  return rows.map((r: any) => String(r.col));
}

// ── Health check (catalog-only, cheap) ───────────────────────────────────────

export type PgSourceHealth =
  | { ok: true; masked: false }
  | { ok: true; masked: true }                       // RLS detected — skip standardizing, auto-recovers
  | { ok: false; reason: 'table_missing' | 'column_missing' | 'column_not_text'; message: string };

const TEXT_TYPES = new Set(['text', 'character varying', 'varchar', 'character', 'char', 'bpchar', 'citext']);

export async function checkSourceHealthPg(conn: any, fqn: string, column: string): Promise<PgSourceHealth> {
  const { schema, table } = pgTableRef(fqn);

  const tRows = await exec(
    conn,
    `SELECT c.oid::int AS oid, c.relrowsecurity AS rls
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ? AND c.relname = ? AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [schema, table],
  );
  if (!tRows.length) {
    return { ok: false, reason: 'table_missing', message: `Source table ${fqn} no longer exists or is not accessible.` };
  }

  const colRows = await exec(
    conn,
    `SELECT column_name AS col, data_type AS type_name
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?`,
    [schema, table],
  );
  const col = colRows.find((r: any) => String(r.col).toLowerCase() === column.toLowerCase());
  if (!col) {
    return { ok: false, reason: 'column_missing', message: `Watched column "${column}" no longer exists on ${fqn}.` };
  }
  if (!TEXT_TYPES.has(String(col.type_name).toLowerCase())) {
    return { ok: false, reason: 'column_not_text', message: `Watched column "${column}" on ${fqn} is no longer a text type (now ${col.type_name}).` };
  }

  // Row-Level Security on the source table is the Postgres analog of a
  // masking/row-access policy: the service role may see a filtered subset, so
  // standardizing from it would bake a partial view into the lookup
  // permanently. Skip + flag; auto-recovers when RLS is disabled.
  return { ok: true, masked: Boolean(tRows[0]?.rls) };
}

// ── Mode selection / init ─────────────────────────────────────────────────────

/** Postgres pipelines always run diff mode (see the module header). */
export async function initDetection(
  conn: any,
  fqn: string,
  opts: { serverless?: boolean } = {},
): Promise<PgDetectionState> {
  const serverless = opts.serverless ?? false;
  const rowCount = await getApproxRowCount(conn, fqn).catch(() => 0);
  return {
    mode: 'diff',
    diff_reason: 'pg_diff',
    heartbeat: null,
    scan_every: computeScanTier(rowCount, serverless),
    passes_since_scan: 0,
    serverless,
  };
}

// ── Diff-scan path ────────────────────────────────────────────────────────────

export interface PgHeartbeat {
  /** Opaque write-counter marker; compare against the stored one. */
  marker: string;
  /** Cumulative delete counter — a delta over the stored marker's third field
   *  means rows were deleted (hygiene rebuild needed). */
  deletes: number;
}

/**
 * Free heartbeat: the table's cumulative write counters from the statistics
 * collector (pg_stat_user_tables — no table access, no special grant).
 * Counters can RESET (server restart, pg_stat_reset) — the caller treats any
 * marker difference, including a backwards jump, as "changed" (fail open: one
 * wasted scan beats a missed change).
 */
export async function diffHeartbeat(conn: any, fqn: string): Promise<PgHeartbeat | 'unavailable'> {
  const { schema, table } = pgTableRef(fqn);
  try {
    const rows = await exec(
      conn,
      `SELECT COALESCE(n_tup_ins, 0) AS ins, COALESCE(n_tup_upd, 0) AS upd, COALESCE(n_tup_del, 0) AS del
       FROM pg_stat_user_tables WHERE schemaname = ? AND relname = ?`,
      [schema, table],
    );
    if (!rows.length) return { marker: 'never', deletes: 0 };
    const r = rows[0];
    return { marker: `${r.ins}:${r.upd}:${r.del}`, deletes: Number(r.del ?? 0) };
  } catch {
    return 'unavailable';
  }
}

/** Parse the delete counter out of a stored heartbeat marker. */
export function deletesFromMarker(marker: string | null | undefined): number {
  if (!marker || marker === 'never') return 0;
  const parts = String(marker).split(':');
  const del = Number(parts[2]);
  return Number.isFinite(del) ? del : 0;
}

/** The real scan: distinct non-null values + frequencies, capped at
 *  DIFF_SCAN_MAX_DISTINCT (+1 sentinel to detect truncation). */
export async function diffScan(
  conn: any,
  fqn: string,
  column: string,
): Promise<{ values: Array<{ literal_value: string; frequency: number }>; truncated: boolean; durationMs: number }> {
  const { ref } = pgTableRef(fqn);
  const colRef = quoteIdent(column);
  const started = Date.now();
  const rows = await exec(
    conn,
    `SELECT ${colRef} AS v, COUNT(*) AS freq
     FROM ${ref}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${colRef}
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
 * known value" from an old row, so known values never re-queue here — the
 * hourly safety rebuild publishes their new rows; see WAREHOUSES.md).
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

  // Batched semi-join against the lookup. Postgres's bind ceiling is ~65k;
  // 5,000/batch keeps statements a sane size (+1 scope/spec_id bind).
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

/** Idempotent upsert into pipeline_queue (INSERT … ON CONFLICT — the Postgres
 *  MERGE analog that works on the 13+ floor), batched. Guards mirror the mssql
 *  queueValues: over-long values dropped loudly (KI-121 — one 801-char value
 *  must not sink a whole batch) and in-batch normalized duplicates collapsed
 *  (KI-106 — the conflict target is the raw literal under COLLATE "C", so
 *  'ATT' and 'att' arriving together would otherwise both queue). */
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
      `[postgres/detection] Pipeline ${pipelineId}: skipped ${oversized.length} source value(s) longer than ` +
      `${MAX_LEN} chars (lengths: ${oversized.slice(0, 5).join(', ')}${oversized.length > 5 ? ', …' : ''}) — ` +
      `they exceed the lookup column width and can never be standardized.`,
    );
  }
  values = safeValues;

  const BATCH = 5_000; // 3 binds/row → 15k binds, well under the ceiling
  let queued = 0;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const rowsSql = batch.map(() => '(?, ?, ?)').join(', ');
    const binds: any[] = [];
    for (const v of batch) binds.push(pipelineId, v.literal_value, v.frequency);
    await exec(
      conn,
      `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency)
       VALUES ${rowsSql}
       ON CONFLICT (pipeline_id, literal_value)
       DO UPDATE SET source_frequency = EXCLUDED.source_frequency`,
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
