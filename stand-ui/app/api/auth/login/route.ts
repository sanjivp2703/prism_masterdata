import { NextRequest } from 'next/server';
import { google } from 'googleapis';
import { sanitizeReturnTo } from '@/app/api/_lib/session';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

export async function GET(request: NextRequest) {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GOOGLE_REDIRECT_URI
  ) {
    return Response.json(
      { error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.' },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const returnTo    = sanitizeReturnTo(searchParams.get('returnTo'), '/home');
  const inviteToken = searchParams.get('inviteToken') || null;

  const oauth2Client = getOAuth2Client();
  const statePayload: Record<string, unknown> = { returnTo, isLogin: true };
  if (inviteToken) statePayload.inviteToken = inviteToken;

  // IDENTITY SCOPES ONLY. Do not add spreadsheets/drive.file back here.
  //
  // Signing in is not consent to write to someone's Google Drive. This route
  // used to request both, so every user — including those who will never touch
  // a Sheets pipeline or a Sheets export — had to grant Prism spreadsheet and
  // Drive write access just to authenticate, and the callback then stored a
  // write-capable refresh token in a cookie for a year.
  //
  // The Sheets scopes are requested lazily, at the moment they are actually
  // needed, by /api/auth/google (the sheetsOnly route) — which exists for
  // exactly this purpose and already handles the returnTo round trip.
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'openid',
      'email',
      'profile',
    ],
    state: Buffer.from(JSON.stringify(statePayload)).toString('base64url'),
    prompt: 'consent',
  });

  return Response.redirect(authUrl);
}
