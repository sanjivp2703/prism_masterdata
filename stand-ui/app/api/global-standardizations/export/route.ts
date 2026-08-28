import { reportError, googleErrorMessage } from '@/app/api/_lib/report-error';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { warehouseErrorResponse, withWarehouse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { parseFqn, quoteIdent, isSimpleIdent } from '@/app/api/_lib/op-one-time';
import { internalTable } from '@/app/api/_lib/warehouse-tables';
import { parseFqn as pgParseFqn, quoteIdent as pgQuoteIdent, assertFqnInDatabase } from '@/app/api/_lib/warehouse/postgres/dialect';
import { getConnectedPgDatabase } from '@/app/api/_lib/warehouse/postgres/connection';
import { parseFqn as myParseFqn, quoteIdent as myQuoteIdent } from '@/app/api/_lib/warehouse/mysql/dialect';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { visibleSpecIdsForViewer } from '@/app/api/_lib/native-visibility';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';

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
  // Compare case-INSENSITIVELY. Unquoted parts were uppercased above, but
  // QUOTED parts are preserved verbatim, so `"prism_db"."internal".X` sailed
  // past this guard. On Snowflake that was refused anyway — by accident of the
  // platform, since quoted identifiers are case-sensitive and no lowercase
  // `prism_db` exists — and it surfaced as a driver 500 rather than this clean
  // 400. On SQL Server, where identifiers are case-insensitive by default, the
  // same input would have resolved to the real internal schema. A guard that
  // holds only because of one dialect's casing rules is not a guard.
  //
  // Deliberately over-strict: a genuinely distinct lowercase-quoted database is
  // refused too. Nobody should be exporting a lookup into anything that reads
  // as PRISM_DB.INTERNAL.
  // .trim() as well as .toUpperCase(): parseFqn trims each part's OUTER
  // whitespace, but a space INSIDE the quotes survives, so `"PRISM_DB "` was
  // still slipping past. Harmless on Snowflake (resolves to nothing), but SQL
  // Server ignores trailing blanks in identifiers, where it would have resolved
  // to the real internal schema.
  if (resolved[0].trim().toUpperCase() === 'PRISM_DB' && resolved[1].trim().toUpperCase() === 'INTERNAL') {
    return { error: 'Cannot export into the PRISM_DB.INTERNAL schema.' };
  }
  return { fqn: resolved.map(quoteIdent).join('.') };
}

/**
 * Postgres variant: accepts SCHEMA.TABLE or DB.SCHEMA.TABLE (the DB part must
 * match the connected database — Postgres cannot write across databases),
 * folds unquoted parts to LOWERCASE (Postgres's resolution rule, the opposite
 * of Snowflake's), and refuses Prism's internal schema.
 */
function buildSafeTargetFqnPg(rawFqn: string): { fqn: string } | { error: string } {
  let parsed: { db: string | null; schema: string; table: string };
  try {
    parsed = pgParseFqn(rawFqn);
    const connected = getConnectedPgDatabase();
    if (connected) assertFqnInDatabase(parsed, connected);
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    return {
      error: msg.includes('cannot query across databases')
        ? msg
        : 'Target table must be a SCHEMA.TABLE (or DB.SCHEMA.TABLE) name.',
    };
  }

  const resolved = [parsed.schema, parsed.table].map((p) => {
    const m = /^"(.*)"$/.exec(p);
    return m ? m[1].replace(/""/g, '"') : p.toLowerCase();
  });
  if (resolved.some((p) => !isSimpleIdent(p))) {
    return { error: 'Target table name contains unsupported characters.' };
  }
  // Same over-strict spirit as the Snowflake guard: nothing that reads as the
  // internal schema is writable, regardless of quoting or case.
  if (resolved[0].trim().toLowerCase() === 'prism_internal') {
    return { error: 'Cannot export into the prism_internal schema.' };
  }
  return { fqn: resolved.map(pgQuoteIdent).join('.') };
}

/**
 * MySQL analog of buildSafeTargetFqnPg: DATABASE.TABLE only (MySQL has no
 * schema level), lowercase folding for unquoted parts (install convention;
 * table-name case sensitivity is OS-dependent), backtick quoting, and refuses
 * Prism's internal database.
 */
