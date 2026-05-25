import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { sendInviteEmail } from '@/app/api/_lib/email';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function POST(request: NextRequest) {
  // Verify session
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = sessionValue ? await decodeSession(sessionValue) : null;
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // Admin-only
  if (session.role !== 'admin') {
    return Response.json({ error: 'Only admins can invite new users.' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const email = String(body?.email ?? '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'A valid email address is required.' }, { status: 400 });
  }

  const invitedRole: 'admin' | 'user' = body?.role === 'admin' ? 'admin' : 'user';

  try {
    const token = randomBytes(32).toString('hex');

    await withSnowflake(async (conn) => {
      // Prevent inviting an email that already has an account
      const existing = await exec(
        conn,
        `SELECT account_id FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE LOWER(email) = ?`,
        [email],
      );
      if (existing.length > 0) {
        throw Object.assign(new Error('already_member'), { code: 'ALREADY_MEMBER' });
      }

      // Cancel any previous pending invitation for this email
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.INVITATIONS
         SET status = 'revoked'
         WHERE LOWER(invited_email) = ? AND status = 'pending'`,
        [email],
      );

      // Insert new invitation
      await exec(
        conn,
        `INSERT INTO STAND_DB.STAND_INTERNAL.INVITATIONS
           (invited_email, invited_by, invited_role, token)
         VALUES (?, ?, ?, ?)`,
        [email, session.accountId, invitedRole, token],
      );
    });

    // Send email (gracefully degrades when SMTP is not configured)
    const { sent, acceptUrl } = await sendInviteEmail({
      to:           email,
      inviterName:  session.name,
      inviterEmail: session.email,
      token,
      invitedRole,
    });

    return Response.json({ success: true, emailSent: sent, acceptUrl: sent ? null : acceptUrl });

  } catch (err: any) {
    if (err?.code === 'ALREADY_MEMBER') {
      return Response.json({ error: 'That email already has a Prism account.' }, { status: 409 });
    }
    console.error('Invitation error:', err);
    return snowflakeErrorResponse(err, 'Failed to create invitation');
  }
}
