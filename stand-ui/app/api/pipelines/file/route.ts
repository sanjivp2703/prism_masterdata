import { cookies } from 'next/headers';
import { google } from 'googleapis';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { insertFileRows, readFileDistinctValues, readAllSheetRows } from '@/app/api/_lib/op-file-pipeline';
import { fetchPipelineById, createRunFromQueue } from '@/app/api/_lib/pipeline-hourly-processor';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';
import { encryptSecret } from '@/app/api/_lib/crypto';

function getOAuth2Client(accessToken?: string, refreshToken?: string, tokenExpiry?: string) {
  const c = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
  c.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   tokenExpiry ? parseInt(tokenExpiry, 10) : undefined,
  });
  return c;
}

/**
 * Creates a blank Google Sheets spreadsheet for standardized output, naming the
 * first tab after the source tab so the output structure mirrors the source.
 * Returns null on any failure.
 */
async function createOutputSpreadsheet(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  tokenExpiry: string | undefined,
  title: string,
  firstTabName: string,
): Promise<{ id: string; url: string } | null> {
  if (!process.env.GOOGLE_CLIENT_ID || (!accessToken && !refreshToken)) return null;
  try {
    const auth   = getOAuth2Client(accessToken, refreshToken, tokenExpiry);
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: firstTabName } }],
      },
    });
    const id = res.data.spreadsheetId;
    if (!id) return null;
    return { id, url: `https://docs.google.com/spreadsheets/d/${id}` };
  } catch {
    return null;
  }
}

/**
 * Adds a new tab to an existing output spreadsheet.
 * Silently ignores errors (e.g. tab already exists).
 */
async function addTabToSpreadsheet(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  tokenExpiry: string | undefined,
  spreadsheetId: string,
  tabName: string,
): Promise<void> {
  if (!process.env.GOOGLE_CLIENT_ID || (!accessToken && !refreshToken)) return;
  try {
    const auth   = getOAuth2Client(accessToken, refreshToken, tokenExpiry);
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  } catch { /* tab may already exist */ }
}

