/**
 * Pipeline queue standardization processor.
 *
 * Runs LLM auto-group + direct lookup export for queued items when:
 *   • The clock hour rolls over (all active pipelines with queued items), or
 *   • A pipeline's queue grows past QUEUE_STANDARDIZE_THRESHOLD (default 25)
 *     after a stream poll adds new values.
 *
 * Steps per pipeline:
 *   1. Create a run from queued literals
 *   2. Auto-group (lookup + one-prompt LLM — no deviation/validation LLM)
 *   3. Export directly to LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES
 *   4. Remove exported literals from the queue
 */

import 'server-only';

import { withSnowflake } from './snowflake';
import { saveOpRunState, loadOpRunState, type OpRunState } from './op-auto-group';
import { runAutoGroupForRun } from './op-auto-group-run';
import { runOpExportDirect } from './op-export';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { beginStandardization, endStandardization, isPipelineStandardizing } from './pipeline-coordination';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { pausePipelineWithMessage } from './pipeline-alerts';

const HOUR_MS = 60 * 60 * 1_000;

/** Run standardization when queue size is strictly greater than this value. */
export const QUEUE_STANDARDIZE_THRESHOLD = 25;

/**
 * Max number of previously-unmapped source values the reconciliation sweep
 * queues per pipeline per pass.  The baseline scan caps at 5 000 distinct
 * values and the APPEND_ONLY stream only emits post-setup inserts, so any
 * pre-existing distinct tail beyond the cap is invisible to both.  This sweep
 * trickles that tail into the queue in batches so a huge backlog is absorbed
 * over successive hourly passes rather than in one oversized standardization.
 */
const RECONCILE_QUEUE_BATCH = 5_000;

const processingPipelineIds = new Set<number>();

// ── Standardization failure backoff ──────────────────────────────────────────
//
// A persistently failing standardization used to retry every 30 s forever, each
// attempt burning LLM tokens (errors were swallowed with the queue left intact,
// so the threshold trigger re-fired every poll).  Track consecutive failures
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
 *  threshold trigger and the hourly sweep both skip it until nextAttemptAt. */
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
    await pausePipelineWithMessage(
      pipelineId,
      `Automatic standardization failed ${MAX_CONSECUTIVE_FAILURES} times in a row — paused. Latest error: ${errMsg}. Resume the pipeline to retry.`,
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

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      },
    });
  });
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
  domain_id:        number | null;
  domain_name:      string | null;
  status:           string;
  source_type:      string;
  file_source_meta: any;
  file_export_meta: any;
}

