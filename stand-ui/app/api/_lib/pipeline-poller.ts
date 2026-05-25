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

import { withSnowflake } from './snowflake';
import { isPollingPaused } from './pipeline-coordination';
import { maybeTriggerQueueStandardization } from './pipeline-hourly-processor';

const POLL_INTERVAL_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function quoteIdent(ident: string) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

/** Fully-qualified name of the stream for a given pipeline (unquoted — safe because pipeline_id is always a positive integer). */
function streamFqn(pipeline_id: number): string {
  return `STAND_DB.STAND_INTERNAL.PIPELINE_STREAM_${pipeline_id}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRef {
  pipeline_id:  number;
  table_fqn:    string;
  column_name:  string;
  domain_id:    number | null;
}

// ── Fetch active pipelines ────────────────────────────────────────────────────

async function fetchActivePipelines(): Promise<PipelineRef[]> {
  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT pipeline_id, table_fqn, column_name, domain_id
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE status = 'active'`,
      );
      return rows.map(r => ({
        pipeline_id:  Number(r.PIPELINE_ID  ?? r.pipeline_id),
        table_fqn:    String(r.TABLE_FQN    ?? r.table_fqn    ?? ''),
        column_name:  String(r.COLUMN_NAME  ?? r.column_name  ?? ''),
        domain_id:    (r.DOMAIN_ID ?? r.domain_id) != null
          ? Number(r.DOMAIN_ID ?? r.domain_id)
          : null,
      }));
    });
  } catch (e) {
    console.error('[Poller] Failed to fetch active pipelines:', e);
    return [];
  }
}

// ── Public: drop stream (call when pipeline is deleted) ───────────────────────

export async function dropPipelineStream(pipeline_id: number): Promise<void> {
  try {
    await withSnowflake(async (conn) => {
      await exec(conn, `DROP STREAM IF EXISTS ${streamFqn(pipeline_id)}`);
    });
    console.log(`[Poller] Dropped stream for pipeline ${pipeline_id}`);
  } catch (e) {
    // Non-fatal — log and continue
    console.warn(`[Poller] Could not drop stream for pipeline ${pipeline_id}:`, e);
  }
}

// ── Poll one pipeline ─────────────────────────────────────────────────────────

