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
import { isPipelineStandardizing, beginStandardization, endStandardization } from './pipeline-coordination';
import { QUEUE_STANDARDIZE_THRESHOLD, fetchPipelineById, processPipelineQueue, runHourlyStandardization, reconcilePipelineQueue, standardizeTable, type PipelineForProcessing } from './pipeline-hourly-processor';
import { broadcastPipelineEvent } from './pipeline-broadcaster';
import { refreshExportTable, updatePipelineMappedCount } from './export-table';
import { refreshSheetsFileRows } from './op-file-pipeline';
import {
  pausePipelineWithMessage,
  clearPipelineStatusMessage,
  flagPipelineMessage,
  broadcastGlobalAlert,
} from './pipeline-alerts';

const POLL_INTERVAL_MS = 30_000;

// Pipelines whose stream has been confirmed (this process) to be a standard,
// delete-aware stream — not a legacy APPEND_ONLY one.  Checked once per pipeline
// per process to avoid a SHOW STREAMS round-trip on every poll.
const verifiedStandardStreams = new Set<number>();

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

// Snowflake's INFORMATION_SCHEMA reports VARCHAR/CHAR/STRING all as 'TEXT'.
const STRING_DATA_TYPES = new Set(['TEXT']);

type SourceHealth =
  | { ok: true }
  | { ok: false; action: 'pause' | 'skip'; message: string };

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
): Promise<SourceHealth> {
  const colRows = await exec(
    connection,
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM ${quoteIdent(db)}.INFORMATION_SCHEMA.COLUMNS
     WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)`,
    [schema, table],
  );

  if (colRows.length === 0) {
    return {
      ok: false, action: 'pause',
      message: `Source table ${tableFqn} not found or not accessible — it may have been dropped, renamed, or access was revoked. Fix the source or update the pipeline, then resume.`,
    };
  }

  const watched = colRows.find((r: any) =>
    String(r.COLUMN_NAME ?? r.column_name ?? '').toUpperCase() === columnName.toUpperCase());
  if (!watched) {
    return {
      ok: false, action: 'pause',
      message: `Watched column "${columnName}" no longer exists on ${tableFqn} — it may have been dropped or renamed. Update the pipeline, then resume.`,
    };
  }

  const dataType = String((watched as any).DATA_TYPE ?? (watched as any).data_type ?? '').toUpperCase();
  if (!STRING_DATA_TYPES.has(dataType)) {
    return {
      ok: false, action: 'pause',
      message: `Watched column "${columnName}" is type ${dataType || 'unknown'} — standardization needs a text column. Paused until it is a text type again.`,
    };
  }

  // Masking / row-access policy detection (best-effort; unavailable on some editions).
  try {
    const polRows = await exec(
      connection,
      `SELECT POLICY_KIND, REF_COLUMN_NAME
       FROM TABLE(${quoteIdent(db)}.INFORMATION_SCHEMA.POLICY_REFERENCES(
         REF_ENTITY_NAME => '${db}.${schema}.${table}',
         REF_ENTITY_DOMAIN => 'TABLE'))`,
    );
    for (const r of polRows) {
      const kind = String((r as any).POLICY_KIND ?? (r as any).policy_kind ?? '').toUpperCase();
      const col  = String((r as any).REF_COLUMN_NAME ?? (r as any).ref_column_name ?? '');
      if (kind.includes('MASKING') && col.toUpperCase() === columnName.toUpperCase()) {
        return {
          ok: false, action: 'skip',
          message: `Watched column "${columnName}" has a masking policy — standardization skipped to avoid mapping masked values. Resumes automatically when the policy is removed.`,
        };
      }
      if (kind.includes('ROW_ACCESS')) {
        return {
          ok: false, action: 'skip',
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
  return 'transient';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRef {
  pipeline_id:      number;
  table_fqn:        string;
  column_name:      string;
  domain_id:        number | null;
  export_table_fqn: string | null;
  mode:             string;
  status_message:   string | null;
  source_type:      string;
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
  reconcilePipelineQueue(p).catch((e) =>
    console.error(`[Poller] Pipeline ${p.pipeline_id}: gap reconciliation after stream reset failed:`, e),
  );
  const refresh = p.export_table_fqn
    ? refreshExportTable(p.table_fqn, p.column_name, p.export_table_fqn, p.domain_id, p.pipeline_id)
    : updatePipelineMappedCount(p.table_fqn, p.column_name, p.domain_id, p.pipeline_id);
  refresh
    .then(() => broadcastPipelineEvent({ type: 'metrics_updated' }))
    .catch((e) =>
      console.error(`[Poller] Pipeline ${p.pipeline_id}: export refresh after stream reset failed:`, e),
    );
}

// ── Fetch active pipelines ────────────────────────────────────────────────────

async function fetchActivePipelines(): Promise<PipelineRef[]> {
  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT pipeline_id, table_fqn, column_name, domain_id, export_table_fqn, mode, status_message,
                COALESCE(source_type, 'snowflake') AS source_type
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE status = 'active'`,
      );
      return rows.map(r => ({
        pipeline_id:      Number(r.PIPELINE_ID  ?? r.pipeline_id),
        table_fqn:        String(r.TABLE_FQN    ?? r.table_fqn    ?? ''),
        column_name:      String(r.COLUMN_NAME  ?? r.column_name  ?? ''),
        domain_id:        (r.DOMAIN_ID ?? r.domain_id) != null
          ? Number(r.DOMAIN_ID ?? r.domain_id)
          : null,
        export_table_fqn: r.EXPORT_TABLE_FQN ?? r.export_table_fqn ?? null,
        mode:             String(r.MODE ?? r.mode ?? 'auto'),
        status_message:   r.STATUS_MESSAGE ?? r.status_message ?? null,
        source_type:      String(r.SOURCE_TYPE ?? r.source_type ?? 'snowflake'),
      }));
    });
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
//
// Each poll cycle:
//   1. Non-consuming SELECT classifies new stream values into:
//        list A — value already has a confirmed mapping (no LLM needed)
//        list B — value is new / unmapped (needs standardization)
//   2. COUNT(*) source table → total_source_values
//   3. Push initial metrics: total_source_values updated, total_mapped += list A
//      frequency (those rows are immediately standardized by definition)
//   4. Consuming MERGE: list B values → PIPELINE_QUEUE (accumulates frequency
//      for values already queued from prior polls)
//   5. If queue > threshold after merge → LLM standardization fires inline;
//      after LLM, total_mapped is recomputed from source (full accurate recount)
//
// Total = Standardized + Unstandardized at all times.
// Unstandardized is derived in the UI: total_source_values − total_mapped.

