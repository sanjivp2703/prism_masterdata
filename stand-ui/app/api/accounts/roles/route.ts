/**
 * GET /api/accounts/roles (native edition; any valid session) — account role
 * names for the export dialog's "who can read this table" dropdown.
 *
 * Enumerated on the SERVICE connection: the caller's-rights session is
 * blocked from SHOW ROLES by restricted caller's rights, and the app's own
 * session may see only a subset — so this is best-effort by design and the
 * client keeps a custom-entry escape hatch. Metadata-layer SHOW (never wakes
 * a warehouse), one-shot user-clicked surface, 10-minute in-process cache.
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, executeQuery } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';

export const dynamic = 'force-dynamic';

let _cache: { roles: string[]; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;
const MAX_ROLES = 200;

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('Role enumeration');

  if (_cache && Date.now() - _cache.at < CACHE_MS) {
    return Response.json({ roles: _cache.roles });
  }
  let roles: string[] = [];
  try {
    const rows = await withWarehouse((conn) => executeQuery(conn, 'SHOW ROLES'));
    roles = rows
      .map((r: Record<string, unknown>) => String(r.name ?? ''))
      .filter((n) => n && n !== 'PUBLIC')
      .slice(0, MAX_ROLES);
  } catch {
    roles = []; // app session can't enumerate — dropdown falls back to custom entry
  }
  _cache = { roles, at: Date.now() };
  return Response.json({ roles });
}
