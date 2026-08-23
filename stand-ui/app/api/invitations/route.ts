import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';
import { sendInviteEmail } from '@/app/api/_lib/email';

export async function POST(request: NextRequest) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  // Native edition: Snowflake owns identity/membership — no email invitations.
  if (isNativeEdition()) return nativeEditionUnavailable('Email invitations');
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const email = String(body?.email ?? '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'A valid email address is required.' }, { status: 400 });
  }

  const invitedRole: 'admin' | 'user' = body?.role === 'admin' ? 'admin' : 'user';

  try {
    const token = randomBytes(32).toString('hex');
    const db = getDb();

    // Prevent inviting an email that already has an account
    const existing = db
      .prepare(`SELECT account_id FROM accounts WHERE LOWER(email) = ?`)
      .get(email);
    if (existing) {
      return Response.json({ error: 'That email already has a Prism account.' }, { status: 409 });
    }

    db.transaction(() => {
      // Cancel any previous pending invitation for this email
      db.prepare(
        `UPDATE invitations
         SET status = 'revoked'
         WHERE LOWER(invited_email) = ? AND status = 'pending'`,
      ).run(email);

      db.prepare(
        `INSERT INTO invitations (invited_email, invited_by, invited_role, token)
         VALUES (?, ?, ?, ?)`,
      ).run(email, Number(session.accountId), invitedRole, token);
    })();

    // Send email (gracefully degrades when SMTP is not configured)
    const { sent, acceptUrl } = await sendInviteEmail({
      to:           email,
      inviterName:  session.name,
      inviterEmail: session.email,
      token,
      invitedRole,
    });

    // acceptUrl is returned even on success (finding #24): invitation mail
    // can land in spam, and the link is the only remedy the inviter has.
    return Response.json({ success: true, emailSent: sent, acceptUrl });

  } catch (err) {
    console.error('Invitation error:', err);
    return Response.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
