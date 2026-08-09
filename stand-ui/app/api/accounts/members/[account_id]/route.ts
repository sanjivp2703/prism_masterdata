/**
 * PATCH  /api/accounts/members/[account_id] — change a member's role. Admin only.
 *   Body: { role: 'admin' | 'user' }
 *   Refuses to demote the last remaining admin. Bumps the target's
 *   session_version so their live sessions pick up the new role (re-login).
 *
 * DELETE /api/accounts/members/[account_id] — remove a member. Admin only.
 *   Refuses to delete the last remaining admin or the caller's own account.
 *   Bumps the target's session_version so their live sessions die immediately.
 */

import 'server-only';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireAdminSession, bumpSessionVersion } from '@/app/api/_lib/account-security';

function loadTarget(accountId: number): { account_id: number; role: 'admin' | 'user' } | null {
  const row = getDb()
    .prepare(`SELECT account_id, role FROM accounts WHERE account_id = ?`)
    .get(accountId) as { account_id: number; role: string } | undefined;
  if (!row) return null;
  return {
    account_id: Number(row.account_id),
    role: row.role === 'admin' ? 'admin' : 'user',
  };
}

function countAdmins(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS cnt FROM accounts WHERE role = 'admin'`)
    .get() as { cnt: number };
  return Number(row?.cnt ?? 0);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ account_id: string }> },
) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const { account_id } = await params;
  const targetId = Number(account_id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return Response.json({ error: 'Invalid account_id' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const role = body?.role;
  if (role !== 'admin' && role !== 'user') {
    return Response.json({ error: `role must be 'admin' or 'user'` }, { status: 400 });
  }

  try {
    const target = loadTarget(targetId);
    if (!target) return Response.json({ error: 'Member not found.' }, { status: 404 });

    if (target.role === role) {
      return Response.json({ ok: true, account_id: targetId, role });
    }

    // Refuse demoting the last admin — the workspace must keep one.
    if (target.role === 'admin' && role === 'user') {
      if (countAdmins() <= 1) {
        return Response.json(
          { error: 'Cannot demote the last admin. Promote another member first.' },
          { status: 409 },
        );
      }
    }

    getDb().prepare(`UPDATE accounts SET role = ? WHERE account_id = ?`).run(role, targetId);

    // Invalidate the target's live sessions (their cookie carries the old role).
    await bumpSessionVersion(targetId).catch((err) =>
      console.error('[members] failed to bump session_version:', err),
    );
    return Response.json({ ok: true, account_id: targetId, role });
  } catch (err) {
    console.error('[members] role update failed:', err);
    return Response.json({ error: 'Failed to update member role' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ account_id: string }> },
) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const { account_id } = await params;
  const targetId = Number(account_id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return Response.json({ error: 'Invalid account_id' }, { status: 400 });
  }

  if (targetId === Number(auth.accountId)) {
    return Response.json({ error: 'You cannot remove your own account.' }, { status: 409 });
  }

  try {
    const target = loadTarget(targetId);
    if (!target) return Response.json({ error: 'Member not found.' }, { status: 404 });

    if (target.role === 'admin') {
      if (countAdmins() <= 1) {
        return Response.json(
          { error: 'Cannot remove the last admin. Promote another member first.' },
          { status: 409 },
        );
      }
    }

    getDb().prepare(`DELETE FROM accounts WHERE account_id = ?`).run(targetId);

    // Kill the removed member's live sessions. Even though the accounts row is
    // gone (version lookup now fails), bumping is harmless if the row was
    // somehow recreated.
    await bumpSessionVersion(targetId).catch(() => {});
    return Response.json({ ok: true, account_id: targetId });
  } catch (err) {
    console.error('[members] delete failed:', err);
    return Response.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
