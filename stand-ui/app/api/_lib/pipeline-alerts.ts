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

import { withSnowflake } from './snowflake';
import { broadcastPipelineEvent, type AlertLevel } from './pipeline-broadcaster';

const DEFAULT_TTL_MS = 12_000;

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows ?? [])),
    });
  });
}

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
): Promise<boolean> {
  let changed = false;
  try {
    await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET status = 'paused', status_message = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?
           AND NOT (status = 'paused' AND status_message = ?)`,
        [message, pipelineId, message],
      );
      // Snowflake returns "number of rows updated" in the result of an UPDATE.
      const affected = Number((rows[0] as any)?.['number of rows updated'] ?? 0);
      changed = affected > 0;
    });
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
    await withSnowflake(async (conn) => {
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET status_message = NULL, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ? AND status_message IS NOT NULL`,
        [pipelineId],
      );
    });
  } catch (e) {
    console.error(`[Alert] Failed to clear status message for pipeline ${pipelineId}:`, e);
  }
}

/**
 * Set a pipeline's status_message WITHOUT pausing it (status stays 'active').
 * Used for "skip this cycle but keep polling" conditions like a masking/row-access
 * policy — the pipeline auto-recovers when the condition clears.  Idempotent +
 * toast-once so repeated poll cycles don't churn.
 */
export async function flagPipelineMessage(
  pipelineId: number,
  message:    string,
  level:      AlertLevel = 'warning',
): Promise<void> {
  let changed = false;
  try {
    await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET status_message = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ? AND (status_message IS NULL OR status_message <> ?)`,
        [message, pipelineId, message],
      );
      changed = Number((rows[0] as any)?.['number of rows updated'] ?? 0) > 0;
    });
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

