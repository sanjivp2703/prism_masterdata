import { NextRequest } from 'next/server';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getRunHeader } from '@/app/api/_lib/run-header';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { run_id } = await params;

  try {
    const row = await getRunHeader(Number(run_id));
    if (!row) {
      return Response.json({ error: 'Run not found' }, { status: 404 });
    }
    return Response.json({ data: row });
  } catch (error) {
    console.error('Database error:', error);
    return Response.json({ error: 'Failed to fetch run data' }, { status: 500 });
  }
}
