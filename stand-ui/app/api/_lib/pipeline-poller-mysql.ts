/* eslint-disable @typescript-eslint/no-explicit-any */
// MySQL poll orchestration — the mysql counterpart of pollOnePipeline
// (docs/MYSQL_PORT_PLAN.md Phase M2).
//
// Called from pipeline-poller.ts's pollOneTable when the active warehouse
// adapter is mysql. Same contract as the other paths: DETECT AND QUEUE ONLY —
// standardization stays in the 10-minute tick. Every MySQL pipeline runs diff
// mode gated by the UPDATE_TIME heartbeat (fresh via stats_expiry=0; see
// warehouse/mysql/detection.ts). Differences from the pg orchestrator, both
// deliberate: no RLS/masking branch (MySQL has no analog — health checks
// never return masked), and no free delete flag (UPDATE_TIME can't
// distinguish deletes; the hourly safety rebuild covers them, as on mssql
// diff mode).
import 'server-only';

import { getDb } from './sqlite';
import { withWarehouse, executeQuery as exec } from './warehouse';
import {
  type MysqlDetectionState,
  initDetection,
  diffHeartbeat,
  diffScan,
  filterUnknownValues,
  queueValues,
  getQueueSize,
  retuneScanTier,
  checkSourceHealthMysql,
  classifyMysqlPollError,
} from './warehouse/mysql/detection';
import { myTableRef } from './warehouse/mysql/detection';
import { quoteIdent } from './warehouse/mysql/dialect';
import { pausePipelineWithMessage, clearPipelineStatusMessage, broadcastGlobalAlert } from './pipeline-alerts';
import { isPipelineStandardizing } from './pipeline-coordination';

// Structural copy of the poller's PipelineRef (no import — avoids a module
// cycle with pipeline-poller.ts; the poller passes its own refs in).
export interface MysqlPipelineRef {
  pipeline_id: number;
  table_fqn: string;
  column_name: string;
  domain_id: number | null;
  export_table_fqn: string | null;
  status_message: string | null;
}

export interface MysqlPollResult {
  /** The poll genuinely consulted the source (drives fully_synced_at). */
  checked: boolean;
  /** Always false on mysql diff mode — deletes are invisible to the
   *  UPDATE_TIME heartbeat; the hourly safety rebuild covers them. */
  needsExportRefresh: boolean;
}

// Health checks are cheap catalog reads on MySQL, but still pointless every
// minute — run on the first poll, after any error, while flagged, and every
// 10th pass. Same cadence as the other diff orchestrators.
const HEALTH_CHECK_EVERY = 10;
const healthCounters = new Map<number, number>();
const lastPollErrored = new Set<number>();

function loadState(pipelineId: number): MysqlDetectionState | null {
  const r = getDb()
    .prepare(`SELECT detection_mode, detection_state FROM pipelines WHERE pipeline_id = ?`)
    .get(pipelineId) as any;
  try {
    const state = r?.detection_state ? JSON.parse(String(r.detection_state)) : null;
    return state && state.mode === 'diff' && state.diff_reason === 'mysql_diff' ? (state as MysqlDetectionState) : null;
  } catch { return null; }
}

function saveState(pipelineId: number, state: MysqlDetectionState): void {
  getDb()
    .prepare(`UPDATE pipelines SET detection_mode = ?, detection_state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pipeline_id = ?`)
    .run(state.mode, JSON.stringify(state), pipelineId);
}

/** Same semantics as the other pollers' touchLastPolled: a check that found
 *  nothing pending (queue empty) also advances fully_synced_at. */
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
  const { ref } = myTableRef(tableFqn);
  const rows = await exec(
    conn,
    `SELECT COUNT(*) AS cnt FROM ${ref} WHERE ${quoteIdent(columnName)} IS NOT NULL`,
  );
  const cnt = Number(rows[0]?.cnt ?? 0);
  getDb().prepare(`UPDATE pipelines SET total_source_values = ? WHERE pipeline_id = ?`).run(cnt, pipelineId);
}

/** MySQL reconciliation sweep for one pipeline: diff scan → app-side
 *  normalize → filter already-queued/mapped → queue, capped per pass
 *  (mirrors the Snowflake RECONCILE_QUEUE_BATCH trickle). Returns queued count. */
