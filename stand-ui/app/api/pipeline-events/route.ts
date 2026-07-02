/**
 * GET /api/pipeline-events
 *
 * Server-Sent Events endpoint.  The client subscribes once and receives push
 * notifications whenever:
 *   • metrics_updated          — the poller wrote new values to PIPELINES
 *   • standardizing_started    — a specific pipeline's LLM job started (includes pipeline_id)
 *   • standardizing_finished   — a specific pipeline's LLM job completed (includes pipeline_id)
 *
 * A keepalive comment is sent every 20 s to prevent proxy / browser timeouts.
 * EventSource reconnects automatically on any network interruption.
 */

import 'server-only';
import { type NextRequest } from 'next/server';
import { subscribePipelineEvents } from '@/app/api/_lib/pipeline-broadcaster';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      // Announce the connection
      send('data: {"type":"connected"}\n\n');

      // Push pipeline events to the client
      unsubscribe = subscribePipelineEvents((event) => {
        if (request.signal.aborted) {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keepalive every 20 s so proxies don't close idle connections
      heartbeat = setInterval(() => {
        if (request.signal.aborted) {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        send(': keepalive\n\n');
      }, 20_000);

      // Clean up when the client disconnects
      request.signal.addEventListener('abort', () => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}
