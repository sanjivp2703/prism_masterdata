/**
 * Server-side background pipeline poller.
 *
 * Uses a Snowflake APPEND_ONLY Stream per pipeline for change-data-capture.
 * Instead of a full DISTINCT scan + Redis diff, the stream tracks only new
 * INSERTs to the source table since the last poll.
 *
 * Stream lifecycle:
 *   • Created automatically (IF NOT EXISTS) on the first poll after a
 *     pipeline is activated — i.e. after the initial baseline run is done,
 *     so historical data is already mapped and won't appear as "new".
 *   • Consumed (offset advanced) each poll via a MERGE DML statement.
 *   • Dropped when the pipeline is deleted.
 */

import { withWarehouse, withUserWarehouse, hasUserWarehouseConfig, executeQuery as exec, getWarehouseAdapter, resolveSourceReference, describeRowsToColumns } from './warehouse';
import { pollOneMssqlPipeline } from './pipeline-poller-mssql';
import { pollOnePgPipeline } from './pipeline-poller-postgres';
import { pollOneMysqlPipeline } from './pipeline-poller-mysql';
import { getDb } from './sqlite';
import { isPipelineStandardizing } from './pipeline-coordination';
import { reconcilePipelineQueue } from './pipeline-hourly-processor';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { sqlStringLiteral } from './normalize';
import { internalObject, internalSchemaFqn, internalTable, prismNormalizeFn } from './warehouse-tables';
import { parseStoredSchedule, isScheduleActiveNow, type UpdateSchedule } from './update-schedule';
import { type ExportKind, asExportKind } from './export-kind';
import {
  pausePipelineWithMessage,
  clearPipelineStatusMessage,
  flagPipelineMessage,
  broadcastGlobalAlert,
} from './pipeline-alerts';

// Poll passes fire at every wall-clock multiple of this interval (minute marks).
const POLL_INTERVAL_MS = 60_000;

// Pipelines whose stream has been confirmed (this process) to be a standard,
// delete-aware stream — not a legacy APPEND_ONLY one.  Checked once per pipeline
// per process to avoid a SHOW STREAMS round-trip on every poll.
const verifiedStandardStreams = new Set<number>();

// ── Source-health check throttling ────────────────────────────────────────────
// checkSourceHealth's column check is a metadata-only SHOW COLUMNS (free), but
// its POLICY_REFERENCES probe still wakes the warehouse.  Run the check only
// every Nth cycle per pipeline — plus whenever the previous cycle errored, or
// a status_message is set (so 'skip' conditions like masking policies still
// auto-recover).  On skipped cycles the source is assumed healthy.
const HEALTH_CHECK_EVERY_N_CYCLES = 10;
// Cycles since checkSourceHealth last ran per pipeline; absent = never (check now).
const cyclesSinceHealthCheck = new Map<number, number>();
// Pipelines whose previous poll cycle errored — force a health check next cycle.
const lastPollErrored = new Set<number>();

// Backoff for re-checking a pipeline flagged unhealthy via status_message
// (masking / row-access 'skip' conditions).  Re-confirming an unchanged policy
// every cycle kept the warehouse permanently resumed; instead re-check after
// 2, 4, 8, ... cycles, capped at UNHEALTHY_RECHECK_MAX_CYCLES (~10 min at the
// 1-minute cadence), so policy removal is still picked up promptly.
const UNHEALTHY_RECHECK_MAX_CYCLES = 10;
const unhealthyRecheck = new Map<number, { streak: number; cyclesSinceCheck: number }>();

/** True when a status_message-forced re-check is due; otherwise counts the cycle. */
function unhealthyRecheckDue(pid: number): boolean {
  const s = unhealthyRecheck.get(pid);
  if (!s) return true; // no recorded unhealthy check (e.g. fresh process) — check now
  const gap = Math.min(2 ** s.streak, UNHEALTHY_RECHECK_MAX_CYCLES);
  if (s.cyclesSinceCheck + 1 >= gap) return true;
  s.cyclesSinceCheck++;
  return false;
}

function recordUnhealthyCheck(pid: number): void {
  const s = unhealthyRecheck.get(pid);
  unhealthyRecheck.set(pid, { streak: (s?.streak ?? 0) + 1, cyclesSinceCheck: 0 });
}

// File-based fallback metrics (static CSV/Excel rows) recompute cadence:
// every Nth 1-minute cycle ≈ every 10 minutes per pipeline.
const FILE_METRICS_EVERY_N_CYCLES = 10;
const fileMetricsCycleCounter = new Map<number, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function quoteIdent(ident: string) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  // Trim the WHOLE string, not each part.
  //
  // Per-part trimming silently rewrote any identifier with a genuine leading or
  // trailing space — a legal (if unpleasant) name both warehouses accept. The
  // poller then built SQL for a table that does not exist, stream creation
  // failed, and the pipeline was paused with "not found or not accessible — may
  // have been dropped, renamed, or access revoked" about a table that was
  // present and readable the whole time (DET-S10). A misleading diagnosis is
  // worse than the original problem: it sends the customer looking at
  // permissions and DDL history instead of at the name.
  //
  // Whitespace around a separator is genuinely ambiguous in an unquoted dotted
  // string — in `DB.S.TBL `, only the customer knows whether the table is named
  // `TBL` or `TBL `. Rather than guess, this preserves each part exactly and
  // trims only the whole string (which handles the common copy-paste case).
  //
  // KNOWN RESIDUAL LIMITATION, stated so nobody assumes otherwise: a table whose
  // real name ENDS in a space (or a database whose name STARTS with one) still
  // loses it, because that character sits at the FQN boundary and is
  // indistinguishable from copy-paste whitespace. Live-reproduced with a table
  // literally named `DETS10Z TRAIL SRC2 ` (DET-S10). Interior spaces —
  // `DB.S.MY TABLE`, or a space after a separator — are preserved correctly,
  // which covers every realistic case; a trailing space in a table name is
  // pathological and unrepresentable here without requiring quoted input.
  //
  // The failure is now at least benign: the name resolves to the un-spaced
  // table, so the poller either finds a real table or reports a genuine
  // not-found — it no longer mangles a name and then blames the customer for
  // dropping a table that exists. Fixing it properly means accepting quoted
  // FQNs (`DB.S."TBL "`) end to end, which touches every warehouse path.
  // Preserving is the safe direction: the parts are wrapped in quoteIdent
  // before they reach SQL, so a genuinely-spaced name now resolves, and a name
  // that never had a space is unaffected.
  // Whole string trimmed (copy-paste whitespace), parts preserved VERBATIM.
  const parts = String(fqn).trim().split('.');
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
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

/** last_polled_at lives on the SQLite pipelines row now.
 *  A check that finds nothing pending also advances fully_synced_at — the
 *  customer-facing "standardized table verified fully up to date" timestamp
 *  (queue empty ⇒ every known value is already standardized and exported).
 *  Only call this from paths that GENUINELY consulted the source; pass
 *  `claimSynced: false` from stream-reset/recovery paths, where gap rows may
 *  exist that the freshly-created stream never saw (recovery re-stamps once
 *  the export rebuild lands). */
function touchLastPolled(pipelineId: number, opts: { claimSynced?: boolean } = {}): void {
  const { claimSynced = true } = opts;
  const syncedClause = claimSynced
    ? `fully_synced_at = CASE WHEN queue_size = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE fully_synced_at END,`
    : '';
  getDb()
    .prepare(
      `UPDATE pipelines
       SET last_polled_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           ${syncedClause}
           updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE pipeline_id = ?`,
    )
    .run(pipelineId);
}

/** Fully-qualified name of the stream for a given pipeline (unquoted — safe because pipeline_id is always a positive integer). */
function streamFqn(pipeline_id: number): string {
  return internalObject(`PIPELINE_STREAM_${pipeline_id}`);
}

/**
 * Creating the FIRST stream on a table auto-enables change tracking, which
 * requires MODIFY on the table — the service role typically has only SELECT.
 * Snowflake's error: "Insufficient privileges to operate on stream source
 * without CHANGE_TRACKING enabled '<table>'. Your primary role ... must have
 * MODIFY granted ...". This is a persistent, user-fixable condition (enable
 * change tracking, or grant MODIFY) — pause with instructions, never retry-loop.
 */
