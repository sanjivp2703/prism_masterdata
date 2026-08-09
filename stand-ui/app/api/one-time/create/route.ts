/**
 * POST /api/one-time/create
 *
 * Body: { source_relation, columns: [{ column_name, convention? }] }
 * Creates one one-time RUNS row per column (run_type='one_time', domain_id NULL),
 * sharing a session nonce. Does NOT group yet — the client calls
 * /api/one-time/[run_id]/group per column to drive per-page progress.
 *
 * Returns { session, columns: [{ run_id, column_name }] }.
 */

import { cookies } from 'next/headers';
import {
  withWarehouse, withUserWarehouse, hasUserWarehouseConfig,
  isWarehouseAccessError, warehouseErrorResponse,
  executeQuery, getWarehouseAdapter,
} from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { createOneTimeRun, isSimpleIdent, parseFqn, quoteIdent, OneTimeTooLargeError } from '@/app/api/_lib/op-one-time';
import { sanitizeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';
import { validateStandardizationRules, validateConventionValue } from '@/app/api/_lib/column-specs';
import type { NamingConvention } from '@/app/api/_lib/llm-one-prompt-grouping';
import { llmErrorResponse } from '@/app/api/_lib/llm-one-prompt-grouping';
import { insertOneTimeFileRows, deleteOneTimeFileRows } from '@/app/api/_lib/op-one-time-file';
import { google } from 'googleapis';
import { readAllSheetRows, SheetTooLargeError } from '@/app/api/_lib/sheets-io';
import { gridToRows } from '@/app/api/_lib/table-shape';

function parseConvention(raw: any): NamingConvention | null {
  if (!raw || typeof raw !== 'object') return null;
  const ct = String(raw.type ?? '').toLowerCase();
  const cv = String(raw.value ?? '');
  const type = (ct === 'regex' || ct === 'examples' || ct === 'natural') && cv.trim() ? (ct as NamingConvention['type']) : null;
  const rules = raw.rules ? sanitizeConventionRules(raw.rules) : null;
  const prestd: string[] = Array.isArray(raw.prestandardized_values)
    ? (raw.prestandardized_values as unknown[]).map(v => String(v).trim()).filter(Boolean)
    : [];
  const hasPrestd = prestd.length > 0;
  if (!type && !(rules && hasAnyRule(rules)) && !hasPrestd) return null;
  return {
    type, value: cv,
    rules: rules && hasAnyRule(rules) ? rules : null,
    prestandardized_values: hasPrestd ? prestd : null,
  };
}

/**
 * Free-text standardization rules for a one-time run.
 *
 * REFUSES rather than truncates. This used to `.slice(0, 20)` and clip each
 * rule to 500 chars, so a user submitting 26 rules with one 700-char rule
 * silently lost six of them and had the long one cut mid-sentence — which can
 * invert its meaning ("...except for subsidiaries" disappearing) before it goes
 * verbatim into the LLM prompt. The pipeline path 400s on the same input, so
 * the two contradicted each other, and quiet truncation contradicts CLAUDE.md's
 * invariant that scale limits refuse loudly and never drop data silently
 * (SPEC-02). Shares the pipeline path's validator so they cannot drift again.
 */
function parseStdRules(raw: any): { ok: true; rules: string[] | null } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: true, rules: null };
  const v = validateStandardizationRules(raw);
  if (!v.ok) return v;
  return { ok: true, rules: v.rules.length > 0 ? v.rules : null };
}