export interface PollResult {
  /** True when this column's queue crossed the standardization threshold this cycle
   *  (auto mode). When polling as part of a table batch (deferStandardization),
   *  the caller standardizes the whole table together instead of this column alone. */
  willStandardize: boolean;
}

export async function pollOnePipeline(
  p: PipelineRef,
  opts: { deferStandardization?: boolean } = {},
): Promise<PollResult> {
  if (isPipelineStandardizing(p.pipeline_id)) return { willStandardize: false };

  const { pipeline_id, table_fqn, column_name, domain_id } = p;
  const pid = pipeline_id;

  let db: string, schema: string, table: string;
  try {
    const fqn = parseFqn(table_fqn);
    db = fqn.db; schema = fqn.schema; table = fqn.table;
  } catch (e) {
    console.error(`[Poller] Pipeline ${pid}: invalid table_fqn "${table_fqn}":`, e);
    return { willStandardize: false };
  }

  if (!isSimpleIdent(db) || !isSimpleIdent(schema) || !isSimpleIdent(table) || !isSimpleIdent(column_name)) {
    console.error(`[Poller] Pipeline ${pid}: table/column contains unsupported characters.`);
    return { willStandardize: false };
  }

  const tableRef  = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colRef    = quoteIdent(column_name);
  const streamRef = streamFqn(pid);

  // Used in LEFT JOINs with LITERAL_ALIAS_MATCHES to scope by domain
  const domainJoinCond = domain_id != null
    ? `AND lam.domain_id = ${Number(domain_id)}`
    : `AND lam.domain_id IS NULL`;

  // True if this poller cycle called beginStandardization and has not yet
  // handed cleanup off to processPipelineQueue.  Used in the finally block to
  // ensure the ring always unpauses even if an error occurs mid-cycle.
  let standardizationOwned = false;

  // Hoisted out of withSnowflake so the export rebuild and LLM run open fresh
  // top-level connections — no nested withSnowflake contention.
  interface ClassifiedRow { literal_value: string; new_row_count: number; already_mapped: boolean }
  let listA:          ClassifiedRow[] = [];
  let hasDeletes      = false;
  let willStandardize = false;
  let hasNewUnmapped  = false;   // listB non-empty — used by manual mode to export raw values
  let hasNullInserts  = false;   // new rows with a NULL in this column — exported as-is (NULL passthrough)

  try {
    await withSnowflake(async (connection) => {

      // ── Pre-flight: source table / column / type / policy health ──────────
      // Catches dropped/renamed/revoked tables, dropped/renamed or non-text
      // columns, and masking/row-access policies BEFORE we touch the stream.
      const health = await checkSourceHealth(connection, db, schema, table, column_name, table_fqn);
      if (!health.ok) {
        if (health.action === 'pause') {
          await pausePipelineWithMessage(pid, health.message);
        } else {
          // 'skip' — keep polling (auto-recovers), just don't standardize this cycle.
          await flagPipelineMessage(pid, health.message, 'warning');
        }
        await exec(connection,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE pipeline_id = ?`,
          [pid]);
        return;
      }
      // Source is healthy — clear any stale block message from a prior cycle.
      // Only when one is actually set, so healthy pipelines skip the extra write.
      if (p.status_message) await clearPipelineStatusMessage(pid);

      // ── Ensure stream exists and is valid ─────────────────────────────────
      // A standard (NOT append-only) stream captures inserts, updates, AND
      // deletes — deletes/updates let us drop rows from the export promptly so
      // values no longer in the source don't linger.  CREATE STREAM IF NOT
      // EXISTS is idempotent — it will NOT replace a stale stream that points to
      // a dropped/recreated table.  We validate via SYSTEM$STREAM_HAS_DATA
      // below; if that throws, we drop and recreate.
      try {
        await exec(connection, `
          CREATE STREAM IF NOT EXISTS ${streamRef}
          ON TABLE ${tableRef}`);
      } catch (e: any) {
        console.error(`[Poller] Pipeline ${pid}: failed to create stream:`, e?.message ?? e);
        return;
      }

      // One-time per process: upgrade a legacy APPEND_ONLY stream (created before
      // delete detection existed) to a standard delete-aware stream.  Recreating
      // resets the offset, so we reconcile from the source afterward to recover
      // any unconsumed inserts, then skip the rest of this cycle (stream is empty).
      if (!verifiedStandardStreams.has(pid)) {
        try {
          const streamRows = await exec(connection,
            `SHOW STREAMS LIKE 'PIPELINE_STREAM_${pid}' IN SCHEMA STAND_DB.STAND_INTERNAL`);
          const mode = streamRows.length
            ? String((streamRows[0] as any).mode ?? (streamRows[0] as any).MODE ?? '').toUpperCase()
            : '';
          if (mode === 'APPEND_ONLY') {
            await exec(connection, `CREATE OR REPLACE STREAM ${streamRef} ON TABLE ${tableRef}`);
            verifiedStandardStreams.add(pid);
            console.log(`[Poller] Pipeline ${pid}: upgraded APPEND_ONLY stream to standard (delete-aware)`);
            await exec(connection,
              `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
               SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
               WHERE pipeline_id = ?`,
              [pid]);
            // Offset was reset — recover gap rows (unmapped → queue, mapped → export).
            recoverAfterStreamReset(p);
            return;
          }
          verifiedStandardStreams.add(pid);
        } catch (modeErr: any) {
          // SHOW STREAMS failed (privileges / transient) — non-fatal, retry next poll.
          console.warn(`[Poller] Pipeline ${pid}: could not verify stream mode:`, modeErr?.message ?? modeErr);
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
            ON TABLE ${tableRef}`);
          verifiedStandardStreams.add(pid); // freshly created → already standard
          streamRecreated = true;
          console.log(`[Poller] Pipeline ${pid}: stream recreated — new inserts will be detected on next poll`);
        } catch (recreateErr: any) {
          console.error(`[Poller] Pipeline ${pid}: failed to recreate stream:`, recreateErr?.message ?? recreateErr);
        }
        await exec(connection,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE pipeline_id = ?`,
          [pid]);

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
        // Even with no new stream data, the queue may hold items from a previous
        // standardization that failed or timed out under load.  If the queue is
        // still above the threshold, re-trigger standardization now rather than
        // waiting up to an hour for the hourly sweep.
        if (p.mode === 'auto') {
          const [qRow] = await exec(connection,
            `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
            [pid]);
          const queueSize = Number(qRow?.CNT ?? qRow?.cnt ?? 0);
          if (queueSize > QUEUE_STANDARDIZE_THRESHOLD) {
            willStandardize = true;
            if (!opts.deferStandardization) {
              beginStandardization(pid);
              standardizationOwned = true;
            }
            console.log(`[Poller] Pipeline ${pid}: no new stream data but queue=${queueSize} > threshold — draining backlog`);
          }
        }

        await exec(connection,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE pipeline_id = ?`,
          [pid]);
        if (!willStandardize) {
          console.log(`[Poller] Pipeline ${pid}: no new rows in stream`);
        }
        return;
      }

      console.log(`[Poller] Pipeline ${pid}: stream has data — classifying (table: ${table_fqn}, col: ${column_name})`);

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
          LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
            ON lam.normalized_value = PRISM_NORMALIZE(TO_VARCHAR(s.${colRef}))
            ${domainJoinCond}
          WHERE s.METADATA$ACTION = 'INSERT'
            AND TO_VARCHAR(s.${colRef}) IS NOT NULL
          GROUP BY PRISM_NORMALIZE(TO_VARCHAR(s.${colRef}))`);

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

        // Step 2: Consuming MERGE — push list B into PIPELINE_QUEUE (within tx)
        // IMPORTANT: this DML always runs, even when listB is empty.  Referencing
        // the stream in ANY DML advances the stream offset on COMMIT — skipping this
        // would leave SYSTEM$STREAM_HAS_DATA true forever and re-count the same data
        // on every poll.  When listB is empty the USING subquery produces 0 rows so
        // no queue rows are inserted/updated, but the stream is still consumed.
        await exec(connection, `
          MERGE INTO STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE AS tgt
          USING (
            SELECT
              ANY_VALUE(TO_VARCHAR(s.${colRef})) AS literal_value,
              COUNT(*)                           AS new_row_count
            FROM ${streamRef} s
            LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
              ON lam.normalized_value = PRISM_NORMALIZE(TO_VARCHAR(s.${colRef}))
              ${domainJoinCond}
            WHERE s.METADATA$ACTION = 'INSERT'
              AND TO_VARCHAR(s.${colRef}) IS NOT NULL
              AND lam.literal_value IS NULL
            GROUP BY PRISM_NORMALIZE(TO_VARCHAR(s.${colRef}))
          ) AS src
            ON tgt.pipeline_id = ${pid} AND PRISM_NORMALIZE(tgt.literal_value) = PRISM_NORMALIZE(src.literal_value)
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

      listA              = classified.filter(r =>  r.already_mapped); // already confirmed — hoisted
      const listB        = classified.filter(r => !r.already_mapped); // needs standardization
      hasNewUnmapped     = listB.length > 0;                          // hoisted — manual mode exports these raw
      const listAFreqSum = listA.reduce((s, r) => s + r.new_row_count, 0);
      const totalNewRows = classified.reduce((s, r) => s + r.new_row_count, 0);

      // ── Step 4: Get queue size + source row count after consuming ─────────
      console.log(`[Poller] Pipeline ${pid}: stream consumed (MERGE complete)`);
      const [postMergeRow] = await exec(connection,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`,
        [pid]);
      const queueAfter  = Number(postMergeRow?.CNT ?? postMergeRow?.cnt ?? 0);

      const [srcRow] = await exec(connection,
        `SELECT COUNT(*) AS cnt FROM ${tableRef} WHERE ${colRef} IS NOT NULL`);
      const totalSourceValues = Number(srcRow?.CNT ?? srcRow?.cnt ?? 0);

      // ── Step 5: Determine if LLM standardization will run this cycle ──────
      //
      // Trigger whenever the queue is above the threshold after consuming the
      // stream — regardless of whether the queue grew this cycle or was already
      // above from a previous, partially-failed standardization run.
      //
      // Old behaviour keyed off crossedThreshold || grewWhileOver (listB.length > 0),
      // which missed the case where a prior standardization failed or timed out
      // under load and left items in the queue: the next poll would have listB=[]
      // (no new unmapped values) so grewWhileOver was false, and the backlog sat
      // until the hourly sweep.
      //
      // Manual-mode pipelines still detect and queue new values, but the owner
      // triggers standardization explicitly (process-queue route) — the
      // background threshold path must not fire for them.
      willStandardize = queueAfter > QUEUE_STANDARDIZE_THRESHOLD && p.mode === 'auto'; // hoisted

      // ── Step 6: If LLM will run, pause this pipeline's ring NOW ───────────
      // Ring turns amber in the UI and next poll cycle is skipped for this
      // pipeline.  This happens BEFORE the metrics push so the UI sees the
      // "Standardizing" state simultaneously with the pre-LLM metric snapshot.
      // When deferring (table batch), the caller's standardizeTable owns the
      // begin/end lifecycle for the whole table, so we don't begin here.
      if (willStandardize && !opts.deferStandardization) {
        beginStandardization(pid);
        standardizationOwned = true;
      }

      // ── Step 7: Push pre-LLM metrics in a single UPDATE ───────────────────
      // total_source_values = current source row count
      // total_mapped       += list A frequency (rows instantly confirmed by existing mappings)
      // queue_size          = after MERGE
      // If LLM runs, total_mapped will be further updated inside processPipelineQueue.
      await exec(connection, `
        UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
        SET total_source_values = ?,
            total_mapped        = total_mapped + ?,
            total_new_values    = total_new_values + ?,
            queue_size          = ?,
            last_polled_at      = CURRENT_TIMESTAMP(),
            updated_at          = CURRENT_TIMESTAMP()
        WHERE pipeline_id = ?`,
        [totalSourceValues, listAFreqSum, totalNewRows, queueAfter, pid]);
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

      if (listB.length === 0) {
        console.log(
          `[Poller] Pipeline ${pid}: ${totalNewRows} new row(s), ` +
          `all ${listA.length} distinct value(s) already mapped — stream consumed, metrics updated`,
        );
      } else {
        console.log(
          `[Poller] Pipeline ${pid}: ${totalNewRows} new row(s) — ` +
          `${listA.length} distinct already mapped (${listAFreqSum} rows), ` +
          `${listB.length} distinct queued (queue: ${queueAfter})`,
        );
      }
      // Export rebuild and LLM standardization run AFTER this connection closes
      // (see below) to avoid nested withSnowflake calls on the same process.
    });

    // ── Step 8: Export rebuild — runs on a fresh top-level connection ─────────
    // Moved outside the outer withSnowflake so there is no nested connection
    // contention.  Runs when:
    //   • listA.length > 0 — already-mapped values were inserted; they need to
    //     appear in the export immediately, not wait for the next LLM run.
    //   • hasDeletes — source rows were removed/updated; stale rows must drop out.
    //   • manual mode + hasNewUnmapped — new (unmapped) values must appear in the
    //     export in their RAW form right away (refreshExportTable LEFT JOINs in
    //     manual mode); they also stay queued for the user's manual review.
    //   • hasNullInserts (export table only) — new rows with a NULL in this column
    //     export as-is; rebuild so they appear without waiting for the hourly sweep.
    // Safe to run even when willStandardize is true; the post-LLM refresh in
    // processPipelineQueue overlays the same data.
    if (listA.length > 0 || hasDeletes || (p.mode === 'manual' && hasNewUnmapped) || (hasNullInserts && p.export_table_fqn != null)) {
      try {
        if (p.export_table_fqn) {
          await refreshExportTable(
            table_fqn,
            column_name,
            p.export_table_fqn,
            domain_id,
            pid,
          );
        } else {
          // No export table: recompute total_mapped absolutely.
          // Called for list A values too (not just deletes) so the absolute count
          // stays accurate even without an export table.
          await updatePipelineMappedCount(table_fqn, column_name, domain_id, pid);
        }
        // Suppressed during a table batch — syncTableLastPolled broadcasts once
        // at the end of the cycle instead (avoids mid-poll UI flicker).
        if (!opts.deferStandardization) broadcastPipelineEvent({ type: 'metrics_updated' });
      } catch (exportErr) {
        console.error(`[Poller] Pipeline ${pid}: export/metrics refresh failed:`, exportErr);
      }
    }

    // ── Step 9: LLM standardization when queue exceeds threshold ─────────────
    // processPipelineQueue handles its own beginStandardization (idempotent),
    // runs LLM, writes lookup + export, updates total_mapped, then calls
    // endStandardization in its finally block — which broadcasts
    // standardizing_finished and unpauses the ring.
    //
    // When deferring (table batch), the caller standardizes the whole table
    // together via standardizeTable — we only report whether this column wants it.
    if (willStandardize && !opts.deferStandardization) {
      const pipeline = await fetchPipelineById(pid);
      if (pipeline) {
        standardizationOwned = false; // hand off cleanup to processPipelineQueue
        await processPipelineQueue(pipeline, 'threshold');
      }
      // if pipeline not found: standardizationOwned remains true → finally block cleans up
    }
  } catch (e) {
    console.error(`[Poller] Pipeline ${pid}: poll error:`, e);
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
    }
    // 'transient' — logged above; retried next cycle.
  } finally {
    // Safety net: if beginStandardization was called but processPipelineQueue
    // never took ownership (pipeline lookup failed or exception thrown), ensure
    // the ring is always unpaused.
    if (standardizationOwned) {
      endStandardization(pid);
    }
  }

  return { willStandardize };
}

