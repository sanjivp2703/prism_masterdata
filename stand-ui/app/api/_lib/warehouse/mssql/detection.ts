/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// SQL Server change detection — Change Tracking fast path + tiered diff-scan
// fallback (docs/MSSQL_PORT_PLAN.md Phase 4, decisions 2.1/2.3).
//
// PURE warehouse operations: every function takes a connection + state and
// returns data/new state. Persistence (SQLite pipelines.detection_state),
// pausing, alerts and SSE live in _lib/pipeline-poller-mssql.ts.
//
// CT functions run db-scoped statements (CHANGETABLE and the CT version
// functions resolve in the CURRENT database), so they prefix `USE [db];` —
// safe because every table reference in this codebase is fully qualified.
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { internalTable } from '../../warehouse-tables';
import { executeQuery as exec } from './connection';
import { quoteIdent, parseFqn, computeScanTier } from './dialect';

export { computeScanTier, retuneScanTier, classifyMssqlPollError } from './dialect';

// ── State ────────────────────────────────────────────────────────────────────

export type MssqlDetectionMode = 'ct' | 'diff';

export interface MssqlDetectionState {
  mode: MssqlDetectionMode;
  /** Why diff mode was chosen (drives the UI upgrade nudge). */
  diff_reason?: 'no_pk' | 'ct_disabled' | 'ct_no_grant' | 'ct_error';
  /** CT: last fully-consumed sync version. */
  ct_version?: number;
  /** Diff: last seen sys.dm_db_index_usage_stats.last_user_update (ISO) —
   *  'unavailable' when VIEW SERVER STATE is missing. */
  heartbeat?: string | null;
  /** Diff: run the real scan every N poll passes (tier). */
  scan_every?: number;
  /** Diff: poll passes since the last real scan. */
  passes_since_scan?: number;
  /** Diff: duration of the last real scan (ms) — drives tier retuning. */
  last_scan_ms?: number;
  /** Azure SQL serverless — cadence multiplier applies (decision 2.3). */
  serverless?: boolean;
}

export interface DetectedValues {
  /** Distinct new values (deduped on normalizeLiteral, representative original
   *  + summed source frequency) to queue. */
  values: Array<{ literal_value: string; frequency: number }>;
  /** Deletes/updates observed — the export needs a hygiene rebuild. */
  sawDeletes: boolean;
  /** CT version window expired (stored < min valid) — caller must run the
   *  full reconcile path and must NOT stamp fully_synced_at this cycle. */
  needsReconcile: boolean;
  state: MssqlDetectionState;
}

// Diff scans hard-cap the distinct values read per scan (values pass through
// app memory; the queue drains in 5k installments anyway).
export const DIFF_SCAN_MAX_DISTINCT = 20_000;

// ── Catalog probes ────────────────────────────────────────────────────────────

