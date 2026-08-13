/**
 * Next.js instrumentation hook.
 * Runs once when the Node.js server starts (next dev / next start).
 * Initializes Sentry (no-op when SENTRY_DSN is unset) and starts the
 * background pipeline poller so polling continues regardless of whether
 * any browser has the app open.
 */
import * as Sentry from '@sentry/nextjs';

/**
 * Operator-only env flags that must NEVER be set in a customer installation.
 *
 * Each one weakens or fakes something a customer relies on:
 *   PRISM_DEBUG_TOOLS       — exposes /debug and /api/admin/table (raw table
 *                             contents), AND makes verify-install return raw
 *                             driver text to the browser.
 *   PRISM_FRESH_SETUP       — makes /setup, the /home gate and verify-install
 *                             falsely report that no credentials exist.
 *   PRISM_DEBUG_ARTIFACTS   — writes LLM breakdown + validation audit JSON
 *                             (containing customer values) to the OS temp dir.
 *
 * Warned about at BOOT rather than left to a checklist, because a checklist is
 * a thing someone has to remember: these flags survived in a local .env.local
 * across three separate QA passes (SEC-08). The warning is loud and repeated on
 * every start so it cannot be scrolled past once and forgotten.
 *
 * Deliberately a warning, NOT a hard refusal — the same file is used for local
 * development where these flags are legitimate, and a process that refuses to
 * boot would just get the guard deleted. NODE_ENV === 'production' is the
 * signal that this is a real deployment.
 */
const OPERATOR_ONLY_FLAGS = ['PRISM_DEBUG_TOOLS', 'PRISM_FRESH_SETUP', 'PRISM_DEBUG_ARTIFACTS'] as const;

function warnOnOperatorFlags(): void {
  const on = OPERATOR_ONLY_FLAGS.filter(f => process.env[f] === 'true');
  if (on.length === 0) return;
  const where = process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'development';
  const banner = '='.repeat(72);
  console.warn(
    `\n${banner}\n` +
    `  ⚠  OPERATOR-ONLY FLAG${on.length > 1 ? 'S' : ''} ENABLED IN A ${where} BUILD: ${on.join(', ')}\n` +
    (process.env.NODE_ENV === 'production'
      ? `  These must NOT be set in a customer installation. PRISM_DEBUG_TOOLS exposes\n` +
        `  /debug and /api/admin/table plus raw driver errors; PRISM_FRESH_SETUP fakes\n` +
        `  "not configured" everywhere; PRISM_DEBUG_ARTIFACTS writes customer values to\n` +
        `  the temp dir. Remove them from .env.local and restart before shipping.\n`
      : `  Fine for local development. Remove before any build that ships.\n`) +
    `${banner}\n`,
  );
}

/**
 * Native (Marketplace) edition: no operator ever provisions this install, so
 * SESSION_SECRET / PRISM_ENCRYPTION_KEY cannot come from a human. Generate
 * them once at first boot and persist beside the SQLite file on the app's
 * block volume (mode 600) — stable across restarts/upgrades, unique per
 * installation, and the service spec ships with NO secrets at all (which is
 * also what the marketplace security scan wants to see). Env values still
 * win when present and real ('change-me…' placeholders are treated as absent).
 */
async function ensureNativeSecrets(): Promise<void> {
  const { isNativeEdition } = await import('./app/api/_lib/edition');
  if (!isNativeEdition()) return;
  const needs = (v?: string) => !v || v.trim() === '' || v.startsWith('change-me');
  if (!needs(process.env.SESSION_SECRET) && !needs(process.env.PRISM_ENCRYPTION_KEY)) return;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = path.dirname(process.env.PRISM_SQLITE_PATH?.trim() || './data/prism.db');
  const file = path.join(dir, 'app-secrets.json');
  let secrets: { session_secret?: string; encryption_key?: string } = {};
  try { secrets = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first boot */ }
  if (!secrets.session_secret || !secrets.encryption_key) {
    secrets = {
      session_secret: secrets.session_secret ?? crypto.randomBytes(32).toString('hex'),
      encryption_key: secrets.encryption_key ?? crypto.randomBytes(32).toString('hex'),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  }
  if (needs(process.env.SESSION_SECRET))       process.env.SESSION_SECRET       = secrets.session_secret;
  if (needs(process.env.PRISM_ENCRYPTION_KEY)) process.env.PRISM_ENCRYPTION_KEY = secrets.encryption_key;
}

export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await ensureNativeSecrets();  // BEFORE anything reads session/crypto env
    warnOnOperatorFlags();
    await import('./sentry.server.config');
    const { startPoller } = await import('./app/api/_lib/pipeline-poller');
    const { startQueueProcessor } = await import('./app/api/_lib/pipeline-hourly-processor');
    startPoller();
    startQueueProcessor();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Reports errors from nested React Server Components / route handlers to
// Sentry. Safe no-op when Sentry.init was skipped (no DSN).
export const onRequestError = Sentry.captureRequestError;
