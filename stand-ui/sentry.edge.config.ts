/**
 * Sentry init for the Edge runtime.
 * Loaded from instrumentation.ts register(). No-op when SENTRY_DSN is unset,
 * and force-disabled in the native (Marketplace) edition (no outbound
 * telemetry — docs/NATIVE_APP_PLAN.md §1).
 */
import * as Sentry from '@sentry/nextjs';
import { isNativeEdition } from './app/api/_lib/edition';

if (process.env.SENTRY_DSN && !isNativeEdition()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Errors only — no performance tracing.
    tracesSampleRate: 0,
  });
}
