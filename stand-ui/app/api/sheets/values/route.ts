import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_OPTS    = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

/**
 * GET /api/sheets/values?id=<spreadsheetId>&range=<A1Range>
 * Returns a flat array of non-empty values from the given column range.
 */
export async function GET(request: Request) {
  if (isNativeEdition()) return nativeEditionUnavailable('Google Sheets');
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { searchParams } = new URL(request.url);
  const spreadsheetId = searchParams.get('id') ?? '';
  const range         = searchParams.get('range') ?? '';

  if (!spreadsheetId || !range) {
    return Response.json({ error: 'id and range are required' }, { status: 400 });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return Response.json({ error: 'Google Sheets is not configured on this server.' }, { status: 503 });
  }

  const cookieStore  = await cookies();
  const accessToken  = cookieStore.get('google_access_token')?.value;
  const refreshToken = cookieStore.get('google_refresh_token')?.value;
  const tokenExpiry  = cookieStore.get('google_token_expiry')?.value;

  if (!accessToken && !refreshToken) {
    return Response.json({ needsAuth: true }, { status: 401 });
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   tokenExpiry ? parseInt(tokenExpiry, 10) : undefined,
  });
  let refreshedTokens: any = null;
  oauth2Client.on('tokens', (t) => { refreshedTokens = t; });

  try {
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const res    = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const flat   = (res.data.values ?? []).flat().map(String).filter((v: string) => v.trim());

    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    if (refreshedTokens?.access_token) {
      responseHeaders.append('Set-Cookie', `google_access_token=${refreshedTokens.access_token}; ${COOKIE_OPTS}`);
    }
    if (refreshedTokens?.expiry_date) {
      responseHeaders.append('Set-Cookie', `google_token_expiry=${refreshedTokens.expiry_date}; ${COOKIE_OPTS}`);
    }

    return new Response(JSON.stringify({ values: flat }), { headers: responseHeaders });
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    const errMsg = String(err?.message ?? err?.response?.data?.error ?? '');
    const isAuthErr = status === 401 || status === 403 ||
                      errMsg.toLowerCase().includes('invalid_grant') ||
                      errMsg.toLowerCase().includes('token has been expired or revoked');
    if (isAuthErr) {
      const clearCookie = `HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
      const h = new Headers({ 'Content-Type': 'application/json' });
      h.append('Set-Cookie', `google_access_token=; ${clearCookie}`);
      h.append('Set-Cookie', `google_refresh_token=; ${clearCookie}`);
      h.append('Set-Cookie', `google_token_expiry=; ${clearCookie}`);
      return new Response(JSON.stringify({ needsAuth: true }), { status: 401, headers: h });
    }
    return Response.json({ error: errMsg || 'Failed to read sheet values' }, { status: 500 });
  }
}
