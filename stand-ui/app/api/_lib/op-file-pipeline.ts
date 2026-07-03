import 'server-only';

import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { withSnowflake } from './snowflake';
import { normalizeLiteral, sqlStringLiteral } from './normalize';
import { decryptSecret } from './crypto';

function execSql(conn: any, sqlText: string, binds: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function parseVariant(v: any): Record<string, any> {
  if (typeof v === 'object' && v !== null) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/** Max rows per Google Sheets read/write call; larger sheets page in a loop. */
const SHEETS_PAGE_ROWS = 10000;

/**
 * Escape a sheet/tab name for A1 notation. A1 escapes embedded single quotes
 * by DOUBLING them (not backslash-escaping): `Bob's Tab` → `'Bob''s Tab'`.
 */
export function a1Sheet(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** 1-indexed column number → A1 column letters (1 → A, 27 → AA). */
function a1Col(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Read ALL rows from a sheet tab, paging in SHEETS_PAGE_ROWS-row windows so
 * sheets larger than a single page (the old hardcoded `A1:ZZZ10000` cap) are
 * not silently truncated. Stops when a page comes back short or empty.
 */
export async function readAllSheetRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
): Promise<any[][]> {
  const prefix = tabName ? `${a1Sheet(tabName)}!` : '';
  const all: any[][] = [];
  let startRow = 1;
  for (;;) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${prefix}A${startRow}:ZZZ${startRow + SHEETS_PAGE_ROWS - 1}`,
    });
    const page = res.data.values ?? [];
    all.push(...page);
    if (page.length < SHEETS_PAGE_ROWS) break;
    startRow += SHEETS_PAGE_ROWS;
  }
  return all;
}

/**
 * Ensure the target tab has at least `minRows` rows so chunked values.update
 * calls anchored past the current grid don't fail with "exceeds grid limits".
 * Silently no-ops if the tab can't be resolved (the subsequent write surfaces
 * any real failure).
 */
async function ensureSheetRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
  minRows: number,
): Promise<void> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))',
    });
    const allSheets = meta.data.sheets ?? [];
    const target = tabName
      ? allSheets.find(s => s.properties?.title === tabName)
      : allSheets[0];
    const props = target?.properties;
    if (!props || props.sheetId == null) return;
    const current = props.gridProperties?.rowCount ?? 0;
    if (current >= minRows) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: { sheetId: props.sheetId, dimension: 'ROWS', length: minRows - current },
        }],
      },
    });
  } catch (err: any) {
    console.warn('[ensureSheetRows] could not pre-size sheet:', err?.message ?? err);
  }
}


export type SheetsSyncPipeline = {
  file_source_meta: any;
  file_export_meta: any;
  column_name: string;
  domain_id: number | null;
  output_tab_name?: string | null;
};

/**
 * Full table recreation for a Sheets pipeline tab.
 *
 * Finds ALL sibling pipelines for the same spreadsheet + tab (one per
 * standardized column), fetches their confirmed mappings from
 * LITERAL_ALIAS_MATCHES in one DB pass, then clears and rewrites the complete
 * output table in a single Google Sheets update.  Every call produces a
 * consistent snapshot regardless of which column's pipeline triggered it.
 */
export async function syncSheetsColumn(
  pipeline: SheetsSyncPipeline,
  accessToken: string | undefined,
  refreshToken: string | undefined,
  tokenExpiry: string | undefined,
): Promise<{ ok: boolean; error?: string; sheets_updated_rows?: number }> {
  if (!accessToken && !refreshToken) {
    return { ok: false, error: 'No Google auth token — sign in to enable Sheets sync.' };
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return { ok: false, error: 'Google OAuth is not configured on this server.' };
  }

  const sourceMeta = parseVariant(pipeline.file_source_meta);
  const exportMeta = parseVariant(pipeline.file_export_meta);

  const spreadsheetId       = String(sourceMeta?.spreadsheet_id ?? exportMeta?.spreadsheet_id ?? '');
  const tabName             = String(sourceMeta?.sheet_tab_name ?? '');
  const outputSpreadsheetId = exportMeta?.output_spreadsheet_id
    ? String(exportMeta.output_spreadsheet_id)
    : null;
  const outputTabName       = String(exportMeta?.output_tab_name ?? pipeline.output_tab_name ?? '');

  if (!spreadsheetId) return { ok: false, error: 'No spreadsheet_id in pipeline metadata.' };
  if (!outputSpreadsheetId) {
    console.warn('[syncSheetsColumn] No output_spreadsheet_id configured; skipping sheet sync.');
    return { ok: true, sheets_updated_rows: 0 };
  }

  // Fetch ALL sibling pipelines for this spreadsheet+tab and their domain mappings.
  // colName (lowercase) → Record<literalValue, aliasName>
  const colMappings = await withSnowflake(async (conn: any) => {
    // Also select file_source_meta so we can expand multi-column pipelines that
    // store all their columns in file_source_meta.columns (one pipeline per tab).
    const sibRows = await execSql(conn, `
      SELECT column_name, domain_id, file_source_meta
      FROM STAND_DB.STAND_INTERNAL.PIPELINES
      WHERE source_type = 'sheets'
        AND file_source_meta:spreadsheet_id::VARCHAR = ?
        AND COALESCE(file_source_meta:sheet_tab_name::VARCHAR, '') = ?
    `, [spreadsheetId, tabName]);

    const map = new Map<string, Record<string, string>>();
    for (const row of sibRows) {
      const fsm = parseVariant(row.FILE_SOURCE_META ?? row.file_source_meta ?? null);

      // Build the list of column configs for this row. If file_source_meta.columns
      // is populated (multi-column pipeline), use that; otherwise fall back to the
      // row's own column_name / domain_id (legacy single-column pipeline).
      const colConfigs: Array<{ column_name: string; domain_id: number | null }> =
        Array.isArray(fsm?.columns) && fsm.columns.length > 0
          ? fsm.columns.map((c: any) => ({
              column_name: String(c.column_name ?? ''),
              domain_id:   c.domain_id != null ? Number(c.domain_id) : null,
            }))
          : [{
              column_name: String(row.COLUMN_NAME ?? row.column_name ?? ''),
              domain_id:   row.DOMAIN_ID != null ? Number(row.DOMAIN_ID)
                         : row.domain_id != null ? Number(row.domain_id) : null,
            }];

      for (const colCfg of colConfigs) {
        if (!colCfg.column_name) continue;
        const domainId = colCfg.domain_id;
        const mapRows = await execSql(conn, `
          SELECT lam.literal_value, aan.alias_name
          FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
          JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan ON lam.alias_id = aan.alias_id
          WHERE lam.domain_id ${domainId != null ? '= ?' : 'IS NULL'}
        `, domainId != null ? [domainId] : []);
        // Key by the normalized literal so lookups agree with the SQL-side
        // PRISM_NORMALIZE join used for metrics (card and sheet stay in sync).
        const m: Record<string, string> = {};
        for (const r of mapRows) {
          const lv = String(r.LITERAL_VALUE ?? r.literal_value ?? '');
          m[normalizeLiteral(lv)] = String(r.ALIAS_NAME ?? r.alias_name ?? '');
        }
        map.set(colCfg.column_name.toLowerCase(), m);
      }
    }
    return map;
  });

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
  oauth2Client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   tokenExpiry ? parseInt(tokenExpiry, 10) : undefined,
  });

  try {
    const sheets    = google.sheets({ version: 'v4', auth: oauth2Client });
    const outTabPfx = outputTabName ? `${a1Sheet(outputTabName)}!` : '';

    // Read all source data (paged past the old 10k-row cap).
    const allRows = await readAllSheetRows(sheets, spreadsheetId, tabName);
    if (allRows.length < 2) return { ok: true, sheets_updated_rows: 0 };

    const sourceHeaders = allRows[0].map(String);
    const dataRows      = allRows.slice(1);

    // Build the COMPLETE output grid in memory first: every standardized column
    // gets its confirmed mapping applied (normalized lookup); all other columns
    // carry the raw source value.
    const outputRows: string[][] = dataRows.map((row: any[]) =>
      sourceHeaders.map((header: string, i: number) => {
        const rawVal = String(row[i] ?? '');
        const m      = colMappings.get(header.toLowerCase());
        return (m && rawVal) ? (m[normalizeLiteral(rawVal)] ?? rawVal) : rawVal;
      }),
    );
    const outputGrid = [sourceHeaders, ...outputRows];

    // Non-destructive write: overwrite in place with values.update, chunked to
    // ≤ SHEETS_PAGE_ROWS rows per call, WITHOUT clearing first. If any chunk
    // fails we abort (outer catch) and leave the remaining old content rather
    // than an emptied output sheet.
    if (outputGrid.length > SHEETS_PAGE_ROWS) {
      await ensureSheetRows(sheets, outputSpreadsheetId, outputTabName, outputGrid.length);
    }
    for (let start = 0; start < outputGrid.length; start += SHEETS_PAGE_ROWS) {
      const chunk = outputGrid.slice(start, start + SHEETS_PAGE_ROWS);
      await sheets.spreadsheets.values.update({
        spreadsheetId: outputSpreadsheetId,
        range: `${outTabPfx}A${start + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: chunk },
      });
    }

    // Only AFTER a fully successful write: clear stale leftovers — rows below
    // the new grid and columns to the right of the new width. Failures here are
    // logged but don't fail the sync (the data itself is already written).
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: outputSpreadsheetId,
        range: `${outTabPfx}A${outputGrid.length + 1}:ZZZ`,
      });
      if (sourceHeaders.length > 0) {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: outputSpreadsheetId,
          range: `${outTabPfx}${a1Col(sourceHeaders.length + 1)}1:ZZZ`,
        });
      }
    } catch (clearErr: any) {
      console.warn('[syncSheetsColumn] trailing clear failed (data written OK):', clearErr?.message ?? clearErr);
    }

    return { ok: true, sheets_updated_rows: dataRows.length };
  } catch (err: any) {
    console.warn('[syncSheetsColumn] error:', err?.message ?? err);
    const status = err?.response?.status ?? err?.code;
    if (status === 401 || status === 403) {
      return { ok: false, error: 'Google auth expired — sign in again to re-enable Sheets sync.' };
    }
    return { ok: false, error: err?.message ?? 'Failed to update Google Sheet.' };
  }
}

