import { appendTiming } from '@/app/api/_lib/timing';

/**
 * POST /api/timing — receives a client-measured phase timing (e.g. the wall-clock
 * from clicking Accept to the next page navigating) and records it in the timing
 * log alongside the server-side phases. Temporary profiling aid.
 * Body: { label: string, ms: number }
 */
export async function POST(request: Request) {
  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const label = String(body?.label ?? 'client').slice(0, 80);
  const ms    = Number(body?.ms);
  if (Number.isFinite(ms)) appendTiming(`[Timing] ${label}: ${Math.round(ms)}ms (client)`);
  return Response.json({ ok: true });
}
