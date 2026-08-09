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

/**
 * Turn a googleapis error into a short, actionable sentence for the browser.
 *
 * The Sheets export paths returned `err.message` verbatim, which is the one
 * error-hygiene hole left after the warehouse sanitizers and verify-install
 * were fixed: Google's messages can carry project ids, service-account
 * addresses, quota internals and API endpoints (SEC-04). Every other
 * client-facing error path in the codebase classifies; these now do too. The
 * raw message still reaches the server log via reportError.
 */
export function googleErrorMessage(err: unknown): string {
  const raw = String((err as { message?: unknown } | null)?.message ?? '').toLowerCase();
  if (!raw) return 'Could not create the Google Sheet.';
  if (/quota|rate limit|429|resource has been exhausted/.test(raw)) {
    return 'Google is rate-limiting Prism right now — try again in a few minutes.';
  }
  if (/permission|forbidden|403|insufficient/.test(raw)) {
    return 'Google refused the request — the connected account may not have permission to create sheets.';
  }
  if (/401|unauthorized|invalid_grant|token/.test(raw)) {
    return 'The Google connection has expired — reconnect your Google account and try again.';
  }
  if (/not found|404/.test(raw)) {
    return 'The target spreadsheet could not be found. It may have been deleted or renamed.';
  }
  if (/timeout|timed ?out|etimedout|econnrefused|enotfound|network|socket/.test(raw)) {
    return 'Could not reach Google. Check the network connection and try again.';
  }
  return 'Could not create the Google Sheet. The full error is in the server log.';
}