/**
 * Re-read a Google Sheets source, replace PIPELINE_FILE_ROWS with the current
 * sheet data, then compute and return pipeline metrics.
 *
 * Called by the background poller each cycle for Sheets pipelines so that new
 * values added to the source sheet are detected without user interaction.
 *
 * Returns null if the pipeline has no stored refresh_token or if the Sheets API
 * call fails (the caller falls back to counting PIPELINE_QUEUE).
 */
export async function refreshSheetsFileRows(
  pipelineId: number,
  meta: Record<string, any>,
): Promise<{ totalSourceValues: number; totalMapped: number; queueSize: number } | null> {
  const { spreadsheet_id, sheet_tab_name, columns, refresh_token } = meta;
  if (!spreadsheet_id) {
    console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: missing spreadsheet_id in file_source_meta`);
    return null;
  }
  if (!refresh_token) {
    console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: no refresh_token stored — re-authenticate via Google Sheets to enable background polling`);
    return null;
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: columns not found in file_source_meta`);
    return null;
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: GOOGLE_CLIENT_ID not set — cannot refresh Google auth`);
    return null;
  }

  // Stored token may be encrypted at rest (enc:v1 format); decrypt only here,
  // at the moment of use. Plaintext legacy rows pass through unchanged. The
  // meta object keeps the stored form so write-backs never persist plaintext.
  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptSecret(String(refresh_token));
  } catch (err: any) {
    console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: could not decrypt stored refresh_token:`, err?.message ?? err);
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
  oauth2Client.setCredentials({ refresh_token: refreshTokenPlain });

  try {
    const sheets  = google.sheets({ version: 'v4', auth: oauth2Client });
    const allRows = await readAllSheetRows(
      sheets,
      String(spreadsheet_id),
      sheet_tab_name ? String(sheet_tab_name) : '',
    );
    console.log(`[refreshSheetsFileRows] Pipeline ${pipelineId}: read ${allRows.length} rows from sheet (incl. header)`);
    if (allRows.length < 2) {
      console.warn(`[refreshSheetsFileRows] Pipeline ${pipelineId}: sheet has < 2 rows — returning 0 metrics`);
      return { totalSourceValues: 0, totalMapped: 0, queueSize: 0 };
    }

    const headerRow  = allRows[0].map(String);
    const dataRows   = allRows.slice(1);
    const rowObjects = dataRows.map((row: any[]) =>
      Object.fromEntries(headerRow.map((h: string, i: number) => [h, String(row[i] ?? '')])),
    );

    console.log(`[refreshSheetsFileRows] Pipeline ${pipelineId}: ${dataRows.length} data rows, headers=[${headerRow.join(', ')}]`);

    // Replace PIPELINE_FILE_ROWS with the current sheet snapshot.
    // Wrapped in an explicit transaction so the DELETE rolls back if any INSERT fails.
    await withSnowflake(async (conn) => {
      await execSql(conn, `BEGIN`, []);
      try {
        await execSql(conn,
          `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS WHERE pipeline_id = ?`,
          [pipelineId]);
        const BATCH = 200;
        for (let b = 0; b < rowObjects.length; b += BATCH) {
          const chunk = rowObjects.slice(b, b + BATCH);
          const vals  = chunk.map((_: any, i: number) => `(${pipelineId}, ${b + i}, ?)`).join(', ');
          const binds = chunk.map((r: Record<string, any>) => JSON.stringify(r));
          await execSql(conn,
            `INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS (pipeline_id, row_num, column_data)
             SELECT column1, column2, PARSE_JSON(column3) FROM VALUES ${vals}`,
            binds);
        }
        await execSql(conn, `COMMIT`, []);
      } catch (txErr) {
        await execSql(conn, `ROLLBACK`, []).catch(() => {});
        throw txErr;
      }
    });

    console.log(`[refreshSheetsFileRows] Pipeline ${pipelineId}: replaced PIPELINE_FILE_ROWS with ${rowObjects.length} rows`);

    // Compute metrics per column and aggregate.
    let totalSourceValues = 0;
    let totalMapped       = 0;
    const updatedColumns: Array<Record<string, any>> = [];

    for (const colCfg of columns) {
      const colName  = String(colCfg.column_name ?? '');
      const domainId = colCfg.domain_id != null ? Number(colCfg.domain_id) : null;
      if (!colName) {
        updatedColumns.push(colCfg);
        continue;
      }

      const safeCol   = sqlStringLiteral(colName);
      const domainCond = domainId != null ? `AND lam.domain_id = ${domainId}` : 'AND lam.domain_id IS NULL';

      const rows = await withSnowflake(async (conn) => execSql(conn, `
        WITH src AS (
          SELECT DISTINCT PRISM_NORMALIZE(column_data['${safeCol}']::VARCHAR) AS nv
          FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS
          WHERE pipeline_id = ?
            AND column_data['${safeCol}']::VARCHAR IS NOT NULL
            AND TRIM(column_data['${safeCol}']::VARCHAR) != ''
        )
        SELECT
          COUNT(*)                                                       AS total,
          COUNT(lam.literal_value)                                       AS mapped
        FROM src
        LEFT JOIN STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
          ON PRISM_NORMALIZE(lam.literal_value) = src.nv
          ${domainCond}
      `, [pipelineId]));

      const colTotal  = rows.length > 0 ? Number((rows[0] as any).TOTAL  ?? (rows[0] as any).total  ?? 0) : 0;
      const colMapped = rows.length > 0 ? Number((rows[0] as any).MAPPED ?? (rows[0] as any).mapped ?? 0) : 0;
      console.log(`[refreshSheetsFileRows] Pipeline ${pipelineId}: column "${colName}" (domain ${domainId}) → total=${colTotal}, mapped=${colMapped}`);
      totalSourceValues += colTotal;
      totalMapped       += colMapped;
      updatedColumns.push({
        column_name: colName,
        domain_id:   domainId,
        total_source_values: colTotal,
        total_mapped:        colMapped,
      });
    }

    // Write per-column metrics into file_source_meta so the GET route's virtual
    // expansion can assign correct per-column values instead of duplicating the
    // aggregate to every virtual entry.
    //
    // Lost-update guard: `meta` was captured at cycle start — if a user added a
    // column or re-authed (new refresh_token) mid-cycle, writing the stale copy
    // back would revert their change. Re-SELECT the CURRENT meta and deep-merge
    // only the per-column metrics computed above (matched by column_name) into
    // the fresh copy; anything present in the fresh copy that the stale copy
    // lacked (new columns, rotated refresh_token) is preserved untouched.
    await withSnowflake(async (conn) => {
      const freshRows = await execSql(conn, `
        SELECT file_source_meta
        FROM STAND_DB.STAND_INTERNAL.PIPELINES
        WHERE pipeline_id = ?
      `, [pipelineId]);
      const freshMeta = freshRows.length > 0
        ? parseVariant(freshRows[0].FILE_SOURCE_META ?? freshRows[0].file_source_meta ?? null)
        : {};
      const base = Object.keys(freshMeta).length > 0 ? freshMeta : meta;

      const metricsByCol = new Map<string, Record<string, any>>();
      for (const c of updatedColumns) {
        const name = String(c.column_name ?? '');
        if (name && c.total_source_values != null) metricsByCol.set(name, c);
      }

      const baseCols: any[] = Array.isArray(base.columns) ? base.columns : updatedColumns;
      const mergedCols = baseCols.map((c: any) => {
        const m = metricsByCol.get(String(c?.column_name ?? ''));
        return m
          ? { ...c, total_source_values: m.total_source_values, total_mapped: m.total_mapped }
          : c;
      });

      const updatedMeta = { ...base, columns: mergedCols };
      await execSql(conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET file_source_meta = PARSE_JSON(?)
         WHERE pipeline_id = ?`,
        [JSON.stringify(updatedMeta), pipelineId]);
    });

    const queueSize = Math.max(0, totalSourceValues - totalMapped);
    console.log(`[refreshSheetsFileRows] Pipeline ${pipelineId}: aggregate → totalSource=${totalSourceValues}, totalMapped=${totalMapped}, queue=${queueSize}`);
    return { totalSourceValues, totalMapped, queueSize };
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    if (status === 401 || status === 403) {
      console.warn(`[refreshSheetsFileRows] Google auth expired for pipeline ${pipelineId}`);
    } else {
      console.warn(`[refreshSheetsFileRows] Failed for pipeline ${pipelineId}:`, err?.message ?? err);
    }
    return null;
  }
}

