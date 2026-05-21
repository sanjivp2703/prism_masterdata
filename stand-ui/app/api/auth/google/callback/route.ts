import { NextRequest } from 'next/server';
import { google } from 'googleapis';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const COOKIE_OPTS = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return Response.json({ error: `Google OAuth error: ${error}` }, { status: 400 });
  }

  if (!code) {
    return Response.json({ error: 'No authorization code received from Google.' }, { status: 400 });
  }

  let returnTo = '/';
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
      returnTo = typeof decoded.returnTo === 'string' ? decoded.returnTo : '/';
    } catch {
      // ignore malformed state
    }
  }

  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  // Build redirect URL — keeps any query params the returnTo already has (e.g. gsExport=1)
  const separator = returnTo.includes('?') ? '&' : '?';
  const redirectUrl = `${returnTo}${separator}gauth=success`;

  const headers = new Headers({ Location: redirectUrl });

  if (tokens.access_token) {
    headers.append('Set-Cookie', `google_access_token=${tokens.access_token}; ${COOKIE_OPTS}`);
  }
  if (tokens.refresh_token) {
    headers.append('Set-Cookie', `google_refresh_token=${tokens.refresh_token}; ${COOKIE_OPTS}`);
  }
  if (tokens.expiry_date) {
    headers.append('Set-Cookie', `google_token_expiry=${tokens.expiry_date}; ${COOKIE_OPTS}`);
  }

  return new Response(null, { status: 302, headers });
}