export async function fetchPipelineById(pipelineId: number): Promise<PipelineForProcessing | null> {
  return await withSnowflake(async (conn) => {
    const rows = await exec(
      conn,
      `SELECT
         p.pipeline_id,
         p.table_fqn,
         p.column_name,
         p.export_table_fqn,
         p.domain_id,
         p.status,
         p.source_type,
         p.file_source_meta,
         p.file_export_meta,
         d.name AS domain_name
       FROM STAND_DB.STAND_INTERNAL.PIPELINES p
       LEFT JOIN STAND_DB.STAND_INTERNAL.DOMAINS d ON d.domain_id = p.domain_id
       WHERE p.pipeline_id = ?
       LIMIT 1`,
      [pipelineId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      pipeline_id:      Number(r.PIPELINE_ID      ?? r.pipeline_id),
      table_fqn:        String(r.TABLE_FQN         ?? r.table_fqn        ?? ''),
      column_name:      String(r.COLUMN_NAME       ?? r.column_name      ?? ''),
      export_table_fqn: r.EXPORT_TABLE_FQN ?? r.export_table_fqn ?? null,
      domain_id:        (r.DOMAIN_ID ?? r.domain_id) != null
        ? Number(r.DOMAIN_ID ?? r.domain_id)
        : null,
      domain_name:      r.DOMAIN_NAME ?? r.domain_name ?? null,
      status:           String(r.STATUS ?? r.status ?? ''),
      source_type:      String(r.SOURCE_TYPE ?? r.source_type ?? 'snowflake'),
      file_source_meta: r.FILE_SOURCE_META ?? r.file_source_meta ?? null,
      file_export_meta: r.FILE_EXPORT_META ?? r.file_export_meta ?? null,
    };
  });
}

async function fetchPipelinesWithQueue(): Promise<PipelineForProcessing[]> {
  return await withSnowflake(async (conn) => {
    const rows = await exec(
      conn,
      `SELECT
         p.pipeline_id,
         p.table_fqn,
         p.column_name,
         p.export_table_fqn,
         p.domain_id,
         p.status,
         d.name AS domain_name
       FROM STAND_DB.STAND_INTERNAL.PIPELINES p
       LEFT JOIN STAND_DB.STAND_INTERNAL.DOMAINS d ON d.domain_id = p.domain_id
       WHERE p.status = 'active'
         AND p.mode = 'auto'
         AND (p.source_type = 'snowflake' OR p.source_type IS NULL)
         AND EXISTS (
           SELECT 1 FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE q
           WHERE q.pipeline_id = p.pipeline_id
         )
       ORDER BY p.pipeline_id`,
    );
    return rows.map((r) => ({
      pipeline_id:      Number(r.PIPELINE_ID      ?? r.pipeline_id),
      table_fqn:        String(r.TABLE_FQN         ?? r.table_fqn        ?? ''),
      column_name:      String(r.COLUMN_NAME       ?? r.column_name      ?? ''),
      export_table_fqn: r.EXPORT_TABLE_FQN ?? r.export_table_fqn ?? null,
      domain_id:        (r.DOMAIN_ID ?? r.domain_id) != null
        ? Number(r.DOMAIN_ID ?? r.domain_id)
        : null,
      domain_name:      r.DOMAIN_NAME ?? r.domain_name ?? null,
      status:           String(r.STATUS ?? r.status ?? ''),
      source_type:      'snowflake',
      file_source_meta: null,
      file_export_meta: null,
    }));
  });
}

/** All active pipelines, regardless of whether they currently have queued items. */
async function fetchAllActivePipelines(): Promise<PipelineForProcessing[]> {
  return await withSnowflake(async (conn) => {
    const rows = await exec(
      conn,
      `SELECT
         p.pipeline_id,
         p.table_fqn,
         p.column_name,
         p.export_table_fqn,
         p.domain_id,
         p.status,
         d.name AS domain_name
       FROM STAND_DB.STAND_INTERNAL.PIPELINES p
       LEFT JOIN STAND_DB.STAND_INTERNAL.DOMAINS d ON d.domain_id = p.domain_id
       WHERE p.status = 'active'
         AND (p.source_type = 'snowflake' OR p.source_type IS NULL)
       ORDER BY p.pipeline_id`,
    );
    return rows.map((r) => ({
      pipeline_id:      Number(r.PIPELINE_ID      ?? r.pipeline_id),
      table_fqn:        String(r.TABLE_FQN         ?? r.table_fqn        ?? ''),
      column_name:      String(r.COLUMN_NAME       ?? r.column_name      ?? ''),
      export_table_fqn: r.EXPORT_TABLE_FQN ?? r.export_table_fqn ?? null,
      domain_id:        (r.DOMAIN_ID ?? r.domain_id) != null
        ? Number(r.DOMAIN_ID ?? r.domain_id)
        : null,
      domain_name:      r.DOMAIN_NAME ?? r.domain_name ?? null,
      status:           String(r.STATUS ?? r.status ?? ''),
      source_type:      'snowflake',
      file_source_meta: null,
      file_export_meta: null,
    }));
  });
}

/**
 * Queue previously-unmapped source values that the stream never captured.
 *
 * Finds distinct non-null source values that are neither mapped in
 * LITERAL_ALIAS_MATCHES (for this pipeline's domain) nor already in the queue,
 * and inserts up to RECONCILE_QUEUE_BATCH of them into PIPELINE_QUEUE with their
 * full source row count as the initial frequency.  Pure detection — does not
 * standardize — so it is safe to run for manual-mode pipelines too (the owner
 * still triggers standardization).  Returns the number of values newly queued.
 */
export async function reconcilePipelineQueue(
  pipeline: { pipeline_id: number; table_fqn: string; column_name: string; domain_id: number | null },
): Promise<number> {
  const { pipeline_id: pid, table_fqn, column_name, domain_id } = pipeline;

  // Skip if a standardization run is in flight — it is actively mutating the
  // queue and LITERAL_ALIAS_MATCHES, so a concurrent scan would race.
  if (isPipelineStandardizing(pid)) return 0;

  const parts = String(table_fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3 || !parts.every(isSimpleIdent) || !isSimpleIdent(column_name)) {
    console.warn(`[Reconcile] Pipeline ${pid}: invalid table/column identifier — skipping`);
    return 0;
  }

  const tableRef   = parts.map(quoteIdent).join('.');
  const colRef     = quoteIdent(column_name);
  const domainCond = domain_id != null
    ? `AND lam.domain_id = ${Number(domain_id)}`
    : `AND lam.domain_id IS NULL`;

  return await withSnowflake(async (conn) => {
    const [beforeRow] = await exec(
      conn,
      `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
      [pid],
    );
    const queueBefore = Number(beforeRow?.CNT ?? beforeRow?.cnt ?? 0);

    // The NOT EXISTS guard against the queue (in addition to WHEN NOT MATCHED)
    // ensures the LIMIT budget is spent only on genuinely-new values, so every
    // pass makes forward progress instead of re-selecting already-queued rows.
    await exec(conn, `
      MERGE INTO STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE AS tgt
      USING (
        SELECT ANY_VALUE(TO_VARCHAR(src.${colRef})) AS literal_value,
               COUNT(*)                             AS source_frequency
        FROM ${tableRef} src
        LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
          ON lam.normalized_value = PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
          ${domainCond}
        WHERE src.${colRef} IS NOT NULL
          AND lam.literal_value IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE q
            WHERE q.pipeline_id = ${pid}
              AND PRISM_NORMALIZE(q.literal_value) = PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
          )
        GROUP BY PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
        LIMIT ${RECONCILE_QUEUE_BATCH}
      ) AS recon
        ON tgt.pipeline_id = ${pid} AND PRISM_NORMALIZE(tgt.literal_value) = PRISM_NORMALIZE(recon.literal_value)
      WHEN NOT MATCHED THEN INSERT (pipeline_id, literal_value, source_frequency)
        VALUES (${pid}, recon.literal_value, recon.source_frequency)`);

    const [afterRow] = await exec(
      conn,
      `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
      [pid],
    );
    const queueAfter = Number(afterRow?.CNT ?? afterRow?.cnt ?? 0);
    const added      = Math.max(0, queueAfter - queueBefore);

    if (added > 0) {
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET queue_size = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [queueAfter, pid],
      );
      broadcastPipelineEvent({ type: 'metrics_updated' });
      console.log(`[Reconcile] Pipeline ${pid}: queued ${added} previously-unmapped value(s) (queue: ${queueAfter})`);
    }

    return added;
  });
}