function threePartRef(fqn: string): string {
  const { db, schema, table } = parseFqn(fqn);
  return `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** PK columns in key order ([] = no primary key). */
export async function getPrimaryKeyColumns(conn: any, fqn: string): Promise<string[]> {
  const { db } = parseFqn(fqn);
  const rows = await exec(
    conn,
    `SELECT c.name AS col
     FROM ${quoteIdent(db)}.sys.indexes i
     JOIN ${quoteIdent(db)}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN ${quoteIdent(db)}.sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
     WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(?)
     ORDER BY ic.key_ordinal`,
    [threePartRef(fqn)],
  );
  return rows.map((r: any) => String(r.col));
}

export async function isCtEnabled(conn: any, fqn: string): Promise<{ db: boolean; table: boolean }> {
  const { db } = parseFqn(fqn);
  const dbRows = await exec(conn, `SELECT 1 AS x FROM sys.change_tracking_databases WHERE database_id = DB_ID(?)`, [db]);
  if (!dbRows.length) return { db: false, table: false };
  const tRows = await exec(
    conn,
    `SELECT 1 AS x FROM ${quoteIdent(db)}.sys.change_tracking_tables WHERE object_id = OBJECT_ID(?)`,
    [threePartRef(fqn)],
  );
  return { db: true, table: tRows.length > 0 };
}

/** Whether the SERVICE login (prism_svc) can actually read change data for
 *  this table — a permission distinct from enabling Change Tracking itself.
 *  Metadata-only (HAS_PERMS_BY_NAME), never requires elevated rights to run. */
export async function hasViewChangeTrackingPermission(conn: any, fqn: string): Promise<boolean> {
  const rows = await exec(conn, `SELECT HAS_PERMS_BY_NAME(?, 'OBJECT', 'VIEW CHANGE TRACKING') AS has_perm`, [threePartRef(fqn)]);
  return Number(rows[0]?.has_perm ?? rows[0]?.HAS_PERM ?? 0) === 1;
}

/** Grants prism_svc permission to read this table's change data. Requires
 *  elevated rights to run (ALTER/CONTROL or similar) — same credential tier
 *  as enableCt below. GRANT is always database-scoped, hence the USE. */
export async function grantViewChangeTracking(conn: any, fqn: string): Promise<void> {
  const { db, schema, table } = parseFqn(fqn);
  await exec(
    conn,
    `USE ${quoteIdent(db)}; GRANT VIEW CHANGE TRACKING ON OBJECT::${quoteIdent(schema)}.${quoteIdent(table)} TO prism_svc`,
  );
}

/** Best-effort CT enable (DB + table) AND the VIEW CHANGE TRACKING grant
 *  prism_svc needs to actually read what gets tracked — enabling Change
 *  Tracking without this grant leaves the service login unable to consume it
 *  (a distinct SQL Server permission from enabling CT itself). The grant runs
 *  unconditionally, not just when this call actually enabled CT: it also
 *  covers a table whose Change Tracking was already on independently (a DBA
 *  ran it by hand, or a pre-existing table) but never got the grant. Usually
 *  requires ALTER — the service login rarely has it; the caller runs the
 *  credential ladder. Throws on failure so the caller can classify. */
export async function enableCt(conn: any, fqn: string): Promise<void> {
  const { db } = parseFqn(fqn);
  const status = await isCtEnabled(conn, fqn);
  if (!status.db) {
    await exec(
      conn,
      `ALTER DATABASE ${quoteIdent(db)} SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON)`,
    );
  }
  if (!status.table) {
    await exec(conn, `USE ${quoteIdent(db)}; ALTER TABLE ${threePartRef(fqn)} ENABLE CHANGE_TRACKING`);
  }
  await grantViewChangeTracking(conn, fqn);
}

/** Approximate row count from partition stats (catalog read, no table scan). */
export async function getApproxRowCount(conn: any, fqn: string): Promise<number> {
  const { db } = parseFqn(fqn);
  const rows = await exec(
    conn,
    `SELECT SUM(p.rows) AS c
     FROM ${quoteIdent(db)}.sys.partitions p
     WHERE p.object_id = OBJECT_ID(?) AND p.index_id IN (0, 1)`,
    [threePartRef(fqn)],
  );
  return Number(rows[0]?.c ?? 0);
}

// ── Health check (catalog-only, cheap) ───────────────────────────────────────

export type MssqlSourceHealth =
  | { ok: true; masked: false }
  | { ok: true; masked: true }                       // skip standardizing, auto-recovers
  | { ok: false; reason: 'table_missing' | 'column_missing' | 'column_not_text'; message: string };

const TEXT_TYPES = new Set(['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext']);

export async function checkSourceHealthMssql(conn: any, fqn: string, column: string): Promise<MssqlSourceHealth> {
  const { db } = parseFqn(fqn);
  const ref = threePartRef(fqn);

  const objRows = await exec(conn, `SELECT OBJECT_ID(?) AS oid`, [ref]);
  if (objRows[0]?.oid == null) {
    return { ok: false, reason: 'table_missing', message: `Source table ${fqn} no longer exists or is not accessible.` };
  }

  const colRows = await exec(
    conn,
    `SELECT c.name AS col, t.name AS type_name
     FROM ${quoteIdent(db)}.sys.columns c
     JOIN ${quoteIdent(db)}.sys.types t ON t.user_type_id = c.user_type_id
     WHERE c.object_id = OBJECT_ID(?)`,
    [ref],
  );
  const col = colRows.find((r: any) => String(r.col).toLowerCase() === column.toLowerCase());
  if (!col) {
    return { ok: false, reason: 'column_missing', message: `Watched column "${column}" no longer exists on ${fqn}.` };
  }
  if (!TEXT_TYPES.has(String(col.type_name).toLowerCase())) {
    return { ok: false, reason: 'column_not_text', message: `Watched column "${column}" on ${fqn} is no longer a text type (now ${col.type_name}).` };
  }

  // Dynamic Data Masking on the watched column → skip standardizing (reading
  // masked values would standardize garbage); auto-recovers when unmasked.
  const maskedRows = await exec(
    conn,
    `SELECT 1 AS x FROM ${quoteIdent(db)}.sys.masked_columns WHERE object_id = OBJECT_ID(?) AND name = ?`,
    [ref, col.col],
  );
  return { ok: true, masked: maskedRows.length > 0 };
}

// ── Mode selection / init ─────────────────────────────────────────────────────

/** Decide the detection mode for a pipeline and build its initial state.
 *  `tryEnable` lets the caller attempt CT enablement first (the credential
 *  ladder); pass false to only use what's already enabled. */
export async function initDetection(
  conn: any,
  fqn: string,
  opts: { tryEnable?: boolean; serverless?: boolean } = {},
): Promise<MssqlDetectionState> {
  const serverless = opts.serverless ?? false;

  const pkCols = await getPrimaryKeyColumns(conn, fqn);
  if (pkCols.length === 0) {
    return await initDiffState(conn, fqn, 'no_pk', serverless);
  }

  let ct = await isCtEnabled(conn, fqn);
  if ((!ct.db || !ct.table) && opts.tryEnable) {
    try {
      await enableCt(conn, fqn);
      ct = await isCtEnabled(conn, fqn);
    } catch {
      /* no permission — ladder handled by caller; fall through to diff */
    }
  }
  if (!ct.db || !ct.table) {
    return await initDiffState(conn, fqn, 'ct_disabled', serverless);
  }

  // CT infrastructure is on, but that's not sufficient on its own — reading
  // change data needs the separate VIEW CHANGE TRACKING permission. Verify it
  // even when CT was already active before this call (it may have been
  // enabled independently — a DBA running Part C by hand, or a pre-existing
  // table — without ever granting prism_svc the read permission). Only
  // attempt the grant with consent; same "require this before claiming ct
  // mode" principle as enabling CT itself.
  let canView = await hasViewChangeTrackingPermission(conn, fqn);
  if (!canView && opts.tryEnable) {
    try {
      await grantViewChangeTracking(conn, fqn);
      canView = await hasViewChangeTrackingPermission(conn, fqn);
    } catch {
      /* no permission to grant — ladder handled by caller; fall through to diff */
    }
  }
  if (!canView) {
    // DISTINCT from 'ct_disabled'. Change Tracking is fully enabled here — the
    // only thing missing is the separate VIEW CHANGE TRACKING permission. Both
    // used to report 'ct_disabled', so the card told the customer to enable a
    // feature that was already on, and the statement that would actually fix it
    // (GRANT VIEW CHANGE TRACKING) appeared nowhere in the UI — making the
    // misconfiguration effectively undiscoverable (INS-M09).
    return await initDiffState(conn, fqn, 'ct_no_grant', serverless);
  }

  // CT active: baseline at the current version — existing rows are the initial
  // standardization's job (baseline scan), not detection's.
  const version = await getCtCurrentVersion(conn, fqn);
  return { mode: 'ct', ct_version: version, serverless };
}

async function initDiffState(
  conn: any,
  fqn: string,
  reason: 'no_pk' | 'ct_disabled' | 'ct_no_grant' | 'ct_error',
  serverless: boolean,
): Promise<MssqlDetectionState> {
  const rowCount = await getApproxRowCount(conn, fqn).catch(() => 0);
  return {
    mode: 'diff',
    diff_reason: reason,
    heartbeat: null,
    scan_every: computeScanTier(rowCount, serverless),
    passes_since_scan: 0,
    serverless,
  };
}

// ── Change Tracking path ──────────────────────────────────────────────────────

export async function getCtCurrentVersion(conn: any, fqn: string): Promise<number> {
  const { db } = parseFqn(fqn);
  const rows = await exec(conn, `USE ${quoteIdent(db)}; SELECT CHANGE_TRACKING_CURRENT_VERSION() AS v`);
  return Number(rows[0]?.v ?? 0);
}

async function getCtMinValidVersion(conn: any, fqn: string): Promise<number> {
  const { db, schema, table } = parseFqn(fqn);
  const rows = await exec(
    conn,
    `USE ${quoteIdent(db)}; SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(?)) AS v`,
    [`${quoteIdent(schema)}.${quoteIdent(table)}`],
  );
  return Number(rows[0]?.v ?? 0);
}

/**
 * Cheap "anything new?" — one scalar function call, no table access.
 *
 * CHANGE_TRACKING_CURRENT_VERSION() is DATABASE-scoped, not table-scoped: it
 * only advances when SOME CT-enabled table in the database changes. A table
 * that has been dropped and recreated (same name, new object) silently loses
 * its own CT registration — its inserts stop bumping this counter entirely,
 * so comparing only against the stored ct_version would report "no changes"
 * forever, even as real data piles up, unless some unrelated table in the
 * database happens to advance the counter past the stale stored value.
 * Guard with a cheap per-object registration check (sys.change_tracking_tables,
 * metadata-layer, no warehouse wake) and surface the SAME error CHANGETABLE
 * would throw so the existing 'ct_reset' classification/self-heal
 * (pipeline-poller-mssql.ts) handles recovery — one recovery path, not two.
 */
export async function ctHasChanges(conn: any, fqn: string, state: MssqlDetectionState): Promise<boolean> {
  const { db, schema, table } = parseFqn(fqn);
  const ctRows = await exec(
    conn,
    `USE ${quoteIdent(db)}; SELECT 1 AS x FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(?)`,
    [`${quoteIdent(schema)}.${quoteIdent(table)}`],
  );
  if (ctRows.length === 0) {
    const err: any = new Error(`Change tracking is not enabled on table '${schema}.${table}'.`);
    err.number = 22105;
    throw err;
  }

  const current = await getCtCurrentVersion(conn, fqn);
  return current > (state.ct_version ?? 0);
}

/**
 * Consume changes since state.ct_version via CHANGETABLE.
 *  - insert/update halves: the changed rows' CURRENT column values → queue
 *    (ALL of them, lookup hits included — consistent-snapshot semantics, same
 *    as the Snowflake stream path).
 *  - delete/update ops → sawDeletes (hygiene export rebuild).
 *  - stored version below the min valid window → needsReconcile (retention
 *    expired; the caller runs the full reconcile and does not stamp
 *    fully_synced_at).
 */
export async function ctConsume(conn: any, fqn: string, column: string, state: MssqlDetectionState): Promise<DetectedValues> {
  const { db, schema, table } = parseFqn(fqn);
  const stored = state.ct_version ?? 0;

  const minValid = await getCtMinValidVersion(conn, fqn);
  const current = await getCtCurrentVersion(conn, fqn);
  if (stored < minValid) {
    // Window expired — changes between stored and minValid are unrecoverable
    // from CT. Re-baseline at current; the caller reconciles from the source.
    return { values: [], sawDeletes: true, needsReconcile: true, state: { ...state, ct_version: current } };
  }

  const pkCols = await getPrimaryKeyColumns(conn, fqn);
  const joinOn = pkCols.map(c => `t.${quoteIdent(c)} = ct.${quoteIdent(c)}`).join(' AND ');
  const rows = await exec(
    conn,
    `USE ${quoteIdent(db)};
     SELECT ct.SYS_CHANGE_OPERATION AS op, t.${quoteIdent(column)} AS v
     FROM CHANGETABLE(CHANGES ${quoteIdent(schema)}.${quoteIdent(table)}, ?) AS ct
     LEFT JOIN ${quoteIdent(schema)}.${quoteIdent(table)} AS t ON ${joinOn}`,
    [stored],
  );

  let sawDeletes = false;
  const freqByNorm = new Map<string, { literal_value: string; frequency: number }>();
  for (const r of rows) {
    const op = String(r.op ?? '').toUpperCase();
    if (op === 'D' || op === 'U') sawDeletes = true;
    if (op === 'D') continue;              // delete-half: no current row/value
    const v = r.v;
    if (v == null) continue;               // null inserts don't queue (hygiene rebuild covers null-only inserts)
    const literal = String(v);
    const norm = normalizeLiteral(literal);
    if (!norm) continue;
    const cur = freqByNorm.get(norm);
    if (cur) cur.frequency += 1;
    else freqByNorm.set(norm, { literal_value: literal, frequency: 1 });
  }

  return {
    values: [...freqByNorm.values()],
    sawDeletes,
    needsReconcile: false,
    state: { ...state, ct_version: current },
  };
}

// ── Diff-scan path ────────────────────────────────────────────────────────────

/** Free heartbeat: the table's last write time from server bookkeeping (no
 *  table access). Returns the marker string, or 'unavailable' when the login
 *  lacks VIEW SERVER STATE (caller scans on the tier schedule instead). */
export async function diffHeartbeat(conn: any, fqn: string): Promise<string | 'unavailable'> {
  const { db } = parseFqn(fqn);
  try {
    const rows = await exec(
      conn,
      `SELECT CONVERT(NVARCHAR(33), MAX(last_user_update), 126) AS lu
       FROM sys.dm_db_index_usage_stats
       WHERE database_id = DB_ID(?) AND object_id = OBJECT_ID(?)`,
      [db, threePartRef(fqn)],
    );
    return String(rows[0]?.lu ?? 'never');
  } catch {
    return 'unavailable';
  }
}

/** The real scan: distinct non-null values + frequencies, capped at
 *  DIFF_SCAN_MAX_DISTINCT (+1 sentinel to detect truncation). */
export async function diffScan(
  conn: any,
  fqn: string,
  column: string,
): Promise<{ values: Array<{ literal_value: string; frequency: number }>; truncated: boolean; durationMs: number }> {
  const ref = threePartRef(fqn);
  const colRef = quoteIdent(column);
  const started = Date.now();
  const rows = await exec(
    conn,
    `SELECT TOP (${DIFF_SCAN_MAX_DISTINCT + 1}) ${colRef} AS v, COUNT(*) AS freq
     FROM ${ref}
     WHERE ${colRef} IS NOT NULL
     GROUP BY ${colRef}
     ORDER BY COUNT(*) DESC`,
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
    `SELECT literal_value FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
    [pipelineId],
  );
  const queuedNorms = new Set(queuedRows.map((r: any) => normalizeLiteral(String(r.literal_value))));

  const unqueued = candidates.filter(c => !queuedNorms.has(normalizeLiteral(c.literal_value)));
  if (!unqueued.length) return [];

  // Batched semi-join against the lookup (bind ceiling ~2100 → 500/batch,
  // +1 scope/spec_id bind).
  const mappedNorms = new Set<string>();
  const domainFilter = domainId != null ? `AND domain_id = ?` : `AND domain_id IS NULL`;
  const BATCH = 500;
  for (let i = 0; i < unqueued.length; i += BATCH) {
    const batch = unqueued.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const binds: any[] = batch.map(c => normalizeLiteral(c.literal_value));
    if (domainId != null) binds.push(domainId);
    const rows = await exec(
      conn,
      `SELECT DISTINCT normalized_value AS nv
       FROM ${internalTable('LITERAL_ALIAS_MATCHES')}
       WHERE normalized_value IN (${placeholders}) ${domainFilter}`,
      binds,
    );
    for (const r of rows) mappedNorms.add(String(r.nv));
  }

  return unqueued.filter(c => !mappedNorms.has(normalizeLiteral(c.literal_value)));
}

