import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getDb, sqliteNow } from '@/app/api/_lib/sqlite';
import { encryptSecret } from '@/app/api/_lib/crypto';
import { invalidateAnthropicKeyCache, anthropicKeySource, asLlmProvider, type LlmProvider } from '@/app/api/_lib/anthropic-key';
import { DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL } from '@/app/api/_lib/llm-one-prompt-grouping';
import { isFreshSetupSim } from '@/app/api/_lib/env';

/** Status source with the fresh-install simulation applied: env-provided keys
 *  are hidden so the setup flow behaves like a bare deployment. */
function effectiveSource(): 'workspace' | 'env' | 'none' {
  const s = anthropicKeySource();
  return isFreshSetupSim() && s === 'env' ? 'none' : s;
}

/**
 * GET /api/accounts/llm-provider (admin only) — masked status.
 * `source` says where the active credential comes from ('workspace' | 'env' |
 * 'none'); `provider` is 'anthropic' (Claude), 'openai', or 'gemini'.
 */
export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  try {
    const r = getDb()
      .prepare(`SELECT provider, anthropic_api_key, model FROM workspace_llm_config WHERE id = 1`)
      .get() as any;
    return Response.json({
      source:   effectiveSource(),
      provider: asLlmProvider(r?.provider),
      model:    r?.model ?? null,
      has_key:  Boolean(r?.anthropic_api_key),
    });
  } catch (err) {
    console.error('[llm-provider] load failed:', err);
    return Response.json({ error: 'Failed to load AI provider status' }, { status: 500 });
  }
}

/**
 * POST /api/accounts/llm-provider (admin only)
 *
 * Body: { provider: 'anthropic' | 'openai' | 'gemini', credential }
 *   — validates the credential live against the provider (free list-models
 *     call), then saves it encrypted as the workspace AI provider. OpenAI/Gemini
 *     saves get the pinned best-fit model recorded. Nothing is saved
 *     if validation fails.
 * Body: { clear: true } — removes the workspace config (falls back to env).
 */
export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  if (body?.clear) {
    try {
      getDb().prepare(`DELETE FROM workspace_llm_config WHERE id = 1`).run();
      invalidateAnthropicKeyCache();
      return Response.json({ ok: true, cleared: true, source: effectiveSource() });
    } catch (err) {
      console.error('[llm-provider] clear failed:', err);
      return Response.json({ error: 'Failed to clear the AI provider config' }, { status: 500 });
    }
  }

  const provider: LlmProvider = asLlmProvider(body?.provider);

  // No credential typed → adopt the env-configured Anthropic key (saves the
  // admin hunting for it; it never left the server). Anthropic only — there is
  // no env fallback for OpenAI/Gemini — and suppressed by the fresh-install sim.
  const credential = String(body?.credential ?? '').trim()
    || (provider === 'anthropic' && !isFreshSetupSim() ? process.env.ANTHROPIC_API_KEY?.trim() ?? '' : '');
  if (!credential) {
    const what = provider === 'openai' ? 'An OpenAI API key'
      : provider === 'gemini' ? 'A Google AI API key'
      : 'An Anthropic API key';
    return Response.json({ error: `${what} is required.` }, { status: 400 });
  }
  if (/\s/.test(credential) || credential.length > 500) {
    return Response.json({ error: 'That does not look like a valid credential.' }, { status: 400 });
  }

  // ── Validate live against the provider before saving ──────────────────────
  // Both probes are free list-models calls that exercise real auth, so a
  // typo'd or revoked credential is caught here instead of silently breaking
  // every standardization run.
  const probe: { url: string; headers: Record<string, string>; rejected: string } =
    provider === 'openai'
      ? { url: 'https://api.openai.com/v1/models',
          headers: { 'Authorization': `Bearer ${credential}` },
          rejected: 'OpenAI rejected this key — nothing was saved. Check it was copied fully (it starts with sk-).' }
      : provider === 'gemini'
      ? { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
          headers: { 'Authorization': `Bearer ${credential}` },
          rejected: 'Google rejected this key — nothing was saved. Check it was copied fully (it starts with AIza).' }
      : { url: 'https://api.anthropic.com/v1/models?limit=1',
          headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' },
          rejected: 'Anthropic rejected this key — nothing was saved. Check it was copied fully (it starts with sk-ant-).' };

  try {
    const res = await fetch(probe.url, { headers: probe.headers });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // Not every provider uses 401/403 for a bad key — Gemini's OpenAI-compat
      // endpoint returns 400 INVALID_ARGUMENT ("Please pass a valid API key")
      // instead, which would otherwise fall through to the generic "try again"
      // message below and wrongly suggest a transient/retry-able problem.
      const isKeyRejection = res.status === 401 || res.status === 403
        || /invalid.*api.?key|api.?key.*invalid|INVALID_ARGUMENT/i.test(bodyText);
      if (isKeyRejection) {
        return Response.json({ ok: false, error: probe.rejected }, { status: 400 });
      }
      console.error('[llm-provider] validation call failed:', provider, res.status, bodyText);
      return Response.json({
        ok: false,
        error: `Could not validate the credential (HTTP ${res.status}) — nothing was saved. Try again in a moment.`,
      }, { status: 502 });
    }
  } catch (err) {
    console.error('[llm-provider] validation request failed:', err);
    return Response.json({
      ok: false,
      error: 'Could not reach the provider to validate the credential — nothing was saved. Check the server’s network access.',
    }, { status: 502 });
  }

  // ── Save (encrypted at rest) ──────────────────────────────────────────────
  const model = provider === 'openai' ? DEFAULT_OPENAI_MODEL
    : provider === 'gemini' ? DEFAULT_GEMINI_MODEL
    : null;
  try {
    getDb()
      .prepare(
        `INSERT INTO workspace_llm_config (id, anthropic_api_key, provider, model, configured_by, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           anthropic_api_key = excluded.anthropic_api_key,
           provider = excluded.provider, model = excluded.model,
           configured_by = excluded.configured_by, updated_at = excluded.updated_at`,
      )
      .run(encryptSecret(credential), provider, model, Number(session.accountId), sqliteNow());
    invalidateAnthropicKeyCache();
  } catch (err) {
    console.error('[llm-provider] save failed:', err);
    return Response.json({ error: 'The credential validated but saving failed. Try again.' }, { status: 500 });
  }

  return Response.json({ ok: true, source: 'workspace', provider, model });
}
