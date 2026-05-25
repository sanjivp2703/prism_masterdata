/**
 * Application-level Redis cache for LLM confidence scoring results.
 *
 * Cache key: `llm_cache:<conceptId>:<aliasId>:<literalValue>`
 *
 * Keyed on run_item.literal_value (not normalized_value or clean_value) to
 * guarantee uniqueness per distinct source string. Different strings can
 * normalize identically, which would produce a wrong cache hit silently.
 *
 * No TTL — entries are invalidated explicitly when alias data changes.
 */

import type { LLMConfidenceResponse } from './llm-confidence';
import { getRedisClient } from './redis';

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

export function buildCacheKey(
  literalValue: string,
  conceptId: number,
  aliasId: number,
): string {
  return `llm_cache:${conceptId}:${aliasId}:${literalValue}`;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Returns the cached LLM result for (literalValue, conceptId, aliasId),
 * or null if there is no cache entry or if caching is disabled.
 */
export async function getCachedResult(
  literalValue: string,
  conceptId: number,
  aliasId: number,
): Promise<LLMConfidenceResponse | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const key = buildCacheKey(literalValue, conceptId, aliasId);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as LLMConfidenceResponse;
  } catch {
    return null;
  }
}

/**
 * Stores the LLM result for (literalValue, conceptId, aliasId).
 * No TTL — invalidated explicitly via invalidateAliasCacheEntries.
 * No-op if caching is disabled.
 */
export async function setCachedResult(
  literalValue: string,
  conceptId: number,
  aliasId: number,
  result: LLMConfidenceResponse,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const key = buildCacheKey(literalValue, conceptId, aliasId);
    await redis.set(key, JSON.stringify(result));
  } catch {
    // Write failures are silent — the result is still used for this request.
  }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Deletes all cached LLM results for a given (concept, alias) pair.
 *
 * Call this whenever:
 *   - An admin validation event adds new approved alias_items to an alias
 *   - An alias_name.literal_value changes
 *
 * Both events change the feature payload that would be sent for future
 * (run_item, alias) comparisons, making any cached results stale.
 *
 * Uses KEYS pattern scan — suitable for the relatively small key spaces
 * expected in this workload (aliases have bounded item counts).
 */
export async function invalidateAliasCacheEntries(
  conceptId: number,
  aliasId: number,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const pattern = `llm_cache:${conceptId}:${aliasId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(
        `[redis-cache] Invalidated ${keys.length} cache entries for concept=${conceptId} alias=${aliasId}`,
      );
    }
  } catch {
    // Invalidation failures are non-fatal — worst case is a stale cache hit
    // on the next run. Flush manually if needed.
  }
}