function parseMeta(v: any): Record<string, any> {
  if (typeof v === 'object' && v !== null) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

/**
 * POST /api/pipelines/file
 *
 * Creates file-based pipeline(s) (CSV, Excel, or Google Sheets source).
 *
 * CSV / Excel body:
 *   { source_type, column_name, domain_id, file_name, rows }
 *
 * Sheets body (multi-column):
 *   { source_type: 'sheets', spreadsheet_url, spreadsheet_id, sheet_tab_name,
 *     spreadsheet_title,
 *     columns: [{ column_name, domain_id, initial_values? }] }
 *
 * Sheets body (single-column legacy):
 *   { source_type: 'sheets', column_name, domain_id, initial_values, ... }
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session     = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const source_type     = String(body?.source_type ?? '');
  const domain_id_raw   = body?.domain_id != null ? Number(body.domain_id) : null;
  const column_name_raw = String(body?.column_name ?? '').trim();
  const file_name       = String(body?.file_name ?? '').trim();
  const rows            = Array.isArray(body?.rows) ? body.rows : [];

  // Sheets-specific
  const spreadsheet_url   = String(body?.spreadsheet_url  ?? '').trim();
  const spreadsheet_id    = String(body?.spreadsheet_id   ?? '').trim();
  const sheet_tab_name    = String(body?.sheet_tab_name   ?? '').trim();
  const spreadsheet_title = String(body?.spreadsheet_title ?? '').trim();
  const display_name_override = typeof body?.display_name === 'string' ? body.display_name.trim() : '';

  if (!['csv', 'excel', 'sheets'].includes(source_type)) {
    return Response.json({ error: 'source_type must be csv, excel, or sheets' }, { status: 400 });
  }

  // ── Sheets: build columns array ────────────────────────────────────────────
  if (source_type === 'sheets') {
    if (!spreadsheet_id) {
      return Response.json({ error: 'spreadsheet_id is required for sheets' }, { status: 400 });
    }

    // Accept multi-column array or fall back to single-column legacy fields.
    type ColInput = { column_name: string; domain_id: number; initial_values?: string[] };
    const columns: ColInput[] = Array.isArray(body?.columns) && body.columns.length > 0
      ? body.columns.map((c: any) => ({
          column_name:    String(c.column_name ?? '').trim(),
          domain_id:      Number(c.domain_id),
          initial_values: Array.isArray(c.initial_values) ? c.initial_values : [],
        }))
      : [{
          column_name:    column_name_raw,
          domain_id:      domain_id_raw ?? 0,
          initial_values: Array.isArray(body?.initial_values) ? body.initial_values : [],
        }];

    if (columns.some(c => !c.column_name)) {
      return Response.json({ error: 'column_name is required for every column' }, { status: 400 });
    }
    if (columns.some(c => !Number.isFinite(c.domain_id))) {
      return Response.json({ error: 'domain_id is required for every column' }, { status: 400 });
    }

    try {
      const nonce        = Math.random().toString(36).slice(2, 10);
      const outputTabName = sheet_tab_name || 'Sheet1';
      const table_fqn    = `SHEETS:${spreadsheet_id}:${outputTabName}:${nonce}`;

      const display_name = display_name_override
        || (spreadsheet_title
          ? (sheet_tab_name ? `${spreadsheet_title} / ${sheet_tab_name}` : spreadsheet_title)
          : (sheet_tab_name ? `${spreadsheet_id} / ${sheet_tab_name}` : spreadsheet_id));

      // OAuth tokens — needed both for file_source_meta (stored refresh_token for
      // background polling) and later for creating/updating the output spreadsheet.
      const gAccessToken  = cookieStore.get('google_access_token')?.value;
      const gRefreshToken = cookieStore.get('google_refresh_token')?.value;
      const gTokenExpiry  = cookieStore.get('google_token_expiry')?.value;

      // file_source_meta includes all column configs so a single pipeline row
      // carries the full multi-column spec. The refresh_token is stored so the
      // background poller can re-read the sheet autonomously to detect new values.
      const file_source_meta = JSON.stringify({
        source_type, spreadsheet_url, spreadsheet_id, sheet_tab_name,
        columns: columns.map(c => ({ column_name: c.column_name, domain_id: c.domain_id })),
        // Encrypted at rest; decrypted only at the moment of use (the poller's
        // refreshSheetsFileRows). In-memory use below keeps the plaintext token.
        ...(gRefreshToken ? { refresh_token: encryptSecret(gRefreshToken) } : {}),
      });

      // ── Check for duplicate tab pipeline ──────────────────────────────────
      // Fetch ALL existing pipelines for this spreadsheet+tab (no LIMIT).
      // pending_baseline rows = incomplete setup — delete them and allow retry.
      // active/paused rows    = live pipeline — block with a 409.
      {
        let liveDupe = false;
        try {
          await withSnowflake(async (conn) => {
            const existing = await exec(conn, `
              SELECT pipeline_id, status
              FROM STAND_DB.STAND_INTERNAL.PIPELINES
              WHERE source_type = 'sheets'
                AND file_source_meta:spreadsheet_id::VARCHAR     = ?
                AND COALESCE(file_source_meta:sheet_tab_name::VARCHAR, 'Sheet1') = ?
            `, [spreadsheet_id, outputTabName]);

            if (existing.length === 0) return;

            const hasLive = existing.some(r => {
              const s = String((r as any).STATUS ?? (r as any).status ?? '');
              return s !== 'pending_baseline';
            });

            if (hasLive) {
              liveDupe = true;
              return;
            }

            // All rows are pending_baseline — orphaned incomplete setups.
            // Delete them all so the user can start fresh.
            await exec(conn, `
              DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINES
              WHERE source_type = 'sheets'
                AND file_source_meta:spreadsheet_id::VARCHAR     = ?
                AND COALESCE(file_source_meta:sheet_tab_name::VARCHAR, 'Sheet1') = ?
                AND status = 'pending_baseline'
            `, [spreadsheet_id, outputTabName]);
          });
        } catch {
          // Non-fatal — let the INSERT handle any remaining conflict.
        }
        if (liveDupe) {
          return Response.json(
            { error: `A pipeline already exists for tab "${outputTabName}". Use "Standardize another column" on the existing card to add more columns.` },
            { status: 409 },
          );
        }
      }

      // ── Find or create output spreadsheet ─────────────────────────────────
      let outputSpreadsheetId:  string | null = null;
      let outputSpreadsheetUrl: string | null = null;

      // Look for an existing output spreadsheet for this source file (different tab).
      const existingMeta = await withSnowflake(async (conn) => {
        const rows = await exec(conn, `
          SELECT file_export_meta
          FROM STAND_DB.STAND_INTERNAL.PIPELINES
          WHERE source_type = 'sheets'
            AND file_source_meta:spreadsheet_id::VARCHAR         = ?
            AND file_export_meta:output_spreadsheet_id::VARCHAR IS NOT NULL
            AND file_export_meta:output_spreadsheet_id::VARCHAR != ''
          ORDER BY pipeline_id DESC
          LIMIT 1
        `, [spreadsheet_id]);
        if (rows.length === 0) return null;
        return parseMeta(rows[0].FILE_EXPORT_META ?? rows[0].file_export_meta);
      });

      if (existingMeta?.output_spreadsheet_id) {
        // Reuse the existing output spreadsheet; add a new tab for this source tab.
        outputSpreadsheetId  = String(existingMeta.output_spreadsheet_id);
        outputSpreadsheetUrl = existingMeta.output_spreadsheet_url
          ? String(existingMeta.output_spreadsheet_url)
          : `https://docs.google.com/spreadsheets/d/${outputSpreadsheetId}`;
        await addTabToSpreadsheet(gAccessToken, gRefreshToken, gTokenExpiry, outputSpreadsheetId, outputTabName);
      } else {
        // Create a new output spreadsheet, naming the first tab after the source tab.
        const outputTitle = spreadsheet_title
          ? `${spreadsheet_title} — Standardized`
          : `${display_name} — Standardized`;
        const created = await createOutputSpreadsheet(gAccessToken, gRefreshToken, gTokenExpiry, outputTitle, outputTabName);
        if (created) {
          outputSpreadsheetId  = created.id;
          outputSpreadsheetUrl = created.url;
        }
      }

      // ── Create ONE pipeline for this tab ─────────────────────────────────
      const file_export_meta = JSON.stringify({
        spreadsheet_id,
        spreadsheet_url,
        output_spreadsheet_id:  outputSpreadsheetId,
        output_spreadsheet_url: outputSpreadsheetUrl,
        output_tab_name:        outputTabName,
      });

      // Use first column for the row-level column_name / domain_id fields
      // (schema compatibility). The authoritative multi-column spec is in
      // file_source_meta.columns.
      const firstCol = columns[0];
      let pipeline_id: number | null = null;

      await withSnowflake(async (conn) => {
        await exec(conn, `
          INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINES
            (table_fqn, column_name, name, status, mode, export_unmapped_rows,
             created_by, domain_id, source_type, file_source_meta, file_export_meta)
          SELECT ?, ?, ?, 'pending_baseline', 'manual', TRUE,
                 ${Number(session.accountId)}, ${Number(firstCol.domain_id)},
                 ?, PARSE_JSON(?), PARSE_JSON(?)
        `, [table_fqn, firstCol.column_name, display_name, source_type, file_source_meta, file_export_meta]);

        const pidRows = await exec(conn, `
          SELECT pipeline_id FROM STAND_DB.STAND_INTERNAL.PIPELINES
          WHERE table_fqn = ? AND column_name = ?
          ORDER BY pipeline_id DESC LIMIT 1
        `, [table_fqn, firstCol.column_name]);
        pipeline_id = Number(pidRows[0]?.PIPELINE_ID ?? pidRows[0]?.pipeline_id ?? 0);
      });

      if (!pipeline_id) {
        return Response.json({ error: 'Failed to create Sheets pipeline' }, { status: 500 });
      }

      if (!gRefreshToken) {
        console.warn(`[Sheets create] Pipeline ${pipeline_id}: google_refresh_token cookie is missing — background sheet refresh will not work. User may need to re-authenticate.`);
      }

      // Populate PIPELINE_FILE_ROWS from the Google Sheet so the background
      // poller's fallback path has data to compute metrics from.
      try {
        const auth   = getOAuth2Client(gAccessToken, gRefreshToken, gTokenExpiry);
        const sheetsApi = google.sheets({ version: 'v4', auth });
        // Paged read (correct A1 quote escaping) — no silent 10k-row truncation.
        const allRows = await readAllSheetRows(sheetsApi, spreadsheet_id, sheet_tab_name);
        if (allRows.length >= 2) {
          const headerRow  = allRows[0].map(String);
          const dataRows   = allRows.slice(1);
          const rowObjects = dataRows.map((row: any[]) =>
            Object.fromEntries(headerRow.map((h: string, i: number) => [h, String(row[i] ?? '')])),
          );
          await withSnowflake(async (conn) => {
            await insertFileRows(conn, pipeline_id!, rowObjects);
          });
          console.log(`[Sheets create] Pipeline ${pipeline_id}: populated PIPELINE_FILE_ROWS with ${rowObjects.length} rows`);
        }
      } catch (err) {
        console.warn(`[Sheets create] Pipeline ${pipeline_id}: failed to populate PIPELINE_FILE_ROWS:`, err);
      }

      // ── Create one review run per column ─────────────────────────────────
      const run_ids: (number | null)[] = [];
      const column_names: string[]     = columns.map(c => c.column_name);
      const basePipeline = await fetchPipelineById(pipeline_id);

      // If ALL columns have no values, advance the pipeline directly to paused.
      const allEmpty = columns.every(c => (c.initial_values ?? []).filter(Boolean).length === 0);
      if (allEmpty || !basePipeline) {
        if (allEmpty) {
          await withSnowflake(async (conn) => {
            await exec(conn, `
              UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
              SET status = 'paused', last_queue_empty_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
              WHERE pipeline_id = ?
            `, [pipeline_id]);
          });
        }
        return Response.json({ pipeline_id, run_ids: columns.map(() => null), column_names }, { status: 201 });
      }

      for (const col of columns) {
        const literals = (col.initial_values ?? []).map(String).filter(Boolean);
        if (literals.length === 0) { run_ids.push(null); continue; }

        // Spread the pipeline with per-column overrides so the run gets the right
        // source_column and domain_id.
        const colPipeline = { ...basePipeline, column_name: col.column_name, domain_id: col.domain_id };
        const run_id = await withSnowflake(async (conn) => {
          const id = await createRunFromQueue(conn, colPipeline, literals);
          await runAutoGroupForRun(conn, id, apiKey, { writeBreakdown: false });
          return id;
        });
        run_ids.push(run_id);
      }

      return Response.json({ pipeline_id, run_ids, column_names }, { status: 201 });

    } catch (err) {
      return snowflakeErrorResponse(err, 'Failed to create Sheets pipeline');
    }
  }

  // ── CSV / Excel ───────────────────────────────────────────────────────────
  if (!column_name_raw) return Response.json({ error: 'column_name is required' }, { status: 400 });
  if (domain_id_raw == null || !Number.isFinite(domain_id_raw)) {
    return Response.json({ error: 'domain_id is required' }, { status: 400 });
  }
  if (!file_name) return Response.json({ error: 'file_name is required for csv/excel' }, { status: 400 });

  try {
    const nonce        = Math.random().toString(36).slice(2, 10);
    const table_fqn    = `FILE:${file_name}:${nonce}`;
    const display_name = file_name;
    const file_source_meta = JSON.stringify({ source_type, original_name: file_name, nonce });
    const suggested_export = file_name.replace(/\.(csv|xlsx?)$/i, '') + '_standardized';
    const file_export_meta = JSON.stringify({ type: 'download', suggested_name: suggested_export });

    let pipeline_id: number | null = null;

    await withSnowflake(async (conn) => {
      await exec(conn, `
        INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINES
          (table_fqn, column_name, name, status, mode, export_unmapped_rows,
           created_by, domain_id, source_type, file_source_meta, file_export_meta)
        SELECT ?, ?, ?, 'pending_baseline', 'manual', TRUE,
               ${Number(session.accountId)}, ${Number(domain_id_raw)},
               ?, PARSE_JSON(?), PARSE_JSON(?)
      `, [table_fqn, column_name_raw, display_name, source_type, file_source_meta, file_export_meta]);

      const pidRows = await exec(conn, `
        SELECT pipeline_id FROM STAND_DB.STAND_INTERNAL.PIPELINES
        WHERE table_fqn = ? AND column_name = ?
        ORDER BY pipeline_id DESC LIMIT 1
      `, [table_fqn, column_name_raw]);
      pipeline_id = Number(pidRows[0]?.PIPELINE_ID ?? pidRows[0]?.pipeline_id ?? 0);

      if (pipeline_id && rows.length > 0) {
        await insertFileRows(conn, pipeline_id, rows);
      }
    });

    if (!pipeline_id) return Response.json({ error: 'Failed to create pipeline' }, { status: 500 });

    let literals: string[] = [];
    await withSnowflake(async (conn) => {
      literals = await readFileDistinctValues(conn, pipeline_id!, column_name_raw);
    });

    if (literals.length === 0) {
      await withSnowflake(async (conn) => {
        await exec(conn, `
          UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
          SET status = 'paused', last_queue_empty_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
          WHERE pipeline_id = ?
        `, [pipeline_id]);
      });
      return Response.json({ pipeline_id, run_id: null }, { status: 201 });
    }

    const pipeline = await fetchPipelineById(pipeline_id);
    if (!pipeline) return Response.json({ error: 'Pipeline not found after creation' }, { status: 500 });

    const run_id = await withSnowflake(async (conn) => {
      const id = await createRunFromQueue(conn, pipeline, literals);
      await runAutoGroupForRun(conn, id, apiKey, { writeBreakdown: false });
      return id;
    });

    return Response.json({ pipeline_id, run_id }, { status: 201 });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create file pipeline');
  }
}
