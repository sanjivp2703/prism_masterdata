/**
 * Sentry init for the Node.js server runtime.
 * Loaded from instrumentation.ts register(). No-op when SENTRY_DSN is unset,
 * and force-disabled in the native (Marketplace) edition — outbound telemetry
 * from inside a consumer's account requires disclosure/consent we don't ask
 * for (docs/NATIVE_APP_PLAN.md §1).
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