/**
 * Run the reconciliation scan across all active pipelines.  Runs ahead of the
 * standardization sweep so any newly-surfaced tail values are present in the
 * queue when fetchPipelinesWithQueue picks the auto-mode pipelines up.
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
  const busyExports = new Set<string>();
  for (const p of pipelines) {
    if (p.export_table_fqn && isPipelineStandardizing(p.pipeline_id)) busyExports.add(p.export_table_fqn);
  }
  const rebuiltExports = new Set<string>();
  for (const p of pipelines) {
    if (!p.table_fqn || !p.column_name) continue;
    try {
      if (p.export_table_fqn) {
        if (busyExports.has(p.export_table_fqn) || rebuiltExports.has(p.export_table_fqn)) continue;
        // Re-check immediately before starting the rebuild — standardization may
        // have begun since we computed busyExports at the top of the loop.
        if (isPipelineStandardizing(p.pipeline_id)) {
          busyExports.add(p.export_table_fqn); // block siblings of this export too
          continue;
        }
        rebuiltExports.add(p.export_table_fqn);
        await refreshExportTable(p.table_fqn, p.column_name, p.export_table_fqn, p.domain_id, p.pipeline_id);
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
  const rows = await exec(
    connection,
    `SELECT literal_value
     FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
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
  const rows = await exec(
    connection,
    `SELECT literal_value, source_frequency
     FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
     WHERE pipeline_id = ?
     ORDER BY detected_at NULLS LAST, literal_value`,
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
  const conceptKey = pipeline.domain_name?.trim() || 'mobile_carrier';
  const nonce = `hourly_${pipeline.pipeline_id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Reuse the newest still-pending run from a previous failed attempt for this
  // pipeline (a failed standardization leaves its run in 'created'/'running')
  // instead of inserting a fresh RUNS row per retry.  The creation_nonce prefix
  // `hourly_<pipeline_id>_` scopes the lookup to this pipeline; source columns
  // are matched too as a belt-and-braces check.  Any lookup failure falls back
  // to the plain insert below.
  try {
    const pendingRows = await exec(
      connection,
      `SELECT run_id FROM STAND_DB.STAND_INTERNAL.RUNS
       WHERE creation_nonce LIKE ? ESCAPE '\\\\'
         AND source_relation = ?
         AND source_column   = ?
         AND run_status IN ('created', 'running')
       ORDER BY run_id DESC
       LIMIT 1`,
      [`hourly_${pipeline.pipeline_id}\\_%`, pipeline.table_fqn, pipeline.column_name],
    );
    if (pendingRows.length) {
      const reuseId = Number(pendingRows[0].RUN_ID ?? pendingRows[0].run_id);
      if (Number.isFinite(reuseId) && reuseId > 0) {
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.RUNS
           SET run_status = 'created', updated_at = CURRENT_TIMESTAMP()
           WHERE run_id = ?`,
          [reuseId],
        );
        await saveOpRunState(connection, reuseId, buildInitialQueueRunState(literals, frequencies));
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

  await exec(
    connection,
    `INSERT INTO STAND_DB.STAND_INTERNAL.RUNS
       (concept_key, source_relation, source_column, mode, domain_id, run_status, creation_nonce, created_at, updated_at)
     VALUES (?, ?, ?, 'auto', ${pipeline.domain_id != null ? String(Number(pipeline.domain_id)) : 'NULL'}, 'created', ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    [conceptKey, pipeline.table_fqn, pipeline.column_name, nonce],
  );

  const runIdRows = await exec(
    connection,
    `SELECT run_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE creation_nonce = ? LIMIT 1`,
    [nonce],
  );
  if (!runIdRows.length) {
    throw new Error(`Hourly run created but run_id could not be retrieved for pipeline ${pipeline.pipeline_id}`);
  }
  const runId = Number(runIdRows[0].RUN_ID ?? runIdRows[0].run_id);

  await saveOpRunState(connection, runId, buildInitialQueueRunState(literals, frequencies));
  return runId;
}

async function removeExportedFromQueue(
  connection:   any,
  pipelineId:   number,
  exportedLiterals: string[],
): Promise<void> {
  if (exportedLiterals.length === 0) return;

  const placeholders = exportedLiterals.map(() => '?').join(', ');
  await exec(
    connection,
    `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE
     WHERE pipeline_id = ? AND literal_value IN (${placeholders})`,
    [pipelineId, ...exportedLiterals],
  );

  const countRows = await exec(
    connection,
    `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
    [pipelineId],
  );
  const queueSize = Number(countRows[0]?.CNT ?? countRows[0]?.cnt ?? 0);

  const setClauses = [
    'queue_size = ?',
    'updated_at = CURRENT_TIMESTAMP()',
  ];
  const binds: any[] = [queueSize];

  if (queueSize === 0) {
    setClauses.push('last_queue_empty_at = CURRENT_TIMESTAMP()');
  }

  binds.push(pipelineId);
  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES SET ${setClauses.join(', ')} WHERE pipeline_id = ?`,
    binds,
  );
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
    return await withSnowflake(async (conn) => {
      const runId = await createRunFromQueue(conn, pipeline, literals);

      const groupResult = await runAutoGroupForRun(conn, runId, apiKey, { writeBreakdown: false });

      const state          = await loadOpRunState(conn, runId);
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
  reason:   'hourly' | 'threshold' = 'hourly',
  opts:     { beginEndStandardization?: boolean } = {},
): Promise<void> {
  const { beginEndStandardization = true } = opts;
  const tag = reason === 'threshold' ? 'Queue' : 'Hourly';
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[${tag}] ANTHROPIC_API_KEY not set — skipping pipeline ${pipeline.pipeline_id}`);
    processingPipelineIds.delete(pipeline.pipeline_id);
    if (beginEndStandardization) endStandardization(pipeline.pipeline_id);
    return;
  }

  try {
    await withSnowflake(async (connection) => {
      const queueItems = await fetchQueueLiteralsWithFreq(connection, pipeline.pipeline_id);
      if (queueItems.length === 0) {
        console.log(`[${tag}] Pipeline ${pipeline.pipeline_id}: queue empty — skip`);
        return;
      }

      const literals = queueItems.map(q => q.literal_value);
      const frequencies = new Map(queueItems.map(q => [q.literal_value, q.source_frequency]));

      console.log(
        `[${tag}] Pipeline ${pipeline.pipeline_id} (${pipeline.domain_name ?? 'no domain'}): ` +
        `standardizing ${literals.length} queued value(s)…`,
      );

      const runId = await createRunFromQueue(connection, pipeline, literals, frequencies);

      await runAutoGroupForRun(connection, runId, apiKey, { writeBreakdown: false });

      const stateAfter = await loadOpRunState(connection, runId);
      const exportedLiterals = stateAfter?.groups.flatMap((g) =>
        g.items.map((gi) => gi.literal_value),
      ) ?? [];

      if (exportedLiterals.length === 0) {
        console.error(
          `[${tag}] Pipeline ${pipeline.pipeline_id}: run ${runId} produced no groups — queue unchanged`,
        );
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'failed', updated_at = CURRENT_TIMESTAMP() WHERE run_id = ?`,
          [runId],
        );
        // Counts toward the failure backoff: with the queue intact, the threshold
        // trigger would otherwise re-fire this (token-burning) LLM pass every 30 s.
        await recordStandardizationFailure(
          pipeline.pipeline_id,
          new Error('LLM grouping produced no groups — queue unchanged'),
        );
        return;
      }

      const exportResult = await runOpExportDirect(runId);
      // runOpExportDirect already rebuilds the export table and updates total_mapped
      // internally (errors caught non-fatally there).  No second rebuild needed here.
      await removeExportedFromQueue(connection, pipeline.pipeline_id, exportedLiterals);

      // For pipelines without an export table, increment total_mapped by the
      // source_frequency sum of exported literals (runOpExportDirect skips this path).
      if (!pipeline.export_table_fqn) {
        const exportedFreqSum = exportedLiterals.reduce(
          (sum, lit) => sum + (frequencies.get(lit) ?? 1),
          0,
        );
        if (exportedFreqSum > 0) {
          await exec(
            connection,
            `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
             SET total_mapped = total_mapped + ?,
                 updated_at   = CURRENT_TIMESTAMP()
             WHERE pipeline_id = ?`,
            [exportedFreqSum, pipeline.pipeline_id],
          );
        }
      }

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
  reason:  'hourly' | 'threshold' = 'hourly',
): Promise<void> {
  if (columns.length === 0) return;
  // Mark the whole table standardizing before touching any column so the card
  // stays lit for the entire batch (beginStandardization only flips the animation
  // state; processPipelineQueue still manages its own processing lock).
  for (const c of columns) beginStandardization(c.pipeline_id);
  try {
    for (const c of columns) {
      await processPipelineQueue(c, reason, { beginEndStandardization: false });
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

/** Run standardization for all pipelines that have queued items, grouped by table. */
export async function runHourlyStandardization(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Hourly] ANTHROPIC_API_KEY not set — skipping pipeline standardization');
    return;
  }

  // Surface any pre-existing source values the stream never captured (e.g. the
  // distinct tail beyond the baseline scan cap) into the queue first, so the
  // standardization sweep below picks them up.
  await runReconciliationSweep().catch((e) =>
    console.error('[Hourly] Reconciliation sweep failed:', e),
  );

  const pipelines = await fetchPipelinesWithQueue();
  if (pipelines.length === 0) {
    console.log('[Hourly] No pipelines with queued items');
    return;
  }

  // Standardize a table's columns together (one cycle per table), not per column.
  const byTable = groupByTable(pipelines);
  console.log(`[Hourly] Starting standardization for ${pipelines.length} column(s) across ${byTable.size} table(s)…`);
  for (const [table, cols] of byTable) {
    console.log(`[Hourly] Table ${table}: standardizing ${cols.length} column(s) together`);
    await standardizeTable(cols, 'hourly');
  }
  console.log('[Hourly] Standardization pass complete');
}

function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

/**
 * Schedule hourly standardization at the top of each clock hour.
 */
export function startHourlyProcessor(): void {
  const g = global as typeof globalThis & { __hourlyProcessorStarted?: boolean };
  if (g.__hourlyProcessorStarted) return;
  g.__hourlyProcessorStarted = true;

  // Never let a rejected run tear down the scheduler: catch every invocation,
  // and install the interval BEFORE the first run so a first-run failure can't
  // prevent future runs from being scheduled.
  const safeRun = () => {
    runHourlyStandardization().catch((err) =>
      console.error('[Hourly] run failed:', err),
    );
  };

  const scheduleNext = () => {
    const delay = msUntilNextHour();
    console.log(`[Hourly] Next pipeline standardization in ${Math.round(delay / 60_000)} min`);
    setTimeout(() => {
      setInterval(safeRun, HOUR_MS);
      safeRun();
    }, delay);
  };

  scheduleNext();
  console.log('[Hourly] Pipeline hourly standardization scheduler started');
}
