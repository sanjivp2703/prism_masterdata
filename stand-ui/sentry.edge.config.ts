/**
 * Sentry init for the Edge runtime.
 * Loaded from instrumentation.ts register(). No-op when SENTRY_DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Errors only — no performance tracing.
    tracesSampleRate: 0,
  });
}
