/**
 * Coordinates the stream poller and LLM queue standardization so they never
 * overlap. While standardization is running, polling is skipped entirely —
 * preventing a 30 s poll cycle from enqueueing the same values again mid-run.
 */

import 'server-only';

let standardizationDepth = 0;

/** True while any pipeline standardization job is in progress. */
export function isPollingPaused(): boolean {
  return standardizationDepth > 0;
}

/** Call when starting auto-group + export for a pipeline queue. */
export function beginStandardization(): void {
  standardizationDepth++;
}

/** Call when standardization finishes (success or failure). */
export function endStandardization(): void {
  standardizationDepth = Math.max(0, standardizationDepth - 1);
}
