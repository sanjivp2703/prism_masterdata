/* eslint-disable @typescript-eslint/no-explicit-any */
// PostgreSQL poll orchestration — the postgres counterpart of pollOnePipeline
// (docs/POSTGRES_PORT_PLAN.md Phase P2).
//
// Called from pipeline-poller.ts's pollOneTable when the active warehouse
// adapter is postgres. Same contract as the other paths: DETECT AND QUEUE
// ONLY — standardization stays in the 10-minute tick. Every Postgres pipeline
// runs diff mode (no CT analog — see warehouse/postgres/detection.ts), gated
// by the free pg_stat heartbeat, whose delete counter also gives Postgres
// something mssql diff mode can't see: row deletions flag a hygiene export
// rebuild the same cycle instead of waiting for the hourly safety rebuild.
import 'server-only';

import { getDb } from './sqlite';
import { withWarehouse, executeQuery as exec } from './warehouse';
import {
  type PgDetectionState,
  initDetection,
  diffHeartbeat,
  deletesFromMarker,
  diffScan,
  filterUnknownValues,
  queueValues,
  getQueueSize,
  retuneScanTier,
  checkSourceHealthPg,
  classifyPgPollError,
} from './warehouse/postgres/detection';
import { pgTableRef } from './warehouse/postgres/detection';
import { quoteIdent } from './warehouse/postgres/dialect';
import { pausePipelineWithMessage, flagPipelineMessage, clearPipelineStatusMessage, broadcastGlobalAlert } from './pipeline-alerts';
import { isPipelineStandardizing } from './pipeline-coordination';

// Structural copy of the poller's PipelineRef (no import — avoids a module
// cycle with pipeline-poller.ts; the poller passes its own refs in).
export interface PgPipelineRef {
  pipeline_id: number;
  table_fqn: string;
  column_name: string;
  domain_id: number | null;
  export_table_fqn: string | null;
  status_message: string | null;
  // Raw passthrough (finding #17): with export_unmapped_rows ON, newly
  // queued values also trigger an export rebuild the same cycle. Table-kind
  // exports only (pg views are live and need no rebuild).
  export_kind?: string;
  export_unmapped_rows?: boolean;
}

export interface PgPollResult {
  /** The poll genuinely consulted the source (drives fully_synced_at). */
  checked: boolean;
  /** Deletes observed (heartbeat delete-counter delta) — the export needs a
   *  hygiene rebuild. */
  needsExportRefresh: boolean;
}

// Health checks are cheap catalog reads on Postgres (no warehouse wake-cost),
// but still pointless every minute — run on the first poll, after any error,
// while flagged, and every 10th pass. Same cadence as the mssql orchestrator.
const HEALTH_CHECK_EVERY = 10;
const healthCounters = new Map<number, number>();
const lastPollErrored = new Set<number>();

function loadState(pipelineId: number): PgDetectionState | null {
  const r = getDb()
    .prepare(`SELECT detection_mode, detection_state FROM pipelines WHERE pipeline_id = ?`)
    .get(pipelineId) as any;
  try {
    const state = r?.detection_state ? JSON.parse(String(r.detection_state)) : null;
    return state && state.mode === 'diff' ? (state as PgDetectionState) : null;
  } catch { return null; }
}

function saveState(pipelineId: number, state: PgDetectionState): void {
  getDb()
    .prepare(`UPDATE pipelines SET detection_mode = ?, detection_state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pipeline_id = ?`)
    .run(state.mode, JSON.stringify(state), pipelineId);
}

/** Same semantics as the Snowflake poller's touchLastPolled: a check that
 *  found nothing pending (queue empty) also advances fully_synced_at. */
function touchLastPolled(pipelineId: number, opts: { claimSynced?: boolean } = {}): void {
  const { claimSynced = true } = opts;
  const syncedClause = claimSynced
    ? `fully_synced_at = CASE WHEN queue_size = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE fully_synced_at END,`
    : '';
  getDb()
    .prepare(
      `UPDATE pipelines
       SET last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           ${syncedClause}
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE pipeline_id = ?`,
    )
    .run(pipelineId);
}

