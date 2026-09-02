/**
 * Pipeline queue standardization processor.
 *
 * Runs auto-group + direct lookup export for queued items at every 10-minute
 * WALL-CLOCK mark (1:00, 1:10, 1:20, … — aligned to the clock, not to process
 * start or pipeline creation), for every active pipeline with queued items
 * whose update window is open. There is no queue-size threshold — the
 * minute-mark poller only detects and queues; this tick is the only automatic
 * standardization trigger (plus the user's manual "Update Standardizations").
 * The top-of-hour tick additionally runs the reconciliation sweep + safety
 * export rebuilds first (kept hourly — they wake the warehouse for full scans).
 *
 * Steps per pipeline:
 *   1. Create a run from queued literals
 *   2. Auto-group: hash lookup FIRST — values already in LITERAL_ALIAS_MATCHES
 *      map with zero LLM calls (a tick whose queue is 100% lookup hits never
 *      touches the LLM); only unmatched values go to the one-prompt LLM
 *   3. Export directly to LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES + rebuild
 *      the export table (publishes queued lookup hits and new values together)
 *   4. Remove exported literals from the queue
 */

import 'server-only';

import { withWarehouse, executeQuery as exec, getWarehouseAdapter, isWarehouseAccessError, resolveSourceReference } from './warehouse';
import { getDb } from './sqlite';
import { saveOpRunState, loadOpRunState, type OpRunState } from './op-auto-group';
import { runAutoGroupForRun } from './op-auto-group-run';
import { runOpExportDirect } from './op-export';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { beginStandardization, endStandardization, isPipelineStandardizing } from './pipeline-coordination';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { pausePipelineWithMessage, NOT_BLOCKED_SQL } from './pipeline-alerts';
import { reconcileMssqlQueue } from './pipeline-poller-mssql';
import { reconcilePgQueue } from './pipeline-poller-postgres';
import { reconcileMysqlQueue } from './pipeline-poller-mysql';
import { internalTable, prismNormalizeFn } from './warehouse-tables';
import { getAnthropicApiKey } from './anthropic-key';
import { parseStoredSchedule, isScheduleActiveNow } from './update-schedule';
import { type ExportKind, asExportKind } from './export-kind';

const HOUR_MS = 60 * 60 * 1_000;

/** Standardization ticks fire at every wall-clock multiple of this interval. */
const QUEUE_TICK_MS = 10 * 60 * 1_000;

/**
 * Max number of previously-unmapped source values the reconciliation sweep
 * queues per pipeline per pass.  The baseline scan caps at 5 000 distinct
 * values and the APPEND_ONLY stream only emits post-setup inserts, so any
 * pre-existing distinct tail beyond the cap is invisible to both.  This sweep
 * trickles that tail into the queue in batches so a huge backlog is absorbed
 * over successive hourly passes rather than in one oversized standardization.
 */
const RECONCILE_QUEUE_BATCH = 5_000;

// Mutual exclusion for "a standardization pass is actively inside this module
// for this pipeline". MUST live on globalThis, not module scope.
//
// A module-scope Set is per-instance, and Next can hold more than one instance
// of this module alive (dev hot reload, or a route-handler bundle separate from
// the instrumentation bundle — the exact scenario pipeline-coordination.ts's
// header documents as a past incident). A duplicated instance got a fresh empty
// Set and sailed past the guard: live-demonstrated with two passes running the
// same pipeline concurrently, both reusing the same run, both making LLM calls,
// and both logging "N mapping(s) written" — duplicated spend, two writers on one
// RUN_STATE blob, and racing queue deletes.
//
// NOTE this is deliberately SEPARATE from pipeline-coordination's
// __prismStandardizingSince. That lock means "a pass is in flight" for the UI
// and the poller, and is held by the CALLER across a whole multi-column batch
// (standardizeTable sets it per column, then calls processPipelineQueue with
// beginEndStandardization: false). Reusing it as this guard would make those
// calls see their own caller's lock and skip the work entirely. Two locks with
// different scopes is correct here — the bug was only that this one was not
// crash-safe or instance-safe.
//
// Timestamped so the same staleness valve applies: a pass whose finally never
// ran (an await that never settles) would otherwise wedge the pipeline forever
// with no log and no self-heal.
const PROCESSING_MAX_MS = 30 * 60_000;
const _pg = globalThis as unknown as { __prismProcessingSince?: Map<number, number> };
const processingSince: Map<number, number> =
  _pg.__prismProcessingSince ?? (_pg.__prismProcessingSince = new Map());

const processingPipelineIds = {
  has(pipelineId: number): boolean {
    const since = processingSince.get(pipelineId);
    if (since == null) return false;
    if (Date.now() - since > PROCESSING_MAX_MS) {
      processingSince.delete(pipelineId);
      console.warn(
        `[Standardize] Pipeline ${pipelineId}: processing lock held > ${PROCESSING_MAX_MS / 60_000} min — clearing stale lock`,
      );
      return false;
    }
    return true;
  },
  add(pipelineId: number): void { processingSince.set(pipelineId, Date.now()); },
  delete(pipelineId: number): void { processingSince.delete(pipelineId); },
};

// ── Standardization failure backoff ──────────────────────────────────────────
//
// A persistently failing standardization used to retry every 30 s forever, each
// attempt burning LLM tokens (errors were swallowed with the queue left intact,
// so the tick re-fired it every 10 minutes).  Track consecutive failures
// per pipeline in memory: exponential backoff between retries, and after
// MAX_CONSECUTIVE_FAILURES the pipeline is paused with an explanatory message.
// Resuming the pipeline (or a process restart) clears the tracker.

const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS           = 60 * 60_000; // cap: 60 minutes

interface StandardizationFailure {
  count:         number;
  nextAttemptAt: number; // epoch ms — skip standardization attempts before this
}

