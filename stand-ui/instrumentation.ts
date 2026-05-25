/**
 * Next.js instrumentation hook.
 * Runs once when the Node.js server starts (next dev / next start).
 * Starts the background pipeline poller so polling continues regardless
 * of whether any browser has the app open.
 */
export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startPoller } = await import('./app/api/_lib/pipeline-poller');
    const { startHourlyProcessor } = await import('./app/api/_lib/pipeline-hourly-processor');
    startPoller();
    startHourlyProcessor();
  }
}
