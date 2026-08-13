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

export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureNativeSecrets } = await import('./native-secrets');
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