// ── Queue write ───────────────────────────────────────────────────────────────

/** Idempotent MERGE into PIPELINE_QUEUE, batched under the bind ceiling
 *  (3 binds/row → 500 rows = 1500 binds). Values must already be deduped on
 *  the normalized form (both scan paths do). */
export async function queueValues(
  conn: any,
  pipelineId: number,
  values: Array<{ literal_value: string; frequency: number }>,
): Promise<number> {
  // ── Guard the two things that break this MERGE ──────────────────────────
  //
  // 1. OVER-LONG VALUES (KI-121). PIPELINE_QUEUE.literal_value is
  //    NVARCHAR(800). A single longer value made the ENTIRE 500-row batch
  //    fail, taking perfectly valid values down with it — live-confirmed with
  //    a source holding 'att', an 801-char value and 'vzw'. Such a value can
  //    never be mapped anyway (the lookup column is the same width), so drop
  //    it and say so rather than losing the batch.
  // 2. IN-BATCH NORMALIZED DUPLICATES (KI-106). The MERGE matches on raw
  //    literal_value under BIN2 (binary-exact), so 'ATT' and 'att' arriving
  //    together are two distinct keys and both get queued — the same value
  //    twice. filterUnknownValues dedupes candidates against ALREADY-QUEUED
  //    rows but not against each other, so this has to happen here to cover
  //    every caller.
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
      `[mssql/detection] Pipeline ${pipelineId}: skipped ${oversized.length} source value(s) longer than ` +
      `${MAX_LEN} chars (lengths: ${oversized.slice(0, 5).join(', ')}${oversized.length > 5 ? ', …' : ''}) — ` +
      `they exceed the lookup column width and can never be standardized.`,
    );
  }
  values = safeValues;

  const BATCH = 500;
  let queued = 0;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const rowsSql = batch.map(() => '(?, ?, ?)').join(', ');
    const binds: any[] = [];
    for (const v of batch) binds.push(pipelineId, v.literal_value, v.frequency);
    await exec(
      conn,
      `MERGE ${internalTable('PIPELINE_QUEUE')} WITH (HOLDLOCK) AS q
       USING (VALUES ${rowsSql}) AS s (pipeline_id, literal_value, source_frequency)
       ON q.pipeline_id = s.pipeline_id AND q.literal_value = s.literal_value
       WHEN MATCHED THEN UPDATE SET source_frequency = s.source_frequency
       WHEN NOT MATCHED THEN INSERT (pipeline_id, literal_value, source_frequency)
         VALUES (s.pipeline_id, s.literal_value, s.source_frequency);`,
      binds,
    );
    queued += batch.length;
  }
  return queued;
}

export async function getQueueSize(conn: any, pipelineId: number): Promise<number> {
  const rows = await exec(conn, `SELECT COUNT(*) AS c FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`, [pipelineId]);
  return Number(rows[0]?.c ?? 0);
}
