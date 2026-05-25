/**
 * Shared Redis client singleton.
 *
 * Returns a connected ioredis client, or null if REDIS_URL is unset or the
 * connection has permanently failed. All callers must treat null as
 * "Redis unavailable — degrade gracefully."
 */

import 'server-only';
import Redis from 'ioredis';

let _client: Redis | null = null;
let _disabled = false;

export function getRedisClient(): Redis | null {
  if (_disabled) return null;
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    _disabled = true;
    console.warn('[redis] REDIS_URL is not set — Redis features are disabled.');
    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: 0,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
    lazyConnect: true,
  });

  // Suppress per-error noise; the 'close' handler fires once on permanent failure.
  client.on('error', () => {});

  client.on('close', () => {
    if (_client === client) {
      _client = null;
      _disabled = true;
      console.warn(
        '[redis] Connection permanently failed — Redis features are disabled for this session. ' +
        'Start Redis and restart the dev server to re-enable.',
      );
    }
  });

  _client = client;
  return _client;
}
