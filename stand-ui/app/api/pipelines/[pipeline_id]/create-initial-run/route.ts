/**
 * POST /api/pipelines/[pipeline_id]/create-initial-run
 *
 * Premium only. Creates a review run for the pipeline's initial baseline
 * mapping so the user can inspect and adjust groupings before accepting.
 *
 *   1. Fetch all distinct non-null values from the source column (up to 5 000).
 *   2. Create a run via createRunFromQueue and run auto-group for LLM suggestions.
 *   3. Return { run_id } — the caller navigates to /run/:run_id for review.
 *
 * Contrast with process-queue, which auto-exports without user review.
 * If the source table is empty the pipeline is advanced directly to 'paused'
 * and { run_id: null } is returned so the UI can skip the review step.
 */

import { cookies } from 'next/headers';
import { withWarehouse, withUserWarehouse, hasUserWarehouseConfig, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter, isWarehouseAccessError, resolveSourceReference } from '@/app/api/_lib/warehouse';
import { markPipelineUserConnection } from '@/app/api/_lib/pipeline-user-connection';
import { diffScan, initDetection, enableCt, grantViewChangeTracking} from '@/app/api/_lib/warehouse/mssql/detection';
import { diffScan as pgDiffScan, initDetection as pgInitDetection } from '@/app/api/_lib/warehouse/postgres/detection';
import { diffScan as myDiffScan, initDetection as myInitDetection } from '@/app/api/_lib/warehouse/mysql/detection';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { llmErrorResponse } from '@/app/api/_lib/llm-one-prompt-grouping';
import { getDb } from '@/app/api/_lib/sqlite';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
import { internalObject, prismNormalizeFn } from '@/app/api/_lib/warehouse-tables';
import {
  fetchPipelineById,
  createRunFromQueue,
  type PipelineForProcessing,
} from '@/app/api/_lib/pipeline-hourly-processor';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';
import { isChangeTrackingPrivilegeError } from '@/app/api/_lib/pipeline-poller';
import { flagPipelineMessage, clearPipelineStatusMessage } from '@/app/api/_lib/pipeline-alerts';
import { appendTiming } from '@/app/api/_lib/timing';

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

/**
 * Distinct source values for the baseline run, WITH their real frequencies.
 *
 * Returns a representative original per normalized value plus how many source
 * rows collapsed into it. Both halves used to be thrown away: Snowflake never
 * computed a count at all, and the mssql branch called diffScan (which DOES
 * compute correct per-value frequencies) and then mapped them off with
 * `.map(v => v.literal_value)`. Everything fed into createRunFromQueue with no
 * frequency map, so buildInitialQueueRunState's `frequencies?.get(lv) ?? 1`
 * fallback stamped source_frequency = 1 on every item regardless of whether one
 * row or eight thousand normalized into it (REV-01).
 *
 * Nothing read the field at the time, which is exactly why it was worth fixing
 * rather than deleting: a silently-wrong number is a landmine for the first
 * consumer that trusts it (prevalence sorting, an "N rows affected" count,
 * frequency-weighted grouping). The tick path already supplied real counts from
 * PIPELINE_QUEUE.source_frequency, so the baseline path was also the ONLY place
 * the two disagreed.
 */
