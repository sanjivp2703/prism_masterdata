/**
 * Redis-backed "seen values" store for the auto_export polling loop.
 *
 * Each (tableFqn, columnName) pair gets a Redis Set that accumulates every
 * distinct value that has already been observed. On each poll the server diffs
 * the current Snowflake column against this set to find genuinely new values.
 *
 * Key format:  auto_export:seen:{tableFqn}:{columnName}
 *   e.g.       auto_export:seen:TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS:RAW_CARRIER_VALUE
 *
 * Persistence: survives page refreshes, tab closes, and Next.js hot reloads.
 * Falls back silently to returning all values as "new" when Redis is unavailable.
 */

import 'server-only';
import { getRedisClient } from './redis';

function seenKey(tableFqn: string, columnName: string): string {
  return `auto_export:seen:${tableFqn}:${columnName}`;
}

/**
 * Returns true if a baseline has already been established for this source.
 */
export async function hasBaseline(
  tableFqn: string,
  columnName: string,
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    return (await redis.exists(seenKey(tableFqn, columnName))) === 1;
  } catch {
    return false;
  }
}

/**
 * Seeds the seen-set with all current values (baseline poll).
 * Should only be called when hasBaseline() returns false.
 */
export async function initBaseline(
  tableFqn: string,
  columnName: string,
  values: string[],
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || values.length === 0) return;
  try {
    await redis.sadd(seenKey(tableFqn, columnName), ...values);
  } catch {
    // Non-fatal — next poll will re-attempt
  }
}

/**
 * Deletes the seen-set for this source, resetting the baseline.
 * Call this when the user explicitly wants to start fresh.
 */
export async function clearBaseline(
  tableFqn: string,
  columnName: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(seenKey(tableFqn, columnName));
  } catch {
    // Non-fatal
  }
}