export function isChangeTrackingPrivilegeError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? '');
  return /CHANGE_TRACKING/i.test(msg) && /privileg|MODIFY/i.test(msg);
}

/** The pause/flag message when change tracking can't be enabled automatically. */
export function changeTrackingFixMessage(tableFqn: string): string {
  return (
    `Prism can't watch ${tableFqn} for changes: change tracking is not enabled on the table and the service role can't enable it. ` +
    `Run in Snowflake as the table owner or an admin: ALTER TABLE ${tableFqn} SET CHANGE_TRACKING = TRUE; then resume this pipeline. ` +
    `(Alternatively: GRANT MODIFY ON TABLE ${tableFqn} TO ROLE PRISM_SERVICE; or save your own Snowflake credentials in Setup so Prism can enable it for you.)`
  );
}

// Change-tracking auto-fix attempts in flight, per pipeline — the fix is
// fire-and-forget (it opens its own connections; never nest inside the poll
// cycle's connection), so consecutive poll cycles must not double-start it.
const ctFixInFlight = new Set<number>();

/**
 * Try to unblock a source table whose first stream can't be created because
 * change tracking is off: enable it using the PIPELINE CREATOR'S saved
 * personal Snowflake credentials (the same mechanism the one-time flow uses
 * for access the service role lacks — creators typically own or can modify
 * the tables they connect), then create the stream with the service
 * connection and run gap recovery. Falls back to pausing the pipeline with
 * the exact fix SQL when the creator has no saved credentials or the ALTER
 * fails.
 */
function attemptChangeTrackingFix(p: PipelineRef): void {
  const pid = p.pipeline_id;
  if (ctFixInFlight.has(pid)) return;
  ctFixInFlight.add(pid);
  (async () => {
    let tableRef: string;
    let fqnParts: { db: string; schema: string; table: string };
    try {
      fqnParts = parseFqn(p.table_fqn);
      tableRef = `${quoteIdent(fqnParts.db)}.${quoteIdent(fqnParts.schema)}.${quoteIdent(fqnParts.table)}`;
    } catch {
      return; // unparseable FQN — the poll cycle itself already reports this
    }
    const createdByRaw = (getDb()
      .prepare(`SELECT created_by FROM pipelines WHERE pipeline_id = ?`)
      .get(pid) as any)?.created_by;
    const createdBy = createdByRaw != null ? Number(createdByRaw) : null;

    if (createdBy != null && (await hasUserWarehouseConfig(createdBy))) {
      try {
        await withUserWarehouse(createdBy, async (conn) => {
          await exec(conn, `ALTER TABLE ${tableRef} SET CHANGE_TRACKING = TRUE`);
        });
        await withWarehouse(async (conn) => {
          // Reference-granted source (native): the app addresses it via
          // reference('source_table','<alias>'), never the FQN.
          const srcRef = (await resolveSourceReference(conn, fqnParts))?.refSql ?? tableRef;
          await exec(conn, `CREATE STREAM IF NOT EXISTS ${streamFqn(pid)} ON TABLE ${srcRef}`);
        });
        verifiedStandardStreams.add(pid);
        console.log(`[Poller] Pipeline ${pid}: enabled change tracking on ${p.table_fqn} using the creator's saved credentials — stream created, recovering gap rows`);
        await clearPipelineStatusMessage(pid).catch(() => {});
        recoverAfterStreamReset(p);
        return;
      } catch (fixErr: any) {
        console.warn(`[Poller] Pipeline ${pid}: automatic change-tracking fix failed:`, fixErr?.message ?? fixErr);
      }
    }
    await pausePipelineWithMessage(pid, changeTrackingFixMessage(p.table_fqn)).catch(() => {});
    invalidateActivePipelinesCache();
  })().finally(() => ctFixInFlight.delete(pid));
}

// SHOW COLUMNS reports VARCHAR/CHAR/STRING all as type 'TEXT' in its data_type JSON.
const STRING_DATA_TYPES = new Set(['TEXT']);

type SourceHealth =
  | { ok: true }
  // `reason` is the machine-readable counterpart to `message` — see
  // PIPELINE_BLOCK_REASONS in pipeline-alerts.ts. A 'skip' that carries a
  // blocking reason halts the standardization tick and sweep as well, not just
  // this poll cycle's queuing.
  | { ok: false; action: 'pause' | 'skip'; message: string; reason?: string };

/**
 * Pre-flight check before each poll: verify the source table + watched column
 * still exist, the column is still a text type, and no masking/row-access policy
 * is filtering what the service role reads.  Returns a 'pause' action for
 * persistent problems (dropped/renamed/revoked/wrong-type) and a 'skip' action
 * for policy conditions that should halt standardization but auto-recover.
 */
async function checkSourceHealth(
  connection: any,
  db: string, schema: string, table: string, columnName: string, tableFqn: string,
  srcRefSql?: string | null,
): Promise<SourceHealth> {
  // SHOW COLUMNS is a metadata-layer command — unlike a SELECT against
  // INFORMATION_SCHEMA.COLUMNS it never wakes the warehouse.  (The old
  // INFORMATION_SCHEMA query was the account's single most expensive query:
  // each run resumed the warehouse for a 60 s billing minimum, and on forced
  // every-cycle checks it kept the warehouse resumed around the clock.)
  // A missing/inaccessible table THROWS here instead of returning zero rows.
  //
  // Reference-granted source (native edition, srcRefSql set): the app has no
  // FQN visibility at all, so SHOW COLUMNS on the FQN would report a healthy
  // table as "not found". DESCRIBE TABLE reference(...) is the documented
  // reference-path equivalent (also metadata-layer); its rows are mapped to
  // the SHOW COLUMNS shape so everything below is shared.
  let colRows: any[];
  try {
    if (srcRefSql) {
      const descRows = await exec(connection, `DESCRIBE TABLE ${srcRefSql}`);
      colRows = describeRowsToColumns(descRows).map((c) => ({
        column_name: c.name,
        data_type: JSON.stringify({ type: c.typeToken }),
      }));
    } else {
      colRows = await exec(
        connection,
        `SHOW COLUMNS IN TABLE ${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`,
      );
    }
  } catch (e: any) {
    if (/does not exist|not authorized/i.test(String(e?.message ?? e))) {
      return {
        ok: false, action: 'pause',
        message: srcRefSql
          ? `Source table ${tableFqn} is not reachable through the app's granted reference — it may have been dropped, renamed, or removed from the app's Security tab. Re-add the table there (or grant it with SQL), then resume.`
          : `Source table ${tableFqn} not found or not accessible — it may have been dropped, renamed, or access was revoked. Fix the source or update the pipeline, then resume.`,
      };
    }
    throw e; // other errors → outer poll-error classification (transient/global)
  }

  const watched = colRows.find((r: any) =>
    String(r.column_name ?? r.COLUMN_NAME ?? '').toUpperCase() === columnName.toUpperCase());
  if (!watched) {
    return {
      ok: false, action: 'pause',
      message: `Watched column "${columnName}" no longer exists on ${tableFqn} — it may have been dropped or renamed. Update the pipeline, then resume.`,
    };
  }

  // SHOW COLUMNS returns data_type as a JSON blob, e.g. {"type":"TEXT",...}.
  const rawType = String((watched as any).data_type ?? (watched as any).DATA_TYPE ?? '');
  let dataType: string;
  try {
    dataType = String(JSON.parse(rawType)?.type ?? '').toUpperCase();
  } catch {
    dataType = rawType.toUpperCase(); // defensive: treat as plain type name
  }
  if (!STRING_DATA_TYPES.has(dataType)) {
    return {
      ok: false, action: 'pause',
      message: `Watched column "${columnName}" is type ${dataType || 'unknown'} — standardization needs a text column. Paused until it is a text type again.`,
    };
  }

  // Masking / row-access policy detection (best-effort; unavailable on some editions).
  //
  // Reference-path limitation: this probe queries the SOURCE DATABASE's
  // INFORMATION_SCHEMA, which needs USAGE on that database — a reference
  // grants none. On a reference-only source it therefore fails and lands in
  // the catch below (warn + skip), i.e. masking/row-access detection is
  // unavailable for tables granted solely through the permission UI. The
  // direct-grant SQL path keeps it.
  //
  // REF_ENTITY_NAME must carry QUOTED identifier parts. Snowflake resolves the
  // name inside this string as an identifier, so an unquoted one is case-folded
  // to upper case before lookup — meaning any source table whose real name is
  // not already all-upper-case simply failed to resolve, and policy detection
  // was silently skipped for it (console.warn only: no pause, no
  // status_message, no flag). That is a safety guard quietly not running on a
  // large fraction of real tables, which is how a masked column could keep
  // being standardized. Live-reproduced both ways: an ALL-CAPS name containing
  // a space resolved fine, while a mixed-case name with no space at all did
  // not. CLAUDE.md previously blamed spaces; the real trigger is case-folding,
  // and it is strictly broader.
  //
  // sqlStringLiteral escapes the quoted name for embedding in the SQL string
  // literal, so a name containing a quote or backslash cannot break out of it.
  const policyEntityName = sqlStringLiteral(
    `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`,
  );
  try {
    const polRows = await exec(
      connection,
      `SELECT POLICY_KIND, REF_COLUMN_NAME
       FROM TABLE(${quoteIdent(db)}.INFORMATION_SCHEMA.POLICY_REFERENCES(
         REF_ENTITY_NAME => '${policyEntityName}',
         REF_ENTITY_DOMAIN => 'TABLE'))`,
    );
    for (const r of polRows) {
      const kind = String((r as any).POLICY_KIND ?? (r as any).policy_kind ?? '').toUpperCase();
      const col  = String((r as any).REF_COLUMN_NAME ?? (r as any).ref_column_name ?? '');
      if (kind.includes('MASKING') && col.toUpperCase() === columnName.toUpperCase()) {
        return {
          ok: false, action: 'skip', reason: 'policy_blocked',
          message: `Watched column "${columnName}" has a masking policy — standardization skipped to avoid mapping masked values. Resumes automatically when the policy is removed.`,
        };
      }
      if (kind.includes('ROW_ACCESS')) {
        return {
          ok: false, action: 'skip', reason: 'policy_blocked',
          message: `Source table has a row access policy — standardization skipped because the service role may see only a filtered subset. Resumes automatically when the policy is removed.`,
        };
      }
    }
  } catch (polErr: any) {
    console.warn(`[Poller] POLICY_REFERENCES check skipped for ${tableFqn}:`, polErr?.message ?? polErr);
  }

  return { ok: true };
}