const standardizationFailures = new Map<number, StandardizationFailure>();

/** True while a pipeline is inside its failure-backoff window — the poller's
 *  10-minute tick skips it until nextAttemptAt. */
export function isStandardizationBackedOff(pipelineId: number): boolean {
  const f = standardizationFailures.get(pipelineId);
  return f != null && Date.now() < f.nextAttemptAt;
}

function clearStandardizationFailures(pipelineId: number): void {
  standardizationFailures.delete(pipelineId);
}

async function recordStandardizationFailure(pipelineId: number, err: unknown): Promise<void> {
  const count  = (standardizationFailures.get(pipelineId)?.count ?? 0) + 1;
  const errMsg = String((err as any)?.message ?? err ?? 'unknown error').slice(0, 200);

  if (count >= MAX_CONSECUTIVE_FAILURES) {
    standardizationFailures.delete(pipelineId); // reset — a resume starts fresh
    console.error(
      `[Standardize] Pipeline ${pipelineId}: ${count} consecutive standardization failures — pausing pipeline. Latest error: ${errMsg}`,
    );
    // The raw driver message stays in the server log above and NEVER goes into
    // status_message. GET /api/pipelines returns status_message verbatim to the
    // browser, where it renders on the pipeline card and the /settings health
    // rollup — so interpolating the driver text here routed around
    // warehouseErrorResponse, the sanitizer that exists precisely to stop raw
    // SQL and driver output reaching a client. Live-demonstrated with a real
    // SQL Server error 229 ("The SELECT permission was denied on the object
    // 'sysjobs', database 'msdb'...") landing in status_message unmodified;
    // Snowflake messages in this position can carry SQL fragments outright.
    // Every other pause/flag call site builds a curated, driver-free message —
    // this was the sole exception (SEC-04).
    const hint = isWarehouseAccessError(err)
      ? ' The warehouse rejected Prism’s access — check that the service role still has permission on the source table.'
      : '';
    await pausePipelineWithMessage(
      pipelineId,
      `Automatic standardization failed ${MAX_CONSECUTIVE_FAILURES} times in a row — paused.${hint} ` +
      `The full error is in the server log. Resume the pipeline to retry.`,
    ).catch((pauseErr) =>
      console.error(`[Standardize] Pipeline ${pipelineId}: failed to pause after repeated failures:`, pauseErr),
    );
    return;
  }

  const backoffMs = Math.min(2 ** count * 60_000, MAX_BACKOFF_MS);
  standardizationFailures.set(pipelineId, { count, nextAttemptAt: Date.now() + backoffMs });
  console.error(
    `[Standardize] Pipeline ${pipelineId}: standardization failure ${count}/${MAX_CONSECUTIVE_FAILURES} — ` +
    `backing off ${Math.round(backoffMs / 60_000)} min before retry. Error: ${errMsg}`,
  );
}

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function isSimpleIdent(s: string): boolean {
  // Permissive: any non-empty name quoteIdent can safely wrap (spaces, hyphens,
  // leading digits, Unicode letters are all valid quoted identifiers). Reject
  // only control chars and quotes/backslash, which could break out of a quoted
  // identifier or a string literal built elsewhere.
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 34 || c === 39 || c === 92) return false;
  }
  return true;
}

export interface PipelineForProcessing {
  pipeline_id:      number;
  table_fqn:        string;
  column_name:      string;
  export_table_fqn: string | null;
  export_kind:      ExportKind;
  domain_id:        number | null;
  status:           string;
}

export async function fetchPipelineById(pipelineId: number): Promise<PipelineForProcessing | null> {
  const r = getDb()
    .prepare(
      `SELECT pipeline_id, table_fqn, column_name, export_table_fqn, export_kind,
              domain_id, status
       FROM pipelines WHERE pipeline_id = ?`,
    )
    .get(pipelineId) as any;
  if (!r) return null;
  return {
    pipeline_id:      Number(r.pipeline_id),
    table_fqn:        String(r.table_fqn        ?? ''),
    column_name:      String(r.column_name      ?? ''),
    export_table_fqn: r.export_table_fqn ?? null,
    export_kind:      asExportKind(r.export_kind),
    domain_id:        r.domain_id != null ? Number(r.domain_id) : null,
    status:           String(r.status ?? ''),
  };
}

