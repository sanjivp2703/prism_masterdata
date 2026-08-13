/**
 * POST /api/pipelines/[pipeline_id]/process-queue
 *
 * Premium only.  On-demand bulk standardization.  Handles two modes:
 *
 *   pending_baseline  — fetches all distinct non-null values directly from the
 *                       source Snowflake column, runs the full auto-group + LLM
 *                       pipeline, exports results to the lookup tables, then
 *                       advances the pipeline from pending_baseline → paused.
 *
 *   active | paused   — drains the current PIPELINE_QUEUE through the same
 *                       auto-group + LLM + export pipeline, then removes
 *                       successfully processed items from the queue.
 *
 * In both cases the standardized export table is rebuilt fire-and-forget if
 * the pipeline has export_table_fqn configured.
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse, executeQuery as exec } from '@/app/api/_lib/warehouse';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { broadcastPipelineEvent } from '@/app/api/_lib/pipeline-broadcaster';
import { PIPELINE_BLOCK_REASONS } from '@/app/api/_lib/pipeline-alerts';
import { internalObject, prismNormalizeFn } from '@/app/api/_lib/warehouse-tables';
import { getAnthropicApiKey } from '@/app/api/_lib/anthropic-key';
import {
  fetchPipelineById,
  fetchQueueLiteralsWithFreq,
  bulkProcessPipelineQueue,
  type PipelineForProcessing,
} from '@/app/api/_lib/pipeline-hourly-processor';

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

/** Fetch all distinct non-null values from the pipeline's source column. */
async function fetchSourceLiterals(
  conn: any,
  pipeline: PipelineForProcessing,
): Promise<string[]> {
  const parts = pipeline.table_fqn.split('.');
  if (parts.length !== 3) return [];
  const tableRef = parts.map(p => quoteIdent(p.trim())).join('.');
  const colRef   = quoteIdent(pipeline.column_name);

  // Dedup by the normalized form; ANY_VALUE keeps a representative original.
  const rows = await exec(conn, `
    SELECT ANY_VALUE(${colRef}) AS val
    FROM ${tableRef}
    WHERE ${colRef} IS NOT NULL
    GROUP BY ${prismNormalizeFn()}(TO_VARCHAR(${colRef}))
    LIMIT 5000
  `);
  return rows.map((r: any) => String(r.VAL ?? r.val ?? '')).filter(Boolean);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore  = await cookies();
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  // Google OAuth tokens — same cookies set at sign-in (login already requests Sheets scope).
  const gAccessToken  = cookieStore.get('google_access_token')?.value;
  const gRefreshToken = cookieStore.get('google_refresh_token')?.value;
  const gTokenExpiry  = cookieStore.get('google_token_expiry')?.value;

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
    // ── Fetch pipeline ───────────────────────────────────────────────────────
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    // ── Refuse while a blocking condition is flagged ─────────────────────────
    // A masking / row-access policy on the watched column makes the service
    // role see masked or filtered values. Standardizing those would write
    // nonsense into LITERAL_ALIAS_MATCHES permanently, indistinguishable from
    // legitimately confirmed mappings. The poller already flags this and skips
    // its own queuing, but nothing stopped an owner clicking "Update
    // Standardizations" straight through it — so refuse here too, with the
    // same prose the card is showing them.
    const blocked = getDb()
      .prepare(`SELECT status_message, status_reason FROM pipelines WHERE pipeline_id = ?`)
      .get(pid) as { status_message?: string | null; status_reason?: string | null } | undefined;
    if (blocked?.status_reason && (PIPELINE_BLOCK_REASONS as readonly string[]).includes(blocked.status_reason)) {
      return Response.json(
        {
          error: blocked.status_message
            ?? 'Standardization is blocked for this pipeline right now. It resumes automatically when the condition clears.',
          reason: blocked.status_reason,
        },
        { status: 409 },
      );
    }

    const isInitial      = pipeline.status === 'pending_baseline';
    // ── Collect literals to process ───────────────────────────────────────────
    const literals = await withWarehouse(async (conn) => {
      if (isInitial) {
        // Pre-create the stream BEFORE scanning the source table so there is
        // no gap between what the baseline scan sees and what the stream tracks.
        // Values in the table at scan time  → caught by the baseline scan.
        // Values inserted after this point  → caught by the stream on next poll.
        const parts      = pipeline.table_fqn.split('.');
        const tableRef   = parts.map(p => quoteIdent(p.trim())).join('.');
        const streamName = internalObject(`PIPELINE_STREAM_${pid}`);
        try {
          await exec(conn, `
            CREATE STREAM IF NOT EXISTS ${streamName}
            ON TABLE ${tableRef}`);
          console.log(`[ProcessQueue] Pipeline ${pid}: stream pre-created (${streamName})`);
        } catch (streamErr: any) {
          console.warn(`[ProcessQueue] Pipeline ${pid}: could not pre-create stream:`, streamErr?.message ?? streamErr);
        }
        return fetchSourceLiterals(conn, pipeline);
      }
      // Use the CAPPED fetch (5,000 FIFO installment), same as the 10-minute
      // tick and the "Manual review" option. This route previously used the
      // uncapped fetchQueueLiterals, so one click on "Auto-standardize" drained
      // the ENTIRE queue — live-measured at 12,345 values in a single run,
      // which for genuinely new values is ~494 parallel LLM chunk calls plus a
      // merge pass over hundreds of groups. That is precisely the failure the
      // cap's own rationale comment describes, and it contradicted CLAUDE.md's
      // documented "manual trigger = one 5k installment per click".
      const capped = await fetchQueueLiteralsWithFreq(conn, pid);
      return capped.map((r) => r.literal_value);
    });

    if (literals.length === 0) {
      // Nothing to do — for initial pipelines still advance the status.
      if (isInitial) {
        getDb().prepare(`
          UPDATE pipelines
          SET status              = 'paused',
              last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE pipeline_id = ? AND status = 'pending_baseline'
        `).run(pid);
      }
      return Response.json({
        ok: true,
        items_written: 0,
        literals_processed: 0,
        message: isInitial ? 'No values found in source table.' : 'Queue is empty.',
        sheets_sync: null,
      });
    }

    // ── Run auto-group + LLM + direct export ─────────────────────────────────
    broadcastPipelineEvent({ type: 'standardizing_started', pipeline_id: pid });
    const result = await bulkProcessPipelineQueue(pipeline, literals, apiKey);
    broadcastPipelineEvent({ type: 'standardizing_finished', pipeline_id: pid });

    // ── Update pipeline state ────────────────────────────────────────────────
    await withWarehouse(async (conn) => {
      if (isInitial) {
        // Advance pending_baseline → paused.
        getDb().prepare(`
          UPDATE pipelines
          SET status              = 'paused',
              total_new_values    = ?,
              queue_size          = 0,
              last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE pipeline_id = ?
        `).run(result.literals_processed, pid);
      } else {
        // Remove successfully exported items from the queue.
        // The queue cleanup and queue_size recompute that used to live here
        // were REDUNDANT and actively harmful (KI-166).
        //
        // bulkProcessPipelineQueue already calls removeExportedFromQueue, which
        // does exactly this AND batches the DELETE at
        // getWarehouseAdapter().bindLimit - 100. The copy here built ONE
        // IN-list with a bind per exported literal, so on SQL Server — capped
        // at 2,100 parameters per request — any queue over ~2,099 values threw
        // "The incoming request has too many parameters". Because it ran AFTER
        // the mappings were written and the queue already drained, the throw
        // was caught by the outer handler and returned as a 500, so the user
        // saw "Auto-standardize failed" for work that had actually SUCCEEDED.
        // Snowflake tolerated it only because its bind ceiling is ~65k.
      }
    });

    // Export table refresh is handled inside runOpExportDirect after writes commit.

    return Response.json({
      ok:                  true,
      run_id:              result.run_id,
      groups_created:      result.groups_created,
      items_written:       result.items_written,
      lookup_matched:      result.lookup_matched,
      llm_grouped:         result.llm_grouped,
      literals_processed:  result.literals_processed,
      pipeline_advanced:   isInitial,
      sheets_sync:         null,
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to process pipeline queue');
  }
}