async function fetchSourceLiterals(
  conn: any,
  pipeline: PipelineForProcessing,
): Promise<{ literals: string[]; frequencies: Map<string, number> }> {
  // SQL Server / Postgres / MySQL: no SQL-side normalize — the detection
  // engines' diff scans read distincts and dedup on normalizeLiteral
  // app-side. Same 5k cap. This branch runs BEFORE the 3-part gate below:
  // the scan functions parse/validate FQNs themselves, and MySQL FQNs are
  // legitimately TWO-part (no schema level) — the old gate order returned an
  // empty baseline for them.
  if (getWarehouseAdapter().kind === 'mssql' || getWarehouseAdapter().kind === 'postgres' || getWarehouseAdapter().kind === 'mysql') {
    const kind = getWarehouseAdapter().kind;
    const scanFn = kind === 'mssql' ? diffScan : kind === 'mysql' ? myDiffScan : pgDiffScan;
    const scan = await scanFn(conn, pipeline.table_fqn, pipeline.column_name);
    const values = scan.values.slice(0, 5000);
    const frequencies = new Map<string, number>();
    for (const v of values) {
      // diffScan already returns a real per-value count — keep it.
      frequencies.set(v.literal_value, Number((v as { frequency?: number }).frequency ?? 1) || 1);
    }
    return { literals: values.map(v => v.literal_value), frequencies };
  }

  const parts = pipeline.table_fqn.split('.');
  if (parts.length !== 3) return { literals: [], frequencies: new Map() };
  // Reference-granted source (native edition): address via
  // reference('source_table','<alias>'); null everywhere else.
  const tableRef = (await resolveSourceReference(conn, {
    db: parts[0].trim(), schema: parts[1].trim(), table: parts[2].trim(),
  }))?.refSql ?? parts.map(p => quoteIdent(p.trim())).join('.');
  const colRef   = quoteIdent(pipeline.column_name);

  // Dedup by the normalized form; ANY_VALUE keeps a representative original,
  // COUNT(*) is how many source rows collapsed into it.
  const rows = await exec(conn, `
    SELECT ANY_VALUE(${colRef}) AS val, COUNT(*) AS freq
    FROM ${tableRef}
    WHERE ${colRef} IS NOT NULL
    GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(${colRef}))
    LIMIT 5000
  `);
  const literals: string[] = [];
  const frequencies = new Map<string, number>();
  for (const r of rows as any[]) {
    const val = String(r.VAL ?? r.val ?? '');
    if (!val) continue;
    literals.push(val);
    frequencies.set(val, Number(r.FREQ ?? r.freq ?? 1) || 1);
  }
  return { literals, frequencies };
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore = await cookies();
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return Response.json({ error: 'No Anthropic API key configured — add one on the setup page.' }, { status: 500 });
  }

  try {
    const _t0 = Date.now();
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }
    appendTiming(`[Timing] initial-run.fetch_pipeline: ${Date.now() - _t0}ms (pipeline ${pid})`);

    const _scanStart    = Date.now();

    // Pre-create the stream BEFORE scanning so there's no gap between what the
    // review run sees and what the stream tracks once the pipeline is activated.
    // Uses its own connections (sequential, never nested inside the scan
    // connection): creating the FIRST stream on a table auto-enables change
    // tracking, which needs MODIFY — the service role typically has only
    // SELECT. When that fails, try enabling change tracking with the CREATOR'S
    // saved personal Snowflake credentials (the same mechanism the one-time
    // flow uses), then retry; only when that's impossible does the card get a
    // heads-up message with the exact fix SQL. Setup itself can continue — the
    // review run only needs SELECT.
    if (getWarehouseAdapter().kind === 'mssql') {
      // SQL Server: initialize change detection (Change Tracking when the
      // table qualifies, tiered diff scan otherwise). ALTER DATABASE/ALTER
      // TABLE are schema-modifying DDL, so — mirroring the Column output
      // mode's consent gate — Prism only attempts the CT-enable ladder
      // (service connection → the creator's saved personal credentials) when
      // the creator explicitly consented via the connect-form disclosure.
      // Without consent this is a pure status check: whatever's already
      // enabled is used, nothing is altered, and diff-scan is the fallback —
      // never blocks setup either way.
      const consentRow = getDb()
        .prepare(`SELECT change_tracking_consent, use_user_connection, created_by, export_kind FROM pipelines WHERE pipeline_id = ?`)
        .get(pid) as any;
      const ctConsent = consentRow?.change_tracking_consent === 1;
      // A user-connection pipeline (source visible only to the creator's
      // personal credentials — flag set below on the scan fallback, or on a
      // previous visit) runs detection init on THAT connection: the detection
      // state must reflect the connection the poller will actually poll with.
      const alreadyUserConn = consentRow?.use_user_connection === 1;
      const creatorId = consentRow?.created_by != null ? Number(consentRow.created_by) : Number(session.accountId);
      const withDetectionConn = alreadyUserConn
        ? <T,>(fn: (conn: any) => Promise<T>) => withUserWarehouse(creatorId, fn)
        : withWarehouse;
      try {
        let state = await withDetectionConn(async (conn) =>
          initDetection(conn, pipeline.table_fqn, { tryEnable: ctConsent }));
        // 'ct_no_grant' escalates too, not just 'ct_disabled'. Splitting those
        // two reasons (INS-M09) would otherwise have narrowed this condition by
        // accident and silently stopped the personal-credential retry for the
        // missing-permission case — which is precisely the case that retry can
        // fix, since granting VIEW CHANGE TRACKING needs rights the service
        // login lacks. enableCt is safe to call when CT is already on.
        if (!alreadyUserConn && ctConsent && state.mode === 'diff'
            && (state.diff_reason === 'ct_disabled' || state.diff_reason === 'ct_no_grant')
            && (await hasUserWarehouseConfig(Number(session.accountId)))) {
          try {
            await withUserWarehouse(Number(session.accountId), async (conn) => {
              await enableCt(conn, pipeline.table_fqn);
              await grantViewChangeTracking(conn, pipeline.table_fqn);
            });
            state = await withWarehouse(async (conn) =>
              initDetection(conn, pipeline.table_fqn, { tryEnable: false }));
            console.log(`[InitialRun] Pipeline ${pid}: enabled Change Tracking using the creator's saved credentials`);
          } catch (fixErr: any) {
            console.warn(`[InitialRun] Pipeline ${pid}: personal-credential Change Tracking enable failed:`, fixErr?.message ?? fixErr);
          }
        }
        getDb()
          .prepare(`UPDATE pipelines SET detection_mode = ?, detection_state = ? WHERE pipeline_id = ?`)
          .run(state.mode, JSON.stringify(state), pid);
        console.log(`[InitialRun] Pipeline ${pid}: detection initialized — mode=${state.mode}${state.diff_reason ? ` (${state.diff_reason})` : ''}`);
      } catch (detErr: any) {
        console.warn(`[InitialRun] Pipeline ${pid}: detection init failed (poller will retry):`, detErr?.message ?? detErr);
      }
    } else if (getWarehouseAdapter().kind === 'postgres' || getWarehouseAdapter().kind === 'mysql') {
      // Postgres/MySQL: every pipeline runs diff mode (no CT analog, no
      // consent ladder — detection needs no DDL at all). Pure status/state
      // init; never blocks setup.
      const isMy = getWarehouseAdapter().kind === 'mysql';
      try {
        const state = await withWarehouse(async (conn) =>
          isMy ? myInitDetection(conn, pipeline.table_fqn) : pgInitDetection(conn, pipeline.table_fqn));
        getDb()
          .prepare(`UPDATE pipelines SET detection_mode = ?, detection_state = ? WHERE pipeline_id = ?`)
          .run(state.mode, JSON.stringify(state), pid);
        console.log(`[InitialRun] Pipeline ${pid}: detection initialized — mode=diff (${isMy ? 'mysql_diff' : 'pg_diff'})`);
      } catch (detErr: any) {
        console.warn(`[InitialRun] Pipeline ${pid}: detection init failed (poller will retry):`, detErr?.message ?? detErr);
      }
    } else {
      const parts = pipeline.table_fqn.split('.');
      if (parts.length === 3) {
        const tableRef   = parts.map(p => quoteIdent(p.trim())).join('.');
        const streamName = internalObject(`PIPELINE_STREAM_${pid}`);
        const createStream = () => withWarehouse(async (conn) => {
          // Reference-granted source (native): create the stream via the
          // reference form — the app has no FQN visibility on it.
          const srcRef = (await resolveSourceReference(conn, {
            db: parts[0].trim(), schema: parts[1].trim(), table: parts[2].trim(),
          }))?.refSql ?? tableRef;
          return exec(conn, `CREATE STREAM IF NOT EXISTS ${streamName} ON TABLE ${srcRef}`);
        });
        try {
          await createStream();
        } catch (streamErr: any) {
          console.warn(`[InitialRun] Pipeline ${pid}: could not pre-create stream:`, streamErr?.message ?? streamErr);
          if (isChangeTrackingPrivilegeError(streamErr)) {
            let fixed = false;
            if (await hasUserWarehouseConfig(Number(session.accountId))) {
              try {
                await withUserWarehouse(Number(session.accountId), async (conn) => {
                  await exec(conn, `ALTER TABLE ${tableRef} SET CHANGE_TRACKING = TRUE`);
                });
                await createStream();
                fixed = true;
                console.log(`[InitialRun] Pipeline ${pid}: enabled change tracking on ${pipeline.table_fqn} using the creator's saved credentials`);
              } catch (fixErr: any) {
                console.warn(`[InitialRun] Pipeline ${pid}: automatic change-tracking fix failed:`, fixErr?.message ?? fixErr);
              }
            }
            if (!fixed) {
              flagPipelineMessage(
                pid,
                `Heads up: Prism won't be able to watch ${pipeline.table_fqn} for new values yet — change tracking is not enabled on the table and the service role can't enable it. ` +
                `Run in Snowflake as the table owner or an admin: ALTER TABLE ${pipeline.table_fqn} SET CHANGE_TRACKING = TRUE; ` +
                `(or GRANT MODIFY ON TABLE ${pipeline.table_fqn} TO ROLE PRISM_SERVICE; or save your own Snowflake credentials in Setup so Prism can enable it for you.)`,
              ).catch(() => {});
            }
          }
        }
      }
    }

    // Warehouse pipelines supply real summed counts on both adapters (REV-01).
    // mssql: a pipeline already marked user-connection scans on the creator's
    // personal credentials; otherwise scan on the service connection and, when
    // that fails with an ACCESS error, fall back to the creator's credentials
    // (the pipeline analog of the one-time flow's personal-connection
    // fallback) and persist the choice for the poller/tick/export.
    let scanned: { literals: string[]; frequencies: Map<string, number> };
    const isMssql = getWarehouseAdapter().kind === 'mssql';
    const connRow = isMssql
      ? getDb().prepare(`SELECT use_user_connection, created_by, export_kind FROM pipelines WHERE pipeline_id = ?`).get(pid) as any
      : null;
    const scanCreatorId = connRow?.created_by != null ? Number(connRow.created_by) : Number(session.accountId);
    if (isMssql && connRow?.use_user_connection === 1) {
      scanned = await withUserWarehouse(scanCreatorId, async (conn) => fetchSourceLiterals(conn, pipeline));
    } else {
      try {
        scanned = await withWarehouse(async (conn) => fetchSourceLiterals(conn, pipeline));
      } catch (scanErr) {
        const canFallBack =
          isMssql &&
          isWarehouseAccessError(scanErr) &&
          (await hasUserWarehouseConfig(scanCreatorId));
        if (!canFallBack) throw scanErr;
        // Column mode writes onto the source via the SERVICE connection at
        // sync time — it cannot run split-connection. Refuse loudly rather
        // than building a pipeline that will fail at its first sync.
        if (String(connRow?.export_kind ?? '') === 'column') {
          return Response.json(
            {
              error:
                `Prism's service login can't see ${pipeline.table_fqn}, and the Column output mode ` +
                `can't run on personal credentials. Grant the service login access to the table ` +
                `(see the setup page's access SQL), or choose a different output mode.`,
            },
            { status: 400 },
          );
        }
        scanned = await withUserWarehouse(scanCreatorId, async (conn) => fetchSourceLiterals(conn, pipeline));
        markPipelineUserConnection(pid);
        // The POST route's table-mode access preflight ran against the SERVICE
        // login and may have flagged "needs CREATE TABLE …" — irrelevant now
        // that the build runs on the creator's own access. Clear it.
        await clearPipelineStatusMessage(pid).catch(() => {});
        console.log(
          `[InitialRun] Pipeline ${pid}: service login can't read ${pipeline.table_fqn} — ` +
          `switched to the creator's personal credentials for source reads`,
        );
        // Detection init above ran (or failed) on the service connection —
        // redo it on the connection the poller will actually use, so the
        // stored mode/state reflect the polling identity's real permissions.
        try {
          const consent = getDb().prepare(`SELECT change_tracking_consent FROM pipelines WHERE pipeline_id = ?`).get(pid) as any;
          const st = await withUserWarehouse(scanCreatorId, async (conn) =>
            initDetection(conn, pipeline.table_fqn, { tryEnable: consent?.change_tracking_consent === 1 }));
          getDb()
            .prepare(`UPDATE pipelines SET detection_mode = ?, detection_state = ? WHERE pipeline_id = ?`)
            .run(st.mode, JSON.stringify(st), pid);
        } catch (detErr: any) {
          console.warn(`[InitialRun] Pipeline ${pid}: user-connection detection re-init failed (poller will retry):`, detErr?.message ?? detErr);
        }
      }
    }
    const literals = scanned.literals;
    appendTiming(`[Timing] initial-run.source_scan: ${Date.now() - _scanStart}ms (${literals.length} distinct value(s))`);

    // Empty source table — advance directly to paused, no run needed.
    if (literals.length === 0) {
      getDb().prepare(`
        UPDATE pipelines
        SET status              = 'paused',
            last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE pipeline_id = ? AND status = 'pending_baseline'
      `).run(pid);
      return Response.json({ run_id: null, message: 'No values found in source table — pipeline is ready.' });
    }


    // RESUME an already-reviewed run instead of silently replacing it.
    //
    // This route backs the "Continue" button on an Incomplete pipeline card. It
    // used to unconditionally create a NEW run and re-run auto-group, and
    // createRunFromQueue's reuse lookup deliberately excludes 'approved' and
    // 'completed'. So a user who reviewed a column, accepted it (which marks the
    // run 'approved' and writes nothing yet — the deferred-write design), then
    // left and came back, got a brand-new run and a fresh LLM pass: their
    // completed review was orphaned, silently, along with the LLM spend that
    // produced it (PIPE-16b, live-reproduced).
    //
    // 'approved' means "reviewed, awaiting the commit at Begin". Handing that
    // run back is the whole point of the wizard being resumable. Deliberately
    // NOT reused: 'completed' (already written to the lookup — a new run is
    // correct there) and 'failed' (createRunFromQueue's own stale-reuse handles
    // it).
    const existingApproved = getDb()
      .prepare(
        `SELECT run_id FROM runs
         WHERE source_relation = ? AND source_column = ? AND run_status = 'approved'
         ORDER BY run_id DESC LIMIT 1`,
      )
      .get(pipeline.table_fqn, pipeline.column_name) as { run_id?: number } | undefined;
    if (existingApproved?.run_id) {
      console.log(
        `[InitialRun] Pipeline ${pid}: resuming already-approved run ${existingApproved.run_id} ` +
        `for "${pipeline.column_name}" instead of creating a new one`,
      );
      return Response.json({ run_id: Number(existingApproved.run_id), resumed: true });
    }

    // Create run and run auto-group for initial suggestions.
    const runId = await withWarehouse(async (conn) => {
      const _runStart = Date.now();
      const id = await createRunFromQueue(conn, pipeline, literals, scanned.frequencies);
      appendTiming(`[Timing] initial-run.create_run: ${Date.now() - _runStart}ms (run ${id})`);
      const _agStart = Date.now();
      await runAutoGroupForRun(conn, id, apiKey, { writeBreakdown: false });
      appendTiming(`[Timing] initial-run.auto_group_total: ${Date.now() - _agStart}ms`);
      return id;
    });
    appendTiming(`[Timing] initial-run.TOTAL: ${Date.now() - _t0}ms (pipeline ${pid}, run ${runId})`);

    return Response.json({ run_id: runId });
  } catch (err) {
    // Classify AI-provider failures BEFORE the warehouse sanitizer, which is
    // tuned for Snowflake/SQL Server shapes and would discard the provider's
    // own actionable message (rate-limit retry hints, rejected-key detail).
    // Returns null for anything not provider-shaped, so warehouse errors are
    // handled exactly as before.
    const llmResp = llmErrorResponse(err);
    if (llmResp) return llmResp;
    return warehouseErrorResponse(err, 'Failed to create initial mapping run');
  }
}