async function fetchPipelinesWithQueue(): Promise<PipelineForProcessing[]> {
  // PIPELINES lives in SQLite; PIPELINE_QUEUE stays in Snowflake.
  // ANY queued value qualifies — there is no queue-size threshold. The
  // 10-minute tick is the only automatic standardization trigger, so every
  // trickle (including already-mapped values, which wait in the queue too)
  // drains and publishes at the next mark.
  //
  // ORDER MATTERS — SQLite FIRST, warehouse only if it might have work.
  //
  // This function used to open a warehouse connection and run the SUM query
  // unconditionally, then filter the results against SQLite. That fired every
  // 10 minutes forever on any Snowflake install, which RESUMES PRISM_WH — and
  // a resume bills a 60-second minimum. 144 ticks/day against a source that
  // never changes is the exact opposite of the "a quiet source costs zero"
  // guarantee in CLAUDE.md's cost model. It was live-reproduced (DET-S07): a
  // suspended PRISM_WH was woken by a tick, with resumed_on stamped to the
  // tick's timestamp. It only *looked* fine on repeat runs because Snowflake's
  // 24h result cache served the byte-identical query — an opportunistic
  // optimization, not a guarantee, and one that evaporates the moment any
  // pipeline's queue changes.
  //
  // So: gate on the SQLite pipelines.queue_size mirror before touching the
  // warehouse. The mirror is trustworthy because EVERY writer into
  // PIPELINE_QUEUE updates it in the same breath — the poller's consuming
  // MERGE, reconcilePipelineQueue, and removeExportedFromQueue on drain.
  const candidates = (getDb()
    .prepare(
      `SELECT pipeline_id, table_fqn, column_name, export_table_fqn, export_kind, domain_id, status, update_schedule, queue_size
       FROM pipelines
       WHERE status = 'active'
         AND ${NOT_BLOCKED_SQL}
       ORDER BY pipeline_id`,
    )
    .all() as any[])
    // Only pipelines whose update window is open right now — manual-only and
    // outside-window pipelines keep queueing until their window (or an
    // explicit owner trigger) drains them.
    .filter((r) => isScheduleActiveNow(parseStoredSchedule(r.update_schedule)));

  if (candidates.length === 0) return [];

  // FAIL OPEN on an unknown mirror value: a NULL queue_size means "we don't
  // know", and the safe reading of "don't know" is "there might be work" — a
  // missed standardization pass is worse than one extra warehouse wake.
  // A known 0 across every candidate is the common steady state, and that is
  // the case we refuse to spend a warehouse resume on.
  const maybeWork = candidates.some(
    (r) => r.queue_size == null || Number(r.queue_size) > 0,
  );
  if (!maybeWork) return [];

  return await withWarehouse(async (conn) => {
    const sumRows = await exec(
      conn,
      `SELECT pipeline_id, COALESCE(SUM(source_frequency), 0) AS freq_sum
       FROM ${internalTable('PIPELINE_QUEUE')}
       GROUP BY pipeline_id`,
    );
    const overThreshold = new Set(
      sumRows
        .filter((r: any) => Number(r.FREQ_SUM ?? r.freq_sum ?? 0) > 0)
        .map((r: any) => Number(r.PIPELINE_ID ?? r.pipeline_id)),
    );
    if (overThreshold.size === 0) return [];

    const rows = candidates.filter((r) => overThreshold.has(Number(r.pipeline_id)));
    return rows.map((r: any) => ({
      pipeline_id:      Number(r.pipeline_id),
      table_fqn:        String(r.table_fqn        ?? ''),
      column_name:      String(r.column_name      ?? ''),
      export_table_fqn: r.export_table_fqn ?? null,
      export_kind:      asExportKind(r.export_kind),
      domain_id:        r.domain_id != null ? Number(r.domain_id) : null,
      status:           String(r.status ?? ''),
    }));
  });
}

/** All active pipelines, regardless of whether they currently have queued items. */
async function fetchAllActivePipelines(): Promise<PipelineForProcessing[]> {
  {
    const rows = (getDb()
      .prepare(
        `SELECT pipeline_id, table_fqn, column_name, export_table_fqn, export_kind, domain_id, status, update_schedule
         FROM pipelines
         WHERE status = 'active'
             AND ${NOT_BLOCKED_SQL}
         ORDER BY pipeline_id`,
      )
      .all() as any[])
      // Skip pipelines whose update WINDOW is closed (KI-88 / KI-115).
      //
      // Unlike the 10-minute tick's fetchPipelinesWithQueue — which filters on
      // the window AND exits early when the queue is empty — this sweep used to
      // run for every active pipeline every hour. It cannot be served from the
      // metadata layer (it re-reads the customer's source table on purpose), so
      // it woke the warehouse 24x a day whether or not anything had changed.
      // Both warehouses bill by awake-time with a 60-second minimum per resume,
      // so that was ~24 billed minutes a day on a completely idle install —
      // contradicting the documented guarantee that a quiet source costs zero.
      //
      // If the owner said "Mon-Fri, 9-5", they have already said not to do work
      // outside it; anything the sweep would have found is found at the first
      // sweep after the window opens.
      //
      // DELIBERATELY NOT using isScheduleActiveNow() verbatim: it returns false
      // for 'manual' too, and excluding manual-only pipelines would be a
      // CORRECTNESS regression, not a saving. For those, this sweep is the only
      // automatic recovery from a mass event (TRUNCATE / bulk reload / restore)
      // that change-detection cannot see — and because the manual "Update
      // Standardizations" button drains the QUEUE, values the sweep never
      // queued would not be standardized by a manual click either. So 'manual'
      // and 'always' keep sweeping; only an explicitly closed window skips.
      //
      // FAIL OPEN on anything we don't positively understand. parseStoredSchedule
      // is deliberately tolerant and DEFAULTS a missing/corrupt value to the
      // Mon-Fri 9-5 window — correct for the tick, wrong here: a row with a NULL
      // or malformed update_schedule would silently inherit 9-5 semantics and
      // stop being swept overnight. A safety net must keep running when it
      // cannot read its own configuration, so only an EXPLICITLY stored window
      // is allowed to skip.
      .filter((r) => {
        let storedType: unknown = null;
        try { storedType = (JSON.parse(String(r.update_schedule ?? '')) as any)?.type; } catch { storedType = null; }
        if (storedType !== 'window') return true;          // always / manual / unknown → sweep
        return isScheduleActiveNow(parseStoredSchedule(r.update_schedule));
      });
    return rows.map((r: any) => ({
      pipeline_id:      Number(r.pipeline_id),
      table_fqn:        String(r.table_fqn        ?? ''),
      column_name:      String(r.column_name      ?? ''),
      export_table_fqn: r.export_table_fqn ?? null,
      export_kind:      asExportKind(r.export_kind),
      domain_id:        r.domain_id != null ? Number(r.domain_id) : null,
      status:           String(r.status ?? ''),
    }));
  }
}

/**
 * Queue previously-unmapped source values that the stream never captured.
 *
 * Finds distinct non-null source values that are neither mapped in
 * LITERAL_ALIAS_MATCHES (for this pipeline's domain) nor already in the queue,
 * and inserts up to RECONCILE_QUEUE_BATCH of them into PIPELINE_QUEUE with their
 * full source row count as the initial frequency.  Pure detection — does not
 * standardize — so it is safe to run for manual-only pipelines too (the owner
 * still triggers standardization).  Returns the number of values newly queued.
 */
