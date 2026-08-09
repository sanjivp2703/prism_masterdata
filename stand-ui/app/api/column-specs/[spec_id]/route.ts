import { requireValidSession } from '@/app/api/_lib/account-security';
import { warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import {
  validateSpecBody, updateColumnSpec, seedSpecValues, getColumnSpec,
} from '@/app/api/_lib/column-specs';

/**
 * GET /api/column-specs/[spec_id]
 */
export async function GET(_req: Request, { params }: { params: Promise<{ spec_id: string }> }) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  const { spec_id } = await params;
  const spec = getColumnSpec(Number(spec_id));
  if (!spec) return Response.json({ error: 'Spec not found' }, { status: 404 });
  return Response.json({ spec });
}

/**
 * PATCH /api/column-specs/[spec_id]
 * Body: same spec fields as POST (description mandatory). Updates the metadata
 * and (idempotently) re-seeds any examples / pre-standardized values supplied.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ spec_id: string }> }) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  const { spec_id } = await params;
  const specId = Number(spec_id);

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const validated = validateSpecBody(body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

  let spec;
  try {
    spec = updateColumnSpec(specId, validated.spec);
  } catch (err) {
    console.error('[column-specs] update failed:', err);
    return Response.json({ error: 'Failed to update column spec' }, { status: 500 });
  }
  if (!spec) return Response.json({ error: 'Spec not found' }, { status: 404 });

  try {
    await seedSpecValues(spec.spec_id, validated.spec.valuesToSeed);
  } catch (err) {
    return warehouseErrorResponse(err, 'Spec updated, but seeding its values into the lookup failed');
  }

  return Response.json({ spec });
}
