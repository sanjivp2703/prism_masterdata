/**
 * Pipeline alerting + pause/resume helpers.
 *
 * Two surfaces, both pushed to the UI over SSE (see pipeline-broadcaster.ts):
 *   • Persistent reason — PIPELINES.status_message, shown on a paused/blocked
 *     pipeline's card until the condition clears.
 *   • Transient toast/banner — an `alert` SSE event with a ttl_ms the UI fades.
 *
 * Used by the poller/guards to react to source-table problems (table dropped,
 * column missing, masking policy, revoked access, …) and global failures
 * (expired key, suspended warehouse) per the agreed handling:
 *   - table-specific problem  → pausePipelineWithMessage (persistent + toast)
 *   - global auth/warehouse   → broadcastGlobalAlert (transient banner, auto-resume)
 */
import 'server-only';

import { getDb } from './sqlite';
import { broadcastPipelineEvent, type AlertLevel } from './pipeline-broadcaster';

const DEFAULT_TTL_MS = 12_000;

/**
 * Pause a pipeline and record a human-readable reason.  Idempotent: only writes
 * when the pipeline isn't already paused with this exact message, so repeated
 * poll cycles don't churn the row or re-toast.  Returns true if it changed state
 * (and emitted a toast), false if it was already in this paused state.
 */
export async function pausePipelineWithMessage(
  pipelineId: number,
  message:    string,
  level:      AlertLevel = 'error',
  reason?:    string,
): Promise<boolean> {
  let changed = false;
  try {
    const res = getDb()
      .prepare(
        `UPDATE pipelines
         SET status = 'paused', status_message = ?, status_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ?
           AND NOT (status = 'paused' AND status_message = ?)`,
      )
      .run(message, reason ?? null, pipelineId, message);
    changed = res.changes > 0;
  } catch (e) {
    console.error(`[Alert] Failed to pause pipeline ${pipelineId}:`, e);
    return false;
  }

  if (changed) {
    broadcastPipelineEvent({ type: 'alert', level, scope: 'pipeline', pipeline_id: pipelineId, message, ttl_ms: DEFAULT_TTL_MS });
    broadcastPipelineEvent({ type: 'metrics_updated' });
  }
  return changed;
}

/**
 * Clear a pipeline's status_message (e.g. once a poll succeeds again).  Does NOT
 * change status — un-pausing is a deliberate user/operator action.  Only writes
 * when a message is actually set, so healthy polls are a no-op.
 */
export async function clearPipelineStatusMessage(pipelineId: number): Promise<void> {
  try {
    getDb()
      .prepare(
        `UPDATE pipelines
         SET status_message = NULL, status_reason = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ? AND status_message IS NOT NULL`,
      )
      .run(pipelineId);
  } catch (e) {
    console.error(`[Alert] Failed to clear status message for pipeline ${pipelineId}:`, e);
  }
}

/**
 * status_reason values that mean "this pipeline must NOT be standardized right
 * now", even though its status is still 'active' and the poller keeps watching
 * it so it can auto-recover.
 *
 * Every automatic standardization entry point — the 10-minute tick, the
 * top-of-hour reconciliation sweep, and the manual process-queue route — must
 * exclude pipelines carrying one of these.  Standardizing through a masking or
 * row-access policy is not a cosmetic bug: the service role sees masked or
 * filtered values, and the export writes them into LITERAL_ALIAS_MATCHES
 * permanently, where they look exactly like legitimately confirmed mappings.
 */
export const PIPELINE_BLOCK_REASONS = ['policy_blocked'] as const;

/** SQL fragment for the above — usable directly in a WHERE clause. */
export const NOT_BLOCKED_SQL =
  `(status_reason IS NULL OR status_reason NOT IN (${PIPELINE_BLOCK_REASONS.map((r) => `'${r}'`).join(', ')}))`;

/**
 * Set a pipeline's status_message WITHOUT pausing it (status stays 'active').
 * Used for "skip this cycle but keep polling" conditions like a masking/row-access
 * policy — the pipeline auto-recovers when the condition clears.  Idempotent +
 * toast-once so repeated poll cycles don't churn.
 *
 * `reason` is the MACHINE-READABLE half of the flag, written to
 * pipelines.status_reason. status_message is human prose for the card and must
 * never be pattern-matched in code; anything that needs to *act* on a flag
 * filters on status_reason instead.  This exists because the masking-policy
 * flag was, in practice, advisory only: it told the user "standardization
 * skipped" while the 10-minute tick and the hourly reconciliation sweep — both
 * of which read PIPELINES without ever looking at status_message — happily
 * pulled the masked values, LLM-standardized them, and wrote them permanently
 * into the lookup and the export.  See PIPELINE_BLOCK_REASONS below.
 */
export async function flagPipelineMessage(
  pipelineId: number,
  message:    string,
  level:      AlertLevel = 'warning',
  reason:     string | null = null,
): Promise<void> {
  let changed = false;
  try {
    const res = getDb()
      .prepare(
        `UPDATE pipelines
         SET status_message = ?, status_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE pipeline_id = ? AND (status_message IS NULL OR status_message <> ? OR status_reason IS NOT ?)`,
      )
      .run(message, reason, pipelineId, message, reason);
    changed = res.changes > 0;
  } catch (e) {
    console.error(`[Alert] Failed to flag pipeline ${pipelineId}:`, e);
    return;
  }
  if (changed) {
    broadcastPipelineEvent({ type: 'alert', level, scope: 'pipeline', pipeline_id: pipelineId, message, ttl_ms: DEFAULT_TTL_MS });
    broadcastPipelineEvent({ type: 'metrics_updated' });
  }
}

/**
 * Transient account-level banner for global failures (expired key, disabled
 * user, suspended/credit-less warehouse).  No DB change — the pipelines aren't
 * individually paused; they auto-resume when access returns.
 */
export function broadcastGlobalAlert(
  message: string,
  level:   AlertLevel = 'error',
  ttlMs:   number = DEFAULT_TTL_MS,
): void {
  broadcastPipelineEvent({ type: 'alert', level, scope: 'global', message, ttl_ms: ttlMs });
}