export async function insertFileRows(
  conn: any,
  pipelineId: number,
  rows: Record<string, any>[],
): Promise<void> {
  const BATCH = 200;
  for (let b = 0; b < rows.length; b += BATCH) {
    const chunk = rows.slice(b, b + BATCH);
    const vals  = chunk.map((_, i) => `(${pipelineId}, ${b + i}, ?)`).join(', ');
    const binds = chunk.map(r => JSON.stringify(r));
    await execSql(
      conn,
      `INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS (pipeline_id, row_num, column_data)
       SELECT column1, column2, PARSE_JSON(column3) FROM VALUES ${vals}`,
      binds,
    );
  }
}

export async function readFileDistinctValues(
  conn: any,
  pipelineId: number,
  columnName: string,
): Promise<string[]> {
  const safeCol = sqlStringLiteral(columnName);
  const rows = await execSql(conn, `
    SELECT ANY_VALUE(column_data['${safeCol}']::VARCHAR) AS val
    FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS
    WHERE pipeline_id = ?
      AND column_data['${safeCol}']::VARCHAR IS NOT NULL
    GROUP BY PRISM_NORMALIZE(column_data['${safeCol}']::VARCHAR)
  `, [pipelineId]);
  return rows.map((r: any) => String(r.VAL ?? r.val ?? '')).filter(Boolean);
}

