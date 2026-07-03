/**
 * Sentry init for the browser.
 * Next.js loads this file automatically on the client (instrumentation-client convention).
 * No-op when NEXT_PUBLIC_SENTRY_DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // Errors only — no performance tracing.
    tracesSampleRate: 0,
  });
}

// Required export for navigation instrumentation (harmless with tracing off).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
