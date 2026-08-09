/**
 * Google Sheets read primitives.
 *
 * Extracted from op-file-pipeline.ts so the ONE-TIME flow can read a sheet
 * without importing the pipeline-side file machinery, which is being retired.
 * These are the parts that outlive that removal: paging, A1 quoting, and the
 * size ceiling.
 */

import 'server-only';

import type { sheets_v4 } from 'googleapis';

/* eslint-disable @typescript-eslint/no-explicit-any -- googleapis client and
   row values are untyped at this boundary. */

export const SHEETS_PAGE_ROWS = 10000;

/**
 * Escape a sheet/tab name for A1 notation. A1 escapes embedded single quotes
 * by DOUBLING them (not backslash-escaping): `Bob's Tab` → `'Bob''s Tab'`.
 */
export function a1Sheet(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** 1-indexed column number → A1 column letters (1 → A, 27 → AA). */
export function a1Col(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Max rows Prism will read from a Google Sheet tab. The poller re-reads the
 *  full tab every 30 s cycle on a single-process server — an unbounded sheet
 *  is a memory + warehouse-cost hazard, not a supported use case. */
export const MAX_SHEET_ROWS = 100_000;

/** Thrown when a tab exceeds MAX_SHEET_ROWS. The poller pauses the pipeline
 *  with a status message; creation routes surface it as a 400. */
export class SheetTooLargeError extends Error {
  constructor(public tabName: string) {
    super(
      `Sheet tab "${tabName}" has more than ${MAX_SHEET_ROWS.toLocaleString()} rows — ` +
      `larger than Prism supports for file pipelines. Connect the data as a Snowflake table instead.`,
    );
    this.name = 'SheetTooLargeError';
  }
}

/**
 * The stored Google refresh token was rejected (expired, revoked, or access to
 * the sheet withdrawn). Distinct from a transient network failure: retrying
 * will never succeed, so the poller must surface it on the pipeline instead of
 * quietly serving stale cached metrics forever.
 */
export class SheetsAuthError extends Error {
  constructor(public pipelineId: number) {
    super(
      'Google authorization for this sheet has expired or been revoked — Prism can no longer read it. ' +
      'Reconnect the Google account for this pipeline to resume syncing.',
    );
    this.name = 'SheetsAuthError';
  }
}

/**
 * Read ALL rows from a sheet tab, paging in SHEETS_PAGE_ROWS-row windows so
 * sheets larger than a single page (the old hardcoded `A1:ZZZ10000` cap) are
 * not silently truncated. Stops when a page comes back short or empty; throws
 * SheetTooLargeError past MAX_SHEET_ROWS.
 */
/**
 * The 0-based row index holding the column headers for a Sheets pipeline.
 *
 * Persisted at creation as `file_source_meta.header_row` because a Google Sheet
 * frequently has title/summary rows above the real header — `detectHeaderRow`
 * finds it and the connect form lets the user override it, but that answer used
 * to be thrown away the moment the pipeline was created. Every later read
 * (creation ingest, poller refresh, output write) then hardcoded row 0, so a
 * sheet whose header was on row 5 ingested the TITLE as its only column name,
 * matched none of the chosen columns, and reported 0 source values forever
 * while the output sheet echoed the junk rows back (live-reproduced 2026-08-09).
 *
 * Defaults to 0 so pipelines created before this was stored keep working
 * exactly as they did.
 */
export function headerRowFromMeta(meta: { header_row?: unknown } | null | undefined): number {
  const n = Number(meta?.header_row);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

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
    if (all.length > MAX_SHEET_ROWS) throw new SheetTooLargeError(tabName);
    if (page.length < SHEETS_PAGE_ROWS) break;
    startRow += SHEETS_PAGE_ROWS;
  }
  return all;
}