export async function readFilePipelineRowsForDownload(
  conn: any,
  pipelineId: number,
  columnName: string,
  domainId: number | null,
): Promise<{ headers: string[]; rows: string[][] }> {
  const fileRows = await execSql(conn, `
    SELECT row_num, column_data
    FROM STAND_DB.STAND_INTERNAL.PIPELINE_FILE_ROWS
    WHERE pipeline_id = ?
    ORDER BY row_num
  `, [pipelineId]);

  if (fileRows.length === 0) return { headers: [], rows: [] };

  const first   = parseVariant(fileRows[0].COLUMN_DATA ?? fileRows[0].column_data);
  const headers = Object.keys(first);

  const domainFilter = domainId != null
    ? `AND lam.domain_id = ${Number(domainId)}`
    : `AND lam.domain_id IS NULL`;
  const mappingRows = await execSql(conn, `
    SELECT lam.literal_value, aan.alias_name
    FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
    JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES aan ON aan.alias_id = lam.alias_id
    WHERE 1=1 ${domainFilter}
  `, []);
  // Key by normalizeLiteral so the download matches the same values as the
  // SQL-side PRISM_NORMALIZE joins used for metrics.
  const mappings = new Map<string, string>();
  for (const mr of mappingRows) {
    const lv = String(mr.LITERAL_VALUE ?? mr.literal_value ?? '');
    const an = String(mr.ALIAS_NAME    ?? mr.alias_name    ?? '');
    mappings.set(normalizeLiteral(lv), an);
  }

  const stdHeader   = `${columnName}_STANDARDIZED`;
  const outHeaders  = [...headers, stdHeader];
  const outRows     = fileRows.map((fr: any) => {
    const cd     = parseVariant(fr.COLUMN_DATA ?? fr.column_data);
    const rawVal = String(cd[columnName] ?? '');
    const stdVal = mappings.get(normalizeLiteral(rawVal)) ?? rawVal;
    return [...headers.map(h => String(cd[h] ?? '')), stdVal];
  });

  return { headers: outHeaders, rows: outRows };
}