export async function pollOnePipeline(p: PipelineRef): Promise<void> {
  if (isPollingPaused()) return;

  const { pipeline_id, table_fqn, column_name, domain_id } = p;

  let db: string, schema: string, table: string;
  try {
    const fqn = parseFqn(table_fqn);
    db = fqn.db; schema = fqn.schema; table = fqn.table;
  } catch (e) {
    console.error(`[Poller] Pipeline ${pipeline_id}: invalid table_fqn "${table_fqn}":`, e);
    return;
  }

  if (!isSimpleIdent(db) || !isSimpleIdent(schema) || !isSimpleIdent(table) || !isSimpleIdent(column_name)) {
    console.error(`[Poller] Pipeline ${pipeline_id}: table/column contains unsupported characters.`);
    return;
  }

  const tableRef  = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colRef    = quoteIdent(column_name);
  const streamRef = streamFqn(pipeline_id);

  // Domain filter applied inside the USING subquery to exclude already-mapped values
  const domainFilter = domain_id != null
    ? `domain_id = ${Number(domain_id)}`
    : `domain_id IS NULL`;

  try {
    await withSnowflake(async (connection) => {

      // ── 1. Ensure stream exists (idempotent) ──────────────────────────────
      // APPEND_ONLY = TRUE means the stream only captures INSERT operations,
      // not UPDATEs or DELETEs — exactly what we need for new-value detection.
      // The stream is created AFTER the baseline run, so pre-existing rows are
      // already standardized and won't appear as "new" inserts.
      try {
        await exec(
          connection,
          `CREATE STREAM IF NOT EXISTS ${streamRef}
           ON TABLE ${tableRef}
           APPEND_ONLY = TRUE`,
        );
      } catch (e: any) {
        console.error(`[Poller] Pipeline ${pipeline_id}: failed to create stream:`, e?.message ?? e);
        return;
      }

      // ── 2. Quick check — any new rows at all? (non-consuming) ─────────────
      // SYSTEM$STREAM_HAS_DATA returns TRUE if the stream has unconsumed rows.
      // This avoids an unnecessary MERGE DML when nothing has changed.
      let hasData = false;
      try {
        const rows = await exec(
          connection,
          `SELECT SYSTEM$STREAM_HAS_DATA('${streamRef}') AS has_data`,
        );
        const val = rows[0]?.HAS_DATA ?? rows[0]?.has_data;
        hasData = val === true || String(val).toUpperCase() === 'TRUE';
      } catch (e: any) {
        console.warn(`[Poller] Pipeline ${pipeline_id}: STREAM_HAS_DATA failed — assuming no data:`, e?.message ?? e);
      }

      // ── 3a. No new data — just stamp last_polled_at and return ───────────
      if (!hasData) {
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE pipeline_id = ?`,
          [pipeline_id],
        );
        console.log(`[Poller] Pipeline ${pipeline_id}: no new rows in stream`);
        return;
      }

      // ── 3b. New data found — snapshot queue size before consuming ─────────
      const beforeRows = await exec(
        connection,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
        [pipeline_id],
      );
      const queueBefore = Number(beforeRows[0]?.CNT ?? beforeRows[0]?.cnt ?? 0);

      // ── 4. MERGE from stream → PIPELINE_QUEUE (consumes the stream) ───────
      // The USING subquery:
      //   • Reads only INSERT rows from the APPEND_ONLY stream.
      //   • Excludes values already present in LITERAL_ALIAS_MATCHES for the
      //     domain (they're already standardized — no need to re-queue).
      // The MERGE ON condition deduplicates against existing queue rows.
      // Because a DML statement references the stream, the stream offset
      // advances even if zero rows are ultimately inserted.
      await exec(
        connection,
        `MERGE INTO STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE AS tgt
         USING (
           SELECT DISTINCT TO_VARCHAR(s.${colRef}) AS literal_value
           FROM ${streamRef} s
           WHERE s.METADATA$ACTION = 'INSERT'
             AND TO_VARCHAR(s.${colRef}) IS NOT NULL
             AND TO_VARCHAR(s.${colRef}) NOT IN (
               SELECT literal_value
               FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES
               WHERE ${domainFilter}
             )
         ) AS src
           ON tgt.pipeline_id = ${pipeline_id} AND tgt.literal_value = src.literal_value
         WHEN NOT MATCHED THEN
           INSERT (pipeline_id, literal_value) VALUES (${pipeline_id}, src.literal_value)`,
      );

      // ── 5. Update pipeline stats ──────────────────────────────────────────
      const afterRows = await exec(
        connection,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
        [pipeline_id],
      );
      const queueAfter  = Number(afterRows[0]?.CNT ?? afterRows[0]?.cnt ?? 0);
      const newlyQueued = Math.max(0, queueAfter - queueBefore);

      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET last_polled_at   = CURRENT_TIMESTAMP(),
             queue_size       = ?,
             total_new_values = total_new_values + ?,
             updated_at       = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [queueAfter, newlyQueued, pipeline_id],
      );

      if (newlyQueued > 0) {
        console.log(`[Poller] Pipeline ${pipeline_id}: ${newlyQueued} new value(s) added to queue (total in queue: ${queueAfter})`);
      } else {
        console.log(`[Poller] Pipeline ${pipeline_id}: stream consumed — ${queueAfter} value(s) already in queue, none newly added`);
      }

      // Run LLM standardization when the queue exceeds the batch threshold
      await maybeTriggerQueueStandardization(pipeline_id, queueBefore, queueAfter, newlyQueued);
    });
  } catch (e) {
    console.error(`[Poller] Pipeline ${pipeline_id}: poll error:`, e);
  }
}

// ── Background loop ───────────────────────────────────────────────────────────

export function startPoller(): void {
  if (process.env.NEXT_PUBLIC_APP_MODE !== 'premium') return;

  // Guard against hot-reload creating multiple intervals in development
  const g = global as any;
  if (g.__pipelinePollerStarted) return;
  g.__pipelinePollerStarted = true;

  async function runAllPolls() {
    if (isPollingPaused()) {
      console.log('[Poller] Skipping poll cycle — standardization in progress');
      return;
    }

    const pipelines = await fetchActivePipelines();
    if (pipelines.length === 0) return;
    console.log(`[Poller] Polling ${pipelines.length} active pipeline(s) via Snowflake streams…`);
    // Poll sequentially so a mid-cycle standardization pause stops remaining pipelines
    for (const p of pipelines) {
      if (isPollingPaused()) {
        console.log('[Poller] Stopping poll cycle — standardization in progress');
        break;
      }
      await pollOnePipeline(p);
    }
  }

  // First poll runs 5 s after boot (let Next.js finish starting up)
  setTimeout(runAllPolls, 5_000);
  setInterval(runAllPolls, POLL_INTERVAL_MS);
  console.log('[Poller] Background pipeline poller started (Snowflake stream mode, interval: 30 s)');
}
