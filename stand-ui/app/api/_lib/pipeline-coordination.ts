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

const standardizingPipelines = new Set<number>();

/** True if this specific pipeline is currently being standardized. */
export function isPipelineStandardizing(pipelineId: number): boolean {
  return standardizingPipelines.has(pipelineId);
}


/** Call when starting auto-group + export for a specific pipeline. */
export function beginStandardization(pipelineId?: number): void {
  if (pipelineId != null) {
    standardizingPipelines.add(pipelineId);
    broadcastPipelineEvent({ type: 'standardizing_started', pipeline_id: pipelineId });
  }
}

/** Call when standardization finishes for a specific pipeline. */
export function endStandardization(pipelineId?: number): void {
  if (pipelineId != null) {
    standardizingPipelines.delete(pipelineId);
    broadcastPipelineEvent({ type: 'standardizing_finished', pipeline_id: pipelineId });
    broadcastPipelineEvent({ type: 'metrics_updated' });
  }
}
