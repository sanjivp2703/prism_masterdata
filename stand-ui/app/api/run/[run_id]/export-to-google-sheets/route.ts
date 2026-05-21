import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

// ── Snowflake helpers ─────────────────────────────────────────────────────────

async function exec(connection: any, sqlText: string, binds?: any[]) {
  return await new Promise<any[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

// ── Google OAuth helpers ──────────────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_OPTS = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> },
) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    return Response.json(
      { error: 'Google Sheets export is not configured on this server.' },
      { status: 503 },
    );
  }

  const { run_id } = await params;
  const runIdNum = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runIdNum)) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const includeOriginalCol: boolean = body.includeOriginalCol !== false;

  // ── Read tokens from cookies ──────────────────────────────────────────────
  const cookieStore = await cookies();
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

  // Capture any token refresh so we can update cookies in the response.
  let refreshedTokens: { access_token?: string | null; expiry_date?: number | null } | null = null;
  oauth2Client.on('tokens', (tokens) => {
    refreshedTokens = tokens;
  });

  // ── Fetch export data from Snowflake ──────────────────────────────────────
  let headers: string[];
  let rows: Record<string, string>[];
  let title: string | null;
  let sourceColumn: string;

  try {
    const result = await withSnowflake(async (connection) => {
      const runRows = await exec(
        connection,
        `SELECT source_relation, source_column, stats_snapshot
         FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS
         WHERE run_id = ?`,
        [runIdNum],
      );

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const runRow         = runRows[0];
      const sourceRelation = String(runRow.SOURCE_RELATION ?? runRow.source_relation ?? '');
      const srcCol         = String(runRow.SOURCE_COLUMN   ?? runRow.source_column   ?? '');
      const statsSnapshot  = runRow.STATS_SNAPSHOT ?? runRow.stats_snapshot ?? null;

      const mappingRows = await exec(
        connection,
        `SELECT literal_value AS original_value, alias_name AS standardized_value
         FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
         WHERE run_id = ?
         ORDER BY standardized_value, original_value`,
        [runIdNum],
      );

      const mapping: Record<string, string> = {};
      for (const r of mappingRows) {
        const orig = String(r.ORIGINAL_VALUE    ?? r.original_value    ?? '');
        const std  = String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? '');
        mapping[orig] = std;
      }

      if (sourceRelation === '__pasted__' && statsSnapshot) {
        const tableData: { title: string; headers: string[]; rows: string[][] } =
          typeof statsSnapshot === 'string' ? JSON.parse(statsSnapshot) : statsSnapshot;

        const colIdx     = tableData.headers.findIndex(
          (h) => h.toLowerCase() === srcCol.toLowerCase(),
        );
        const stdColName = `standardized_${srcCol}`;
        const insertAt   = colIdx >= 0 ? colIdx + 1 : tableData.headers.length;
        const hdrs = [
          ...tableData.headers.slice(0, insertAt),
          stdColName,
          ...tableData.headers.slice(insertAt),
        ];

        const rws: Record<string, string>[] = tableData.rows.map((r) => {
          const originalVal = colIdx >= 0 ? (r[colIdx] ?? '') : '';
          const rowObj: Record<string, string> = {};
          tableData.headers.forEach((h, i) => { rowObj[h] = r[i] ?? ''; });
          rowObj[stdColName] = originalVal ? (mapping[originalVal] ?? '') : '';
          return rowObj;
        });

        return { rows: rws, headers: hdrs, title: tableData.title || null, sourceColumn: srcCol };
      }

      const rws = mappingRows.map((r) => ({
        original_value:     String(r.ORIGINAL_VALUE    ?? r.original_value    ?? ''),
        standardized_value: String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? ''),
      }));

      return {
        rows:         rws,
        headers:      ['original_value', 'standardized_value'],
        title:        null,
        sourceColumn: srcCol,
      };
    });

    // If withSnowflake returned a Response (error), forward it.
    if (result instanceof Response) return result;

    ({ headers, rows, title, sourceColumn } = result as {
      headers: string[];
      rows: Record<string, string>[];
      title: string | null;
      sourceColumn: string;
    });
  } catch (err) {
    console.error('export-to-google-sheets snowflake error:', err);
    return snowflakeErrorResponse(err, 'Failed to load export data');
  }

  // ── Apply includeOriginalCol transformation ───────────────────────────────
  const stdColName = `standardized_${sourceColumn}`;
  if (!includeOriginalCol && headers.includes(stdColName)) {
    const newHeaders = headers.filter((h) => h !== stdColName);
    const srcIdx = newHeaders.indexOf(sourceColumn);
    rows = rows.map((r) => {
      const row = { ...r };
      row[sourceColumn] = r[stdColName] ?? r[sourceColumn] ?? '';
      delete row[stdColName];
      return row;
    });
    headers = newHeaders;
    // If srcIdx changed position after removing stdColName, newHeaders is already correct.
    void srcIdx;
  }

  // ── Build sheet data (2D array) ───────────────────────────────────────────
  const sheetData: string[][] = [
    headers,
    ...rows.map((r) => headers.map((h) => r[h] ?? '')),
  ];

  const sheetTitle = title || `Run ${run_id} – Standardized`;

  // ── Create Google Sheet ───────────────────────────────────────────────────
  try {
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    const createResp = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: sheetTitle },
        sheets: [{ properties: { title: sheetTitle.slice(0, 100) } }],
      },
    });

    const spreadsheetId = createResp.data.spreadsheetId!;
    const sheetId = createResp.data.sheets?.[0]?.properties?.sheetId ?? 0;

    // Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      requestBody: { values: sheetData },
    });

    // Bold the header row and auto-resize columns
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: headers.length,
              },
            },
          },
        ],
      },
    });

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    // Build response, attaching refreshed tokens as cookies if any
    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    if (refreshedTokens) {
      const rt = refreshedTokens as { access_token?: string | null; expiry_date?: number | null };
      if (rt.access_token) {
        responseHeaders.append('Set-Cookie', `google_access_token=${rt.access_token}; ${COOKIE_OPTS}`);
      }
      if (rt.expiry_date) {
        responseHeaders.append('Set-Cookie', `google_token_expiry=${rt.expiry_date}; ${COOKIE_OPTS}`);
      }
    }

    return new Response(JSON.stringify({ url: sheetUrl, title: sheetTitle }), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error('export-to-google-sheets sheets API error:', err);

    // Token may be revoked — prompt re-auth
    const statusCode = err?.response?.status ?? err?.code;
    if (statusCode === 401 || statusCode === 403) {
      return Response.json({ needsAuth: true }, { status: 401 });
    }

    return Response.json(
      { error: err?.message || 'Failed to create Google Sheet' },
      { status: 500 },
    );
  }
}
