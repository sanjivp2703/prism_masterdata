'use client';

/**
 * App Router global error boundary. Catches errors thrown in the root
 * layout (where nested error.tsx boundaries can't). Must render its own
 * <html>/<body> because it replaces the root layout entirely.
 */
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#F4F6F8',
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          padding: '24px',
        }}
      >
        <div
          style={{
            backgroundColor: '#FFFFFF',
            border: '0.5px solid #E5E7EB',
            borderRadius: 3,
            padding: 24,
            maxWidth: 400,
            width: '100%',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              margin: '0 0 8px',
              fontSize: 16,
              fontWeight: 600,
              color: '#1A1A2E',
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: 13,
              lineHeight: 1.5,
              color: '#6B7280',
            }}
          >
            An unexpected error occurred. Try again, or reload the page if the
            problem persists.
          </p>
          <button
            onClick={() => reset()}
            style={{
              backgroundColor: '#378ADD',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 2,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