function updateQueueMetric(pipelineId: number, queueSize: number): void {
  getDb()
    .prepare(
      `UPDATE pipelines
       SET queue_size = ?,
           last_queue_empty_at = CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE last_queue_empty_at END
       WHERE pipeline_id = ?`,
    )
    .run(queueSize, queueSize, pipelineId);
}

/** Parity with the other pollers: a live COUNT(*) of the source column on
 *  every cycle that actually touched the source, independent of total_mapped
 *  (which stays frozen until the next standardization tick). */
async function updateSourceValueCount(conn: any, pipelineId: number, tableFqn: string, columnName: string): Promise<void> {
  const { ref } = pgTableRef(tableFqn);
  const rows = await exec(
    conn,
    `SELECT COUNT(*) AS cnt FROM ${ref} WHERE ${quoteIdent(columnName)} IS NOT NULL`,
  );
  const cnt = Number(rows[0]?.cnt ?? 0);
  getDb().prepare(`UPDATE pipelines SET total_source_values = ? WHERE pipeline_id = ?`).run(cnt, pipelineId);
}

/** Postgres reconciliation sweep for one pipeline: diff scan → app-side
 *  normalize → filter already-queued/mapped → queue, capped per pass
 *  (mirrors the Snowflake RECONCILE_QUEUE_BATCH trickle). Returns queued count. */
export async function reconcilePgQueue(
  p: { pipeline_id: number; table_fqn: string; column_name: string; domain_id: number | null },
  cap = 5_000,
): Promise<number> {
  return await withWarehouse(async (conn) => {
    const scan = await diffScan(conn, p.table_fqn, p.column_name);
    const unknown = await filterUnknownValues(conn, p.pipeline_id, p.domain_id, scan.values);
    const slice = unknown.slice(0, cap);
    if (slice.length) {
      await queueValues(conn, p.pipeline_id, slice);
      updateQueueMetric(p.pipeline_id, await getQueueSize(conn, p.pipeline_id));
    }
    await updateSourceValueCount(conn, p.pipeline_id, p.table_fqn, p.column_name);
    return slice.length;
  });
}

