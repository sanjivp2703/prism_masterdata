import { requireValidSession } from '@/app/api/_lib/account-security';
import { warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import {
  validateSpecBody, insertColumnSpec, seedSpecValues, listColumnSpecs,
} from '@/app/api/_lib/column-specs';

/**
 * GET /api/column-specs[?pipeline_id=N]
 * Lists column specs (optionally scoped to one pipeline). Any valid session.
 */
export async function GET(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const pidRaw = url.searchParams.get('pipeline_id');
    const pipelineId = pidRaw != null && pidRaw !== '' ? Number(pidRaw) : null;
    return Response.json({ specs: listColumnSpecs(pipelineId) });
  } catch (err) {
    console.error('[column-specs] list failed:', err);
    return Response.json({ error: 'Failed to fetch column specs' }, { status: 500 });
  }
}

/**
 * POST /api/column-specs
 * Body: { column_name, description, standardization_rules?, convention_type?,
 *         convention_value?, convention_rules?, prestandardized_values?,
 *         pipeline_id?, table_fqn? }
 * Creates a per-column spec and seeds its examples / pre-standardized values into
 * the lookup as confirmed self-mappings (scoped by the new spec_id).
 */
export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const columnName = String(body?.column_name ?? '').trim();
  if (!columnName) return Response.json({ error: 'column_name is required' }, { status: 400 });

  const validated = validateSpecBody(body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

  const pipelineId = body?.pipeline_id != null ? Number(body.pipeline_id) : null;
  const tableFqn   = body?.table_fqn != null ? String(body.table_fqn) : null;

  let spec;
  try {
    spec = insertColumnSpec(validated.spec, { pipeline_id: pipelineId, table_fqn: tableFqn, column_name: columnName });
  } catch (err) {
    console.error('[column-specs] create failed:', err);
    return Response.json({ error: 'Failed to create column spec' }, { status: 500 });
  }

  try {
    await seedSpecValues(spec.spec_id, validated.spec.valuesToSeed);
  } catch (err) {
    // Spec row exists; seeding is best-effort — surface the warehouse error.
    return warehouseErrorResponse(err, 'Spec created, but seeding its values into the lookup failed');
  }

  return Response.json({ spec }, { status: 201 });
}