// ── Poll one table (all its columns as a single cycle) ─────────────────────────

/** Overwrite last_polled_at for all of a table's columns with one timestamp so the
 *  table card's polling ring is a single synchronized animation. */
async function syncTableLastPolled(pipelineIds: number[]): Promise<void> {
  if (pipelineIds.length === 0) return;
  try {
    await withSnowflake(async (conn) => {
      const placeholders = pipelineIds.map(() => '?').join(', ');
      await exec(conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id IN (${placeholders})`,
        pipelineIds);
    });
    broadcastPipelineEvent({ type: 'metrics_updated' });
  } catch (e) {
    console.warn(`[Poller] Failed to sync last_polled_at for table columns:`, e);
  }
}

/**
 * Poll for file-based pipelines (sheets, csv, excel).
 *
 * For Sheets pipelines that have a stored refresh_token: re-reads the Google
 * Sheet, replaces PIPELINE_FILE_ROWS with the current data, and recomputes
 * total_source_values / total_mapped / queue_size so new sheet rows appear in
 * the metrics automatically each cycle.
 *
 * For CSV / Excel (or Sheets without a refresh_token): just refreshes
 * queue_size from the existing PIPELINE_FILE_ROWS vs LITERAL_ALIAS_MATCHES.
 * last_polled_at is synced by syncTableLastPolled after this returns.
 */
async function pollOneFilePipeline(p: PipelineRef): Promise<void> {
  try {
    // Fetch the pipeline's file_source_meta to get the stored refresh_token.
    const meta = await withSnowflake(async (conn) => {
      const rows = await exec(conn,
        `SELECT file_source_meta FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ?`,
        [p.pipeline_id]);
      if (!rows.length) return null;
      const raw = (rows[0] as any).FILE_SOURCE_META ?? (rows[0] as any).file_source_meta;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
      return raw ?? {};
    });
    if (!meta) return;

    const colNames = Array.isArray(meta.columns) ? meta.columns.map((c: any) => c.column_name) : [];
    console.log(`[Poller] File pipeline ${p.pipeline_id} (${p.source_type}): columns=[${colNames.join(', ')}], has_refresh_token=${!!meta.refresh_token}`);

    // Sheets with a stored refresh_token: re-read the sheet and refresh file rows.
    if (p.source_type === 'sheets' && meta.refresh_token) {
      const metrics = await refreshSheetsFileRows(p.pipeline_id, meta);
      if (metrics) {
        console.log(`[Poller] File pipeline ${p.pipeline_id}: writing metrics → source=${metrics.totalSourceValues}, mapped=${metrics.totalMapped}, queue=${metrics.queueSize}`);
        await withSnowflake(async (conn) => {
          await exec(conn,
            `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
             SET total_source_values = ?,
                 total_mapped        = ?,
                 queue_size          = ?,
                 updated_at          = CURRENT_TIMESTAMP()
             WHERE pipeline_id = ?`,
            [metrics.totalSourceValues, metrics.totalMapped, metrics.queueSize, p.pipeline_id]);
        });
        broadcastPipelineEvent({ type: 'metrics_updated' });
        return;
      }
      console.warn(`[Poller] File pipeline ${p.pipeline_id}: Sheets re-read returned null — using cached PIPELINE_FILE_ROWS for metrics`);
    } else if (p.source_type === 'sheets' && !meta.refresh_token) {
      console.warn(`[Poller] File pipeline ${p.pipeline_id}: no refresh_token stored in file_source_meta — cannot re-read sheet`);
    }

    // CSV / Excel (or Sheets without token): recompute queue_size from existing file rows.
    console.log(`[Poller] File pipeline ${p.pipeline_id}: using lightweight fallback (PIPELINE_FILE_ROWS)`);
    let metricsUpdated = false;
    await withSnowflake(async (conn) => {
      // Guard: if PIPELINE_FILE_ROWS has no data for this pipeline, skip the update.
      // Sheets pipelines don't populate this table at creation — only refreshSheetsFileRows
      // does (which requires a refresh_token). Overwriting with 0 would erase the initial
      // metrics set by the export flow.
      const [countRow] = await exec(conn,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS WHERE pipeline_id = ?`,
        [p.pipeline_id]);
      const fileRowCount = Number((countRow as any).CNT ?? (countRow as any).cnt ?? 0);
      if (fileRowCount === 0) {
        console.log(`[Poller] File pipeline ${p.pipeline_id}: PIPELINE_FILE_ROWS is empty — skipping metrics update to preserve existing values`);
        return;
      }

      const columns: Array<Record<string, any>> =
        Array.isArray(meta.columns) && meta.columns.length > 0
          ? meta.columns.map((c: any) => ({
              column_name: String(c.column_name ?? ''),
              domain_id:   c.domain_id != null ? Number(c.domain_id) : null,
            }))
          : [{ column_name: String(meta.column_name ?? p.column_name ?? ''), domain_id: null }];

      let totalSourceValues = 0;
      let totalMapped       = 0;
      const updatedColumns: Array<Record<string, any>> = [];

      for (const col of columns) {
        if (!col.column_name) { updatedColumns.push(col); continue; }
        const safeCol    = col.column_name.replace(/'/g, "\\'");
        const domainCond = col.domain_id != null
          ? `AND lam.domain_id = ${col.domain_id}`
          : 'AND lam.domain_id IS NULL';

        const rows = await exec(conn, `
          WITH src AS (
            SELECT DISTINCT PRISM_NORMALIZE(column_data['${safeCol}']::VARCHAR) AS nv
            FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS
            WHERE pipeline_id = ?
              AND column_data['${safeCol}']::VARCHAR IS NOT NULL
              AND TRIM(column_data['${safeCol}']::VARCHAR) != ''
          )
          SELECT
            COUNT(*)               AS total,
            COUNT(lam.literal_value) AS mapped
          FROM src
          LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
            ON PRISM_NORMALIZE(lam.literal_value) = src.nv
            ${domainCond}
        `, [p.pipeline_id]);

        const colTotal  = rows.length > 0 ? Number((rows[0] as any).TOTAL  ?? (rows[0] as any).total  ?? 0) : 0;
        const colMapped = rows.length > 0 ? Number((rows[0] as any).MAPPED ?? (rows[0] as any).mapped ?? 0) : 0;
        console.log(`[Poller] File pipeline ${p.pipeline_id} fallback: column "${col.column_name}" (domain ${col.domain_id}) → total=${colTotal}, mapped=${colMapped}`);
        totalSourceValues += colTotal;
        totalMapped       += colMapped;
        updatedColumns.push({
          column_name: col.column_name,
          domain_id:   col.domain_id,
          total_source_values: colTotal,
          total_mapped:        colMapped,
        });
      }

      // Write per-column metrics into file_source_meta for the GET route's
      // virtual expansion.
      const updatedMeta = { ...meta, columns: updatedColumns };
      await exec(conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET file_source_meta   = PARSE_JSON(?),
             total_source_values = ?,
             total_mapped        = ?,
             queue_size          = ?,
             updated_at          = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [JSON.stringify(updatedMeta), totalSourceValues, totalMapped,
         Math.max(0, totalSourceValues - totalMapped), p.pipeline_id]);
      metricsUpdated = true;
    });
    if (metricsUpdated) broadcastPipelineEvent({ type: 'metrics_updated' });
  } catch (e) {
    console.warn(`[Poller] File pipeline ${p.pipeline_id}: metrics update failed:`, e);
  }
}

/**
 * Poll all columns of one table as a single cycle: each column's stream is
 * polled (with standardization deferred), then last_polled_at is synchronized
 * across the table, and if any auto-mode column crossed its threshold, every
 * auto column of the table is standardized together via standardizeTable.
 */
async function pollOneTable(cols: PipelineRef[]): Promise<void> {
  const pipelineIds = cols.map(c => c.pipeline_id);

  // The whole table shares ONE "Checking for new values" span, fired EVERY cycle
  // (not only when data is found). The UI ring fills to 100%, then instead of
  // animating a reset it switches straight into this teal span for the duration of
  // the poll; when the span ends the ring resumes the cycle from 0% — or, if the
  // queue crossed the threshold, standardizing_started supersedes it (teal → amber).
  // One span for all columns ⇒ a multi-column card shows a single check, not one
  // per column.
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

    // File-based pipelines (sheets/csv/excel) have no Snowflake stream — just
    // refresh their queue_size metric and let syncTableLastPolled stamp last_polled_at.
    const sfCols   = cols.filter(c => c.source_type === 'snowflake');
    const fileCols = cols.filter(c => c.source_type !== 'snowflake');
    for (const col of fileCols) {
      await pollOneFilePipeline(col);
    }

    let anyStandardize = false;
    for (const col of sfCols) {
      const res = await pollOnePipeline(col, { deferStandardization: true });
      if (res.willStandardize) anyStandardize = true;
    }

    // One synchronized poll timestamp for the whole table (broadcasts metrics_updated).
    await syncTableLastPolled(pipelineIds);

    // Standardize every auto-mode Snowflake column of the table together (manual
    // columns still only queue; file-based pipelines never auto-standardize here).
    // Kept inside the try so the scanning span stays open until standardizing_started
    // takes over on the client — teal flows straight into amber with no gap.
    if (anyStandardize) {
      const autoCols = sfCols.filter(c => c.mode === 'auto');
      const toProcess: PipelineForProcessing[] = [];
      for (const c of autoCols) {
        const pf = await fetchPipelineById(c.pipeline_id);
        if (pf) toProcess.push(pf);
      }
      if (toProcess.length > 0) {
        console.log(`[Poller] Table ${cols[0].table_fqn}: standardizing ${toProcess.length} column(s) together`);
        await standardizeTable(toProcess, 'threshold');
      }
    }
  } finally {
    // End the check (in a finally so it never sticks teal on error). For columns
    // that standardized, the client already left the scanning state when
    // standardizing_started arrived, so this is just a no-op cleanup for them.
    endScan();
  }
}

