/* eslint-disable @typescript-eslint/no-explicit-any */
// SQL Server poll orchestration — the mssql counterpart of pollOnePipeline
// (docs/MSSQL_PORT_PLAN.md Phase 4).
//
// Called from pipeline-poller.ts's pollOneTable when the active warehouse
// adapter is mssql. Same contract as the Snowflake path: DETECT AND QUEUE
// ONLY — standardization stays in the 10-minute tick (Phase 5 for mssql).
// Persistence of detection state (pipelines.detection_mode/detection_state),
// pausing, alerts and SSE live here; the pure warehouse operations live in
// warehouse/mssql/detection.ts.
import 'server-only';

import { getDb } from './sqlite';
import { withWarehouse, executeQuery as exec } from './warehouse';
import {
  type MssqlDetectionState,
  initDetection,
  ctHasChanges,
  ctConsume,
  diffHeartbeat,
  diffScan,
  filterUnknownValues,
  queueValues,
  getQueueSize,
  retuneScanTier,
  checkSourceHealthMssql,
  classifyMssqlPollError,
} from './warehouse/mssql/detection';
import { quoteIdent, parseFqn } from './warehouse/mssql/dialect';
import { pausePipelineWithMessage, flagPipelineMessage, clearPipelineStatusMessage, broadcastGlobalAlert } from './pipeline-alerts';
import { isPipelineStandardizing } from './pipeline-coordination';

// Structural copy of the poller's PipelineRef (no import — avoids a module
// cycle with pipeline-poller.ts; the poller passes its own refs in).
export interface MssqlPipelineRef {
  pipeline_id: number;
  table_fqn: string;
  column_name: string;
  domain_id: number | null;
  export_table_fqn: string | null;
  status_message: string | null;
  // Consent to Prism attempting to enable Change Tracking automatically
  // (ALTER DATABASE/ALTER TABLE) — mirrors the Column output mode's consent
  // gate. Without it, detection init only reports current status; it never
  // runs DDL via the service login or the creator's personal credentials.
  change_tracking_consent: boolean;
}

export interface MssqlPollResult {
  /** The poll genuinely consulted the source (drives fully_synced_at). */
  checked: boolean;
  /** Deletes/updates or reconcile — the export needs a hygiene rebuild
   *  (rebuild itself is Phase 5 on mssql; the flag is honest anyway). */
  needsExportRefresh: boolean;
}

/** Minimum poll passes between diff scans when the free heartbeat DMV is not
 *  readable (no VIEW SERVER STATE / VIEW DATABASE STATE). Without it nothing
 *  else defers a scan on a small table — see the reasoning at the diff-mode
 *  due-check. One pass is one minute, so this is a ~5-minute floor. */
const DIFF_NO_HEARTBEAT_MIN_PASSES = 5;

// Health checks are cheap catalog reads on mssql, but still pointless every
// minute — run on the first poll, after any error, and every 10th pass.
const HEALTH_CHECK_EVERY = 10;
const healthCounters = new Map<number, number>();
const lastPollErrored = new Set<number>();

function loadState(pipelineId: number): { mode: string | null; state: MssqlDetectionState | null } {
  const r = getDb()
    .prepare(`SELECT detection_mode, detection_state FROM pipelines WHERE pipeline_id = ?`)
    .get(pipelineId) as any;
  let state: MssqlDetectionState | null = null;
  try {
    state = r?.detection_state ? JSON.parse(String(r.detection_state)) : null;
  } catch { state = null; }
  return { mode: r?.detection_mode ?? null, state };
}

