/**
 * Edit-in-place patching for one-time round-trip files (CSV + XLSX).
 *
 * The point: a customer who exports from Dynamics/SAP/anywhere, cleans in
 * Prism, and reimports needs back THE SAME FILE with only the standardized
 * cells changed — hidden columns still hidden, styles/formats intact, column
 * order untouched. Regenerating a workbook from parsed rows (the fallback
 * path) silently destroys all of that; import wizards then reject or
 * mis-map it.
 *
 * How each format is patched:
 *   CSV — a byte-offset tokenizer (RFC-4180: quoted fields, "" escapes,
 *   quoted newlines) finds the exact span of each target field; replacements
 *   are spliced in with correct quoting; every other byte — delimiters, line
 *   endings, spacing, BOM — passes through untouched.
 *
 *   XLSX — the file is a zip; only the ONE worksheet XML entry is modified.
 *   Each target <c> element is replaced with an inline-string cell that
 *   PRESERVES the style attribute (s="…"), so number formats/colors/borders
 *   survive; sharedStrings, styles.xml, hidden-column definitions, other
 *   sheets, and every other zip entry are copied through byte-identical.
 *
 * Row/column addressing NEVER trusts the caller's parse: the original file is
 * re-read here, headers are derived with the SAME gridToRows renaming the
 * upload used, and data-row indices come from gridDataRowIndices — so stored
 * row i provably maps to the physical row it came from (blank rows and all).
 *
 * Anything unexpected throws — callers fall back to the regenerated-file
 * path, never a corrupted "original".
 *
 * Pure module (no server-only): parity-tested in scripts/parity-tests.ts.
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

import { gridToRows, gridDataRowIndices, columnLetter } from './table-shape';

export interface CellEdit {
  /** 0-based index into the STORED data rows (gridToRows output order). */
  dataRow: number;
  /** Header name as stored (post-gridToRows renaming). */
  column: string;
  value: string;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

interface CsvField { start: number; end: number; }          // byte span incl. quotes
interface CsvRecord { fields: CsvField[]; }

/** Tokenize CSV preserving exact spans. Handles quoted fields ("" escapes,
 *  embedded delimiters/newlines) and both LF/CRLF line endings. */
function tokenizeCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: CsvField[] = [];
  let i = 0;
  const n = text.length;
  let fieldStart = 0;

  // A UTF-8 BOM belongs to no field — skip it so field 0's span excludes it.
  if (text.charCodeAt(0) === 0xfeff) { i = 1; fieldStart = 1; }

  while (i <= n) {
    if (i === n) {
      // EOF terminates a pending record (no trailing newline case).
      if (fields.length > 0 || fieldStart < n) {
        fields.push({ start: fieldStart, end: n });
        records.push({ fields });
      }
      break;
    }
    const c = text[i];
    if (c === '"' && i === fieldStart) {
      // Quoted field: scan to the closing quote ("" escapes).
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      i = j; // now at the char after the closing quote
      continue;
    }
    if (c === ',') {
      fields.push({ start: fieldStart, end: i });
      i++;
      fieldStart = i;
      continue;
    }
    if (c === '\n' || c === '\r') {
      fields.push({ start: fieldStart, end: i });
      records.push({ fields });
      fields = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      fieldStart = i;
      continue;
    }
    i++;
  }
  return records;
}

/** Decode one field's raw span to its value (unquote + unescape). */
function decodeCsvField(text: string, f: CsvField): string {
  const raw = text.slice(f.start, f.end);
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

function encodeCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Patch a CSV in place: returns the new text with ONLY the target fields
 *  changed. Throws on any addressing failure (caller falls back). */
export function patchCsvInPlace(originalText: string, headerIdx: number, edits: CellEdit[]): string {
  const records = tokenizeCsv(originalText);
  if (headerIdx >= records.length) throw new Error(`header row ${headerIdx} beyond ${records.length} records`);

  const grid: string[][] = records.map((r) => r.fields.map((f) => decodeCsvField(originalText, f)));
  const { headers } = gridToRows(grid, headerIdx);
  const colIndex = new Map<string, number>();
  headers.forEach((h, idx) => { if (!colIndex.has(h)) colIndex.set(h, idx); });
  const dataIdx = gridDataRowIndices(grid, headerIdx);

  // Resolve every edit to a byte span first — fail whole before splicing any.
  const splices: Array<{ start: number; end: number; text: string }> = [];
  for (const e of edits) {
    const gridRow = dataIdx[e.dataRow];
    if (gridRow == null) throw new Error(`data row ${e.dataRow} beyond ${dataIdx.length} rows`);
    const ci = colIndex.get(e.column);
    if (ci == null) throw new Error(`column "${e.column}" not found in header row`);
    const field = records[gridRow].fields[ci];
    if (!field) throw new Error(`row ${gridRow} has no field ${ci}`);
    splices.push({ start: field.start, end: field.end, text: encodeCsvField(e.value) });
  }

  splices.sort((a, b) => b.start - a.start); // splice back-to-front
  let out = originalText;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** `B12` → { col: 1, row: 11 } (0-based both). */
function parseCellRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad cell ref ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/** Resolve the worksheet zip path for a tab name (or the first sheet). */
function findSheetPath(files: Record<string, Uint8Array>, sheetName: string | null): string {
  const workbook = strFromU8(files['xl/workbook.xml'] ?? new Uint8Array());
  const rels = strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array());
  if (!workbook || !rels) throw new Error('workbook.xml or rels missing');

  const sheets = [...workbook.matchAll(/<sheet\b[^>]*/g)].map((m) => {
    const tag = m[0];
    const name = /name="([^"]*)"/.exec(tag)?.[1] ?? '';
    const rid = /r:id="([^"]*)"/.exec(tag)?.[1] ?? '';
    return { name: xmlUnescape(name), rid };
  });
  if (!sheets.length) throw new Error('no sheets in workbook.xml');
  const target = sheetName == null
    ? sheets[0]
    : sheets.find((s) => s.name === sheetName);
  if (!target) throw new Error(`sheet "${sheetName}" not found`);

  const rel = new RegExp(`<Relationship\\b[^>]*Id="${target.rid}"[^>]*`).exec(rels)?.[0];
  const path = rel ? /Target="([^"]*)"/.exec(rel)?.[1] : null;
  if (!path) throw new Error(`no relationship for sheet r:id ${target.rid}`);
  return path.startsWith('/') ? path.slice(1) : `xl/${path}`;
}

