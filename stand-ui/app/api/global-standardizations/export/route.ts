import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { parseFqn, quoteIdent, isSimpleIdent } from '@/app/api/_lib/op-one-time';

/**
 * Validate and quote a user-supplied DB.SCHEMA.TABLE target so it can be
 * safely interpolated into DDL. Unquoted parts are uppercased (matching
 * Snowflake's resolution of unquoted identifiers); every part is then wrapped
 * in double quotes. Rejects malformed FQNs and anything targeting Prism's
 * internal schema.
 */
function buildSafeTargetFqn(rawFqn: string): { fqn: string } | { error: string } {
  let parts: { db: string; schema: string; table: string };
  try {
    parts = parseFqn(rawFqn);
  } catch {
    return { error: 'Target table must be a fully qualified DB.SCHEMA.TABLE name.' };
  }

  const resolved = [parts.db, parts.schema, parts.table].map((p) => {
    const m = /^"(.*)"$/.exec(p);
    return m ? m[1].replace(/""/g, '"') : p.toUpperCase();
  });

  if (resolved.some((p) => !isSimpleIdent(p))) {
    return { error: 'Target table name contains unsupported characters.' };
  }
  if (resolved[0] === 'STAND_DB' && resolved[1] === 'STAND_INTERNAL') {
    return { error: 'Cannot export into the STAND_DB.STAND_INTERNAL schema.' };
  }
  return { fqn: resolved.map(quoteIdent).join('.') };
}

async function exec(connection: any, sqlText: string, binds?: any[]) {
  return new Promise<any[]>((resolve, reject) => {
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

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_OPTS    = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

// ── POST /api/global-standardizations/export ──────────────────────────────────
// Body: { format: 'sheets' | 'snowflake', snowflakeTableFqn?: string }
// Reads the current state of LITERAL_ALIAS_MATCHES and exports.
// Changes should be saved via POST /api/global-standardizations first.

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { format, snowflakeTableFqn, domain_id: rawDomainId, domain_name: rawDomainName } = body as {
    format?: string;
    snowflakeTableFqn?: string;
    domain_id?: number | null;
    domain_name?: string | null;
  };

  if (!format || !['sheets', 'snowflake'].includes(format)) {
    return Response.json({ error: 'Invalid format. Use "sheets" or "snowflake".' }, { status: 400 });
  }

  const domainId   = rawDomainId != null ? Number(rawDomainId) : null;
  const domainName = rawDomainName ? String(rawDomainName) : null;

  // ── Load current mappings from Snowflake ────────────────────────────────────
  let rows: Array<{ canonical_name: string; raw_value: string }>;

  try {
    const result = await withSnowflake(async (connection) => {
      const domainFilter = domainId != null ? 'WHERE lam.domain_id = ?' : '';
      const binds        = domainId != null ? [domainId] : [];
      const sfRows = await exec(
        connection,
        `SELECT aan.alias_name AS canonical_name, lam.literal_value AS raw_value
         FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
         JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
           ON lam.alias_id = aan.alias_id
         ${domainFilter}
         ORDER BY aan.alias_name, lam.literal_value`,
        binds,
      );
      return sfRows.map((r) => ({
        canonical_name: String(r.CANONICAL_NAME ?? r.canonical_name ?? ''),
        raw_value:      String(r.RAW_VALUE      ?? r.raw_value      ?? ''),
      }));
    });
    rows = result as Array<{ canonical_name: string; raw_value: string }>;
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load global standardizations for export');
  }

  const headers     = ['canonical_name', 'raw_value'];
  const sheetData   = [headers, ...rows.map((r) => [r.canonical_name, r.raw_value])];
  const sheetTitle  = domainName ? `${domainName} — Lookup Table` : 'Global Standardizations';

  // ── Google Sheets ────────────────────────────────────────────────────────────
  if (format === 'sheets') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
      return Response.json(
        { error: 'Google Sheets export is not configured on this server.' },
        { status: 503 },
      );
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

    let refreshedTokens: { access_token?: string | null; expiry_date?: number | null } | null = null;
    oauth2Client.on('tokens', (tokens) => { refreshedTokens = tokens; });

    try {
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      const createResp = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: sheetTitle },
          sheets: [{ properties: { title: sheetTitle.slice(0, 100) } }],
        },
      });

      const spreadsheetId = createResp.data.spreadsheetId!;
      const sheetId       = createResp.data.sheets?.[0]?.properties?.sheetId ?? 0;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: { values: sheetData },
      });

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
                dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 },
              },
            },
          ],
        },
      });

      const sheetUrl        = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
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

      return new Response(JSON.stringify({ url: sheetUrl, title: sheetTitle, rows: rows.length }), {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err: any) {
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

  // ── Snowflake table ──────────────────────────────────────────────────────────
  if (format === 'snowflake') {
    const defaultFqn = domainName
      ? `STAND_DB.PUBLIC.${domainName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_LOOKUP`
      : 'STAND_DB.STAND_INTERNAL.GLOBAL_CANONICAL_MAPPINGS';
    const targetFqn = snowflakeTableFqn?.trim() || defaultFqn;

    // Never interpolate the raw string: parse, validate, and fully quote each
    // part. The internal-schema block only applies to user-supplied targets —
    // the legacy no-domain default deliberately lives in STAND_INTERNAL.
    let safeFqn: string;
    if (snowflakeTableFqn?.trim()) {
      const built = buildSafeTargetFqn(targetFqn);
      if ('error' in built) return Response.json({ error: built.error }, { status: 400 });
      safeFqn = built.fqn;
    } else {
      safeFqn = targetFqn.split('.').map(quoteIdent).join('.');
    }

    try {
      await withSnowflake(async (connection) => {
        await exec(
          connection,
          `CREATE OR REPLACE TABLE ${safeFqn} AS
           SELECT
             aan.alias_name    AS canonical_name,
             lam.literal_value AS raw_value,
             lam.confirmed_at
           FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
           JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
             ON lam.alias_id = aan.alias_id
           ORDER BY canonical_name, raw_value`,
        );
      });

      return Response.json({ success: true, table_fqn: targetFqn, rows: rows.length });
    } catch (err) {
      return snowflakeErrorResponse(err, 'Failed to create Snowflake table');
    }
  }

  return Response.json({ error: 'Unknown format' }, { status: 400 });
}
