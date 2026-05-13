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

import Redis from 'ioredis';
import type { LLMConfidenceResponse } from './llm-confidence';

// ---------------------------------------------------------------------------
// Redis client singleton with graceful disable
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
// Set to true after the first unrecoverable connection failure. All cache
// operations become silent no-ops for the rest of the process lifetime.
// A single warning is logged; no per-request error spam.
let _cacheDisabled = false;

/**
 * Returns the Redis client, or null if:
 *   - REDIS_URL is not set, OR
 *   - A previous connection attempt permanently failed.
 *
 * Callers must treat a null return as "cache unavailable — proceed without it."
 */
function getRedis(): Redis | null {
  if (_cacheDisabled) return null;
  if (_redis) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    _cacheDisabled = true;
    console.warn('[redis-cache] REDIS_URL is not set — LLM result caching is disabled.');
    return null;
  }

  const client = new Redis(url, {
    // Commands fail immediately when not connected rather than queuing.
    maxRetriesPerRequest: 0,
    // Try to reconnect up to 3 times, then give up.
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
    lazyConnect: true,
  });

  client.on('error', () => {
    // Suppress all per-error log lines. The 'close' handler below fires once
    // when the client gives up and logs a single actionable message.
  });

  client.on('close', () => {
    if (_redis === client) {
      _redis = null;
      _cacheDisabled = true;
      console.warn(
        '[redis-cache] Could not connect to Redis — LLM result caching is disabled for this session. ' +
        'Start Redis and restart the dev server to enable caching.',
      );
    }
  });

  _redis = client;
  return _redis;
}

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
  const redis = getRedis();
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
  const redis = getRedis();
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
  const redis = getRedis();
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