function parseSharedStrings(files: Record<string, Uint8Array>): string[] {
  const raw = files['xl/sharedStrings.xml'];
  if (!raw) return [];
  const xml = strFromU8(raw);
  // Each <si> concatenates its <t> runs (rich text has several).
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join('') +
    (/<t\b[^>]*\/>/.test(m[1]) && !/<t\b[^>]*>/.test(m[1]) ? '' : ''),
  );
}

interface SheetCell { ref: string; span: { start: number; end: number }; value: string; styleAttr: string }

/** Extract every cell (with byte spans in the sheet XML) and the full grid. */
function extractSheet(xml: string, shared: string[]): { cells: Map<string, SheetCell>; grid: string[][] } {
  const cells = new Map<string, SheetCell>();
  const grid: string[][] = [];

  const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = m[1];
    const ref = /r="([^"]*)"/.exec(attrs)?.[1];
    if (!ref) continue; // ref-less cells (rare producers) — leave untouched
    const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const styleAttr = /s="[^"]*"/.exec(attrs)?.[0] ?? '';
    const inner = m[3] ?? '';
    let value = '';
    if (type === 's') {
      const idx = Number(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1);
      value = shared[idx] ?? '';
    } else if (type === 'inlineStr') {
      value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join('');
    } else {
      value = xmlUnescape(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
    }
    const { col, row } = parseCellRef(ref);
    (grid[row] ??= [])[col] = value;
    cells.set(ref, { ref, span: { start: m.index, end: m.index + m[0].length }, value, styleAttr });
  }
  // Normalize ragged rows to dense arrays (undefined → '').
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? (grid[r] = []);
    for (let c = 0; c < row.length; c++) row[c] ??= '';
  }
  return { cells, grid };
}

/** Patch an XLSX in place: returns new bytes with ONLY the target cells
 *  changed (style-preserving inline strings); every other zip entry is
 *  copied through untouched. Throws on any addressing failure. */
export function patchXlsxInPlace(
  original: Uint8Array,
  sheetName: string | null,
  headerIdx: number,
  edits: CellEdit[],
): Uint8Array {
  const files = unzipSync(original);
  const sheetPath = findSheetPath(files, sheetName);
  const sheetRaw = files[sheetPath];
  if (!sheetRaw) throw new Error(`sheet entry ${sheetPath} missing`);
  const xml = strFromU8(sheetRaw);
  const shared = parseSharedStrings(files);
  const { cells, grid } = extractSheet(xml, shared);

  const { headers } = gridToRows(grid, headerIdx);
  const colIndex = new Map<string, number>();
  headers.forEach((h, idx) => { if (!colIndex.has(h)) colIndex.set(h, idx); });
  const dataIdx = gridDataRowIndices(grid, headerIdx);

  const splices: Array<{ start: number; end: number; text: string }> = [];
  for (const e of edits) {
    const gridRow = dataIdx[e.dataRow];
    if (gridRow == null) throw new Error(`data row ${e.dataRow} beyond ${dataIdx.length} rows`);
    const ci = colIndex.get(e.column);
    if (ci == null) throw new Error(`column "${e.column}" not found in header row`);
    const ref = `${columnLetter(ci)}${gridRow + 1}`;
    const cell = cells.get(ref);
    if (!cell) throw new Error(`cell ${ref} not present in sheet XML`);
    const style = cell.styleAttr ? ` ${cell.styleAttr}` : '';
    const text = `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(e.value)}</t></is></c>`;
    splices.push({ start: cell.span.start, end: cell.span.end, text });
  }

  splices.sort((a, b) => b.start - a.start);
  let patched = xml;
  for (const s of splices) patched = patched.slice(0, s.start) + s.text + patched.slice(s.end);

  const out: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) {
    out[path] = path === sheetPath ? strToU8(patched) : data;
  }
  return zipSync(out);
}

/** Grid extraction for callers that need the original file's own view of its
 *  rows (the export route builds edits against this, NOT the stored rows —
 *  one addressing source of truth). */
export function extractCsvGrid(text: string): string[][] {
  const records = tokenizeCsv(text);
  return records.map((r) => r.fields.map((f) => decodeCsvField(text, f)));
}

export function extractXlsxGrid(original: Uint8Array, sheetName: string | null): string[][] {
  const files = unzipSync(original);
  const sheetPath = findSheetPath(files, sheetName);
  const xml = strFromU8(files[sheetPath] ?? new Uint8Array());
  if (!xml) throw new Error(`sheet entry ${sheetPath} missing`);
  return extractSheet(xml, parseSharedStrings(files)).grid;
}
