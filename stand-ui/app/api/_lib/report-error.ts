/**
 * Central error reporting helper.
 *
 * Always logs to console.error; additionally forwards to Sentry when the
 * SDK has been initialized (i.e. a DSN is configured). Never throws.
 *
 * Intentionally NOT marked 'server-only' — safe to import from both server
 * and client code (no secrets, no Snowflake, no heavy dependencies beyond
 * the lazily-imported Sentry SDK).
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (context && Object.keys(context).length > 0) {
    console.error(err, context);
  } else {
    console.error(err);
  }

  try {
    // Dynamic import keeps this module dependency-light and guarantees a
    // missing/broken SDK can never take down the caller.
    import('@sentry/nextjs')
      .then((Sentry) => {
        try {
          if (typeof Sentry.isInitialized === 'function' && !Sentry.isInitialized()) return;
          Sentry.captureException(err, context ? { extra: context } : undefined);
        } catch {
          // swallow — reporting must never throw
        }
      })
      .catch(() => {
        // swallow — SDK unavailable
      });
  } catch {
    // swallow — reporting must never throw
  }
}