export async function reconcilePipelineQueue(
  pipeline: { pipeline_id: number; table_fqn: string; column_name: string; domain_id: number | null },
): Promise<number> {
  const { pipeline_id: pid, table_fqn, column_name, domain_id } = pipeline;

  // Skip if a standardization run is in flight — it is actively mutating the
  // queue and LITERAL_ALIAS_MATCHES, so a concurrent scan would race.
  if (isPipelineStandardizing(pid)) return 0;

  // SQL Server / Postgres: the reconcile is a diff scan (distinct values →
  // app-side normalize → filter already-queued/mapped → queue), reusing each
  // port's detection engine. No SQL-side normalize exists on these warehouses.
  if (getWarehouseAdapter().kind === 'mssql') {
    return await reconcileMssqlQueue(pipeline);
  }
  if (getWarehouseAdapter().kind === 'postgres') {
    return await reconcilePgQueue(pipeline);
  }
  if (getWarehouseAdapter().kind === 'mysql') {
    return await reconcileMysqlQueue(pipeline);
  }

  const parts = String(table_fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3 || !parts.every(isSimpleIdent) || !isSimpleIdent(column_name)) {
    console.warn(`[Reconcile] Pipeline ${pid}: invalid table/column identifier — skipping`);
    return 0;
  }

  const quotedRef  = parts.map(quoteIdent).join('.');
  const colRef     = quoteIdent(column_name);
  const domainCond = domain_id != null
    ? `AND lam.domain_id = ${Number(domain_id)}`
    : `AND lam.domain_id IS NULL`;

  return await withWarehouse(async (conn) => {
    // Reference-granted source (native): address via the reference form.
    const tableRef = (await resolveSourceReference(conn, {
      db: parts[0], schema: parts[1], table: parts[2],
    }))?.refSql ?? quotedRef;
    const [beforeRow] = await exec(
      conn,
      `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
      [pid],
    );
    const queueBefore = Number(beforeRow?.CNT ?? beforeRow?.cnt ?? 0);

    // The NOT EXISTS guard against the queue (in addition to WHEN NOT MATCHED)
    // ensures the LIMIT budget is spent only on genuinely-new values, so every
    // pass makes forward progress instead of re-selecting already-queued rows.
    await exec(conn, `
      MERGE INTO ${internalTable('PIPELINE_QUEUE')} AS tgt
      USING (
        SELECT ANY_VALUE(TO_VARCHAR(src.${colRef})) AS literal_value,
               COUNT(*)                             AS source_frequency
        FROM ${tableRef} src
        LEFT JOIN ${internalTable('LITERAL_ALIAS_MATCHES')} lam
          ON lam.normalized_value = ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef}))
          ${domainCond}
        WHERE src.${colRef} IS NOT NULL
          AND lam.literal_value IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${internalTable('PIPELINE_QUEUE')} q
            WHERE q.pipeline_id = ${pid}
              AND ${prismNormalizeFn()}(q.literal_value) = ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef}))
          )
        GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(src.${colRef}))
        LIMIT ${RECONCILE_QUEUE_BATCH}
      ) AS recon
        ON tgt.pipeline_id = ${pid} AND ${prismNormalizeFn()}(tgt.literal_value) = ${prismNormalizeFn()}(recon.literal_value)
      WHEN NOT MATCHED THEN INSERT (pipeline_id, literal_value, source_frequency)
        VALUES (${pid}, recon.literal_value, recon.source_frequency)`);

    const [afterRow] = await exec(
      conn,
      `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
      [pid],
    );
    const queueAfter = Number(afterRow?.CNT ?? afterRow?.cnt ?? 0);
    const added      = Math.max(0, queueAfter - queueBefore);

    if (added > 0) {
      getDb()
        .prepare(`UPDATE pipelines SET queue_size = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pipeline_id = ?`)
        .run(queueAfter, pid);
      broadcastPipelineEvent({ type: 'metrics_updated' });
      console.log(`[Reconcile] Pipeline ${pid}: queued ${added} previously-unmapped value(s) (queue: ${queueAfter})`);
    }

    return added;
  });
}

/**
 * Run the reconciliation scan across all active pipelines.  Runs ahead of the
 * standardization sweep so any newly-surfaced tail values are present in the
 * queue when fetchPipelinesWithQueue picks the window-open pipelines up.
 *
 * Also rebuilds each pipeline's export (or recomputes its mapped count) as a
 * safety net: mass source changes the stream can't reliably surface — TRUNCATE,
 * bulk reload, Time-Travel restore/UNDROP — converge here, so rows no longer in
 * the source drop out of the export even if no per-row delete event was seen.
 */