// ── Background loop ───────────────────────────────────────────────────────────

export function startPoller(): void {
  // Guard against hot-reload creating multiple intervals in development
  const g = global as any;
  if (g.__pipelinePollerStarted) return;
  g.__pipelinePollerStarted = true;

  // Per-table independent poll loops.
  //
  // Each source table polls on its OWN self-chaining cadence (next cycle 30 s
  // after this one fully completes), anchored to its own last_polled_at. Why not
  // one global loop sweeping all tables:
  //   • A global chain polls each table at the chain's phase, not the table's, so
  //     a freshly-activated table's first poll lands at an arbitrary point in the
  //     ring's countdown — the "ring picks up at a random time" the first time a
  //     value is added. Per-table loops fire the first poll exactly one interval
  //     after the table is anchored, so detection lands at the cycle boundary.
  //   • With several tables, a global chain's 30 s tail is shared, so each table's
  //     ring drifts by the others' poll durations. Independent loops don't drift.
  //
  // (All COLUMNS of a table still poll together inside pollOneTable and share one
  // synchronized last_polled_at — that's what keeps a multi-column card's ring a
  // single aligned animation.)
  const tableTimers: Map<string, ReturnType<typeof setTimeout>> =
    g.__pipelineTableTimers ?? (g.__pipelineTableTimers = new Map());

  async function pollTableLoop(tableFqn: string): Promise<void> {
    let reschedule = true;
    try {
      const all  = await fetchActivePipelines();
      const cols = all.filter(p => p.table_fqn === tableFqn);
      if (cols.length === 0) {
        reschedule = false; // table no longer active — stop its loop (supervisor restarts it if it returns)
      } else {
        await pollOneTable(cols);
      }
    } catch (e) {
      // Unknown state (e.g. transient fetch failure) — keep the loop alive and retry.
      console.error(`[Poller] Table ${tableFqn}: poll cycle failed:`, e);
    } finally {
      if (reschedule) {
        tableTimers.set(tableFqn, setTimeout(() => { void pollTableLoop(tableFqn); }, POLL_INTERVAL_MS));
      } else {
        tableTimers.delete(tableFqn);
      }
    }
  }

  // Anchor a table's ring to NOW so its countdown starts cleanly the moment its
  // loop begins, and the first real poll (scheduled one interval later) lands at
  // 100% rather than at a stale/random phase.
  async function anchorTableRing(tableFqn: string): Promise<void> {
    try {
      await withSnowflake(async (conn) => {
        await exec(conn,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_polled_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE table_fqn = ? AND status = 'active'`,
          [tableFqn]);
      });
      broadcastPipelineEvent({ type: 'metrics_updated' });
    } catch (e) {
      console.warn(`[Poller] Could not anchor ring for table ${tableFqn}:`, e);
    }
  }

  // Supervisor: discover active tables and start a loop for any that don't have
  // one yet (covers boot, and pipelines activated later). Runs often enough that
  // a newly-activated pipeline starts polling promptly.
  let supervising = false;
  async function superviseTables(): Promise<void> {
    if (supervising) return; // never let two ticks run concurrently (would double-start a loop)
    supervising = true;
    try {
      const pipelines = await fetchActivePipelines();
      const activeTables = new Set(pipelines.map(p => p.table_fqn));
      for (const tableFqn of activeTables) {
        if (tableTimers.has(tableFqn)) continue;
        // Reserve the slot first so a later tick can't double-start the same table.
        tableTimers.set(tableFqn, setTimeout(() => { void pollTableLoop(tableFqn); }, POLL_INTERVAL_MS));
        void anchorTableRing(tableFqn);
      }
    } catch {
      // transient — try again next supervisor tick
    } finally {
      supervising = false;
    }
  }

  // Discover tables shortly after boot, then keep picking up newly activated ones.
  setTimeout(() => { void superviseTables(); }, 5_000);
  setInterval(() => { void superviseTables(); }, 15_000);

  // Drain any queues that were above threshold when the server last shut down.
  // Without this, a queue that was already >threshold before a restart would
  // never trigger the threshold-based standardization path (SYSTEM$STREAM_HAS_DATA
  // returns false when no new inserts have arrived, so pollOnePipeline returns
  // early on every cycle and the queue sits until the hourly processor fires).
  setTimeout(() => {
    runHourlyStandardization().catch(e =>
      console.error('[Poller] Startup queue drain failed:', e)
    );
  }, 15_000);

  console.log('[Poller] Background pipeline poller started (per-table loops, 30 s cadence)');
}
