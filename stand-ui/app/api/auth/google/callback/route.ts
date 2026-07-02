import { NextRequest } from 'next/server';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import { withSnowflake } from '@/app/api/_lib/snowflake';
import { buildSessionCookie, type SessionPayload } from '@/app/api/_lib/session';
import { applyGrants } from '@/app/api/_lib/grants';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const SHEETS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SHEETS_COOKIE_OPTS = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${SHEETS_COOKIE_MAX_AGE}`;

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function col(r: any, key: string) {
  return r[key.toUpperCase()] ?? r[key.toLowerCase()];
}

function safeRole(v: unknown): 'admin' | 'user' {
  return v === 'admin' ? 'admin' : 'user';
}

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const { searchParams } = new URL(request.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) return Response.redirect(`${origin}/login?error=oauth_denied`);
  if (!code)  return Response.redirect(`${origin}/login?error=no_code`);

  let returnTo    = '/home';
  let isLogin     = false;
  let sheetsOnly  = false;
  let inviteToken: string | null = null;

  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
      if (typeof decoded.returnTo    === 'string')  returnTo    = decoded.returnTo;
      if (decoded.isLogin            === true)       isLogin     = true;
      if (decoded.sheetsOnly         === true)       sheetsOnly  = true;
      if (typeof decoded.inviteToken === 'string')  inviteToken = decoded.inviteToken;
    } catch { /* ignore */ }
  }

  // Exchange code for tokens
  const oauth2Client = getOAuth2Client();
  let tokens: Credentials;
  try {
    ({ tokens } = await oauth2Client.getToken(code));
  } catch {
    return Response.redirect(`${origin}/login?error=token_exchange_failed`);
  }
  oauth2Client.setCredentials(tokens);

  // Always store Google Sheets tokens
  const headers = new Headers();
  if (tokens.access_token)  headers.append('Set-Cookie', `google_access_token=${tokens.access_token}; ${SHEETS_COOKIE_OPTS}`);
  if (tokens.refresh_token) headers.append('Set-Cookie', `google_refresh_token=${tokens.refresh_token}; ${SHEETS_COOKIE_OPTS}`);
  if (tokens.expiry_date)   headers.append('Set-Cookie', `google_token_expiry=${tokens.expiry_date}; ${SHEETS_COOKIE_OPTS}`);

  // Sheets-only re-auth: the user's Prism session is already valid.
  // Just refresh the Sheets tokens and return — no account lookup needed.
  if (sheetsOnly) {
    headers.set('Location', returnTo);
    return new Response(null, { status: 302, headers });
  }

  // Fetch Google profile
  let profile: { id?: string | null; email?: string | null; name?: string | null; picture?: string | null };
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    profile = data;
  } catch {
    return Response.redirect(`${origin}/login?error=token_exchange_failed`);
  }

  if (!profile.id || !profile.email) {
    return Response.redirect(`${origin}/login?error=no_profile`);
  }

  const googleId   = profile.id;
  const email      = profile.email.toLowerCase().trim();
  const name       = profile.name    ?? '';
  const pictureUrl = profile.picture ?? null;
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase().trim();

  try {
    const { accountId, role, isNew } = await withSnowflake(async (conn) => {
      // ── Case 1: existing account ──────────────────────────────────────────
      const existing = await exec(
        conn,
        `SELECT account_id, role FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE google_id = ?`,
        [googleId],
      );
      if (existing.length > 0) {
        const id = Number(col(existing[0], 'account_id'));
        const r  = safeRole(col(existing[0], 'role'));
        await exec(
          conn,
          `UPDATE STAND_DB.STAND_INTERNAL.ACCOUNTS
           SET last_login_at = CURRENT_TIMESTAMP(), name = ?, picture_url = ?
           WHERE google_id = ?`,
          [name, pictureUrl, googleId],
        );
        return { accountId: id, role: r, isNew: false };
      }

      // ── Case 2: invite flow ───────────────────────────────────────────────
      if (inviteToken) {
        const invites = await exec(
          conn,
          `SELECT invitation_id, invited_email, invited_role
           FROM STAND_DB.STAND_INTERNAL.INVITATIONS
           WHERE token = ?
             AND status = 'pending'
             AND expires_at > CURRENT_TIMESTAMP()`,
          [inviteToken],
        );
        if (!invites.length) {
          throw Object.assign(new Error('invite_invalid'), { code: 'INVITE_INVALID' });
        }
        const invitedEmail = String(col(invites[0], 'invited_email')).toLowerCase().trim();
        if (invitedEmail !== email) {
          throw Object.assign(new Error('invite_email_mismatch'), { code: 'INVITE_EMAIL_MISMATCH' });
        }
        const invitedRole = safeRole(col(invites[0], 'invited_role'));

        const nonce = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        await exec(
          conn,
          `INSERT INTO STAND_DB.STAND_INTERNAL.ACCOUNTS
             (google_id, email, name, picture_url, role, creation_nonce)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [googleId, email, name, pictureUrl, invitedRole, nonce],
        );
        const created = await exec(
          conn,
          `SELECT account_id FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE creation_nonce = ? LIMIT 1`,
          [nonce],
        );
        if (!created.length) throw new Error('Could not retrieve new account_id');

        await exec(
          conn,
          `UPDATE STAND_DB.STAND_INTERNAL.INVITATIONS
           SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP()
           WHERE invitation_id = ?`,
          [Number(col(invites[0], 'invitation_id'))],
        );
        // Auto-apply grants using the system Snowflake user so the service role
        // has correct privileges from day one. Errors are swallowed — the user can
        // re-apply via Settings → Snowflake connection if anything is missing.
        await applyGrants(conn, process.env.SNOWFLAKE_USER).catch(() => {});
        return { accountId: Number(col(created[0], 'account_id')), role: invitedRole, isNew: true };
      }

      // ── Case 3: bootstrap admin ───────────────────────────────────────────
      if (adminEmail && email === adminEmail) {
        const nonce = `boot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        await exec(
          conn,
          `INSERT INTO STAND_DB.STAND_INTERNAL.ACCOUNTS
             (google_id, email, name, picture_url, role, creation_nonce)
           VALUES (?, ?, ?, ?, 'admin', ?)`,
          [googleId, email, name, pictureUrl, nonce],
        );
        const created = await exec(
          conn,
          `SELECT account_id FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE creation_nonce = ? LIMIT 1`,
          [nonce],
        );
        if (!created.length) throw new Error('Could not retrieve admin account_id');
        await applyGrants(conn, process.env.SNOWFLAKE_USER).catch(() => {});
        return { accountId: Number(col(created[0], 'account_id')), role: 'admin' as const, isNew: true };
      }

      throw Object.assign(new Error('no_access'), { code: 'NO_ACCESS' });
    });

    const sessionPayload: SessionPayload = { accountId, googleId, email, name, pictureUrl, role };
    headers.append('Set-Cookie', await buildSessionCookie(sessionPayload));

    // New accounts go to /setup to optionally configure their Snowflake connection.
    let redirectTo: string;
    if (isNew) {
      redirectTo = `/setup?next=${encodeURIComponent(returnTo)}`;
    } else if (isLogin) {
      redirectTo = returnTo;
    } else {
      redirectTo = `${returnTo}${returnTo.includes('?') ? '&' : '?'}gauth=success`;
    }
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });

  } catch (err: any) {
    const code = err?.code;
    if (code === 'NO_ACCESS')             return Response.redirect(`${origin}/login?error=no_access`);
    if (code === 'INVITE_INVALID')        return Response.redirect(`${origin}/accept-invite?token=${inviteToken}&error=invite_invalid`);
    if (code === 'INVITE_EMAIL_MISMATCH') return Response.redirect(`${origin}/accept-invite?token=${inviteToken}&error=email_mismatch`);
    console.error('OAuth callback error:', err);
    return Response.redirect(`${origin}/login?error=server_error`);
  }
}