export async function runReconciliationSweep(): Promise<void> {
  const pipelines = await fetchAllActivePipelines();
  if (pipelines.length === 0) return;

  console.log(`[Reconcile] Scanning ${pipelines.length} active pipeline(s) for unmapped source values…`);

  // 1) Per-column detection — queue any unmapped source values the stream missed.
  let total = 0;
  for (const p of pipelines) {
    try {
      total += await reconcilePipelineQueue(p);
    } catch (e) {
      console.error(`[Reconcile] Pipeline ${p.pipeline_id}: failed:`, e);
    }
  }

  // 2) Safety export rebuild — ONCE per export file (a rebuild covers every
  //    column sharing it), not once per column. Skip any export file that has a
  //    column mid-standardization (that run rebuilds its own export and would race).
  //    A view is always live and has nothing to reconcile, so it's treated the
  //    same as "no export object" here — only table-kind exports get rebuilt.
  const busyExports = new Set<string>();
  for (const p of pipelines) {
    if (p.export_table_fqn && p.export_kind !== 'view' && isPipelineStandardizing(p.pipeline_id)) busyExports.add(p.export_table_fqn);
  }
  const rebuiltExports = new Set<string>();
  for (const p of pipelines) {
    if (!p.table_fqn || !p.column_name) continue;
    try {
      if (p.export_table_fqn && p.export_kind !== 'view') {
        if (busyExports.has(p.export_table_fqn) || rebuiltExports.has(p.export_table_fqn)) continue;
        // Re-check immediately before starting the rebuild — standardization may
        // have begun since we computed busyExports at the top of the loop.
        if (isPipelineStandardizing(p.pipeline_id)) {
          busyExports.add(p.export_table_fqn); // block siblings of this export too
          continue;
        }
        rebuiltExports.add(p.export_table_fqn);
        await refreshExportTable(p.table_fqn, p.column_name, p.export_table_fqn, p.domain_id, p.pipeline_id, p.export_kind);
      } else {
        if (isPipelineStandardizing(p.pipeline_id)) continue;
        await updatePipelineMappedCount(p.table_fqn, p.column_name, p.domain_id, p.pipeline_id);
      }
    } catch (e) {
      console.error(`[Reconcile] Pipeline ${p.pipeline_id}: safety export rebuild failed:`, e);
    }
  }
  console.log(`[Reconcile] Sweep complete — ${total} value(s) queued across all pipelines`);
}

export async function fetchQueueLiterals(
  connection: any,
  pipelineId: number,
): Promise<string[]> {
  const kind = getWarehouseAdapter().kind;
  const rows = await exec(
    connection,
    kind === 'mssql'
      ? `SELECT literal_value
         FROM ${internalTable('PIPELINE_QUEUE')}
         WHERE pipeline_id = ?
         ORDER BY CASE WHEN detected_at IS NULL THEN 1 ELSE 0 END, detected_at, literal_value`
      : kind === 'mysql'
      // MySQL has no NULLS LAST — the IS NULL sort key is the standard form.
      ? `SELECT literal_value
         FROM prism_internal.pipeline_queue
         WHERE pipeline_id = ?
         ORDER BY (detected_at IS NULL), detected_at, literal_value`
      : `SELECT literal_value
         FROM ${internalTable('PIPELINE_QUEUE')}
         WHERE pipeline_id = ?
         ORDER BY detected_at NULLS LAST, literal_value`,
    [pipelineId],
  );
  return rows.map((r) => String(r.LITERAL_VALUE ?? r.literal_value ?? '')).filter(Boolean);
}

/** Fetch queued literals with their accumulated source row counts. */
export async function fetchQueueLiteralsWithFreq(
  connection: any,
  pipelineId: number,
): Promise<Array<{ literal_value: string; source_frequency: number }>> {
  // Capped at 5 000 per standardization run (matching the baseline-scan cap): a
  // bulk load into a watched table can queue tens of thousands of values at
  // once via the stream, and an uncapped drain would build one monster run
  // (context-busting merge pass, unreviewable output). FIFO order + the queue's
  // persistence mean the tail simply processes on subsequent passes.
  const kind = getWarehouseAdapter().kind;
  const rows = await exec(
    connection,
    kind === 'mssql'
      ? `SELECT TOP (5000) literal_value, source_frequency
         FROM ${internalTable('PIPELINE_QUEUE')}
         WHERE pipeline_id = ?
         ORDER BY CASE WHEN detected_at IS NULL THEN 1 ELSE 0 END, detected_at, literal_value`
      : kind === 'mysql'
      ? `SELECT literal_value, source_frequency
         FROM prism_internal.pipeline_queue
         WHERE pipeline_id = ?
         ORDER BY (detected_at IS NULL), detected_at, literal_value
         LIMIT 5000`
      : `SELECT literal_value, source_frequency
         FROM ${internalTable('PIPELINE_QUEUE')}
         WHERE pipeline_id = ?
         ORDER BY detected_at NULLS LAST, literal_value
         LIMIT 5000`,
    [pipelineId],
  );
  return rows
    .map((r) => ({
      literal_value:    String(r.LITERAL_VALUE    ?? r.literal_value    ?? ''),
      source_frequency: Number(r.SOURCE_FREQUENCY ?? r.source_frequency ?? 1),
    }))
    .filter((r) => r.literal_value);
}

function buildInitialQueueRunState(
  literals: string[],
  frequencies?: Map<string, number>,
): OpRunState {
  return {
    status:    'created',
    items:     literals.map((lv, idx) => ({
      run_item_id:         idx + 1,
      literal_value:       lv,
      source_frequency:    frequencies?.get(lv) ?? 1,
      matched_from_lookup: false,
    })),
    groups:    [],
    ungrouped: literals.map((lv) => ({
      literal_value:       lv,
      matched_from_lookup: false,
    })),
  };
}

