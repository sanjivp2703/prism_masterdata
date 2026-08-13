/**
 * Sentry init for the browser.
 * Next.js loads this file automatically on the client (instrumentation-client convention).
 * No-op when NEXT_PUBLIC_SENTRY_DSN is unset, and force-disabled in the
 * native (Marketplace) edition (no outbound telemetry — docs/NATIVE_APP_PLAN.md §1).
 */
import * as Sentry from '@sentry/nextjs';
import { isNativeEdition } from './app/api/_lib/edition';

if (process.env.NEXT_PUBLIC_SENTRY_DSN && !isNativeEdition()) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // Errors only — no performance tracing.
    tracesSampleRate: 0,
  });
}

// Required export for navigation instrumentation (harmless with tracing off).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
