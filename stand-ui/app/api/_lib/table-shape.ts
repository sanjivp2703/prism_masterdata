/**
 * Where does the header row actually start?
 *
 * Pure module (no server-only deps) — used by BOTH the client-side CSV/Excel
 * parser and the server-side Google Sheets column reader, so the two can never
 * disagree about which row is the header.
 *
 * WHY THIS EXISTS: Prism previously took row 1 as the header, unconditionally,
 * everywhere. CLAUDE.md's File Upload Flow specifies blank-row skipping, title-
 * row detection and header detection; none of it was implemented. Caught on a
 * real customer sheet laid out like this:
 *
 *     row 1   Number Sent | 77 | Number Emailed | 54      <- summary/title row
 *     row 2-4 (blank)
 *     row 5   Company | Description | Contact Name | ...  <- the REAL header
 *     row 6+  Addepar | Wealth Management... | Madison | ...
 *
 * Prism built a pipeline over four columns that do not exist — two of them bare
 * numbers — while the columns the user actually wanted were never offered.
 *
 * This is a HEURISTIC and will be wrong on some layout eventually. That is why
 * the callers pair it with a visible preview and a manual "header is in row __"
 * override: the goal is not a perfect guess, it is that a wrong guess is
 * obvious and correctable instead of silent.
 */

/** How many leading rows to inspect. Beyond this a sheet is pathological. */
const SCAN_ROWS = 20;

export interface HeaderDetection {
  /** 0-based index into the grid. */
  headerRow: number;
  /** 'low' when we fell back rather than positively identifying a header. */
  confidence: 'high' | 'low';
}

const isBlank = (cell: unknown): boolean => String(cell ?? '').trim() === '';

/** Populated (non-blank) cell count for a row. */
function populatedCount(row: unknown[]): number {
  return row.reduce<number>((n, c) => n + (isBlank(c) ? 0 : 1), 0);
}

/** True when the cell reads as a plain number — '77', '54', '1,200', '3.5'. */
function looksNumeric(cell: unknown): boolean {
  const s = String(cell ?? '').trim();
  if (!s) return false;
  return /^-?[\d,]+(\.\d+)?$/.test(s);
}

/**
 * Fraction of a row's populated cells that read as numbers. A header is mostly
 * words; a data row that happens to be wide is often mostly numbers.
 */
function numericShare(row: unknown[]): number {
  const populated = row.filter((c) => !isBlank(c));
  if (populated.length === 0) return 0;
  return populated.filter(looksNumeric).length / populated.length;
}

/**
 * Find the header row in a raw grid (array of rows, each an array of cells).
 *
 * The load-bearing signal is WIDTH: the header spans about as many columns as
 * the data beneath it. A summary or title row above the real table is narrower,
 * which is exactly how the customer sheet above gives itself away (4 populated
 * cells vs 8). The numeric check is a second, independent signal — that same
 * row was 50% bare numbers.
 */
export function detectHeaderRow(grid: unknown[][]): HeaderDetection {
  const rows = grid.slice(0, SCAN_ROWS);
  if (rows.length === 0) return { headerRow: 0, confidence: 'low' };

  const counts = rows.map(populatedCount);
  const maxWidth = Math.max(...counts);
  if (maxWidth === 0) return { headerRow: 0, confidence: 'low' };   // entirely blank

  // "Wide enough to be the header": within 60% of the widest row we saw. Loose
  // on purpose — real headers sometimes have a trailing unlabelled column, and
  // being slightly generous costs less than rejecting the true header.
  const minWidth = Math.max(2, Math.ceil(maxWidth * 0.6));

  for (let i = 0; i < rows.length; i++) {
    if (counts[i] < minWidth) continue;          // blank rows and narrow title rows
    if (numericShare(rows[i]) >= 0.5) continue;  // mostly numbers → data, not a header
    return { headerRow: i, confidence: 'high' };
  }

  // Nothing looked like a header — fall back to the first non-blank row and say
  // so, which is the signal the UI uses to nudge the user to check the preview.
  const firstPopulated = counts.findIndex((c) => c > 0);
  return { headerRow: firstPopulated >= 0 ? firstPopulated : 0, confidence: 'low' };
}

/**
 * Spreadsheet column letter for a 0-based index: 0 -> A, 25 -> Z, 26 -> AA.
 *
 * The Sheets client previously used String.fromCharCode(65 + idx), which
 * produces '[', '\\', ']' … past column Z — silently reading the WRONG column
 * on any sheet wider than 26 columns.
 */
export function columnLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return out;
  }
}

/**
 * Turn a raw grid into header names + row objects, given the header row index.
 *
 * Extracted from the file-pipeline connect form so the one-time flow reuses the
 * exact same rules rather than growing a second, subtly different parser — the
 * pipeline-side form is being retired, and this logic must outlive it.
 *
 * Two behaviours here are load-bearing and easy to lose in a re-implementation:
 *
 * 1. DUPLICATE / EMPTY HEADERS ARE DISAMBIGUATED. Rows are keyed by header
 *    TEXT, so headers `Carrier, Region, Carrier` would collapse and the LAST
 *    duplicate would silently win — the user would pick "Carrier" and get the
 *    third column's data with nothing indicating it. Each collision is renamed
 *    and reported so the caller can warn.
 * 2. DATA STARTS BELOW THE HEADER, wherever that is — never a hardcoded row 1.
 *    Getting this wrong ingests the blank rows and the header text as data
 *    (KI-219), and on the Sheets path it silently produced pipelines that
 *    standardized nothing at all (SHEETS-HDR-01).
 *
 * Row objects use Object.create(null): the keys are header text straight from
 * the customer's file, and on a plain object a column headed `__proto__` is
 * swallowed by the prototype setter and read back as an object.
 */
export interface GridRows {
  headers: string[];
  rows: Record<string, string>[];
  /** Header names that were empty or duplicated, for a user-facing warning. */
  collisions: string[];
}

export function gridToRows(grid: unknown[][], headerIdx: number): GridRows {
  const rawHeaders = ((grid[headerIdx] as unknown[]) ?? []).map((h) => String(h ?? '').trim());
  const seen = new Map<string, number>();
  const collisions: string[] = [];
  const headers = rawHeaders.map((h, i) => {
    const base = h || `Column ${i + 1}`;
    if (!h) collisions.push(`column ${i + 1} (no header)`);
    const prior = seen.get(base) ?? 0;
    seen.set(base, prior + 1);
    if (prior === 0) return base;
    collisions.push(base);
    return `${base} (${prior + 1})`;
  });

  const rows = grid.slice(headerIdx + 1)
    .filter((row) => (row as unknown[]).some((c) => String(c ?? '').trim() !== ''))
    .map((row) => {
      const obj: Record<string, string> = Object.create(null);
      headers.forEach((h, i) => { obj[h] = String((row as unknown[])[i] ?? ''); });
      return obj;
    });

  return { headers, rows, collisions: [...new Set(collisions)] };
}

/**
 * The ORIGINAL grid indices of the rows gridToRows keeps, in output order.
 * Exists for the edit-in-place file patcher (file-inplace.ts): stored data
 * row i lives at grid row gridDataRowIndices(...)[i], so the two can never
 * disagree about which physical row a value came from — the filter predicate
 * here MUST stay identical to gridToRows's.
 */
export function gridDataRowIndices(grid: unknown[][], headerIdx: number): number[] {
  const out: number[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = (grid[i] as unknown[]) ?? [];
    if (row.some((c) => String(c ?? '').trim() !== '')) out.push(i);
  }
  return out;
}
