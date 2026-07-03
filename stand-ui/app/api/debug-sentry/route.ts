/**
 * Sentry verification endpoint. Exists only when error monitoring is
 * configured (SENTRY_DSN set) — 404 otherwise. Hitting it sends two events:
 * an explicit reportError capture and an unhandled route error (exercises
 * the onRequestError hook). Use it after wiring a new installation's DSN
 * to confirm events reach the Sentry project.
 */
import { NextResponse } from 'next/server';
import { reportError } from '../_lib/report-error';

export async function GET() {
  if (!process.env.SENTRY_DSN) {
    return new NextResponse(null, { status: 404 });
  }
  reportError(new Error('Sentry test event — explicit reportError capture'), {
    source: '/api/debug-sentry',
  });
  throw new Error('Sentry test error — thrown from /api/debug-sentry to verify monitoring');
}
