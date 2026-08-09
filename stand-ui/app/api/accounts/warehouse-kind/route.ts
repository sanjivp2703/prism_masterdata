// GET /api/accounts/warehouse-kind
//
// The resolved warehouse platform ('snowflake' | 'mssql'), for UI copy that
// needs to say the right platform name (e.g. the Connect tab's source-type
// picker). Deliberately NOT admin-gated, unlike /api/accounts/warehouse-type —
// every user (not just admins) uses the Connect tab, and which platform is
// active isn't sensitive the way credentials/config details are.
import 'server-only';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getWarehouseAdapter } from '@/app/api/_lib/warehouse';

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  return Response.json({ kind: getWarehouseAdapter().kind });
}