export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const source_relation = String(body?.source_relation ?? '').trim();
  const rawColumns = Array.isArray(body?.columns) ? body.columns : [];

  // Source kind. 'warehouse' (the historical behaviour) scans a real table;
  // 'file' means the caller uploaded rows with this request — a CSV/Excel file
  // or a Google Sheet tab. Files are one-shot by nature, which is exactly what
  // the one-time flow is for; pipelines stay warehouse-only.
  const rawSourceType = String(body?.source_type ?? 'warehouse').trim().toLowerCase();
  const FILE_SOURCES = new Set(['csv', 'excel', 'sheets']);
  const isFileSource = FILE_SOURCES.has(rawSourceType);
  if (rawSourceType !== 'warehouse' && !isFileSource) {
    return Response.json({ error: 'source_type must be one of: warehouse, csv, excel, sheets.' }, { status: 400 });
  }

  // Uploaded rows, one object per source row keyed by column header.
  const fileRows: Record<string, unknown>[] = isFileSource && Array.isArray(body?.rows) ? body.rows : [];

  if (!source_relation) return Response.json({ error: 'source_relation is required' }, { status: 400 });

  // A Google Sheet is read SERVER-SIDE from its id + tab, not shipped row by row
  // from the browser: the sheet can be 100k rows, the server already has a
  // paged reader with the right A1 quoting and size ceiling, and the browser
  // would otherwise have to fetch and re-post the whole thing.
  const isSheetSource = rawSourceType === 'sheets';
  const spreadsheetId = String(body?.spreadsheet_id ?? '').trim();
  const sheetTabName  = String(body?.sheet_tab_name ?? '').trim();
  const sheetHeaderRow = (() => {
    const n = Number(body?.header_row);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  })();

  if (isSheetSource) {
    if (!spreadsheetId || !sheetTabName) {
      return Response.json({ error: 'A spreadsheet and tab are required.' }, { status: 400 });
    }
  } else if (isFileSource) {
    if (fileRows.length === 0) {
      return Response.json({ error: 'No rows were received from the file.' }, { status: 400 });
    }
    // Same ceiling the file-pipeline path enforced: rows are held in memory and
    // inserted row-by-row, so an unbounded upload is a process-memory hazard on
    // this single-process server.
    if (fileRows.length > 200_000) {
      return Response.json(
        { error: 'File too large (max 200,000 rows). Load the data into a warehouse table and standardize that instead.' },
        { status: 400 },
      );
    }
  } else {
    // Warehouse source: source_relation must be a real, safely-quotable FQN.
    try {
      const { db, schema, table } = parseFqn(source_relation);
      if (![db, schema, table].every(isSimpleIdent)) {
        return Response.json({ error: 'Table name contains unsupported characters.' }, { status: 400 });
      }
    } catch {
      return Response.json({ error: `Invalid source table. Expected DB.SCHEMA.TABLE, got: ${source_relation}` }, { status: 400 });
    }
  }

  // Validate rules BEFORE building the column list, so an over-cap submission
  // is refused with the same message the pipeline path gives instead of being
  // silently trimmed.
  for (const c of rawColumns) {
    const v = parseStdRules((c as any)?.standardization_rules);
    if (!v.ok) {
      const name = String((c as any)?.column_name ?? '').trim();
      return Response.json({ error: name ? `${name}: ${v.error}` : v.error }, { status: 400 });
    }
  }

  const columns = rawColumns
    .map((c: any) => ({
      column_name: String(c?.column_name ?? '').trim(),
      convention: parseConvention(c?.convention),
      standardization_rules: (parseStdRules(c?.standardization_rules) as { ok: true; rules: string[] | null }).rules,
      // Optional free-text description (grouping concept definition). Capped like
      // a spec/domain description — it rides verbatim in the prompt.
      description: (() => {
        const d = String(c?.description ?? '').trim();
        return d ? d.slice(0, 1_000) : null;
      })(),
    }))
    .filter((c: any) => c.column_name);

  if (columns.length === 0) return Response.json({ error: 'Select at least one column to standardize.' }, { status: 400 });
  for (const c of columns) {
    if (!isSimpleIdent(c.column_name)) {
      return Response.json({ error: `Column "${c.column_name}" contains unsupported characters.` }, { status: 400 });
    }
    // Full convention validation — length cap AND (for regex) compilability and
    // the catastrophic-backtracking screen, via the same validator the
    // column-specs routes use.
    //
    // This route previously checked ONLY the length cap, so an unparseable
    // pattern ("[unclosed") and a catastrophic-but-short one ("(a+)+b") both
    // sailed through here while the column-specs path rejected them — a third
    // code path with its own weaker rules (SPEC-03). The pattern is later
    // compiled and .test()'d against raw source literals, so letting a
    // catastrophic one through risks hanging the whole single-process server.
    if (c.convention?.type) {
      const v = validateConventionValue(c.convention.type, c.convention.value);
      if (!v.ok) {
        return Response.json({ error: `Naming convention for "${c.column_name}": ${v.error}` }, { status: 400 });
      }
    }
  }

  const sessionNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // ── Pick the connection ─────────────────────────────────────────────────────
  // Try the service connection first (tables granted to PRISM_SERVICE). If the
  // service role can't see the table, fall back to the creator's PERSONAL
  // Snowflake credentials — one-time runs never touch the shared lookup, so a
  // user standardizing a table under their own entitlements is safe by design.
  // The chosen connection is recorded in the run meta so grouping previews and
  // the final export use the same one.
  // FILE SOURCES SKIP THE PROBE ENTIRELY. There is no source table to read: the
  // rows arrived with the request. They also never need the personal-credential
  // fallback, which exists only so a user can standardize a warehouse table
  // PRISM_SERVICE cannot see — the service connection always owns
  // INTERNAL.ONE_TIME_FILE_ROWS.
  if (isFileSource) {
    try {
      // Resolve the rows: uploaded/pasted ones came with the request; a Sheet is
      // read here, honouring the header row the user confirmed (SHEETS-HDR-01 —
      // reading from row 0 regardless is exactly what broke the pipeline path).
      let rowsToStore: Record<string, unknown>[] = fileRows;
      if (isSheetSource) {
        const jar = await cookies();
        const accessToken  = jar.get('google_access_token')?.value;
        const refreshToken = jar.get('google_refresh_token')?.value;
        if (!accessToken && !refreshToken) {
          return Response.json({ needsAuth: true }, { status: 401 });
        }
        const oauth2 = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI,
        );
        oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
        const api  = google.sheets({ version: 'v4', auth: oauth2 });
        const grid = await readAllSheetRows(api, spreadsheetId, sheetTabName);
        const parsed = gridToRows(grid as unknown[][], sheetHeaderRow);
        rowsToStore = parsed.rows;
        if (rowsToStore.length === 0) {
          return Response.json({ error: 'That sheet tab has no data rows below the header.' }, { status: 400 });
        }
      }

      return await withWarehouse(async (conn) => {
        await insertOneTimeFileRows(conn, sessionNonce, rowsToStore);

        const created: { run_id: number; column_name: string }[] = [];
        for (const c of columns) {
          const runId = await createOneTimeRun(conn, {
            source_relation,            // display label (file name / sheet tab)
            column_name:  c.column_name,
            createdBy:    Number(session.accountId),
            sessionNonce,
            convention:   c.convention,
            standardization_rules: c.standardization_rules,
            description:  c.description,
            connectionSource: 'service',
            fileSession:  true,
          });
          created.push({ run_id: runId, column_name: c.column_name });
        }
        return Response.json({ session: sessionNonce, runs: created, source_type: rawSourceType }, { status: 201 });
      });
    } catch (err) {
      // A later column tripping the size cap leaves earlier columns' runs and
      // the uploaded rows behind, so clean the rows up rather than orphaning a
      // potentially large upload in the warehouse.
      try {
        await withWarehouse(async (conn) => { await deleteOneTimeFileRows(conn, sessionNonce); });
      } catch { /* best effort — the 400/500 below is the user-visible outcome */ }
      if (err instanceof OneTimeTooLargeError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      // readAllSheetRows refuses a tab past MAX_SHEET_ROWS rather than paging
      // forever. Surface it as the clean 400 it is — the message already names
      // the tab and the limit — instead of a generic warehouse error.
      if (err instanceof SheetTooLargeError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      return warehouseErrorResponse(err, 'Failed to prepare the uploaded data');
    }
  }

  const { db, schema, table } = parseFqn(source_relation);
  // Dialect-branched read probe through the facade's executeQuery — a raw
  // snowflake-sdk conn.execute() here broke every mssql one-time create with
  // "Failed to read the source table" (TypeError, not access-classified).
  const probeFqn = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const probeSql = getWarehouseAdapter().kind === 'mssql'
    ? `SELECT TOP (1) 1 AS one FROM ${probeFqn}`
    : `SELECT 1 FROM ${probeFqn} LIMIT 1`;
  const probe = async (conn: any) => { await executeQuery(conn, probeSql); };

  let connectionSource: 'service' | 'user';
  try {
    await withWarehouse(probe);
    connectionSource = 'service';
  } catch (serviceErr) {
    if (!isWarehouseAccessError(serviceErr)) {
      return warehouseErrorResponse(serviceErr, 'Failed to read the source table');
    }
    if (!hasUserWarehouseConfig(Number(session.accountId))) {
      return Response.json({
        // Carries the encryption clause, same as the columns route. Fixing only
        // ONE of the two needs_user_connection surfaces left the other still
        // preempting the client's fallback text, so the disclosure the security
        // doc credits was still unreachable from this path (SEC-07).
        error: "Prism doesn't have access to this table, so it needs to confirm YOU have access before standardizing it. Connect your own credentials to continue — they're stored encrypted and used only on your behalf.",
        needs_user_connection: true,
      }, { status: 403 });
    }
    try {
      await withUserWarehouse(Number(session.accountId), probe);
      connectionSource = 'user';
    } catch (userErr) {
      if (isWarehouseAccessError(userErr)) {
        return Response.json({
          error: 'Neither Prism nor your connected Snowflake user has read access to this table.',
        }, { status: 403 });
      }
      return warehouseErrorResponse(userErr, 'Failed to read the source table with your Snowflake credentials');
    }
  }

  const withChosen = connectionSource === 'user'
    ? <T,>(fn: (conn: any) => Promise<T>) => withUserWarehouse(Number(session.accountId), fn)
    : withWarehouse;

  try {
    return await withChosen(async (conn) => {
      const created: { run_id: number; column_name: string }[] = [];
      for (const c of columns) {
        const runId = await createOneTimeRun(conn, {
          source_relation,
          column_name:  c.column_name,
          createdBy:    Number(session.accountId),
          sessionNonce,
          convention:   c.convention,
          standardization_rules: c.standardization_rules,
          description:  c.description,
          connectionSource,
        });
        created.push({ run_id: runId, column_name: c.column_name });
      }
      return Response.json({ session: sessionNonce, columns: created, connection: connectionSource }, { status: 201 });
    });
  } catch (err) {
    if (err instanceof OneTimeTooLargeError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    // Classify AI-provider failures BEFORE the warehouse sanitizer, which is
    // tuned for Snowflake/SQL Server shapes and would discard the provider's
    // own actionable message (rate-limit retry hints, rejected-key detail).
    // Returns null for anything not provider-shaped, so warehouse errors are
    // handled exactly as before.
    const llmResp = llmErrorResponse(err);
    if (llmResp) return llmResp;
    return warehouseErrorResponse(err, 'Failed to create one-time standardization');
  }
}
