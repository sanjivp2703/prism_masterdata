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
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { requireAdminSession, bumpSessionVersion } from '@/app/api/_lib/account-security';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function col(r: any, key: string) {
  return r[key.toUpperCase()] ?? r[key.toLowerCase()];
}

async function loadTarget(conn: any, accountId: number) {
  const rows = await exec(
    conn,
    `SELECT account_id, role FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE account_id = ? LIMIT 1`,
    [accountId],
  );
  if (!rows.length) return null;
  return {
    account_id: Number(col(rows[0], 'account_id')),
    role: col(rows[0], 'role') === 'admin' ? ('admin' as const) : ('user' as const),
  };
}

async function countAdmins(conn: any): Promise<number> {
  const rows = await exec(
    conn,
    `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE role = 'admin'`,
  );
  return Number(col(rows[0] ?? {}, 'cnt') ?? 0);
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
    const result = await withSnowflake(async (conn) => {
      const target = await loadTarget(conn, targetId);
      if (!target) return Response.json({ error: 'Member not found.' }, { status: 404 });

      if (target.role === role) {
        return Response.json({ ok: true, account_id: targetId, role });
      }

      // Refuse demoting the last admin — the workspace must keep one.
      if (target.role === 'admin' && role === 'user') {
        const admins = await countAdmins(conn);
        if (admins <= 1) {
          return Response.json(
            { error: 'Cannot demote the last admin. Promote another member first.' },
            { status: 409 },
          );
        }
      }

      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.ACCOUNTS SET role = ? WHERE account_id = ?`,
        [role, targetId],
      );
      return Response.json({ ok: true, account_id: targetId, role });
    });

    // Invalidate the target's live sessions (their cookie carries the old role).
    if (result.status === 200) {
      await bumpSessionVersion(targetId).catch((err) =>
        console.error('[members] failed to bump session_version:', err),
      );
    }
    return result;
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to update member role');
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
    const result = await withSnowflake(async (conn) => {
      const target = await loadTarget(conn, targetId);
      if (!target) return Response.json({ error: 'Member not found.' }, { status: 404 });

      if (target.role === 'admin') {
        const admins = await countAdmins(conn);
        if (admins <= 1) {
          return Response.json(
            { error: 'Cannot remove the last admin. Promote another member first.' },
            { status: 409 },
          );
        }
      }

      await exec(
        conn,
        `DELETE FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE account_id = ?`,
        [targetId],
      );
      return Response.json({ ok: true, account_id: targetId });
    });

    // Kill the removed member's live sessions. Even though the ACCOUNTS row is
    // gone (version lookup now fails), bumping keeps the cache coherent and is
    // harmless if the row was somehow recreated.
    if (result.status === 200) {
      await bumpSessionVersion(targetId).catch(() => {});
    }
    return result;
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to remove member');
  }
}