export async function createRunFromQueue(
  connection: any,
  pipeline: PipelineForProcessing,
  literals: string[],
  frequencies?: Map<string, number>,
): Promise<number> {
  // The column name is the run's "concept" now (was the domain name).
  const conceptKey = pipeline.column_name?.trim() || 'mobile_carrier';
  const nonce = `hourly_${pipeline.pipeline_id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Reuse the newest still-pending run from a previous failed attempt for this
  // pipeline instead of inserting a fresh RUNS row per retry.  The
  // creation_nonce prefix `hourly_<pipeline_id>_` scopes the lookup to this
  // pipeline; source columns are matched too as a belt-and-braces check.  Any
  // lookup failure falls back to the plain insert below.
  //
  // 'validating' and 'failed' are reusable, but ONLY once stale.
  //
  // They used to be excluded entirely, which made every retry of a broken
  // export insert a brand-new RUNS row — AND a brand-new warehouse RUN_STATE
  // blob holding the customer's literal values. Live-reproduced at 4 retries →
  // 4 stranded rows on both warehouses. That is an unbounded leak of customer
  // data into orphaned rows nothing ever cleans up, which the data-residency
  // rule (values live in the customer's warehouse, and only where we account
  // for them) makes worse than a cosmetic pileup. Two ways in: a write that
  // died mid-flight leaves 'validating', and a zero-group tick sets 'failed'
  // directly (both TICK-09).
  //
  // The staleness window is what makes this safe. A run legitimately in flight
  // is also 'validating', and stealing it would put two writers on one blob.
  // The per-pipeline processing lock already prevents concurrent passes, so
  // this is belt-and-braces: only adopt a run whose updated_at is older than
  // the same PROCESSING_MAX_MS valve the lock uses, by which point no live
  // pass can still own it. Reuse rewrites run_status to 'created' and replaces
  // the blob wholesale, so an adopted run carries nothing forward.
  const staleCutoff = new Date(Date.now() - PROCESSING_MAX_MS).toISOString();
  try {
    const pendingRow = getDb()
      .prepare(
        `SELECT run_id FROM runs
         WHERE creation_nonce LIKE ? ESCAPE '\\'
           AND source_relation = ?
           AND source_column   = ?
           AND (
                 run_status IN ('created', 'running')
                 OR (run_status IN ('validating', 'failed') AND COALESCE(updated_at, '') < ?)
               )
         ORDER BY run_id DESC
         LIMIT 1`,
      )
      .get(`hourly_${pipeline.pipeline_id}\\_%`, pipeline.table_fqn, pipeline.column_name, staleCutoff) as any;
    if (pendingRow) {
      const reuseId = Number(pendingRow.run_id);
      if (Number.isFinite(reuseId) && reuseId > 0) {
        getDb()
          .prepare(
            `UPDATE runs
             SET run_status = 'created', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE run_id = ?`,
          )
          .run(reuseId);
        await saveOpRunState(reuseId, buildInitialQueueRunState(literals, frequencies));
        console.log(
          `[Standardize] Pipeline ${pipeline.pipeline_id}: reusing pending run ${reuseId} from a previous attempt`,
        );
        return reuseId;
      }
    }
  } catch (reuseErr) {
    console.warn(
      `[Standardize] Pipeline ${pipeline.pipeline_id}: pending-run lookup failed — creating a new run instead:`,
      reuseErr,
    );
  }

  const insertRes = getDb()
    .prepare(
      `INSERT INTO runs
         (concept_key, source_relation, source_column, mode, domain_id, run_status, creation_nonce)
       VALUES (?, ?, ?, 'auto', ?, 'created', ?)`,
    )
    .run(conceptKey, pipeline.table_fqn, pipeline.column_name,
         pipeline.domain_id != null ? Number(pipeline.domain_id) : null, nonce);
  const runId = Number(insertRes.lastInsertRowid);

  await saveOpRunState(runId, buildInitialQueueRunState(literals, frequencies));
  return runId;
}

async function removeExportedFromQueue(
  connection:   any,
  pipelineId:   number,
  exportedLiterals: string[],
  /**
   * Did the customer-visible export object actually get rebuilt this pass?
   *
   * The queue still drains either way — the MAPPINGS are committed by this
   * point, so re-standardizing the same values would burn LLM calls to reach an
   * identical result. But fully_synced_at means "the standardized table is
   * verified up to date", and stamping it after a failed rebuild is a lie the
   * UI then repeats as "Standardized table last updated just now" (KI-146).
   * Defaults true so existing callers are unchanged.
   */
  exportVerified: boolean = true,
): Promise<void> {
  if (exportedLiterals.length === 0) return;

  // Batched under the adapter's bind budget (a 5k-literal drain would blow
  // SQL Server's ~2.1k-parameter ceiling in one statement).
  const DEL_BATCH = Math.max(100, getWarehouseAdapter().bindLimit - 100);
  for (let i = 0; i < exportedLiterals.length; i += DEL_BATCH) {
    const batch = exportedLiterals.slice(i, i + DEL_BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    await exec(
      connection,
      `DELETE FROM ${internalTable('PIPELINE_QUEUE')}
       WHERE pipeline_id = ? AND literal_value IN (${placeholders})`,
      [pipelineId, ...batch],
    );
  }

  const countRows = await exec(
    connection,
    `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
    [pipelineId],
  );
  const queueSize = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

  const setClauses = [
    `queue_size = ?`,
    `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ];
  const binds: any[] = [queueSize];

  if (queueSize === 0) {
    setClauses.push(`last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    // Queue fully drained AND the export object was actually rebuilt — only
    // then is the standardized table verifiably complete at this instant.
    // When the rebuild failed we deliberately leave fully_synced_at at its
    // previous value: the card should keep showing the older, TRUE timestamp
    // rather than claim a freshness that does not exist.
    if (exportVerified) {
      setClauses.push(`fully_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    } else {
      console.warn(
        `[Standardize] Pipeline ${pipelineId}: queue drained but the export rebuild failed — ` +
        `NOT stamping fully_synced_at (the standardized output is behind the lookup).`,
      );
    }
  }

  binds.push(pipelineId);
  getDb()
    .prepare(`UPDATE pipelines SET ${setClauses.join(', ')} WHERE pipeline_id = ?`)
    .run(...binds);
}

// ── Bulk processing (on-demand) ───────────────────────────────────────────────

export interface BulkQueueResult {
  run_id:             number;
  groups_created:     number;
  items_written:      number;
  lookup_matched:     number;
  llm_grouped:        number;
  literals_processed: number;
  exported_literals:  string[];
}

/**
 * Takes a pre-assembled list of literals, runs the full auto-group + direct-export
 * pipeline synchronously, and returns rich stats.  Premium only — called from the
 * on-demand process-queue API route for initial bulk-import and queue drain.
 *
 * Uses the same concurrency lock as processPipelineQueue so the two paths
 * cannot race against each other.
 */
export async function bulkProcessPipelineQueue(
  pipeline: PipelineForProcessing,
  literals: string[],
  apiKey:   string,
): Promise<BulkQueueResult> {
  if (literals.length === 0) {
    return {
      run_id: 0, groups_created: 0, items_written: 0,
      lookup_matched: 0, llm_grouped: 0, literals_processed: 0, exported_literals: [],
    };
  }

  if (processingPipelineIds.has(pipeline.pipeline_id)) {
    throw new Error(`Pipeline ${pipeline.pipeline_id} is already being processed — try again in a moment.`);
  }
  processingPipelineIds.add(pipeline.pipeline_id);
  beginStandardization(pipeline.pipeline_id);

  try {
    return await withWarehouse(async (conn) => {
      const runId = await createRunFromQueue(conn, pipeline, literals);

      const groupResult = await runAutoGroupForRun(conn, runId, apiKey, { writeBreakdown: false });

      const state          = await loadOpRunState(runId);
      const exportedLits   = state?.groups.flatMap(g => g.items.map(gi => gi.literal_value)) ?? [];

      let items_written = 0;
      if (exportedLits.length > 0) {
        const exportResult = await runOpExportDirect(runId);
        items_written = exportResult.items_written;
        await removeExportedFromQueue(conn, pipeline.pipeline_id, exportedLits);
        broadcastPipelineEvent({ type: 'metrics_updated' });
      }

      // A successful user-triggered bulk run also resets the failure tracker
      // (the user explicitly retried and it worked).
      clearStandardizationFailures(pipeline.pipeline_id);

      return {
        run_id:             runId,
        groups_created:     groupResult.groups_created,
        items_written,
        lookup_matched:     groupResult.lookup_matched,
        llm_grouped:        groupResult.llm_grouped,
        literals_processed: literals.length,
        exported_literals:  exportedLits,
      };
    });
  } finally {
    processingPipelineIds.delete(pipeline.pipeline_id);
    endStandardization(pipeline.pipeline_id);
  }
}

/**
 * Process one pipeline's queue: auto-group + direct export.
 */
export async function processPipelineQueue(
  pipeline: PipelineForProcessing,
  opts:     { beginEndStandardization?: boolean } = {},
): Promise<void> {
  const { beginEndStandardization = true } = opts;
  const tag = 'Standardize';
  if (processingPipelineIds.has(pipeline.pipeline_id)) {
    console.log(`[${tag}] Pipeline ${pipeline.pipeline_id}: already processing — skip`);
    return;
  }
  if (isStandardizationBackedOff(pipeline.pipeline_id)) {
    const f = standardizationFailures.get(pipeline.pipeline_id);
    console.log(
      `[${tag}] Pipeline ${pipeline.pipeline_id}: in failure backoff ` +
      `(${f?.count ?? '?'} consecutive failure(s)) — retry after ${new Date(f?.nextAttemptAt ?? 0).toISOString()}`,
    );
    return;
  }
  processingPipelineIds.add(pipeline.pipeline_id);
  if (beginEndStandardization) beginStandardization(pipeline.pipeline_id);

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    console.warn(`[${tag}] No Anthropic API key configured — skipping pipeline ${pipeline.pipeline_id}`);
    processingPipelineIds.delete(pipeline.pipeline_id);
    if (beginEndStandardization) endStandardization(pipeline.pipeline_id);
    return;
  }

  try {
    await withWarehouse(async (connection) => {
      const queueItems = await fetchQueueLiteralsWithFreq(connection, pipeline.pipeline_id);
      if (queueItems.length === 0) {
        console.log(`[${tag}] Pipeline ${pipeline.pipeline_id}: queue empty — skip`);
        return;
      }

      const literals = queueItems.map(q => q.literal_value);
      const frequencies = new Map(queueItems.map(q => [q.literal_value, q.source_frequency]));

      console.log(
        `[${tag}] Pipeline ${pipeline.pipeline_id} (${pipeline.column_name || 'no column'}): ` +
        `standardizing ${literals.length} queued value(s)…`,
      );

      const runId = await createRunFromQueue(connection, pipeline, literals, frequencies);

      await runAutoGroupForRun(connection, runId, apiKey, { writeBreakdown: false });

      const stateAfter = await loadOpRunState(runId);
      const exportedLiterals = stateAfter?.groups.flatMap((g) =>
        g.items.map((gi) => gi.literal_value),
      ) ?? [];

      if (exportedLiterals.length === 0) {
        console.error(
          `[${tag}] Pipeline ${pipeline.pipeline_id}: run ${runId} produced no groups — queue unchanged`,
        );
        getDb()
          .prepare(`UPDATE runs SET run_status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id = ?`)
          .run(runId);
        // Counts toward the failure backoff: with the queue intact, the tick
        // would otherwise re-fire this (token-burning) LLM pass every 10 min.
        await recordStandardizationFailure(
          pipeline.pipeline_id,
          new Error('LLM grouping produced no groups — queue unchanged'),
        );
        return;
      }

      const exportResult = await runOpExportDirect(runId);
      // runOpExportDirect rebuilds the export table and updates total_mapped
      // internally. A rebuild failure there is non-fatal to the mappings but
      // MUST NOT be reported as a fresh standardized table — pass the outcome
      // through rather than assuming success (KI-146).
      await removeExportedFromQueue(
        connection, pipeline.pipeline_id, exportedLiterals,
        !exportResult.export_refresh_failed,
      );

      // NOTE: total_mapped is deliberately NOT touched here.
      //
      // There used to be an additive `total_mapped = total_mapped + <freq sum>`
      // for pipelines with no export table ("Lookup table" output mode), on the
      // stated grounds that "runOpExportDirect skips this path". That comment
      // was stale: runOpExportDirect's else-branch calls
      // updatePipelineMappedCount for exactly the no-export-object case, which
      // recomputes total_mapped and total_source_values ABSOLUTELY from the
      // lookup. Adding on top of an absolute recompute double-counted every
      // tick and could push mapped above source — live-observed as "18 mapped
      // of 9 source values", an impossible ratio on the card (TICK-01).
      //
      // Counters are recomputed at each rebuild by design, so nothing here
      // should ever increment them.

      broadcastPipelineEvent({ type: 'metrics_updated' });

      // Full success — reset the consecutive-failure tracker.
      clearStandardizationFailures(pipeline.pipeline_id);

      console.log(
        `[${tag}] Pipeline ${pipeline.pipeline_id}: run ${runId} complete — ` +
        `${exportResult.items_written} mapping(s) written, ` +
        `${literals.length - exportedLiterals.length} left ungrouped in queue`,
      );
    });
  } catch (e) {
    console.error(`[${tag}] Pipeline ${pipeline.pipeline_id}: standardization failed:`, e);
    await recordStandardizationFailure(pipeline.pipeline_id, e);
  } finally {
    processingPipelineIds.delete(pipeline.pipeline_id);
    if (beginEndStandardization) endStandardization(pipeline.pipeline_id);
  }
}

/**
 * Standardize every column of one table together, as a single cycle. All of the
 * table's columns are marked "standardizing" up front (so the table card animates
 * as one unit with no flicker between columns) and then each column's queue is
 * processed in turn. Columns with empty queues are skipped by processPipelineQueue.
 */
export async function standardizeTable(
  columns: PipelineForProcessing[],
): Promise<void> {
  if (columns.length === 0) return;
  // Mark the whole table standardizing before touching any column so the card
  // stays lit for the entire batch (beginStandardization only flips the animation
  // state; processPipelineQueue still manages its own processing lock).
  for (const c of columns) beginStandardization(c.pipeline_id);
  try {
    for (const c of columns) {
      await processPipelineQueue(c, { beginEndStandardization: false });
    }
  } finally {
    // Unmark every column — covers ones whose queue was empty and were skipped
    // by processPipelineQueue without toggling their own state.
    for (const c of columns) endStandardization(c.pipeline_id);
  }
}

/** Group pipelines by their source table. */
function groupByTable(pipelines: PipelineForProcessing[]): Map<string, PipelineForProcessing[]> {
  const map = new Map<string, PipelineForProcessing[]>();
  for (const p of pipelines) {
    const arr = map.get(p.table_fqn) ?? [];
    arr.push(p);
    map.set(p.table_fqn, arr);
  }
  return map;
}

/**
 * One standardization tick: drain every window-open pipeline's queue, grouped
 * by table. `reconcile: true` (top-of-hour ticks) first runs the reconciliation
 * sweep + safety export rebuilds — kept hourly, not every tick, because they
 * full-scan every source and rebuild every export (warehouse cost).
 */
export async function runScheduledStandardization(opts: { reconcile?: boolean } = {}): Promise<void> {
  if (opts.reconcile) {
    // Surface any pre-existing source values the stream never captured (e.g. the
    // distinct tail beyond the baseline scan cap) into the queue first, so the
    // standardization pass below picks them up.
    await runReconciliationSweep().catch((e) =>
      console.error('[Standardize] Reconciliation sweep failed:', e),
    );
  }

  const pipelines = await fetchPipelinesWithQueue();
  if (pipelines.length === 0) {
    console.log('[Standardize] Tick: no pipelines with queued items');
    return;
  }

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    console.warn('[Standardize] No AI provider configured — skipping pipeline standardization');
    return;
  }

  // Standardize a table's columns together (one cycle per table), not per column.
  const byTable = groupByTable(pipelines);
  console.log(`[Standardize] Tick: ${pipelines.length} column(s) across ${byTable.size} table(s)…`);
  for (const [table, cols] of byTable) {
    console.log(`[Standardize] Table ${table}: standardizing ${cols.length} column(s) together`);
    await standardizeTable(cols);
  }
  console.log('[Standardize] Tick complete');
}

/** ms until the next wall-clock multiple of QUEUE_TICK_MS (1:00, 1:10, …). */
function msUntilNextTick(): number {
  return Math.max(1_000, QUEUE_TICK_MS - (Date.now() % QUEUE_TICK_MS));
}

/**
 * Schedule standardization at every 10-minute wall-clock mark. Self-chaining
 * (the next tick is computed AFTER the current run finishes) so ticks stay
 * anchored to the clock and never overlap; a run longer than 10 minutes simply
 * skips to the next mark. The top-of-hour mark also runs the reconciliation
 * sweep + safety export rebuilds (the old hourly behavior).
 */
export function startQueueProcessor(): void {
  const g = global as typeof globalThis & { __queueProcessorStarted?: boolean };
  if (g.__queueProcessorStarted) return;
  g.__queueProcessorStarted = true;

  const chain = () => {
    const delay = msUntilNextTick();
    setTimeout(async () => {
      // Which mark did this tick fire for? (Round — the timer lands ~on it.)
      const mark = Math.round(Date.now() / QUEUE_TICK_MS) * QUEUE_TICK_MS;
      const topOfHour = mark % HOUR_MS === 0;
      try {
        await runScheduledStandardization({ reconcile: topOfHour });
      } catch (err) {
        // Never let a rejected run tear down the scheduler.
        console.error('[Standardize] Tick failed:', err);
      }
      chain();
    }, delay);
  };

  chain();
  console.log(`[Standardize] Queue processor started — next tick in ${Math.round(msUntilNextTick() / 1_000)}s, every 10 min on the clock`);
}
