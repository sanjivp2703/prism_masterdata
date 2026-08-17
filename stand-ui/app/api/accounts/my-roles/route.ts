/**
 * GET /api/accounts/my-roles (native edition; any valid session) — the roles
 * THE SIGNED-IN USER holds, for the export dialog's "Create as role" picker.
 *
 * Runs on the CALLER'S-RIGHTS session and asks CURRENT_AVAILABLE_ROLES() —
 * self-inspection the restricted session allows (SHOW ROLES is blocked
 * there). Best-effort: any failure returns an empty list and the picker
 * falls back to the session default. One-shot user-clicked surface.
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withUserWarehouse, executeQuery } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('Role enumeration');

  let roles: string[] = [];
  try {
    const rows = await withUserWarehouse(Number(auth.accountId), (conn) =>
      executeQuery(conn, 'SELECT CURRENT_AVAILABLE_ROLES() AS R'));
    const raw = rows?.[0]?.R ?? rows?.[0]?.r ?? '[]';
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) roles = parsed.map(String).filter(Boolean);
  } catch {
    roles = []; // picker falls back to the session's default role
  }
  return Response.json({ roles });
}
