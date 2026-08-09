import { NextRequest } from 'next/server';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import { getDb } from '@/app/api/_lib/sqlite';
import { withWarehouse } from '@/app/api/_lib/warehouse';
import { buildSessionCookie, sanitizeReturnTo, type SessionPayload } from '@/app/api/_lib/session';
import { applyGrants } from '@/app/api/_lib/grants';
import { reportError } from '@/app/api/_lib/report-error';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const SHEETS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SHEETS_COOKIE_OPTS = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${SHEETS_COOKIE_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

function safeRole(v: unknown): 'admin' | 'user' {
  return v === 'admin' ? 'admin' : 'user';
}

/**
 * Best-effort Snowflake grant application for a brand-new account. Runs on the
 * env-configured service connection; errors are swallowed — the user can
 * re-apply via Settings → Snowflake connection if anything is missing.
 */
async function tryApplyGrants(): Promise<void> {
  try {
    await withWarehouse(async (conn) => {
      await applyGrants(conn, process.env.SNOWFLAKE_USER);
    });
  } catch (err) {
    // No Snowflake configured yet is fine at account-creation time, but still
    // report it — a real customer's grants pass failing silently here would
    // otherwise never surface until something breaks downstream with no log
    // trail pointing back to the cause.
    reportError(err, { phase: 'new-account-grants' });
  }
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
      // Open-redirect guard: only same-origin relative paths are honored.
      if (typeof decoded.returnTo    === 'string')  returnTo    = sanitizeReturnTo(decoded.returnTo);
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

  // Store the Google Sheets tokens ONLY for the sheetsOnly flow.
  //
  // These cookies are the app's "can we call the Sheets API" signal — the
  // lookup-export route gates on their presence alone. The login flow no longer
  // requests spreadsheets/drive.file scopes (see api/auth/login/route.ts), so
  // writing them here for a plain sign-in would store a token that CANNOT call
  // Sheets while still looking like valid Sheets auth: the export's
  // `!accessToken && !refreshToken` check would pass and the request would then
  // fail deep inside the Google client with a 403, instead of cleanly
  // triggering the consent round trip.
  //
  // Setting them only on the sheetsOnly branch keeps "has these cookies" and
  // "actually holds Sheets scopes" the same statement.
  const headers = new Headers();
  if (sheetsOnly) {
    if (tokens.access_token)  headers.append('Set-Cookie', `google_access_token=${tokens.access_token}; ${SHEETS_COOKIE_OPTS}`);
    if (tokens.refresh_token) headers.append('Set-Cookie', `google_refresh_token=${tokens.refresh_token}; ${SHEETS_COOKIE_OPTS}`);
    if (tokens.expiry_date)   headers.append('Set-Cookie', `google_token_expiry=${tokens.expiry_date}; ${SHEETS_COOKIE_OPTS}`);
  }

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
    const db = getDb();

    const resolveAccount = db.transaction((): { accountId: number; role: 'admin' | 'user'; isNew: boolean; sessionVersion: number } => {
      // ── Case 1: existing account ──────────────────────────────────────────
      const existing = db
        .prepare(`SELECT account_id, role, session_version FROM accounts WHERE google_id = ?`)
        .get(googleId) as { account_id: number; role: string; session_version: number } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE accounts
           SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), name = ?, picture_url = ?
           WHERE google_id = ?`,
        ).run(name, pictureUrl, googleId);
        return {
          accountId: Number(existing.account_id),
          role: safeRole(existing.role),
          isNew: false,
          sessionVersion: Number(existing.session_version ?? 1),
        };
      }

      // ── Case 2: invite flow ───────────────────────────────────────────────
      if (inviteToken) {
        const invite = db
          .prepare(
            `SELECT invitation_id, invited_email, invited_role
             FROM invitations
             WHERE token = ?
               AND status = 'pending'
               AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .get(inviteToken) as { invitation_id: number; invited_email: string; invited_role: string } | undefined;
        if (!invite) {
          throw Object.assign(new Error('invite_invalid'), { code: 'INVITE_INVALID' });
        }
        if (String(invite.invited_email).toLowerCase().trim() !== email) {
          throw Object.assign(new Error('invite_email_mismatch'), { code: 'INVITE_EMAIL_MISMATCH' });
        }
        const invitedRole = safeRole(invite.invited_role);

        const nonce = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const res = db
          .prepare(
            `INSERT INTO accounts (google_id, email, name, picture_url, role, creation_nonce)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(googleId, email, name, pictureUrl, invitedRole, nonce);

        db.prepare(
          `UPDATE invitations
           SET status = 'accepted', accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE invitation_id = ?`,
        ).run(Number(invite.invitation_id));

        return { accountId: Number(res.lastInsertRowid), role: invitedRole, isNew: true, sessionVersion: 1 };
      }

      // ── Case 3: bootstrap admin ───────────────────────────────────────────
      if (adminEmail && email === adminEmail) {
        const nonce = `boot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const res = db
          .prepare(
            `INSERT INTO accounts (google_id, email, name, picture_url, role, creation_nonce)
             VALUES (?, ?, ?, ?, 'admin', ?)`,
          )
          .run(googleId, email, name, pictureUrl, nonce);
        return { accountId: Number(res.lastInsertRowid), role: 'admin' as const, isNew: true, sessionVersion: 1 };
      }

      throw Object.assign(new Error('no_access'), { code: 'NO_ACCESS' });
    });

    const { accountId, role, isNew, sessionVersion } = resolveAccount();

    // New accounts get a best-effort grant application on the customer's
    // Snowflake so the service role has correct privileges from day one.
    if (isNew) await tryApplyGrants();

    const sessionPayload: SessionPayload = { accountId, googleId, email, name, pictureUrl, role, v: sessionVersion };
    headers.append('Set-Cookie', await buildSessionCookie(sessionPayload));

    // Every new account goes through /setup once. Admins configure the
    // workspace Snowflake connection there; regular users see an optional,
    // skippable prompt to connect their OWN Snowflake credentials (used only
    // for one-time standardizations of tables the service role can't see —
    // see the personal-connection variant of the setup page).
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
