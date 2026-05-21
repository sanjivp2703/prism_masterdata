import { NextRequest } from 'next/server';
import { google } from 'googleapis';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

export async function GET(request: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    return Response.json(
      { error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.' },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const returnTo = searchParams.get('returnTo') || '/';

  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
    state: Buffer.from(JSON.stringify({ returnTo })).toString('base64url'),
    prompt: 'consent',
  });

  return Response.redirect(authUrl);
}
