import { cookies } from 'next/headers';
import { detectHeaderRow } from '@/app/api/_lib/table-shape';
import { google } from 'googleapis';
import { requireValidSession } from '@/app/api/_lib/account-security';

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_OPTS    = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

function extractSpreadsheetId(urlOrId: string): string | null {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId.trim())) return urlOrId.trim();
  return null;
}

/**
 * GET /api/sheets/columns?url=<sheets-url-or-id>[&tab=<sheet-tab-name>]
 * Returns the header row and available tabs from a Google Sheet.
 */
export async function GET(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { searchParams } = new URL(request.url);
  const input = searchParams.get('url') ?? '';
  const tab   = searchParams.get('tab') ?? '';

  const spreadsheetId = extractSpreadsheetId(input);
  if (!spreadsheetId) {
    return Response.json({ error: 'Invalid Google Sheets URL or ID' }, { status: 400 });
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

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties,properties.title' });
    const title     = meta.data.properties?.title ?? '';
    const sheetList = (meta.data.sheets ?? []).map((s: any) => ({
      name:  String(s.properties?.title  ?? ''),
      index: Number(s.properties?.index  ?? 0),
      id:    Number(s.properties?.sheetId ?? 0),
    }));

    const targetTab = tab
      ? (sheetList.find((s: any) => s.name === tab) ?? sheetList[0])
      : sheetList[0];

    if (!targetTab) return Response.json({ error: 'No sheets found in this spreadsheet' }, { status: 404 });

    // Read the first 20 rows, not just row 1.
    //
    // This used to request '<tab>'!1:1 — so it could not merely GUESS the header
    // wrong, it was structurally incapable of seeing one anywhere else. On a
    // real customer sheet whose header sat on row 5 (under a narrow summary row
    // and three blank rows) it returned "Number Sent | 77 | Number Emailed | 54"
    // — two bare numbers — and the columns the user actually wanted were never
    // offered. See KI-219.
    //
    // headerRow is returned so the client can (a) show it in the preview with an
    // override, and (b) read DATA from the row below it. Both matter: fixing
    // detection without moving the data range would still ingest the blank rows
    // and the header text as data.
    const range  = `'${targetTab.name.replace(/'/g, "\\'")}'!1:20`;
    const valRes = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const grid: string[][] = (valRes.data.values ?? []).map((r) => (r ?? []).map((c) => String(c ?? '')));
    const detection = detectHeaderRow(grid);

    // The caller may OVERRIDE the detected row. The heuristic is good but will
    // be wrong on some layout, and on this path a wrong answer is not cosmetic:
    // the chosen row is persisted and drives which values get read, what gets
    // standardized and what the output looks like. A silent wrong guess
    // produces a session that looks healthy and standardizes the wrong column
    // (SHEETS-HDR-01/02).
    //
    // Resolved HERE rather than client-side so the columns offered and the row
    // the ingest will use come from one place and cannot disagree.
    const overrideRaw = searchParams.get('headerRow');
    const overrideIdx = overrideRaw != null && overrideRaw !== '' ? Number(overrideRaw) : NaN;
    const headerRow = Number.isInteger(overrideIdx) && overrideIdx >= 0 && overrideIdx < grid.length
      ? overrideIdx
      : detection.headerRow;

    const columns: string[] = (grid[headerRow] ?? []).map(String).filter(Boolean);

    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    if (refreshedTokens?.access_token) {
      responseHeaders.append('Set-Cookie', `google_access_token=${refreshedTokens.access_token}; ${COOKIE_OPTS}`);
    }
    if (refreshedTokens?.expiry_date) {
      responseHeaders.append('Set-Cookie', `google_token_expiry=${refreshedTokens.expiry_date}; ${COOKIE_OPTS}`);
    }

    return new Response(JSON.stringify({
      spreadsheetId, title, sheets: sheetList, activeSheet: targetTab.name, columns,
      // 0-based. The client uses this for the preview AND to offset the data range.
      headerRow,
      // What the heuristic picked, regardless of any override — so the UI can
      // show "detected row N" next to a user's correction instead of pretending
      // their choice was the guess.
      detectedHeaderRow: detection.headerRow,
      headerConfidence:  detection.confidence,
      previewRows:       grid.slice(headerRow + 1).filter(r => r.some(c => c.trim() !== '')).slice(0, 3),
      // The raw top-of-sheet rows, so the user can SEE which row holds their
      // column names rather than guessing a number blind.
      sampleRows:        grid.slice(0, 12),
    }), {
      headers: responseHeaders,
    });
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    const errMsg = String(err?.message ?? err?.response?.data?.error ?? '');
    const isAuthErr = status === 401 || status === 403 ||
                      errMsg.toLowerCase().includes('invalid_grant') ||
                      errMsg.toLowerCase().includes('token has been expired or revoked');
    if (isAuthErr) {
      // Clear stale tokens so the UI re-prompts Google auth.
      const clearCookie = `HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
      const h = new Headers({ 'Content-Type': 'application/json' });
      h.append('Set-Cookie', `google_access_token=; ${clearCookie}`);
      h.append('Set-Cookie', `google_refresh_token=; ${clearCookie}`);
      h.append('Set-Cookie', `google_token_expiry=; ${clearCookie}`);
      return new Response(JSON.stringify({ needsAuth: true }), { status: 401, headers: h });
    }
    return Response.json({ error: errMsg || 'Failed to read sheet' }, { status: 500 });
  }
}