export async function pollOnePgPipeline(p: PgPipelineRef): Promise<PgPollResult> {
  const pid = p.pipeline_id;

  // Standardizing-lock guard — same asymmetry fix as TICK-10 on mssql: a poll
  // must never run concurrently with a standardization pass on the pipeline.
  if (isPipelineStandardizing(pid)) {
    console.log(`[Poller/pg] Pipeline ${pid}: standardization in progress — skipping this poll cycle`);
    return { checked: false, needsExportRefresh: false };
  }

  try {
    return await withWarehouse(async (conn) => {
      // ── Detection state (init on first poll) ────────────────────────────
      let state = loadState(pid);
      let initialized = false;
      if (!state) {
        state = await initDetection(conn, p.table_fqn);
        saveState(pid, state);
        initialized = true;
        console.log(`[Poller/pg] Pipeline ${pid}: detection initialized — mode=diff (pg_diff), scan_every=${state.scan_every}`);
      }

      // ── Health check (init / after error / while flagged / every 10th) ───
      // `|| !!p.status_message` is load-bearing for the RLS guard — same
      // masking-guard reasoning as the mssql orchestrator (a flagged pipeline
      // must not sail into the scan branch on the other 9 passes and queue
      // filtered/partial data). Catalog reads are free on Postgres, so
      // re-checking every flagged pass is affordable.
      const counter = (healthCounters.get(pid) ?? 0) + 1;
      healthCounters.set(pid, counter);
      const healthDue = initialized
                     || lastPollErrored.has(pid)
                     || !!p.status_message
                     || counter % HEALTH_CHECK_EVERY === 1;
      if (healthDue) {
        const health = await checkSourceHealthPg(conn, p.table_fqn, p.column_name);
        if (!health.ok) {
          await pausePipelineWithMessage(pid, health.message);
          return { checked: false, needsExportRefresh: false };
        }
        if (health.masked) {
          // 'policy_blocked' is the machine-readable half — it is what stops
          // the 10-minute tick, the reconciliation sweep, and the manual
          // trigger (NOT_BLOCKED_SQL filters on status_reason). Row-Level
          // Security means the service role may see a filtered subset;
          // standardizing from it would bake a partial view into the lookup.
          await flagPipelineMessage(
            pid,
            `Source table ${p.table_fqn} has Row-Level Security enabled — standardization is skipped until it is removed (Prism may only be seeing a subset of rows).`,
            'warning',
            'policy_blocked',
          );
          touchLastPolled(pid, { claimSynced: false });
          return { checked: false, needsExportRefresh: false };
        }
        if (p.status_message) await clearPipelineStatusMessage(pid);
        lastPollErrored.delete(pid);
      }

      // ── Diff mode (the only mode on Postgres) ────────────────────────────
      const passes = (state.passes_since_scan ?? 0) + 1;

      // Free heartbeat (no grant needed on Postgres — 'unavailable' only on
      // unexpected errors, handled like the mssql no-DMV path).
      const beat = await diffHeartbeat(conn, p.table_fqn);
      const beatUsable = beat !== 'unavailable';

      // Delete detection for free: the heartbeat's cumulative delete counter
      // moved → rows were deleted → hygiene export rebuild this cycle. A
      // backwards jump (stats reset) is NOT treated as deletes — it fails
      // open into a scan below instead.
      const storedDeletes = deletesFromMarker(state.heartbeat);
      const sawDeletes = beatUsable && state.heartbeat != null && state.heartbeat !== 'never'
        && (beat as any).deletes > storedDeletes;

      const scanEvery = beatUsable
        ? Math.max(1, state.scan_every ?? 1)
        : Math.max(5, state.scan_every ?? 1); // no heartbeat → ≥5-minute scan floor (mssql rule)

      if (beatUsable && state.heartbeat != null && (beat as any).marker === state.heartbeat) {
        // Nothing written since last look — idle skip, zero table reads.
        saveState(pid, { ...state, passes_since_scan: passes });
        touchLastPolled(pid);
        return { checked: true, needsExportRefresh: false };
      }

      // Scan only when the tier says this pass is due. (A changed heartbeat
      // with a not-yet-due tier still defers — the tier bounds load on big
      // tables; the change is caught on the due pass.)
      if (passes < scanEvery) {
        saveState(pid, { ...state, passes_since_scan: passes });
        touchLastPolled(pid, { claimSynced: false });
        return { checked: false, needsExportRefresh: sawDeletes };
      }

      const scan = await diffScan(conn, p.table_fqn, p.column_name);
      if (scan.truncated) {
        console.warn(`[Poller/pg] Pipeline ${pid}: diff scan truncated at cap — remaining values queue on later scans`);
      }
      const unknown = await filterUnknownValues(conn, pid, p.domain_id, scan.values);
      const rawPassthrough =
        p.export_unmapped_rows === true &&
        p.export_table_fqn != null &&
        String(p.export_kind ?? 'table') === 'table';
      if (unknown.length) {
        await queueValues(conn, pid, unknown);
        console.log(`[Poller/pg] Pipeline ${pid}: diff scan queued ${unknown.length} new value(s) (scan ${scan.durationMs}ms)`);
      }

      saveState(pid, {
        ...state,
        passes_since_scan: 0,
        heartbeat: beatUsable ? (beat as any).marker : null,
        last_scan_ms: scan.durationMs,
        scan_every: retuneScanTier(scan.durationMs, state.serverless ?? false),
      });
      updateQueueMetric(pid, await getQueueSize(conn, pid));
      await updateSourceValueCount(conn, pid, p.table_fqn, p.column_name);
      touchLastPolled(pid);
      return { checked: true, needsExportRefresh: sawDeletes || (rawPassthrough && unknown.length > 0) };
    });
  } catch (err) {
    const kind = classifyPgPollError(err);
    console.error(`[Poller/pg] Pipeline ${pid} poll failed (${kind}):`, (err as any)?.message ?? err);
    lastPollErrored.add(pid);
    if (kind === 'global') {
      broadcastGlobalAlert('PostgreSQL access interrupted (sign-in or database issue). Pipelines will resume automatically when it is restored.');
    } else if (kind === 'table') {
      await pausePipelineWithMessage(pid, `Prism can no longer access ${p.table_fqn} (permission revoked or object dropped). Fix access, then resume this pipeline.`).catch(() => {});
    }
    // transient: retry next minute mark
    return { checked: false, needsExportRefresh: false };
  }
}