function buildSafeTargetFqnMysql(rawFqn: string): { fqn: string } | { error: string } {
  let parsed: { db: string; table: string };
  try {
    parsed = myParseFqn(rawFqn);
  } catch {
    return { error: 'Target table must be a DATABASE.TABLE name (MySQL has no schema level).' };
  }
  const resolved = [parsed.db, parsed.table].map((p) => {
    const m = /^`(.*)`$/.exec(p);
    return m ? m[1].replace(/``/g, '`') : p.toLowerCase();
  });
  if (resolved.some((p) => !isSimpleIdent(p))) {
    return { error: 'Target table name contains unsupported characters.' };
  }
  if (resolved[0].trim().toLowerCase() === 'prism_internal') {
    return { error: 'Cannot export into the prism_internal database.' };
  }
  return { fqn: resolved.map(myQuoteIdent).join('.') };
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
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
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
  if (format === 'sheets' && isNativeEdition()) {
    return nativeEditionUnavailable('Google Sheets export');
  }

  // Validate rather than passing NaN straight through to a bind, which the
  // warehouse rejected with a driver error surfaced as a 500 on what is plainly
  // a bad request.
  let domainId: number | null = null;
  if (rawDomainId != null) {
    const n = Number(rawDomainId);
    if (!Number.isFinite(n)) {
      return Response.json({ error: 'domain_id must be a number.' }, { status: 400 });
    }
  {
    const visibleSpecs = await visibleSpecIdsForViewer(authz.accountId);
    if (visibleSpecs && domainId != null && !visibleSpecs.has(domainId)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }
    domainId = n;
  }
  const domainName = rawDomainName ? String(rawDomainName) : null;

  // ── Load current mappings from Snowflake ────────────────────────────────────
  let rows: Array<{ canonical_name: string; raw_value: string }>;

  try {
    const result = await withWarehouse(async (connection) => {
      const domainFilter = domainId != null ? 'WHERE lam.domain_id = ?' : '';
      const binds        = domainId != null ? [domainId] : [];
      const sfRows = await exec(
        connection,
        `SELECT aan.alias_name AS canonical_name, lam.literal_value AS raw_value
         FROM ${internalTable('LITERAL_ALIAS_MATCHES')}  lam
         JOIN ${internalTable('APPROVED_ALIAS_NAMES')}   aan
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
    return warehouseErrorResponse(err, 'Failed to load global standardizations for export');
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

      // The asymmetry here is deliberate, not an oversight (LKP-02): Google caps
      // a SHEET (tab) title at 100 characters and rejects the create call above
      // that, but imposes no comparable limit on the SPREADSHEET (file) title.
      // So the slice belongs on the tab only. Do not "tidy" this by making the
      // two match — capping both truncates the file name for no reason, and
      // removing the slice turns a long spec name into a hard API error.
      //
      // Consequence worth knowing: for a name over 100 chars the file name and
      // the tab name legitimately differ. That is cosmetic and accepted.
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
      reportError(err, { route: 'app/api/global-standardizations/export/route.ts' });
      return Response.json(
        { error: googleErrorMessage(err) },
        { status: 500 },
      );
    }
  }

  // ── Warehouse table (Snowflake or SQL Server) ───────────────────────────────
  if (format === 'snowflake') {
    const isMssql = getWarehouseAdapter().kind === 'mssql';
    const isPg    = getWarehouseAdapter().kind === 'postgres';
    const isMy    = getWarehouseAdapter().kind === 'mysql';
    // SQL Server installs default lookup exports into EXPORTS ("PUBLIC"
    // collides with the built-in database role there). Postgres installs are
    // single-database (no PRISM_DB) — the default is the 2-part
    // prism_exports.<name>_lookup, lowercase per Postgres folding.
    const defaultSchema = isMssql ? 'EXPORTS' : 'PUBLIC';
    const defaultFqn = isPg || isMy
      // MySQL shares the pg spelling: prism_exports is a DATABASE there.
      ? (domainName
          ? `prism_exports.${domainName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_lookup`
          : `prism_exports.global_canonical_mappings`)
      : (domainName
          ? `PRISM_DB.${defaultSchema}.${domainName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_LOOKUP`
          : `PRISM_DB.${defaultSchema}.GLOBAL_CANONICAL_MAPPINGS`);
    const targetFqn = snowflakeTableFqn?.trim() || defaultFqn;

    // Never interpolate the raw string: parse, validate, and fully quote each
    // part.
    //
    // The INTERNAL-schema refusal inside buildSafeTargetFqn is skipped on the
    // else-branch because that branch handles a target Prism itself just built
    // above (PRISM_DB.PUBLIC/EXPORTS.*), not anything the user typed — so
    // there is nothing to validate. It is NOT skipped because the default
    // "lives in INTERNAL", which is what this comment used to claim; that
    // stopped being true when the default moved to PUBLIC/EXPORTS, and it read
    // as a security exemption resting on a false premise. Both branches still
    // fully quote every part.
    let safeFqn: string;
    if (snowflakeTableFqn?.trim()) {
      const built = isPg ? buildSafeTargetFqnPg(targetFqn) : isMy ? buildSafeTargetFqnMysql(targetFqn) : buildSafeTargetFqn(targetFqn);
      if ('error' in built) return Response.json({ error: built.error }, { status: 400 });
      safeFqn = built.fqn;
    } else {
      safeFqn = targetFqn.split('.').map(isPg ? pgQuoteIdent : isMy ? myQuoteIdent : quoteIdent).join('.');
    }

    try {
      await withWarehouse(async (connection) => {
        const selectBody =
          `SELECT
             aan.alias_name    AS canonical_name,
             lam.literal_value AS raw_value,
             lam.confirmed_at`;
        // The spec filter MUST be repeated here. It is not enough that the
        // `rows` array loaded above was filtered: that array only feeds the
        // response's row COUNT, while the statement below re-queries the lookup
        // independently. Without this WHERE the created table received EVERY
        // spec's mappings in the install while being named after one column and
        // reported as "N mappings" for that column — wrong contents, a false
        // count, and a cross-column disclosure into a PUBLIC-schema table that
        // other roles may read. Live-reproduced: a request scoped to one spec
        // answered "5 mappings" and wrote 22 rows including another spec's
        // values. CSV/Excel/Sheets were always scoped correctly; only this
        // branch was not.
        const exportFilter = domainId != null ? 'WHERE lam.domain_id = ?' : '';
        const exportBinds  = domainId != null ? [domainId] : [];
        const fromBody =
          `FROM ${internalTable('LITERAL_ALIAS_MATCHES')}  lam
           JOIN ${internalTable('APPROVED_ALIAS_NAMES')}   aan
             ON lam.alias_id = aan.alias_id
           ${exportFilter}`;
        if (isMssql) {
          // T-SQL has no CREATE OR REPLACE — drop + SELECT INTO. (ORDER BY on
          // a heap insert is not a durable order; consumers sort themselves.)
          await exec(connection, `DROP TABLE IF EXISTS ${safeFqn}`);
          await exec(connection, `${selectBody}\n           INTO ${safeFqn}\n           ${fromBody}`, exportBinds);
        } else if (isPg || isMy) {
          // Neither Postgres nor MySQL has CREATE OR REPLACE TABLE — drop + CTAS.
          // (CTAS honours ORDER BY for the physical write; as everywhere,
          // consumers who need guaranteed order still sort themselves.)
          await exec(connection, `DROP TABLE IF EXISTS ${safeFqn}`);
          await exec(
            connection,
            `CREATE TABLE ${safeFqn} AS\n           ${selectBody}\n           ${fromBody}\n           ORDER BY canonical_name, raw_value`,
            exportBinds,
          );
        } else {
          await exec(
            connection,
            `CREATE OR REPLACE TABLE ${safeFqn} AS\n           ${selectBody}\n           ${fromBody}\n           ORDER BY canonical_name, raw_value`,
            exportBinds,
          );
        }
      });

      return Response.json({ success: true, table_fqn: targetFqn, rows: rows.length });
    } catch (err) {
      return warehouseErrorResponse(err, 'Failed to create Snowflake table');
    }
  }

  return Response.json({ error: 'Unknown format' }, { status: 400 });
}
