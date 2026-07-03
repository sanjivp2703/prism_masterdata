/**
 * Next.js instrumentation hook.
 * Runs once when the Node.js server starts (next dev / next start).
 * Initializes Sentry (no-op when SENTRY_DSN is unset) and starts the
 * background pipeline poller so polling continues regardless of whether
 * any browser has the app open.
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    const { startPoller } = await import('./app/api/_lib/pipeline-poller');
    const { startHourlyProcessor } = await import('./app/api/_lib/pipeline-hourly-processor');
    startPoller();
    startHourlyProcessor();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Reports errors from nested React Server Components / route handlers to
// Sentry. Safe no-op when Sentry.init was skipped (no DSN).
export const onRequestError = Sentry.captureRequestError;