function saveState(pipelineId: number, state: MssqlDetectionState): void {
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

/** Parity with the Snowflake poller: a live `COUNT(*)` of the source column
 *  on every cycle that actually touched the source (CT changes, or a due diff
 *  scan) — independent of total_mapped, which stays frozen until the next
 *  standardization tick rebuilds the export. Without this, total_source_values
 *  looked frozen too, so "Unstandardized" (source − mapped) stayed 0 even with
 *  values genuinely sitting in the queue — only the Queue tab showed the truth. */
async function updateSourceValueCount(conn: any, pipelineId: number, tableFqn: string, columnName: string): Promise<void> {
  const { db, schema, table } = parseFqn(tableFqn);
  const rows = await exec(
    conn,
    `SELECT COUNT(*) AS cnt FROM ${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)} WHERE ${quoteIdent(columnName)} IS NOT NULL`,
  );
  const cnt = Number(rows[0]?.cnt ?? rows[0]?.CNT ?? 0);
  getDb().prepare(`UPDATE pipelines SET total_source_values = ? WHERE pipeline_id = ?`).run(cnt, pipelineId);
}

/** SQL Server reconciliation sweep for one pipeline (Phase 5): diff scan →
 *  app-side normalize → filter already-queued/mapped → queue, capped per pass
 *  (mirrors the Snowflake RECONCILE_QUEUE_BATCH trickle). Returns queued count. */
export async function reconcileMssqlQueue(
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

export async function pollOneMssqlPipeline(p: MssqlPipelineRef): Promise<MssqlPollResult> {
  const pid = p.pipeline_id;

  // Same standardizing-lock guard the Snowflake poller has — this path had none
  // at all (zero references to pipeline-coordination), so on SQL Server a poll
  // could run concurrently with a standardization pass on the same pipeline:
  // CT/diff detection consuming changes while the tick is mid-write, with both
  // touching PIPELINE_QUEUE. The race protection was asymmetric across
  // warehouses for no reason (TICK-10).
  //
  // Logged rather than silent, for the reason the Snowflake side documents: a
  // leaked lock once starved a pipeline of polling forever with no output.
  if (isPipelineStandardizing(pid)) {
    console.log(`[Poller/mssql] Pipeline ${pid}: standardization in progress — skipping this poll cycle`);
    return { checked: false, needsExportRefresh: false };
  }

  try {
    return await withWarehouse(async (conn) => {
      // ── Detection state (init on first poll) ────────────────────────────
      let { state } = loadState(pid);
      let initialized = false;
      if (!state || (state.mode !== 'ct' && state.mode !== 'diff')) {
        // CT enable ladder, mssql edition: try via the service connection,
        // then the creator's saved personal credentials (create-initial-run
        // runs that escalation; the poller only re-checks status here). Only
        // attempted when the pipeline's creator explicitly consented — ALTER
        // DATABASE/ALTER TABLE are schema-modifying DDL, same consent-gate
        // principle as the Column output mode. Failure/no-consent falls back
        // to diff-scan — never pauses.
        state = await initDetection(conn, p.table_fqn, { tryEnable: p.change_tracking_consent === true });
        saveState(pid, state);
        initialized = true;
        console.log(`[Poller/mssql] Pipeline ${pid}: detection initialized — mode=${state.mode}${state.diff_reason ? ` (${state.diff_reason})` : ''}`);
      }

      // ── Health check (init / after error / every 10th pass) ─────────────
      const counter = (healthCounters.get(pid) ?? 0) + 1;
      healthCounters.set(pid, counter);
      // `|| !!p.status_message` is load-bearing for the masking guard.
      //
      // Without it the health check ran on only 1 in HEALTH_CHECK_EVERY passes,
      // so a pipeline already FLAGGED for a Dynamic Data Masking policy sailed
      // straight into the CT/diff branch on the other 9 and queued whatever the
      // masked column returned. Live-verified as the least-privilege prism_svc
      // login (the identity DDM actually masks): PIPELINE_QUEUE went
      // [] -> ['xxxx'] and stayed there, because flagging never retracts values
      // already queued. So the guard flagged the problem and then kept ingesting
      // masked placeholder data anyway.
      //
      // Re-checking every pass while flagged is affordable here in a way it is
      // NOT on Snowflake: checkSourceHealthMssql reads sys.* catalog views,
      // which do not resume a warehouse — the cost incident that forced
      // exponential backoff on the Snowflake side does not apply.
      const healthDue = initialized
                     || lastPollErrored.has(pid)
                     || !!p.status_message
                     || counter % HEALTH_CHECK_EVERY === 1;
      if (healthDue) {
        const health = await checkSourceHealthMssql(conn, p.table_fqn, p.column_name);
        if (!health.ok) {
          await pausePipelineWithMessage(pid, health.message);
          return { checked: false, needsExportRefresh: false };
        }
        if (health.masked) {
          // 'policy_blocked' is the machine-readable half — it is what actually
          // stops the 10-minute tick, the reconciliation sweep, and the manual
          // "Update Standardizations" button (they filter on status_reason via
          // NOT_BLOCKED_SQL; none of them read the prose message). Without it
          // this flag would only stop THIS poller's queuing, and the tick would
          // go on to standardize masked values into the lookup permanently —
          // the Snowflake-side bug found as DET-S09. Both warehouses must gate
          // identically; a guard that exists on one adapter only is not a guard.
          await flagPipelineMessage(
            pid,
            `Watched column "${p.column_name}" has a Dynamic Data Masking policy — standardization is skipped until it is removed.`,
            'warning',
            'policy_blocked',
          );
          touchLastPolled(pid, { claimSynced: false });
          return { checked: false, needsExportRefresh: false };
        }
        // Healthy: clear a masking/transient flag if one was set.
        if (p.status_message) await clearPipelineStatusMessage(pid);
        lastPollErrored.delete(pid);
      }

      // ── CT mode ──────────────────────────────────────────────────────────
      if (state.mode === 'ct') {
        if (!(await ctHasChanges(conn, p.table_fqn, state))) {
          touchLastPolled(pid);
          return { checked: true, needsExportRefresh: false };
        }
        const result = await ctConsume(conn, p.table_fqn, p.column_name, state);
        if (result.needsReconcile) {
          // Retention window expired — recover from the source: queue unknown
          // values now; already-mapped gap rows need the export rebuild
          // (Phase 5 on mssql). Do NOT claim synced while gaps may exist.
          console.warn(`[Poller/mssql] Pipeline ${pid}: CT retention window expired — running source reconcile`);
          const scan = await diffScan(conn, p.table_fqn, p.column_name);
          const unknown = await filterUnknownValues(conn, pid, p.domain_id, scan.values);
          if (unknown.length) await queueValues(conn, pid, unknown);
          saveState(pid, result.state);
          updateQueueMetric(pid, await getQueueSize(conn, pid));
          await updateSourceValueCount(conn, pid, p.table_fqn, p.column_name);
          touchLastPolled(pid, { claimSynced: false });
          return { checked: true, needsExportRefresh: true };
        }
        if (result.values.length) {
          // Route CT values through filterUnknownValues like the three
          // diff-scan call sites do (KI-106). Skipping it meant CT queued raw
          // values straight into a MERGE that matches on literal_value under
          // BIN2 (binary-exact), so a value already queued — or already MAPPED
          // in the lookup — under different casing was queued AGAIN as if new.
          // filterUnknownValues compares on the normalized form against both
          // the existing queue and the lookup, which is the same comparison the
          // rest of the system uses.
          const unknown = await filterUnknownValues(conn, pid, p.domain_id, result.values);
          if (unknown.length) await queueValues(conn, pid, unknown);
          console.log(
            `[Poller/mssql] Pipeline ${pid}: queued ${unknown.length} of ${result.values.length} value(s) ` +
            `from Change Tracking${result.sawDeletes ? ' (+deletes seen)' : ''}`,
          );
        }
        saveState(pid, result.state);
        updateQueueMetric(pid, await getQueueSize(conn, pid));
        // Parity with Snowflake: a live row count on every cycle that touched
        // CT changes (inserts AND deletes affect this), independent of
        // total_mapped which waits for the next standardization tick.
        await updateSourceValueCount(conn, pid, p.table_fqn, p.column_name);
        touchLastPolled(pid);
        return { checked: true, needsExportRefresh: result.sawDeletes };
      }

      // ── Diff mode ────────────────────────────────────────────────────────
      const passes = (state.passes_since_scan ?? 0) + 1;

      // Free heartbeat: skip everything when the table hasn't been written to.
      const beat = await diffHeartbeat(conn, p.table_fqn);
      const beatUsable = beat !== 'unavailable';

      // How often the tier says to actually read the source column.
      //
      // The stored tier is 1 (every pass) for any table under a million rows,
      // and `retuneScanTier` hands back 1 again for any scan that finishes in
      // under a second — which a small table always does. So the tier alone
      // NEVER defers on a small table.
      //
      // That is fine while the heartbeat works: an idle table is skipped above
      // for free, from server bookkeeping, without touching the table at all.
      // But the heartbeat needs VIEW SERVER STATE (VIEW DATABASE STATE on Azure
      // SQL DB), which the install script lists as OPTIONAL — so a customer who
      // declines it lands on a path where nothing defers anything, and Prism
      // runs a full distinct-scan of their column every single minute, forever,
      // on a table that may never change (DET-M08).
      //
      // Diff mode is already the least-privileged path (it's what runs when
      // Change Tracking isn't available), so this is exactly the installation
      // least likely to have granted the heartbeat DMV. Without the free idle
      // check we fall back to a paid one: scan at most every
      // DIFF_NO_HEARTBEAT_MIN_PASSES minutes. Detection latency rises to ~5 min
      // worst case, which the 10-minute standardization tick largely absorbs —
      // a value still normally reaches the queue before the tick that would
      // have exported it. Recurring load on a customer's production server is
      // the worse of the two costs.
      const scanEvery = beatUsable
        ? Math.max(1, state.scan_every ?? 1)
        : Math.max(DIFF_NO_HEARTBEAT_MIN_PASSES, state.scan_every ?? 1);

      if (beatUsable && state.heartbeat != null && beat === state.heartbeat) {
        saveState(pid, { ...state, passes_since_scan: passes });
        touchLastPolled(pid);
        return { checked: true, needsExportRefresh: false };
      }

      // Scan only when the tier says this pass is due.
      if (passes < scanEvery) {
        saveState(pid, { ...state, passes_since_scan: passes, heartbeat: beatUsable ? state.heartbeat ?? null : null });
        // Not consulted the source this pass — don't claim verified.
        touchLastPolled(pid, { claimSynced: false });
        return { checked: false, needsExportRefresh: false };
      }

      const scan = await diffScan(conn, p.table_fqn, p.column_name);
      if (scan.truncated) {
        console.warn(`[Poller/mssql] Pipeline ${pid}: diff scan truncated at cap — remaining values queue on later scans`);
      }
      const unknown = await filterUnknownValues(conn, pid, p.domain_id, scan.values);
      if (unknown.length) {
        await queueValues(conn, pid, unknown);
        console.log(`[Poller/mssql] Pipeline ${pid}: diff scan queued ${unknown.length} new value(s) (scan ${scan.durationMs}ms)`);
      }

      saveState(pid, {
        ...state,
        passes_since_scan: 0,
        heartbeat: beatUsable ? beat : null,
        last_scan_ms: scan.durationMs,
        scan_every: retuneScanTier(scan.durationMs, state.serverless ?? false),
      });
      updateQueueMetric(pid, await getQueueSize(conn, pid));
      // Parity with Snowflake: a live row count whenever a scan actually ran
      // (a scan is a real read of the source either way), independent of
      // total_mapped which waits for the next standardization tick.
      await updateSourceValueCount(conn, pid, p.table_fqn, p.column_name);
      // Deletes in diff mode surface via the hourly safety rebuild — a scan
      // proves the queue state but not row-level deletions, so a truncated or
      // delete-blind scan must not block the freshness stamp: queue-empty
      // semantics still hold (every KNOWN value standardized and exported).
      touchLastPolled(pid);
      return { checked: true, needsExportRefresh: false };
    });
  } catch (err) {
    const kind = classifyMssqlPollError(err);
    console.error(`[Poller/mssql] Pipeline ${pid} poll failed (${kind}):`, (err as any)?.message ?? err);
    if (kind === 'ct_reset') {
      // The table was almost certainly dropped and recreated (same name, new
      // object — Change Tracking registration is tied to the object, not the
      // name). The table itself is fine and readable, so this self-heals —
      // never pause. Clear the stored detection state so the NEXT poll
      // re-runs initDetection fresh (identical to a pipeline's first-ever
      // poll: re-checks the primary key, retries CT enablement per the
      // creator's consent, or falls back to diff). Reconcile RIGHT NOW too
      // (don't wait for that next pass) so any rows written during the gap
      // between the recreate and this failure aren't silently missed —
      // mirrors the Snowflake side's recoverAfterStreamReset.
      console.warn(`[Poller/mssql] Pipeline ${pid}: Change Tracking reset detected (table likely dropped/recreated) — reconciling and re-initializing detection`);
      getDb().prepare(`UPDATE pipelines SET detection_mode = NULL, detection_state = NULL WHERE pipeline_id = ?`).run(pid);
      healthCounters.delete(pid);
      try {
        await reconcileMssqlQueue({ pipeline_id: pid, table_fqn: p.table_fqn, column_name: p.column_name, domain_id: p.domain_id });
      } catch (reconcileErr) {
        console.warn(`[Poller/mssql] Pipeline ${pid}: reconcile after CT reset failed:`, (reconcileErr as any)?.message ?? reconcileErr);
      }
      lastPollErrored.delete(pid);
      touchLastPolled(pid, { claimSynced: false });
      return { checked: true, needsExportRefresh: true };
    }
    lastPollErrored.add(pid);
    if (kind === 'global') {
      broadcastGlobalAlert('SQL Server access interrupted (sign-in or database issue). Pipelines will resume automatically when it is restored.');
    } else if (kind === 'table') {
      await pausePipelineWithMessage(pid, `Prism can no longer access ${p.table_fqn} (permission revoked or object dropped). Fix access, then resume this pipeline.`).catch(() => {});
    }
    // transient: retry next minute mark
    return { checked: false, needsExportRefresh: false };
  }
}
