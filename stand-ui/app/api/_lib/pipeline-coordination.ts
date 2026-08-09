/**
 * Per-pipeline coordination for the stream poller and LLM queue standardization.
 *
 * Instead of pausing ALL polling when any pipeline is standardizing, only the
 * specific pipeline being processed is skipped.  Other pipelines continue
 * polling normally.
 *
 * SSE events now include pipeline_id so the UI can show "Paused while
 * standardizing" only for the affected pipeline's progress bar.
 */

import 'server-only';
import { broadcastPipelineEvent } from './pipeline-broadcaster';

// pipeline_id → Date.now() when standardization began.
//
// MUST live on globalThis (like the broadcaster and the SQLite handle): in
// Next.js dev the instrumentation bundle (poller/tick) and route-handler
// bundles can each instantiate this module, and hot reloads replace module
// instances mid-flight. Module-local state let a beginStandardization strand
// itself on an instance whose endStandardization never landed — the poller
// then skipped that pipeline forever (streams never created, values never
// queued, metrics frozen).
const g = globalThis as unknown as { __prismStandardizingSince?: Map<number, number> };
const standardizingSince: Map<number, number> =
  g.__prismStandardizingSince ?? (g.__prismStandardizingSince = new Map());

// Safety valve: no legitimate pass runs this long (a 5,000-value drain is
// minutes, not tens of minutes). A lock older than this is treated as leaked
// (crashed pass / stranded hot-reload state) and cleared so polling self-heals.
const STANDARDIZING_MAX_MS = 30 * 60_000;

/** True if this specific pipeline is currently being standardized. */
export function isPipelineStandardizing(pipelineId: number): boolean {
  const since = standardizingSince.get(pipelineId);
  if (since == null) return false;
  if (Date.now() - since > STANDARDIZING_MAX_MS) {
    standardizingSince.delete(pipelineId);
    console.warn(
      `[Coordination] Pipeline ${pipelineId}: standardizing lock held > ${STANDARDIZING_MAX_MS / 60_000} min — clearing stale lock`,
    );
    broadcastPipelineEvent({ type: 'standardizing_finished', pipeline_id: pipelineId });
    return false;
  }
  return true;
}


/** Call when starting auto-group + export for a specific pipeline. */
export function beginStandardization(pipelineId?: number): void {
  if (pipelineId != null) {
    standardizingSince.set(pipelineId, Date.now());
    broadcastPipelineEvent({ type: 'standardizing_started', pipeline_id: pipelineId });
  }
}

/** Call when standardization finishes for a specific pipeline. */
export function endStandardization(pipelineId?: number): void {
  if (pipelineId != null) {
    standardizingSince.delete(pipelineId);
    broadcastPipelineEvent({ type: 'standardizing_finished', pipeline_id: pipelineId });
    broadcastPipelineEvent({ type: 'metrics_updated' });
  }
}
