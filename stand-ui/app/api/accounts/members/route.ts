/**
 * GET /api/accounts/members — list all accounts. Admin only.
 */

import 'server-only';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireAdminSession } from '@/app/api/_lib/account-security';

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  try {
    const rows = getDb()
      .prepare(
        `SELECT account_id, email, name, role, picture_url, created_at
         FROM accounts
         ORDER BY created_at ASC`,
      )
      .all() as any[];

    const members = rows.map((r) => ({
      account_id:  Number(r.account_id),
      email:       String(r.email ?? ''),
      name:        r.name != null ? String(r.name) : null,
      role:        r.role === 'admin' ? 'admin' : 'user',
      picture_url: r.picture_url != null ? String(r.picture_url) : null,
      created_at:  r.created_at ?? null,
    }));
    return Response.json({ members });
  } catch (err) {
    console.error('[members] list failed:', err);
    return Response.json({ error: 'Failed to load members' }, { status: 500 });
  }
}
