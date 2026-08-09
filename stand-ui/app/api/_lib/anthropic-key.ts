import 'server-only';

import { getDb } from './sqlite';
import { decryptSecret } from './crypto';

/**
 * AI provider resolution — which provider (and credential) every LLM call
 * (grouping, merge, export validation) runs under, billed to the client
 * company's own account with that provider. Two tiers, mirroring the Snowflake
 * service connection:
 *   1. workspace_llm_config (SQLite, saved by an admin on /setup — the
 *      credential is encrypted at rest, decrypted only here). `provider` is
 *      'anthropic' (Claude), 'openai', or 'gemini'; the legacy
 *      `anthropic_api_key` column holds whichever provider's credential.
 *   2. ANTHROPIC_API_KEY env var (operator fallback — always provider
 *      'anthropic').
 *
 * All code MUST resolve through this module — never read
 * process.env.ANTHROPIC_API_KEY directly — or a UI-saved provider won't take
 * effect.
 */

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

/** Narrow an untrusted string to a provider id (anything unknown → 'anthropic'). */
export function asLlmProvider(v: unknown): LlmProvider {
  return v === 'openai' || v === 'gemini' ? v : 'anthropic';
}

export interface LlmProviderConfig {
  provider: LlmProvider;
  /** The provider credential: Anthropic, OpenAI, or Google AI Studio API key.
   *  Null when no provider is configured anywhere. */
  apiKey: string | null;
  /** Provider-specific model override; null = the provider default (Claude:
   *  the PRISM_CHUNK_MODEL/... defaults). */
  model: string | null;
  source: 'workspace' | 'env' | 'none';
}

const NONE: LlmProviderConfig = { provider: 'anthropic', apiKey: null, model: null, source: 'none' };

// Short-TTL cache: the poller resolves this every standardization pass and it
// is a per-call SQLite read + decrypt. Explicit invalidation covers the
// same-module case; the TTL covers any other module instance after hot-reload.
let _cache: { value: LlmProviderConfig; at: number } | null = null;
const CACHE_TTL_MS = 10_000;

export function invalidateAnthropicKeyCache(): void {
  _cache = null;
}

function resolve(): LlmProviderConfig {
  try {
    const r = getDb()
      .prepare(`SELECT provider, anthropic_api_key, model FROM workspace_llm_config WHERE id = 1`)
      .get() as any;
    if (r?.anthropic_api_key) {
      return {
        provider: asLlmProvider(r.provider),
        apiKey:   decryptSecret(String(r.anthropic_api_key)),
        model:    r.model ? String(r.model) : null,
        source:   'workspace',
      };
    }
  } catch (err) {
    // A decrypt failure (e.g. rotated PRISM_ENCRYPTION_KEY) must not take all
    // LLM work down — fall back to the env var.
    console.error('[anthropic-key] workspace LLM config unreadable, falling back to env:', err);
  }
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return { provider: 'anthropic', apiKey: envKey, model: null, source: 'env' };
  return NONE;
}

/** The active AI-provider configuration (cached). */
export function getLlmProviderConfig(): LlmProviderConfig {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.value;
  const value = resolve();
  _cache = { value, at: Date.now() };
  return value;
}

/** The active provider's credential, or null when none is configured. */
export function getAnthropicApiKey(): string | null {
  return getLlmProviderConfig().apiKey;
}

/** Where the active AI-provider credential comes from — for setup/status surfaces. */
export function anthropicKeySource(): 'workspace' | 'env' | 'none' {
  return getLlmProviderConfig().source;
}
