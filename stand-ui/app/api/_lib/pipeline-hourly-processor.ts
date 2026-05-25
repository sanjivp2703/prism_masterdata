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
import { beginStandardization, endStandardization } from './pipeline-coordination';

const HOUR_MS = 60 * 60 * 1_000;

/** Run standardization when queue size is strictly greater than this value. */
export const QUEUE_STANDARDIZE_THRESHOLD = 25;

const processingPipelineIds = new Set<number>();

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

export interface PipelineForProcessing {
  pipeline_id:      number;
  table_fqn:        string;
  column_name:      string;
  export_table_fqn: string | null;
  domain_id:        number | null;
  domain_name:      string | null;
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
         d.name AS domain_name
       FROM STAND_DB.STAND_INTERNAL.PIPELINES p
       LEFT JOIN STAND_DB.STAND_INTERNAL.DOMAINS d ON d.domain_id = p.domain_id
       WHERE p.status = 'active'
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
    }));
  });
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

export async function createRunFromQueue(
  connection: any,
  pipeline: PipelineForProcessing,
  literals: string[],
): Promise<number> {
  const conceptKey = pipeline.domain_name?.trim() || 'mobile_carrier';
  const nonce = `hourly_${pipeline.pipeline_id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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

  const initialState: OpRunState = {
    status:    'created',
    items:     literals.map((lv, idx) => ({
      run_item_id:         idx + 1,
      literal_value:       lv,
      source_frequency:    1,
      matched_from_lookup: false,
    })),
    groups:    [],
    ungrouped: literals.map((lv) => ({
      literal_value:       lv,
      matched_from_lookup: false,
    })),
  };
  await saveOpRunState(connection, runId, initialState);
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
  if (process.env.NEXT_PUBLIC_APP_MODE !== 'premium') {
    throw new Error('Bulk pipeline processing is only available in Premium mode.');
  }

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
  beginStandardization();

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
      }

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
    endStandardization();
  }
}

/**
 * Process one pipeline's queue: auto-group + direct export.
 */
export async function processPipelineQueue(
  pipeline: PipelineForProcessing,
  reason:   'hourly' | 'threshold' = 'hourly',
): Promise<void> {
  const tag = reason === 'threshold' ? 'Queue' : 'Hourly';
  if (processingPipelineIds.has(pipeline.pipeline_id)) {
    console.log(`[${tag}] Pipeline ${pipeline.pipeline_id}: already processing — skip`);
    return;
  }
  processingPipelineIds.add(pipeline.pipeline_id);
  beginStandardization();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[${tag}] ANTHROPIC_API_KEY not set — skipping pipeline ${pipeline.pipeline_id}`);
    processingPipelineIds.delete(pipeline.pipeline_id);
    endStandardization();
    return;
  }

  try {
    await withSnowflake(async (connection) => {
      const literals = await fetchQueueLiterals(connection, pipeline.pipeline_id);
      if (literals.length === 0) {
        console.log(`[${tag}] Pipeline ${pipeline.pipeline_id}: queue empty — skip`);
        return;
      }

      console.log(
        `[${tag}] Pipeline ${pipeline.pipeline_id} (${pipeline.domain_name ?? 'no domain'}): ` +
        `standardizing ${literals.length} queued value(s)…`,
      );

      const runId = await createRunFromQueue(connection, pipeline, literals);

      await runAutoGroupForRun(connection, runId, apiKey, { writeBreakdown: false });

      const stateAfter = await loadOpRunState(connection, runId);
      const exportedLiterals = stateAfter?.groups.flatMap((g) =>
        g.items.map((gi) => gi.literal_value),
      ) ?? [];

      if (exportedLiterals.length === 0) {
        console.warn(
          `[${tag}] Pipeline ${pipeline.pipeline_id}: run ${runId} produced no groups — queue unchanged`,
        );
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.RUNS SET run_status = 'failed', updated_at = CURRENT_TIMESTAMP() WHERE run_id = ?`,
          [runId],
        );
        return;
      }

      const exportResult = await runOpExportDirect(runId);
      await removeExportedFromQueue(connection, pipeline.pipeline_id, exportedLiterals);

      console.log(
        `[${tag}] Pipeline ${pipeline.pipeline_id}: run ${runId} complete — ` +
        `${exportResult.items_written} mapping(s) written, ` +
        `${literals.length - exportedLiterals.length} left ungrouped in queue`,
      );
      // Export table refresh is handled inside runOpExportDirect after writes commit.
    });
  } catch (e) {
    console.error(`[${tag}] Pipeline ${pipeline.pipeline_id}: failed:`, e);
  } finally {
    processingPipelineIds.delete(pipeline.pipeline_id);
    endStandardization();
  }
}

/**
 * After a poll updates the queue, run standardization if the queue now exceeds
 * the threshold. Only fires when new items were added or the queue just crossed
 * the threshold — avoids re-running every 30 s while the queue stays large.
 */
export async function maybeTriggerQueueStandardization(
  pipelineId:   number,
  queueBefore:  number,
  queueAfter:   number,
  newlyQueued:  number,
): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_MODE !== 'premium') return;
  if (queueAfter <= QUEUE_STANDARDIZE_THRESHOLD) return;

  const crossedThreshold = queueBefore <= QUEUE_STANDARDIZE_THRESHOLD && queueAfter > QUEUE_STANDARDIZE_THRESHOLD;
  const grewWhileOver    = queueAfter > QUEUE_STANDARDIZE_THRESHOLD && newlyQueued > 0;
  if (!crossedThreshold && !grewWhileOver) return;

  const pipeline = await fetchPipelineById(pipelineId);
  if (!pipeline) return;

  console.log(
    `[Queue] Pipeline ${pipelineId}: queue at ${queueAfter} (>${QUEUE_STANDARDIZE_THRESHOLD}) — triggering standardization`,
  );
  await processPipelineQueue(pipeline, 'threshold');
}

/** Run standardization for all pipelines that have queued items. */
export async function runHourlyStandardization(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Hourly] ANTHROPIC_API_KEY not set — skipping pipeline standardization');
    return;
  }

  const pipelines = await fetchPipelinesWithQueue();
  if (pipelines.length === 0) {
    console.log('[Hourly] No pipelines with queued items');
    return;
  }

  console.log(`[Hourly] Starting standardization for ${pipelines.length} pipeline(s)…`);
  for (const pipeline of pipelines) {
    await processPipelineQueue(pipeline, 'hourly');
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
 * Only runs when NEXT_PUBLIC_APP_MODE is premium.
 */
export function startHourlyProcessor(): void {
  if (process.env.NEXT_PUBLIC_APP_MODE !== 'premium') return;

  const g = global as typeof globalThis & { __hourlyProcessorStarted?: boolean };
  if (g.__hourlyProcessorStarted) return;
  g.__hourlyProcessorStarted = true;

  const scheduleNext = () => {
    const delay = msUntilNextHour();
    console.log(`[Hourly] Next pipeline standardization in ${Math.round(delay / 60_000)} min`);
    setTimeout(async () => {
      await runHourlyStandardization();
      setInterval(runHourlyStandardization, HOUR_MS);
    }, delay);
  };

  scheduleNext();
  console.log('[Hourly] Pipeline hourly standardization scheduler started');
}
