import { hasBaseline } from '@/app/api/_lib/auto-export-seen';

/**
 * GET /api/auto-export/baseline?table_fqn=...&column_name=...
 *
 * Returns whether a persisted seen-values baseline exists in Redis for this
 * source. Used by the home page to decide whether to start polling immediately
 * or to create an initial standardization run first.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const table_fqn   = searchParams.get('table_fqn')?.trim()   ?? '';
  const column_name = searchParams.get('column_name')?.trim() ?? '';

  if (!table_fqn || !column_name) {
    return Response.json(
      { error: 'table_fqn and column_name are required' },
      { status: 400 }
    );
  }

  const exists = await hasBaseline(table_fqn, column_name);
  return Response.json({ hasBaseline: exists });
}