export async function reconcileMysqlQueue(
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

export async function pollOneMysqlPipeline(p: MysqlPipelineRef): Promise<MysqlPollResult> {
  const pid = p.pipeline_id;

  // Standardizing-lock guard — same asymmetry rule as TICK-10: a poll must
  // never run concurrently with a standardization pass on the pipeline.
  if (isPipelineStandardizing(pid)) {
    console.log(`[Poller/mysql] Pipeline ${pid}: standardization in progress — skipping this poll cycle`);
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
        console.log(`[Poller/mysql] Pipeline ${pid}: detection initialized — mode=diff (mysql_diff), scan_every=${state.scan_every}`);
      }

      // ── Health check (init / after error / while flagged / every 10th) ───
      const counter = (healthCounters.get(pid) ?? 0) + 1;
      healthCounters.set(pid, counter);
      const healthDue = initialized
                     || lastPollErrored.has(pid)
                     || !!p.status_message
                     || counter % HEALTH_CHECK_EVERY === 1;
      if (healthDue) {
        const health = await checkSourceHealthMysql(conn, p.table_fqn, p.column_name);
        if (!health.ok) {
          await pausePipelineWithMessage(pid, health.message);
          return { checked: false, needsExportRefresh: false };
        }
        // No masked branch: MySQL has no RLS/masking analog — health never
        // returns masked (see checkSourceHealthMysql).
        if (p.status_message) await clearPipelineStatusMessage(pid);
        lastPollErrored.delete(pid);
      }

      // ── Diff mode (the only mode on MySQL) ───────────────────────────────
      const passes = (state.passes_since_scan ?? 0) + 1;

      const beat = await diffHeartbeat(conn, p.table_fqn);
      const beatUsable = beat !== 'unavailable';

      const scanEvery = beatUsable
        ? Math.max(1, state.scan_every ?? 1)
        : Math.max(5, state.scan_every ?? 1); // no heartbeat → ≥5-minute scan floor (mssql rule)

      // Idle skip: marker equal AND a real timestamp. "never" (NULL — fresh
      // table or ANY server restart) always fails open into the scan path —
      // a restart must not freeze detection on the stale stored marker.
      if (beatUsable && state.heartbeat != null && beat !== 'never' && beat === state.heartbeat) {
        saveState(pid, { ...state, passes_since_scan: passes });
        touchLastPolled(pid);
        return { checked: true, needsExportRefresh: false };
      }

      // Scan only when the tier says this pass is due.
      if (passes < scanEvery) {
        saveState(pid, { ...state, passes_since_scan: passes });
        touchLastPolled(pid, { claimSynced: false });
        return { checked: false, needsExportRefresh: false };
      }

      const scan = await diffScan(conn, p.table_fqn, p.column_name);
      if (scan.truncated) {
        console.warn(`[Poller/mysql] Pipeline ${pid}: diff scan truncated at cap — remaining values queue on later scans`);
      }
      const unknown = await filterUnknownValues(conn, pid, p.domain_id, scan.values);
      if (unknown.length) {
        await queueValues(conn, pid, unknown);
        console.log(`[Poller/mysql] Pipeline ${pid}: diff scan queued ${unknown.length} new value(s) (scan ${scan.durationMs}ms)`);
      }

      saveState(pid, {
        ...state,
        passes_since_scan: 0,
        heartbeat: beatUsable ? beat : null,
        last_scan_ms: scan.durationMs,
        scan_every: retuneScanTier(scan.durationMs, state.serverless ?? false),
      });
      updateQueueMetric(pid, await getQueueSize(conn, pid));
      await updateSourceValueCount(conn, pid, p.table_fqn, p.column_name);
      touchLastPolled(pid);
      return { checked: true, needsExportRefresh: false };
    });
  } catch (err) {
    const kind = classifyMysqlPollError(err);
    console.error(`[Poller/mysql] Pipeline ${pid} poll failed (${kind}):`, (err as any)?.message ?? err);
    lastPollErrored.add(pid);
    if (kind === 'global') {
      broadcastGlobalAlert('MySQL access interrupted (sign-in or database issue). Pipelines will resume automatically when it is restored.');
    } else if (kind === 'table') {
      await pausePipelineWithMessage(pid, `Prism can no longer access ${p.table_fqn} (permission revoked or object dropped). Fix access, then resume this pipeline.`).catch(() => {});
    }
    // transient: retry next minute mark
    return { checked: false, needsExportRefresh: false };
  }
}
