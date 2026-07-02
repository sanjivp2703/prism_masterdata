/**
 * In-process SSE event broadcaster for real-time pipeline status.
 *
 * Uses a Node.js EventEmitter persisted on `global` so it survives
 * Next.js hot-reloads in development without losing subscribed clients.
 *
 * Event types:
 *   metrics_updated         — poller wrote new metrics to PIPELINES; UI should refetch
 *   scanning_started        — a poll cycle found new stream data and began classifying
 *                             it (identifying new/changed values). The UI pauses the
 *                             polling ring at the start of the cycle until it finishes.
 *   scanning_finished       — classification for that pipeline's poll cycle completed
 *   standardizing_started   — a specific pipeline's LLM standardization began
 *   standardizing_finished  — a specific pipeline's standardization completed
 *   alert                   — a problem to surface in the UI (global banner or a
 *                             per-pipeline message). ttl_ms, when present, tells
 *                             the UI to auto-dismiss the toast after that long;
 *                             persistent pause reasons live on PIPELINES.status_message.
 */
import 'server-only';
import { EventEmitter } from 'events';

export type AlertLevel = 'error' | 'warning' | 'info';

export type PipelineEvent =
  | { type: 'metrics_updated' }
  | { type: 'polling_paused' }
  | { type: 'polling_resumed' }
  | { type: 'scanning_started'; pipeline_id: number }
  | { type: 'scanning_finished'; pipeline_id: number }
  | { type: 'standardizing_started'; pipeline_id: number }
  | { type: 'standardizing_finished'; pipeline_id: number }
  | { type: 'alert'; level: AlertLevel; scope: 'global' | 'pipeline'; message: string; pipeline_id?: number; ttl_ms?: number };

// Persist the emitter across Next.js hot-reloads so SSE clients stay connected.
const g = global as typeof globalThis & { __pipelineBroadcaster?: EventEmitter };
if (!g.__pipelineBroadcaster) {
  g.__pipelineBroadcaster = new EventEmitter();
  g.__pipelineBroadcaster.setMaxListeners(100);
}
const emitter = g.__pipelineBroadcaster;

/** Emit an event to all connected SSE clients. */
export function broadcastPipelineEvent(event: PipelineEvent): void {
  emitter.emit('event', event);
}

/**
 * Register a listener and return an unsubscribe function.
 * Always call the returned function when the SSE connection closes.
 */
export function subscribePipelineEvents(
  listener: (event: PipelineEvent) => void,
): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