/**
 * Classify a poll error so we react correctly:
 *   'global'    — account-wide infra (expired key, disabled user, suspended/no-credit
 *                 warehouse). Surface a banner; do NOT pause individual pipelines.
 *   'pipeline'  — this table's access is gone (revoked / not authorized). Pause it.
 *   'transient' — anything else (network blip, unknown). Log and retry next poll.
 */
function classifyPollError(e: any): 'global' | 'pipeline' | 'transient' {
  const msg = String(e?.message ?? e ?? '').toLowerCase();
  if (/jwt|authenticat|incorrect username|password|user is disabled|disabled user|invalid.*credential|token is expired|expired token/.test(msg)) return 'global';
  if (/warehouse|no active warehouse|cannot be resumed|exceeded.*(credit|quota)|out of credit/.test(msg)) return 'global';
  if (/read-only|secondary database|replication/.test(msg)) return 'global';
  if (/insufficient privileges|not authorized|unauthorized|does not exist/.test(msg)) return 'pipeline';
  // Stream-side phrasing for the SAME condition. When SELECT is revoked on a
  // source table that already has a stream, Snowflake does not say "not
  // authorized" — it reports the base table as dropped: "Base table ...
  // dropped, cannot read from stream ...". Without this pattern that message
  // fell through to 'transient', so a permanent access revocation was retried
  // forever instead of pausing the pipeline with a message (DET-S12, matched
  // against error strings captured live from a real REVOKE).
  if (/cannot read from stream|base table .*(dropped|altered)|stream .*(is stale|became stale)/.test(msg)) return 'pipeline';
  return 'transient';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRef {
  pipeline_id:      number;
  table_fqn:        string;
  column_name:      string;
  domain_id:        number | null;
  export_table_fqn: string | null;
  export_kind:      ExportKind;
  update_schedule:  UpdateSchedule;
  status_message:   string | null;
  // mssql only — consent to Prism attempting to enable Change Tracking
  // automatically (schema-modifying DDL); see pipeline-poller-mssql.ts.
  change_tracking_consent: boolean;
  // mssql only — source reads run on the CREATOR's personal credentials
  // (see pipeline-user-connection.ts); internal state stays on the service
  // connection. Always false on other warehouses.
  use_user_connection: boolean;
  created_by: number | null;
  // Raw passthrough: unmapped rows appear in the export with their raw
  // values. When ON, newly detected values also trigger an export rebuild
  // the same cycle (finding #17) so they show up as-is immediately instead
  // of waiting invisible until the tick standardizes them.
  export_unmapped_rows: boolean;
}

/**
 * Recover from a stream offset reset (one-time APPEND_ONLY→standard upgrade, or
 * a stale-stream recreate).  The fresh stream only emits FUTURE changes, so any
 * rows that arrived in the gap must be recovered from the source directly:
 *   • reconcile queues UNMAPPED values for standardization, and
 *   • a full export rebuild reflects ALREADY-MAPPED rows — which reconcile skips,
 *     so without this they'd linger out of the export until the next refresh
 *     trigger (the bug behind "an already-mapped value took several polls to
 *     show up" right after the stream was upgraded).
 * Both run fire-and-forget on their own connections.
 */
function recoverAfterStreamReset(p: PipelineRef): void {
  // Reconcile FIRST, then refresh — these used to be two independent
  // fire-and-forget promises racing each other, and the order matters for one
  // specific reason.
  //
  // `refreshExportTable`'s metric UPDATE stamps `fully_synced_at` whenever the
  // SQLite `queue_size` mirror reads 0. Started in parallel, the refresh could
  // read that mirror BEFORE reconcile had queued the gap rows it was in the
  // middle of finding — so the pipeline stamped "verified up to date" while
  // unqueued unmapped values were still outstanding, and the card said so.
  // Self-correcting on the next cycle, but wrong in the window, and this is the
  // one path whose whole job is recovering rows the stream never reported.
  // Found independently by two live test runs (OPS-07A and DET-S12).
  //
  // Awaiting reconcile costs nothing here: the caller already treats this whole
  // function as background work.
  void (async () => {
    try {
      await reconcilePipelineQueue(p);
    } catch (e) {
      console.error(`[Poller] Pipeline ${p.pipeline_id}: gap reconciliation after stream reset failed:`, e);
      // Fall through to the refresh anyway — a failed reconcile must not also
      // cost the export rebuild that already-mapped gap rows depend on.
    }
    try {
      // A view has no gap to backfill — it's always live — so only a table export
      // needs the full rebuild here; metrics still need recomputing either way.
      await ((p.export_table_fqn && p.export_kind !== 'view')
        ? refreshExportTable(p.table_fqn, p.column_name, p.export_table_fqn, p.domain_id, p.pipeline_id, p.export_kind)
        : updatePipelineMappedCount(p.table_fqn, p.column_name, p.domain_id, p.pipeline_id));
      broadcastPipelineEvent({ type: 'metrics_updated' });
    } catch (e) {
      console.error(`[Poller] Pipeline ${p.pipeline_id}: export refresh after stream reset failed:`, e);
    }
  })();
}

// ── Fetch active pipelines ────────────────────────────────────────────────────

// Short-lived in-module cache shared by the supervisor tick (15 s) and every
// per-table poll loop — without it each of them ran a full PIPELINES scan on a
// fresh connection.  Invalidated whenever the poller itself changes a pipeline's
// status (pause), so a just-paused pipeline isn't polled again off stale data.
const ACTIVE_PIPELINES_CACHE_TTL_MS = 10_000;
let activePipelinesCache: { fetchedAt: number; pipelines: PipelineRef[] } | null = null;

function invalidateActivePipelinesCache(): void {
  activePipelinesCache = null;
}

async function fetchActivePipelines(): Promise<PipelineRef[]> {
  if (activePipelinesCache && Date.now() - activePipelinesCache.fetchedAt < ACTIVE_PIPELINES_CACHE_TTL_MS) {
    return activePipelinesCache.pipelines;
  }
  try {
    const pipelines = await (async () => {
      const rows = getDb()
        .prepare(
          `SELECT pipeline_id, table_fqn, column_name, domain_id, export_table_fqn, export_kind, update_schedule, status_message,
                  change_tracking_consent, use_user_connection, created_by, export_unmapped_rows
           FROM pipelines
           WHERE status = 'active'`,
        )
        .all() as any[];
      return rows.map(r => ({
        pipeline_id:      Number(r.pipeline_id),
        table_fqn:        String(r.table_fqn    ?? ''),
        column_name:      String(r.column_name  ?? ''),
        domain_id:        r.domain_id != null ? Number(r.domain_id) : null,
        export_table_fqn: r.export_table_fqn ?? null,
        export_kind:      asExportKind(r.export_kind),
        update_schedule:  parseStoredSchedule(r.update_schedule),
        status_message:   r.status_message ?? null,
        change_tracking_consent: r.change_tracking_consent === 1,
        use_user_connection: r.use_user_connection === 1,
        created_by: r.created_by != null ? Number(r.created_by) : null,
        export_unmapped_rows: r.export_unmapped_rows === 1 || r.export_unmapped_rows === true,
      }));
    })();
    activePipelinesCache = { fetchedAt: Date.now(), pipelines };
    return pipelines;
  } catch (e) {
    console.error('[Poller] Failed to fetch active pipelines:', e);
    // A global infra failure (expired key / suspended warehouse) breaks even this
    // metadata query — surface a banner so the UI explains why nothing is polling.
    if (classifyPollError(e) === 'global') {
      broadcastGlobalAlert(
        'Snowflake access interrupted (sign-in or warehouse issue). Pipelines will resume automatically when it is restored.',
      );
    }
    return [];
  }
}

// ── Public: drop stream (call when pipeline is deleted) ───────────────────────

export async function dropPipelineStream(pipeline_id: number): Promise<void> {
  try {
    await withWarehouse(async (conn) => {
      await exec(conn, `DROP STREAM IF EXISTS ${streamFqn(pipeline_id)}`);
    });
    console.log(`[Poller] Dropped stream for pipeline ${pipeline_id}`);
  } catch (e) {
    // Non-fatal — log and continue
    console.warn(`[Poller] Could not drop stream for pipeline ${pipeline_id}:`, e);
  }
}

// ── Poll one pipeline ─────────────────────────────────────────────────────────
//
// Each poll cycle:
//   1. Non-consuming SELECT classifies new stream values into:
//        list A — value already has a confirmed mapping (no LLM needed)
//        list B — value is new / unmapped (needs standardization)
//      (the split is informational — for logs; both lists are queued)
//   2. Consuming MERGE: ALL new values (list A + list B) → PIPELINE_QUEUE
//      (accumulates frequency for values already queued from prior polls)
//   3. COUNT(*) source table → total_source_values; queue_size updated
//   4. That's it — the poller never standardizes. The queue drains at the next
//      10-minute wall-clock tick (startQueueProcessor): lookup hits map for
//      free, unmatched values go to the LLM, then ONE export rebuild publishes
//      everything together and total_mapped is recomputed from source.
//
// The export table is therefore always a consistent snapshot as of its last
// standardization pass — new values (even already-known ones) never trickle in
// mid-cycle. Unstandardized is derived in the UI: total_source_values − total_mapped.

export interface PollResult {
  /** True when this cycle's changes require the pipeline's EXPORT TABLE to be
   *  rebuilt (only ever set for pipelines with an export_table_fqn). When polling
   *  as part of a table batch (deferStandardization), the rebuild is deferred to
   *  the caller, which performs AT MOST ONE refreshExportTable per distinct
   *  export_table_fqn for the whole table — sibling columns share one export, so
   *  per-column rebuilds were identical back-to-back full rebuilds. */
  needsExportRefresh: boolean;
  /** True when this cycle actually consulted the source (stream checked and,
   *  if it had data, classified + queued). False on any skip/early-error —
   *  the caller must NOT stamp fully_synced_at for an unchecked pipeline. */
  checked: boolean;
}

export async function pollOnePipeline(
  p: PipelineRef,
  opts: { deferStandardization?: boolean } = {},
): Promise<PollResult> {
  if (isPipelineStandardizing(p.pipeline_id)) {
    // Loudly, not silently: a leaked standardizing lock once starved a pipeline
    // of polling forever with zero log output — keep this visible.
    console.log(`[Poller] Pipeline ${p.pipeline_id}: standardization in progress — skipping this poll cycle`);
    return { needsExportRefresh: false, checked: false };
  }

  const { pipeline_id, table_fqn, column_name, domain_id } = p;
  const pid = pipeline_id;

  let db: string, schema: string, table: string;
  try {
    const fqn = parseFqn(table_fqn);
    db = fqn.db; schema = fqn.schema; table = fqn.table;
  } catch (e) {
    console.error(`[Poller] Pipeline ${pid}: invalid table_fqn "${table_fqn}":`, e);
    return { needsExportRefresh: false, checked: false };
  }

  if (!isSimpleIdent(db) || !isSimpleIdent(schema) || !isSimpleIdent(table) || !isSimpleIdent(column_name)) {
    console.error(`[Poller] Pipeline ${pid}: table/column contains unsupported characters.`);
    return { needsExportRefresh: false, checked: false };
  }

  const tableRef  = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colRef    = quoteIdent(column_name);
  const streamRef = streamFqn(pid);

  // Used in LEFT JOINs with LITERAL_ALIAS_MATCHES to scope by domain
  const domainJoinCond = domain_id != null
    ? `AND lam.domain_id = ${Number(domain_id)}`
    : `AND lam.domain_id IS NULL`;

  // Hoisted out of withWarehouse so the export rebuild opens a fresh top-level
  // connection — no nested withWarehouse contention.
  interface ClassifiedRow { literal_value: string; new_row_count: number; already_mapped: boolean }
  let listA:              ClassifiedRow[] = [];
  let hasDeletes          = false;
  let hasNullInserts      = false;   // new rows with a NULL in this column — exported as-is (NULL passthrough)
  let newRowsQueued       = false;   // any new values queued this cycle (raw-passthrough rebuild trigger)
  let needsExportRefresh  = false;   // export-table rebuild required this cycle (see step 8)
  let sourceChecked       = false;   // the stream/source was genuinely consulted this cycle
  // Set when this cycle deliberately flags the pipeline for a forced health
  // check. Load-bearing: the `return`s inside the withWarehouse callback below
  // only exit the CALLBACK, so control still reaches the
  // `lastPollErrored.delete(pid)` at the end of the try — which erased the very
  // flag the cycle had just set. A dropped/renamed/revoked source table
  // therefore never triggered the next cycle's health check and the pipeline
  // stayed 'active' with no status_message forever (live-reproduced over nine
  // cycles and a process restart). See KI-92 / KI-100.
  let cycleErrored        = false;

  try {
    await withWarehouse(async (connection) => {

      // Native edition: a source granted through the permission UI (manifest
      // reference) is addressable ONLY as reference('source_table','<alias>').
      // Resolve once per cycle; null everywhere else, so srcRef === tableRef
      // and nothing changes. (Metadata-layer + 30 s cache — idle cycles stay
      // warehouse-free.)
      const srcRefSql = (await resolveSourceReference(connection, { db, schema, table }))?.refSql ?? null;
      const srcRef = srcRefSql ?? tableRef;

      // ── Pre-flight: source table / column / type / policy health ──────────
      // Catches dropped/renamed/revoked tables, dropped/renamed or non-text
      // columns, and masking/row-access policies BEFORE we touch the stream.
      //
      // IDLE-CYCLE DISCIPLINE (warehouse cost): the health check's
      // POLICY_REFERENCES probe can wake the warehouse (its column check is a
      // metadata-only SHOW COLUMNS). It therefore runs immediately only when
      // FORCED (previous cycle errored, or a status_message is set — 'skip'
      // conditions like masking policies re-check on an exponential backoff,
      // ≤ ~5 min, until they clear). The routine every-N-cycles
      // check runs further down, only on cycles where the stream HAS data —
      // i.e. cycles that were going to wake the warehouse anyway. Idle cycles
      // stay warehouse-free: SYSTEM$STREAM_HAS_DATA, SHOW STREAMS, and
      // CREATE STREAM IF NOT EXISTS are all metadata-layer operations.
      // A dropped/renamed source still gets caught promptly: the stream
      // operations below throw for a missing table, which sets
      // lastPollErrored and forces the health check on the next cycle.
      const runHealthCheck = async (): Promise<boolean> => {
        const health = await checkSourceHealth(connection, db, schema, table, column_name, table_fqn, srcRefSql);
        if (!health.ok) {
          // Unhealthy — make sure the check runs again next data-bearing cycle,
          // and start/extend the forced-recheck backoff (auto-recovery).
          cyclesSinceHealthCheck.set(pid, HEALTH_CHECK_EVERY_N_CYCLES);
          if (health.action === 'pause') {
            unhealthyRecheck.delete(pid); // paused pipelines stop polling — resume starts fresh
            await pausePipelineWithMessage(pid, health.message);
            invalidateActivePipelinesCache(); // status changed — don't poll it off stale data
          } else {
            // 'skip' — keep polling (auto-recovers), just don't standardize this cycle.
            recordUnhealthyCheck(pid);
            // Pass the machine-readable reason through: a 'skip' condition must
            // block the standardization tick and the sweep too, not just this
            // poll cycle's queuing (they read status_reason, never the prose).
            await flagPipelineMessage(pid, health.message, 'warning', health.reason ?? null);
          }
          touchLastPolled(pid);
          return false;
        }
        cyclesSinceHealthCheck.set(pid, 0);
        unhealthyRecheck.delete(pid);
        // Source is healthy — clear any stale block message from a prior cycle.
        // Only when one is actually set, so healthy pipelines skip the extra write.
        if (p.status_message) await clearPipelineStatusMessage(pid);
        return true;
      };

      // Forced health checks: an errored previous cycle re-checks immediately;
      // a persistent status_message re-checks on the exponential backoff above
      // instead of every cycle (POLICY_REFERENCES wakes the warehouse).
      const forcedHealthCheck = lastPollErrored.has(pid) || p.status_message != null;
      if (forcedHealthCheck) {
        if (!lastPollErrored.has(pid) && !unhealthyRecheckDue(pid)) {
          touchLastPolled(pid);
          return; // still in backoff — assume unchanged, re-check in a later cycle
        }
        if (!(await runHealthCheck())) return;
      }

      // ── Ensure stream exists and is valid ─────────────────────────────────
      // A standard (NOT append-only) stream captures inserts, updates, AND
      // deletes.  Once per process per pipeline, check existence + mode via
      // SHOW STREAMS (metadata-layer, free):
      //   • MISSING — the stream was never created (initial-run pre-create
      //     failed) or was dropped. Rows inserted while it didn't exist are
      //     INVISIBLE to a fresh stream, so creating one is a gap: create it,
      //     then run full gap recovery — unmapped values are queued for the
      //     next standardization tick, already-mapped rows go straight into
      //     the export via a rebuild (with metrics recounted). Never silently
      //     CREATE IF NOT EXISTS without recovery — that loses the gap rows
      //     until the hourly safety rebuild.
      //   • APPEND_ONLY — legacy stream from before delete detection; upgrade
      //     to a standard stream (offset resets ⇒ same gap recovery).
      //   • Standard — verified; later cycles skip straight to the data check
      //     (a stream dropped mid-process makes SYSTEM$STREAM_HAS_DATA throw,
      //     and that path recreates + recovers).
      if (!verifiedStandardStreams.has(pid)) {
        let streamRows: any[] | null = null;
        try {
          streamRows = await exec(connection,
            `SHOW STREAMS LIKE 'PIPELINE_STREAM_${pid}' IN SCHEMA ${internalSchemaFqn()}`);
        } catch (showErr: any) {
          // SHOW STREAMS failed (privileges / transient) — non-fatal; the
          // SYSTEM$STREAM_HAS_DATA check below still catches a missing stream.
          console.warn(`[Poller] Pipeline ${pid}: could not verify stream:`, showErr?.message ?? showErr);
        }
        if (streamRows && streamRows.length === 0) {
          try {
            await exec(connection, `
              CREATE STREAM IF NOT EXISTS ${streamRef}
              ON TABLE ${srcRef}`);
          } catch (e: any) {
            console.error(`[Poller] Pipeline ${pid}: failed to create stream:`, e?.message ?? e);
            if (isChangeTrackingPrivilegeError(e)) {
              // Creating the FIRST stream on a table auto-enables change
              // tracking, which needs MODIFY — the service role typically has
              // only SELECT. The source-health check can't catch this (SELECT
              // works fine), so this must never fail invisibly. Try the
              // automatic fix (creator's saved credentials); fire-and-forget on
              // its own connections — it pauses with the exact fix SQL if it
              // can't unblock the table.
              attemptChangeTrackingFix(p);
              return;
            }
            // Likely a dropped/renamed/revoked source table — force the health
            // check next cycle so the pipeline pauses with a clear message
            // instead of erroring silently every cycle.
            lastPollErrored.add(pid);
            cycleErrored = true;   // must survive to the end-of-cycle delete
            return;
          }
          verifiedStandardStreams.add(pid);
          console.log(`[Poller] Pipeline ${pid}: stream was missing — created it and recovering gap rows (unmapped → queue, mapped → export)`);
          touchLastPolled(pid, { claimSynced: false });
          recoverAfterStreamReset(p);
          return; // fresh stream has nothing to read this cycle
        }
        if (streamRows && streamRows.length > 0) {
          const mode = String((streamRows[0] as any).mode ?? (streamRows[0] as any).MODE ?? '').toUpperCase();
          if (mode === 'APPEND_ONLY') {
            await exec(connection, `CREATE OR REPLACE STREAM ${streamRef} ON TABLE ${srcRef}`);
            verifiedStandardStreams.add(pid);
            console.log(`[Poller] Pipeline ${pid}: upgraded APPEND_ONLY stream to standard (delete-aware)`);
            touchLastPolled(pid, { claimSynced: false });
            // Offset was reset — recover gap rows (unmapped → queue, mapped → export).
            recoverAfterStreamReset(p);
            return;
          }
          verifiedStandardStreams.add(pid);
        }
      }

      // ── Quick non-consuming check ─────────────────────────────────────────
      let hasData = false;
      try {
        const [row] = await exec(connection,
          `SELECT SYSTEM$STREAM_HAS_DATA('${streamRef}') AS has_data`);
        const val = row?.HAS_DATA ?? row?.has_data;
        hasData = val === true || String(val).toUpperCase() === 'TRUE';
      } catch (e: any) {
        // Stream is stale (base table was dropped/recreated, or stream is broken).
        // Drop it and recreate against the current table so the next poll cycle
        // starts detecting inserts correctly.
        console.warn(`[Poller] Pipeline ${pid}: STREAM_HAS_DATA failed (${e?.message ?? e}) — recreating stream`);
        let streamRecreated = false;
        try {
          await exec(connection, `DROP STREAM IF EXISTS ${streamRef}`);
          await exec(connection, `
            CREATE STREAM IF NOT EXISTS ${streamRef}
            ON TABLE ${srcRef}`);
          verifiedStandardStreams.add(pid); // freshly created → already standard
          streamRecreated = true;
          console.log(`[Poller] Pipeline ${pid}: stream recreated — new inserts will be detected on next poll`);
        } catch (recreateErr: any) {
          console.error(`[Poller] Pipeline ${pid}: failed to recreate stream:`, recreateErr?.message ?? recreateErr);
          if (isChangeTrackingPrivilegeError(recreateErr)) {
            // The base table was likely recreated (CREATE OR REPLACE wipes
            // change tracking). Try the automatic fix; it pauses with the
            // exact fix SQL if it can't unblock the table.
            attemptChangeTrackingFix(p);
            return;
          }
          // ANY OTHER recreate failure — most importantly a DROPPED or renamed
          // source table — must force next cycle's health check so the pipeline
          // pauses with a real reason. Without this the failure was logged and
          // then forgotten: live-reproduced with a real DROP TABLE, where five
          // consecutive cycles (and a full process restart) left the pipeline
          // 'active' with status_message NULL, silently detecting nothing.
          // See KI-100.
          lastPollErrored.add(pid);
          cycleErrored = true;
        }
        touchLastPolled(pid, { claimSynced: false });

        // Dropping the stream discards its unconsumed offset, so any rows that
        // arrived while it was stale (e.g. during a long pause, or before a
        // transient error) would otherwise be lost — the fresh stream only emits
        // changes from here on.  Recover that gap from the source directly:
        // unmapped values are re-queued, already-mapped rows are picked up by the
        // export rebuild.  Runs on its own connection after this one's work.
        if (streamRecreated) {
          recoverAfterStreamReset(p);
        }
        return;
      }

      if (!hasData) {
        // Nothing new — any queued backlog waits for the next 10-minute
        // standardization tick (the poller no longer standardizes inline).
        // Idle cycles stay warehouse-free.
        sourceChecked = true;
        touchLastPolled(pid);
        console.log(`[Poller] Pipeline ${pid}: no new rows in stream`);
        return;
      }

      console.log(`[Poller] Pipeline ${pid}: stream has data — classifying (table: ${table_fqn}, col: ${column_name})`);

      // Routine (throttled) health check — only on data-bearing cycles, which
      // wake the warehouse anyway. Forced checks already ran above.
      if (!forcedHealthCheck) {
        const sinceHealthCheck = cyclesSinceHealthCheck.get(pid) ?? Number.POSITIVE_INFINITY;
        if (sinceHealthCheck >= HEALTH_CHECK_EVERY_N_CYCLES - 1) {
          if (!(await runHealthCheck())) return;
        } else {
          cyclesSinceHealthCheck.set(pid, sinceHealthCheck + 1);
        }
      }

      // ── Steps 1–3: classify + consume stream in one explicit transaction ───
      //
      // The classify SELECT (non-consuming) and the consuming MERGE must see
      // the exact same stream snapshot.  Without an explicit transaction they
      // run as separate auto-committed statements; any rows committed to the
      // source table between them would be consumed by the MERGE but absent
      // from the classify results — silently undercounting total_mapped and
      // total_new_values.  Snowflake's snapshot isolation ensures both
      // statements see the same stream data when wrapped in BEGIN/COMMIT.
      //
      // Step 1 — classify (non-consuming SELECT)
      // Step 2 — consuming MERGE (advances stream offset on COMMIT)

      await exec(connection, 'BEGIN');
      let txCommitted = false;
      let streamRows: any[] = [];
      // NOTE: hasDeletes is the function-scoped var (hoisted above) — it's read
      // after this callback by the export rebuild, so it must NOT be re-declared here.

      try {
        // Step 1: Classify stream values (non-consuming SELECT, within tx)
        // already_mapped = 1  → value is in LITERAL_ALIAS_MATCHES (list A — instant match)
        // already_mapped = 0  → value needs LLM standardization (list B — queue it)
        // Only INSERT rows feed standardization.  An UPDATE's new value also
        // appears as an INSERT row here (METADATA$ISUPDATE = TRUE), so updated
        // values are treated as additions — exactly the "update = delete + add"
        // model.
        // Group by the NORMALIZED value so casing/whitespace/Unicode variants
        // collapse into one item; ANY_VALUE keeps a representative ORIGINAL (with
        // casing) for the LLM. Match against the lookup on the normalized form too.
        streamRows = await exec(connection, `
          SELECT
            ANY_VALUE(TO_VARCHAR(s.${colRef}))                            AS literal_value,
            COUNT(*)                                                        AS new_row_count,
            MAX(CASE WHEN lam.literal_value IS NOT NULL THEN 1 ELSE 0 END) AS already_mapped
          FROM ${streamRef} s
          LEFT JOIN ${internalTable('LITERAL_ALIAS_MATCHES')} lam
            ON lam.normalized_value = ${prismNormalizeFn()}(TO_VARCHAR(s.${colRef}))
            ${domainJoinCond}
          WHERE s.METADATA$ACTION = 'INSERT'
            AND TO_VARCHAR(s.${colRef}) IS NOT NULL
          GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(s.${colRef}))`);

        // Step 1b: Detect removals in the SAME snapshot.  DELETE rows cover both
        // pure deletes and the delete-half of updates.  We don't touch the lookup
        // table on a delete — we only flag that the export must be rebuilt so the
        // removed rows drop out.  Must run before COMMIT consumes the stream.
        const [delRow] = await exec(connection,
          `SELECT COUNT(*) AS del_cnt FROM ${streamRef} s WHERE s.METADATA$ACTION = 'DELETE'`);
        hasDeletes = Number((delRow as any)?.DEL_CNT ?? (delRow as any)?.del_cnt ?? 0) > 0; // hoisted

        // Step 1c: Detect new rows with a NULL in this column. They're excluded
        // from the classify above (which requires a non-null value), but a NULL is
        // "standardized as-is" — it exports as NULL — so it still needs the export
        // rebuilt to appear. Covers the single-column case where no sibling column
        // triggers a rebuild. Must run before COMMIT consumes the stream.
        const [nullRow] = await exec(connection,
          `SELECT COUNT(*) AS null_cnt FROM ${streamRef} s
           WHERE s.METADATA$ACTION = 'INSERT' AND TO_VARCHAR(s.${colRef}) IS NULL`);
        const nullCnt = Number((nullRow as any)?.NULL_CNT ?? (nullRow as any)?.null_cnt ?? 0);
        hasNullInserts = nullCnt > 0; // hoisted
        if (hasNullInserts) {
          console.log(`[Poller] Pipeline ${pid}: ${nullCnt} new row(s) with NULL "${column_name}" — will rebuild export to include them as-is`);
        }

        // Step 2: Consuming MERGE — push ALL new values into PIPELINE_QUEUE
        // (within tx). List A (already in the lookup) is queued alongside list B:
        // already-mapped values no longer fast-path into the export at the end of
        // the poll cycle — they wait in the queue and reach the export together
        // with everything else at the next 10-minute standardization tick, so the
        // export is always a consistent snapshot as of the last update. Lookup-hit
        // values cost nothing at that point (hash match, no LLM).
        // IMPORTANT: this DML always runs, even when the classify found nothing.
        // Referencing the stream in ANY DML advances the stream offset on COMMIT —
        // skipping this would leave SYSTEM$STREAM_HAS_DATA true forever and
        // re-count the same data on every poll.  With no new values the USING
        // subquery produces 0 rows so no queue rows are inserted/updated, but the
        // stream is still consumed.
        await exec(connection, `
          MERGE INTO ${internalTable('PIPELINE_QUEUE')} AS tgt
          USING (
            SELECT
              ANY_VALUE(TO_VARCHAR(s.${colRef})) AS literal_value,
              COUNT(*)                           AS new_row_count
            FROM ${streamRef} s
            WHERE s.METADATA$ACTION = 'INSERT'
              AND TO_VARCHAR(s.${colRef}) IS NOT NULL
            GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(s.${colRef}))
          ) AS src
            ON tgt.pipeline_id = ${pid} AND ${prismNormalizeFn()}(tgt.literal_value) = ${prismNormalizeFn()}(src.literal_value)
          WHEN MATCHED THEN UPDATE SET
            tgt.source_frequency = tgt.source_frequency + src.new_row_count
          WHEN NOT MATCHED THEN INSERT (pipeline_id, literal_value, source_frequency)
            VALUES (${pid}, src.literal_value, src.new_row_count)`);

        await exec(connection, 'COMMIT');
        txCommitted = true;
      } catch (txErr) {
        if (!txCommitted) {
          await exec(connection, 'ROLLBACK').catch(() => {});
        }
        throw txErr;
      }

      const classified: ClassifiedRow[] = streamRows.map((r: any) => ({
        literal_value:  String(r.LITERAL_VALUE  ?? r.literal_value  ?? ''),
        new_row_count:  Number(r.NEW_ROW_COUNT  ?? r.new_row_count  ?? 1),
        already_mapped: Number(r.ALREADY_MAPPED ?? r.already_mapped ?? 0) === 1,
      })).filter(r => r.literal_value);

      console.log(`[Poller] Pipeline ${pid}: classify returned ${classified.length} distinct value(s) — samples: [${classified.slice(0,3).map(r=>r.literal_value).join(', ')}]`);

      listA              = classified.filter(r =>  r.already_mapped); // already confirmed (lookup hit)
      const listB        = classified.filter(r => !r.already_mapped); // needs standardization
      const totalNewRows = classified.reduce((s, r) => s + r.new_row_count, 0);

      // ── Step 4: Get queue size + source row count after consuming ─────────
      console.log(`[Poller] Pipeline ${pid}: stream consumed (MERGE complete)`);
      const [postMergeRow] = await exec(connection,
        `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
        [pid]);
      const queueAfter = Number(postMergeRow?.CNT ?? postMergeRow?.cnt ?? 0);

      const [srcRow] = await exec(connection,
        `SELECT COUNT(*) AS cnt FROM ${srcRef} WHERE ${colRef} IS NOT NULL`);
      const totalSourceValues = Number(srcRow?.CNT ?? srcRow?.cnt ?? 0);

      // The poller never standardizes inline — queued values (mapped or not)
      // drain at the next 10-minute standardization tick (see
      // startQueueProcessor in pipeline-hourly-processor.ts), which also
      // respects the pipeline's update window and the failure backoff.

      // ── Step 5: Push pre-standardization metrics in a single UPDATE ───────
      // total_source_values = current source row count
      // queue_size          = after MERGE (now includes lookup-hit values —
      //                       everything waits in the queue until the next
      //                       standardization pass)
      // total_mapped is NOT touched here: it's recomputed absolutely when the
      // export is next rebuilt (standardization pass / hourly sweep), so the
      // card's counters describe the exported snapshot, not the live source.
      getDb().prepare(`
        UPDATE pipelines
        SET total_source_values = ?,
            total_new_values    = total_new_values + ?,
            queue_size          = ?,
            last_polled_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            fully_synced_at     = CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE fully_synced_at END,
            updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE pipeline_id = ?`)
        .run(totalSourceValues, totalNewRows, queueAfter, queueAfter, pid);
      // When polled as part of a table batch, the metrics here are intermediate
      // (an incremental total_mapped that the export rebuild below overwrites with
      // the absolute count) and last_polled_at isn't yet synced across columns.
      // Suppress the broadcast so the UI doesn't flicker mid-cycle — pollOneTable's
      // syncTableLastPolled fires a single authoritative broadcast once the whole
      // table is done.
      if (!opts.deferStandardization) broadcastPipelineEvent({ type: 'metrics_updated' });

      if (hasDeletes) {
        console.log(`[Poller] Pipeline ${pid}: detected removed/updated rows — export will be rebuilt`);
      }

      console.log(
        `[Poller] Pipeline ${pid}: ${totalNewRows} new row(s) queued — ` +
        `${listA.length} distinct already in the lookup, ` +
        `${listB.length} distinct need standardization (queue: ${queueAfter})`,
      );
      newRowsQueued = totalNewRows > 0;
      sourceChecked = true;
      // The export rebuild (if any) runs AFTER this connection closes (see
      // below) to avoid nested withWarehouse calls on the same process.
    });

    // ── Step 6: Export rebuild — runs on a fresh top-level connection ─────────
    // Moved outside the outer withWarehouse so there is no nested connection
    // contention.  NEW VALUES never trigger a rebuild here — mapped or not, they
    // wait in the queue and reach the export together at the next 10-minute
    // standardization tick (or a manual trigger), keeping the export a consistent
    // snapshot as of its last update.  The remaining row-level hygiene triggers:
    //   • hasDeletes — source rows were removed/updated; stale rows must drop out.
    //   • hasNullInserts (export table only) — new rows with a NULL in this column
    //     have nothing to standardize and never queue; rebuild so they appear
    //     as-is without waiting for the next tick.
    // (Note: any rebuild is CREATE OR REPLACE from the live source, so these
    // hygiene rebuilds may incidentally surface queued values early — acceptable;
    // the guarantee is "no rebuild is CAUSED by new values".)
    //
    // When polling as part of a table batch (deferStandardization) AND the
    // pipeline has an export table, the rebuild itself is DEFERRED to
    // pollOneTable, which performs at most one refreshExportTable per distinct
    // export_table_fqn after all columns — sibling columns share one export
    // table and refreshExportTable rebuilds every watched column at once, so
    // per-column rebuilds here were identical back-to-back full rebuilds.
    // A view is live already — it never needs the periodic rebuild a table does,
    // so it's treated the same as "no export object" for this trigger.
    const isTableExport = p.export_table_fqn != null && p.export_kind !== 'view';
    // Raw passthrough (owner decision 2026-08-18, finding #17): when the
    // pipeline opted into export_unmapped_rows, newly detected values should
    // appear in the export THIS cycle — as raw rows — rather than being
    // invisible until the tick standardizes them. That is what the toggle
    // means: the export mirrors the source, standardized where known. The
    // consistent-snapshot rule ("new values never cause a rebuild") still
    // governs the default, toggle-OFF case.
    const rawPassthroughRebuild = p.export_unmapped_rows && newRowsQueued && p.export_kind === 'table';
    const rebuildNeeded = hasDeletes || ((hasNullInserts || rawPassthroughRebuild) && isTableExport);
    needsExportRefresh = rebuildNeeded && isTableExport;
    if (rebuildNeeded) {
      if (isTableExport && opts.deferStandardization) {
        // Deferred — pollOneTable rebuilds this export once for the whole cycle.
      } else {
        try {
          if (isTableExport) {
            await refreshExportTable(
              table_fqn,
              column_name,
              p.export_table_fqn as string,
              domain_id,
              pid,
              p.export_kind,
            );
          } else {
            // No export table: recompute total_mapped absolutely after deletes.
            await updatePipelineMappedCount(table_fqn, column_name, domain_id, pid);
          }
          // Suppressed during a table batch — syncTableLastPolled broadcasts once
          // at the end of the cycle instead (avoids mid-poll UI flicker).
          if (!opts.deferStandardization) broadcastPipelineEvent({ type: 'metrics_updated' });
        } catch (exportErr) {
          console.error(`[Poller] Pipeline ${pid}: export/metrics refresh failed:`, exportErr);
        }
      }
    }

    // Only a genuinely CLEAN cycle may clear the flag. A cycle that returned
    // early after flagging a stream/source problem must leave it set so the
    // next cycle runs checkSourceHealth and pauses with a real message.
    if (!cycleErrored) lastPollErrored.delete(pid);
  } catch (e) {
    console.error(`[Poller] Pipeline ${pid}: poll error:`, e);
    lastPollErrored.add(pid); // force a source-health check on the next cycle
    const kind = classifyPollError(e);
    if (kind === 'global') {
      // Account-wide failure (auth / warehouse) — banner, not a per-pipeline pause.
      // Pipelines auto-resume on the next poll once access returns.
      broadcastGlobalAlert(
        'Snowflake access interrupted (sign-in or warehouse issue). Pipelines will resume automatically when it is restored.',
      );
    } else if (kind === 'pipeline') {
      // This table's access is gone (e.g. SELECT revoked) — pause with a reason.
      await pausePipelineWithMessage(
        pid,
        `Lost access to the source table — the service role may have had its privileges revoked. Restore access, then resume.`,
      ).catch(() => {});
      invalidateActivePipelinesCache(); // status changed — don't poll it off stale data
    }
    // 'transient' — logged above; retried next cycle.
    sourceChecked = false;
  }

  return { needsExportRefresh, checked: sourceChecked };
}

// ── Poll one table (all its columns as a single cycle) ─────────────────────────

/** Overwrite last_polled_at for all of a table's columns with one shared
 *  timestamp. fully_synced_at advances ONLY for `verifiedIds` — pipelines whose
 *  poll this cycle actually consulted the source (PollResult.checked). A column
 *  whose poll was skipped (standardizing) or errored must not have its
 *  "verified fully up to date" timestamp advanced by the table-wide sync. */
async function syncTableLastPolled(pipelineIds: number[], verifiedIds: number[]): Promise<void> {
  if (pipelineIds.length === 0) return;
  try {
    const db = getDb();
    const placeholders = pipelineIds.map(() => '?').join(', ');
    db.prepare(
      `UPDATE pipelines
       SET last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE pipeline_id IN (${placeholders})`,
    ).run(...pipelineIds);
    if (verifiedIds.length > 0) {
      const vPlaceholders = verifiedIds.map(() => '?').join(', ');
      db.prepare(
        `UPDATE pipelines
         SET fully_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id IN (${vPlaceholders}) AND queue_size = 0`,
      ).run(...verifiedIds);
    }
    broadcastPipelineEvent({ type: 'metrics_updated' });
  } catch (e) {
    console.warn(`[Poller] Failed to sync last_polled_at for table columns:`, e);
  }
}


/**
 * Poll all columns of one table as a single cycle: each column's stream is
 * polled (with standardization deferred), then last_polled_at is synchronized
 * across the table. Standardization is NOT triggered here — queued values drain
 * at the next 10-minute tick (startQueueProcessor) or via the manual trigger.
 */
async function pollOneTable(cols: PipelineRef[]): Promise<void> {
  const pipelineIds = cols.map(c => c.pipeline_id);

  // The whole table shares ONE "Checking for new values" span, fired EVERY cycle
  // (not only when data is found). The UI ring fills to 100%, then instead of
  // animating a reset it switches straight into this teal span for the duration of
  // the poll; when the span ends the ring resumes the cycle from 0%. (The amber
  // "standardizing" state now comes from the 10-minute tick's own events, not
  // from within a poll cycle.) One span for all columns ⇒ a multi-column card
  // shows a single check, not one per column.
  let scanStarted = false;
  const startScan = () => {
    if (scanStarted) return;
    scanStarted = true;
    for (const id of pipelineIds) broadcastPipelineEvent({ type: 'scanning_started', pipeline_id: id });
  };
  const endScan = () => {
    if (!scanStarted) return;
    scanStarted = false;
    for (const id of pipelineIds) broadcastPipelineEvent({ type: 'scanning_finished', pipeline_id: id });
  };

  try {
    // Enter the "checking" state immediately, before touching any column's stream.
    startScan();

    // Every pipeline is a live warehouse table now — files and Google Sheets
    // moved to the one-time flow, so there is no non-streaming column class to
    // handle separately.
    const sfCols = cols;

    // Export rebuilds flagged this cycle, deduped by export table — sibling
    // columns share one export table and refreshExportTable replaces ALL watched
    // columns in a single CREATE OR REPLACE, so one rebuild per export per cycle
    // is complete (previously two columns with deletes ran two identical
    // back-to-back full rebuilds).
    const exportRefreshes = new Map<string, PipelineRef>();
    // A column qualifies as verified only when its poll reports checked — not
    // skipped, not errored.
    const verifiedIds: number[] = [];
    // Live-table pipelines poll through the active warehouse adapter:
    // Snowflake → streams (pollOnePipeline); SQL Server → Change Tracking /
    // tiered diff scans (pollOneMssqlPipeline); Postgres → pg_stat-gated
    // tiered diff scans (pollOnePgPipeline); MySQL → UPDATE_TIME-gated tiered
    // diff scans (pollOneMysqlPipeline). Same result contract.
    const whKind = getWarehouseAdapter().kind;
    for (const col of sfCols) {
      const res = whKind === 'mssql'
        ? await pollOneMssqlPipeline(col)
        : whKind === 'postgres'
        ? await pollOnePgPipeline(col)
        : whKind === 'mysql'
        ? await pollOneMysqlPipeline(col)
        : await pollOnePipeline(col, { deferStandardization: true });
      if (res.checked) verifiedIds.push(col.pipeline_id);
      if (res.needsExportRefresh && col.export_table_fqn && !exportRefreshes.has(col.export_table_fqn)) {
        exportRefreshes.set(col.export_table_fqn, col);
      }
    }

    // At most ONE refreshExportTable per distinct export table for this cycle.
    // Runs after all columns but before endScan / syncTableLastPolled so the
    // ring/event semantics are unchanged.
    for (const [exportFqn, col] of exportRefreshes) {
      try {
        await refreshExportTable(col.table_fqn, col.column_name, exportFqn, col.domain_id, col.pipeline_id, col.export_kind);
      } catch (exportErr) {
        console.error(`[Poller] Table ${col.table_fqn}: export rebuild for ${exportFqn} failed:`, exportErr);
      }
    }

    // One synchronized poll timestamp for the whole table (broadcasts metrics_updated).
    await syncTableLastPolled(pipelineIds, verifiedIds);

    // No standardization here — the poller only detects and queues. Queued
    // values drain at the next 10-minute tick (startQueueProcessor) or via the
    // manual "Update Standardizations" trigger.
  } finally {
    // End the check (in a finally so it never sticks teal on error).
    endScan();
  }
}

// ── Background loop ───────────────────────────────────────────────────────────

/** ms until the next wall-clock minute mark (2:33:00, 2:34:00, …). */
function msUntilNextMinute(): number {
  return Math.max(250, POLL_INTERVAL_MS - (Date.now() % POLL_INTERVAL_MS));
}

export function startPoller(): void {
  // Guard against hot-reload creating multiple intervals in development
  const g = global as any;
  if (g.__pipelinePollerStarted) return;
  g.__pipelinePollerStarted = true;

  // One clock-aligned poll pass at every minute mark (2:33:00, 2:34:00, …) —
  // anchored to the wall clock, not to process start or pipeline creation.
  // Each pass fetches the active pipelines fresh (newly activated ones are
  // picked up at the next mark, ≤ 60 s), groups them by source table, and
  // polls every table concurrently — all COLUMNS of a table still poll
  // together inside pollOneTable and share one synchronized last_polled_at.
  // Self-chaining: the next mark is computed AFTER the pass completes, so
  // passes never overlap and a pass longer than a minute skips to the next
  // mark. (The old per-table self-chaining loops + supervisor existed to keep
  // the countdown-ring animation phase-aligned per table; the ring is gone.)
  const chain = () => {
    setTimeout(async () => {
      try {
        const all = await fetchActivePipelines();
        const byTable = new Map<string, PipelineRef[]>();
        for (const p of all) {
          const arr = byTable.get(p.table_fqn) ?? [];
          arr.push(p);
          byTable.set(p.table_fqn, arr);
        }
        const results = await Promise.allSettled(
          [...byTable.entries()].map(([tableFqn, cols]) =>
            pollOneTable(cols).catch((e) => {
              console.error(`[Poller] Table ${tableFqn}: poll cycle failed:`, e);
            }),
          ),
        );
        void results;
      } catch (e) {
        // Never let a failed pass tear down the scheduler.
        console.error('[Poller] Poll pass failed:', e);
      }
      chain();
    }, msUntilNextMinute());
  };

  chain();
  console.log(`[Poller] Background pipeline poller started — polling at every minute mark (first pass in ${Math.round(msUntilNextMinute() / 1000)}s)`);
}
