'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ConventionEditor, {
  emptyConventionDraft, conventionDraftToConvention, conventionDraftHasContent, conventionRegexValid,
  type ConventionDraft,
} from '@/app/components/ConventionEditor';
import { useWarehouseLabel } from '@/app/components/use-warehouse-label';
import { isNativeEdition } from '@/app/api/_lib/edition';
import { detectHeaderRow, gridToRows } from '@/app/api/_lib/table-shape';

interface TableColumn { name: string; type: string; isText: boolean }

interface SelectedCol {
  column_name: string;
  description: string;
  convention:  ConventionDraft;
  showConv:    boolean;
  stdRules:    string[];
}

const inputStyle: React.CSSProperties = {
  borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'monospace',
};

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export default function OneTimeStandardizationCard() {
  const warehouseLabel = useWarehouseLabel();
  const router = useRouter();

  // Where the values come from. A one-time standardization is "clean this list
  // once", so a file or a pasted column is as legitimate a source as a table —
  // and unlike a pipeline, nothing here has to stay live afterwards.
  type OtSource = 'warehouse' | 'file' | 'sheets' | 'paste';
  const [sourceKind, setSourceKind] = useState<OtSource>('warehouse');

  const [tableFqn, setTableFqn] = useState('');

  // File upload
  const [fileName,    setFileName]    = useState('');
  const [fileRows,    setFileRows]    = useState<Record<string, string>[]>([]);
  const [fileGrid,    setFileGrid]    = useState<unknown[][]>([]);
  const [fileTabs,    setFileTabs]    = useState<string[]>([]);
  const [fileTab,     setFileTab]     = useState('');
  const [headerIdx,   setHeaderIdx]   = useState(0);
  const [fileB64,     setFileB64]     = useState<string | null>(null);
  const [tabGrids,    setTabGrids]    = useState<Record<string, unknown[][]>>({});
  const [fileWarning, setFileWarning] = useState<string | null>(null);
  const [fileError,   setFileError]   = useState<string | null>(null);

  // Google Sheet
  const [sheetUrl,   setSheetUrl]   = useState('');
  const [sheetId,    setSheetId]    = useState('');
  const [sheetTabs,  setSheetTabs]  = useState<string[]>([]);
  const [sheetTab,   setSheetTab]   = useState('');
  const [sheetHdr,   setSheetHdr]   = useState(0);
  const [sheetDetected, setSheetDetected] = useState(0);
  const [sheetSample,   setSheetSample]   = useState<string[][]>([]);
  const [sheetBusy,  setSheetBusy]  = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  // Paste
  const [pasteText,   setPasteText]   = useState('');
  const [pasteColumn, setPasteColumn] = useState('value');
  const [fields, setFields]           = useState<TableColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError]     = useState<string | null>(null);
  const [needsConnect, setNeedsConnect]     = useState(false);

  const [selected, setSelected] = useState<SelectedCol[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch columns when the table FQN looks complete (DB.SCHEMA.TABLE).
  useEffect(() => {
    const t = tableFqn.trim();
    if (t.split('.').filter(Boolean).length !== 3) {
      setFields([]); setColumnsError(null); setColumnsLoading(false); setNeedsConnect(false);
      return;
    }
    let cancelled = false;
    setColumnsLoading(true); setColumnsError(null);
    const timer = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/columns?table_fqn=${encodeURIComponent(t)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setColumnsError(body?.error ?? 'Could not read this table — check the name and access.'); setFields([]); }
        else if (body?.needs_user_connection) {
          setNeedsConnect(true);
          setColumnsError(body?.error ?? `Prism doesn't have access to this table, so it needs to confirm you have access before standardizing it. Connect your own ${warehouseLabel} credentials to continue — they're stored encrypted and used only on your behalf.`);
          setFields([]);
        } else {
          setNeedsConnect(false);
          if (body?.error && (body.fields ?? []).length === 0) setColumnsError(String(body.error));
          const f = (body.fields ?? []) as TableColumn[];
          setFields(f);
          const names = new Set(f.map(c => c.name.toUpperCase()));
          setSelected(prev => prev.filter(s => names.has(s.column_name.toUpperCase())));
        }
      } catch {
        if (!cancelled) { setColumnsError('Could not read this table — check the name and access.'); setFields([]); }
      } finally {
        if (!cancelled) setColumnsLoading(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // warehouseLabel is read inside the fallback error message. It resolves once
    // per session and then never changes, so including it costs at most one
    // extra re-probe if the fetch lands mid-lookup — cheaper than silencing the
    // rule and risking a stale vendor name in the message.
  }, [tableFqn, warehouseLabel]);

  function isSelected(name: string) {
    return selected.some(s => s.column_name.toUpperCase() === name.toUpperCase());
  }
  function toggle(name: string) {
    setSelected(prev => prev.some(s => s.column_name.toUpperCase() === name.toUpperCase())
      ? prev.filter(s => s.column_name.toUpperCase() !== name.toUpperCase())
      : [...prev, { column_name: name, description: '', convention: emptyConventionDraft(), showConv: false, stdRules: [''] }]);
  }
  function patchCol(name: string, patch: Partial<SelectedCol>) {
    setSelected(prev => prev.map(s => s.column_name === name ? { ...s, ...patch } : s));
  }
  function applyConventionToAll(src: ConventionDraft) {
    setSelected(prev => prev.map(s => ({ ...s, convention: { ...src }, showConv: true })));
  }

  // ── Source helpers ─────────────────────────────────────────────────────────

  /** Rows to POST for a file/paste session. */
  function effectiveRows(): Record<string, string>[] {
    if (sourceKind === 'paste') {
      // One value per line. Tabs split into columns only if the pasted block
      // actually has them, so pasting a single column out of a spreadsheet (the
      // common case) yields one clean column rather than a ragged grid.
      const lines = pasteText.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
      const col   = pasteColumn.trim() || 'value';
      return lines.map(l => {
        const o: Record<string, string> = Object.create(null);
        o[col] = l;
        return o;
      });
    }
    return fileRows;
  }

  /** csv vs excel — only used for the archive label; both take the same path. */
  function fileSourceType(): 'csv' | 'excel' {
    return /\.csv$/i.test(fileName) ? 'csv' : 'excel';
  }

  /** Re-key the parsed grid when the user corrects the header row. */
  function applyHeader(grid: unknown[][], idx: number) {
    const { headers, rows, collisions } = gridToRows(grid, idx);
    setFileRows(rows);
    setFields(headers.map(h => ({ name: h, type: 'text', isText: true })));
    setSelected(prev => prev.filter(sel => headers.some(h => h.toUpperCase() === sel.column_name.toUpperCase())));
    setFileWarning(collisions.length
      ? `This file has duplicate or empty column headers (${collisions.join(', ')}). They were renamed so each column stays distinct — check you pick the right one.`
      : null);
  }

  async function handleFile(file: File) {
    setFileError(null); setFileWarning(null); setSelected([]); setFields([]); setFileRows([]);
    setFileB64(null);
    setFileName(file.name);
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
      setFileError('Only .csv, .xlsx and .xls files are supported.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setFileError('File too large (max 20 MB). Load the data into a warehouse table and standardize that instead.');
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const buf  = await file.arrayBuffer();
      // Keep the ORIGINAL bytes (base64) so the export can hand back the same
      // file edited in place — hidden columns, styles and column order intact
      // (what a Dynamics/SAP reimport needs). Legacy .xls is excluded: only
      // the zip-based .xlsx format can be surgically patched.
      if (/\.(csv|xlsx)$/i.test(file.name)) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        setFileB64(btoa(bin));
      }
      const wb   = XLSX.read(buf, { type: 'array' });
      // Convert every tab up front so switching tabs needs no re-parse and the
      // workbook object never has to live in React state.
      const grids: Record<string, unknown[][]> = Object.create(null);
      for (const name of wb.SheetNames) {
        // blankrows: TRUE deliberately. Dropping blank rows shifts every index
        // up, so a file whose header sits on row 5 in Excel (under a title, a
        // subtitle and a blank line) parses to index 3 and the control below
        // would tell the user "headers are on row 4" — a number that matches
        // nothing they can see in their own spreadsheet. Keeping the blanks
        // makes the displayed row number the REAL one.
        //
        // Safe on both readers: detectHeaderRow skips blank/narrow rows by
        // width, and gridToRows already filters all-blank rows out of the data.
        grids[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: true, defval: '' }) as unknown[][];
      }
      setTabGrids(grids);
      setFileTabs(wb.SheetNames);
      const tab = wb.SheetNames[0] ?? '';
      setFileTab(tab);
      loadGrid(grids[tab] ?? []);
    } catch {
      setFileError('That file could not be read. Check it is a valid CSV or Excel file.');
    }
  }

  /** Read a Google Sheet's tabs + columns via the existing sheets endpoints. */
  async function loadSheet(url: string, tab?: string, headerRow?: number) {
    setSheetError(null); setSheetBusy(true); setFields([]); setSelected([]);
    try {
      // The endpoint takes the raw URL (or a bare id) and resolves the id
      // itself, so don't pre-parse it here — that would be a second, divergent
      // parser for the same input.
      const qs  = new URLSearchParams({
        url,
        ...(tab ? { tab } : {}),
        // Only sent when the user has overridden it — otherwise the server
        // detects, and its answer is what the ingest will use.
        ...(headerRow != null ? { headerRow: String(headerRow) } : {}),
      });
      const res = await fetch(`/api/sheets/columns?${qs}`);
      const b   = await res.json().catch(() => ({}));
      if (res.status === 401 && b?.needsAuth) {
        window.location.href = '/api/auth/google?returnTo=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!res.ok) { setSheetError(b?.error ?? 'Could not read that sheet.'); return; }
      setSheetId(String(b.spreadsheetId ?? ''));
      setSheetTabs(((b.sheets ?? []) as { name: string }[]).map(x => x.name));
      setSheetTab(String(b.activeSheet ?? tab ?? ''));
      // Same detected header row the server will use when it ingests, so what
      // the picker offers and what gets stored cannot disagree (SHEETS-HDR-01).
      setSheetHdr(Number(b.headerRow ?? 0) || 0);
      setSheetDetected(Number(b.detectedHeaderRow ?? b.headerRow ?? 0) || 0);
      setSheetSample(Array.isArray(b.sampleRows) ? b.sampleRows : []);
      setFields(((b.columns ?? []) as string[]).map(c => ({ name: c, type: 'text', isText: true })));
    } catch {
      setSheetError('Could not read that sheet.');
    } finally {
      setSheetBusy(false);
    }
  }

  /** Load one tab's grid: detect the header row, then key the rows by it. */
  function loadGrid(grid: unknown[][]) {
    setFileGrid(grid);
    if (grid.length === 0) {
      setFileError('That sheet is empty.');
      setFields([]); setFileRows([]);
      return;
    }
    const detected = detectHeaderRow(grid);
    setHeaderIdx(detected.headerRow);
    applyHeader(grid, detected.headerRow);
  }

  const anyRegexInvalid = selected.some(s => conventionRegexValid(s.convention) === false);
  // Submittable depends on the SOURCE: a warehouse session needs a full FQN, a
  // file/paste session needs rows. Requiring the FQN unconditionally would have
  // made the new sources permanently un-submittable.
  const sourceReady =
    sourceKind === 'warehouse' ? tableFqn.trim().split('.').filter(Boolean).length === 3
    : sourceKind === 'file'    ? fileRows.length > 0
    : sourceKind === 'sheets'  ? Boolean(sheetId && sheetTab)
    :                            effectiveRows().length > 0;
  const canSubmit = !submitting && sourceReady && selected.length > 0 && !anyRegexInvalid;

  async function handleStandardize() {
    if (!canSubmit) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch('/api/one-time/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // A file/paste session carries its rows with the request and uses a
          // DISPLAY label for source_relation (a file name, or "Pasted
          // values") — the server skips FQN parsing for those.
          source_type: sourceKind === 'warehouse' ? 'warehouse'
            : sourceKind === 'paste'  ? 'csv'
            : sourceKind === 'sheets' ? 'sheets'
            : fileSourceType(),
          source_relation: sourceKind === 'warehouse' ? tableFqn.trim()
            : sourceKind === 'paste'  ? 'Pasted values'
            : sourceKind === 'sheets' ? sheetTab
            : (fileTab ? `${fileName} — ${fileTab}` : fileName),
          // A Sheet is read server-side from these; the others carry their rows.
          ...(sourceKind === 'sheets'
            ? { spreadsheet_id: sheetId, sheet_tab_name: sheetTab, header_row: sheetHdr }
            : sourceKind === 'warehouse' ? {} : { rows: effectiveRows() }),
          // Original bytes for the edit-in-place export (file uploads only).
          ...(sourceKind === 'file' && fileB64
            ? {
                original_file: {
                  name: fileName,
                  kind: /\.csv$/i.test(fileName) ? 'csv' : 'xlsx',
                  sheet_name: /\.csv$/i.test(fileName) ? null : fileTab || null,
                  header_row: headerIdx,
                  data_b64: fileB64,
                },
              }
            : {}),
          columns: selected.map(s => ({
            column_name: s.column_name,
            description: s.description.trim() || null,
            convention: conventionDraftHasContent(s.convention) ? conventionDraftToConvention(s.convention) : null,
            standardization_rules: s.stdRules.map(r => r.trim()).filter(Boolean),
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.needs_user_connection) setNeedsConnect(true);
        throw new Error(body?.error ?? 'Failed to start the one-time standardization.');
      }
      router.push(`/one-time/${body.session}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  const textCols = fields;

  return (
    <div className="rounded-card border-[0.5px] mt-6"
      style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'calc(var(--card-padding) * 1.5)' }}>
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>One-time standardization</h2>
      </div>
      <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
        Clean a list once — from a {warehouseLabel} table, a CSV/Excel file, or values you paste in — and export the result however you need it. No lookup, no ongoing pipeline.
      </p>

      {/* Source picker */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Source</label>
        <div className="flex rounded-button border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
          {([
            { id: 'warehouse', label: warehouseLabel },
            { id: 'file',      label: 'CSV / Excel' },
            { id: 'sheets',    label: 'Google Sheet' },
            { id: 'paste',     label: 'Paste values' },
          ] as const)
            // Native (Marketplace) edition has no Google integration.
            .filter(({ id }) => id !== 'sheets' || !isNativeEdition())
            .map(({ id, label }, i, arr) => (
            <button
              key={id} type="button" disabled={submitting}
              onClick={() => { setSourceKind(id); setSelected([]); setFields([]); setColumnsError(null); setFileError(null); }}
              className="flex-1 py-2 text-xs font-medium transition-colors disabled:opacity-50"
              style={{
                backgroundColor: sourceKind === id ? 'var(--accent)' : 'transparent',
                color:           sourceKind === id ? 'white' : 'var(--text-muted)',
                borderRight:     i < arr.length - 1 ? '0.5px solid var(--border)' : undefined,
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Warehouse table */}
      {sourceKind === 'warehouse' && (
        <div className="mb-4">
          <label htmlFor="ot-table-fqn" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Source table</label>
          <input
            id="ot-table-fqn" type="text" value={tableFqn}
            onChange={e => setTableFqn(e.target.value)}
            placeholder="DATABASE.SCHEMA.TABLE_NAME"
            autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
            disabled={submitting}
            className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
          />
        </div>
      )}

      {/* File upload */}
      {sourceKind === 'file' && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Upload a file</label>
          <input
            type="file" accept=".csv,.xlsx,.xls" disabled={submitting}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            className="w-full text-xs"
            style={{ color: 'var(--text-secondary)' }}
          />
          {fileTabs.length > 1 && (
            <div className="mt-2">
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Sheet tab</label>
              <select
                value={fileTab} disabled={submitting}
                onChange={e => { setFileTab(e.target.value); setSelected([]); loadGrid(tabGrids[e.target.value] ?? []); }}
                className="w-full px-2.5 py-2 rounded-button border-[0.5px] text-xs outline-none"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              >
                {fileTabs.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
          {/* The detected header row, ALWAYS shown with an override. The
              heuristic will be wrong on some layout, and a wrong guess must be
              visible and correctable rather than silent — a mis-detected header
              produces a session that standardizes the wrong thing entirely. */}
          {fileGrid.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Header row</label>
              <input
                type="number" min={1} max={Math.min(fileGrid.length, 50)} value={headerIdx + 1}
                disabled={submitting}
                onChange={e => {
                  const idx = Math.max(0, Math.min(fileGrid.length - 1, Number(e.target.value) - 1));
                  setHeaderIdx(idx); setSelected([]); applyHeader(fileGrid, idx);
                }}
                className="w-20 px-2 py-1 rounded-button border-[0.5px] text-xs outline-none"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              />
              <span className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
                {fileRows.length.toLocaleString()} data row{fileRows.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
          {fileError && (
            <p className="mt-2 text-xs" style={{ color: 'var(--confidence-low)' }}>{fileError}</p>
          )}
          {fileWarning && (
            <div className="mt-2 rounded-[10px] border-[0.5px] px-3 py-2 text-[11px] leading-relaxed"
                 style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
              {fileWarning}
            </div>
          )}
        </div>
      )}

      {/* Google Sheet */}
      {sourceKind === 'sheets' && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Google Sheet URL</label>
          <div className="flex gap-2">
            <input
              type="text" value={sheetUrl} disabled={submitting || sheetBusy}
              onChange={e => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className="flex-1 px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none disabled:opacity-50"
              style={inputStyle}
            />
            <button type="button" disabled={submitting || sheetBusy || !sheetUrl.trim()}
              onClick={() => loadSheet(sheetUrl.trim())}
              className="px-3 text-xs font-medium rounded-button text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}>
              {sheetBusy ? <Spinner className="w-3 h-3" /> : 'Load'}
            </button>
          </div>
          {sheetTabs.length > 1 && (
            <div className="mt-2">
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Tab</label>
              <select
                value={sheetTab} disabled={submitting || sheetBusy}
                onChange={e => { setSheetTab(e.target.value); loadSheet(sheetUrl.trim(), e.target.value); }}
                className="w-full px-2.5 py-2 rounded-button border-[0.5px] text-xs outline-none"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              >
                {sheetTabs.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
          {/* THE HEADER ROW, SHOWN AND CORRECTABLE.
              A Google Sheet frequently has a title, a "prepared by" line and a
              blank row above the real header. Prism detects it, but the guess
              WILL be wrong on some layout — and since this row is persisted and
              drives which values are read and standardized, a silent wrong
              guess yields a session that looks healthy and standardizes the
              wrong column. File uploads have always had this control; Sheets
              did not (SHEETS-HDR-02). */}
          {sheetId && !sheetBusy && !sheetError && sheetSample.length > 0 && (
            <div className="mt-3 rounded-[10px] border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: 'var(--page-bg)' }}>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Column headers are on row</span>
                <input
                  type="number" min={1} max={sheetSample.length} value={sheetHdr + 1}
                  disabled={submitting || sheetBusy}
                  onChange={e => {
                    const idx = Math.max(0, Math.min(sheetSample.length - 1, Number(e.target.value) - 1));
                    setSelected([]);
                    loadSheet(sheetUrl.trim(), sheetTab, idx);
                  }}
                  className="w-16 px-2 py-1 rounded-button border-[0.5px] text-xs outline-none"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                />
                {sheetHdr !== sheetDetected && (
                  <button type="button" disabled={submitting || sheetBusy}
                    onClick={() => { setSelected([]); loadSheet(sheetUrl.trim(), sheetTab); }}
                    className="text-[11px] underline" style={{ color: 'var(--accent)' }}>
                    reset to detected row {sheetDetected + 1}
                  </button>
                )}
              </div>
              {/* Show the top of the sheet so the choice is visible, not blind. */}
              <div style={{ maxHeight: 150, overflow: 'auto' }}>
                <table className="w-full text-[10px]" style={{ borderCollapse: 'collapse' }}>
                  <tbody>
                    {sheetSample.slice(0, 8).map((row, i) => {
                      const isHeader = i === sheetHdr;
                      return (
                        <tr key={i} style={{
                          backgroundColor: isHeader ? 'var(--accent-tint)' : 'transparent',
                          borderTop: '0.5px solid var(--border-subtle)',
                        }}>
                          <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-hint)', width: 28 }}>{i + 1}</td>
                          {row.slice(0, 6).map((c, j) => (
                            <td key={j} className="px-2 py-1 truncate" style={{
                              maxWidth: 120,
                              color: isHeader ? 'var(--accent-strong)' : 'var(--text-secondary)',
                              fontWeight: isHeader ? 600 : 400,
                            }}>{c}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {sheetError && <p className="mt-2 text-xs" style={{ color: 'var(--confidence-low)' }}>{sheetError}</p>}
        </div>
      )}

      {/* Paste */}
      {sourceKind === 'paste' && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Paste values</label>
          <textarea
            value={pasteText} disabled={submitting}
            onChange={e => {
              setPasteText(e.target.value);
              // One column, named by the user — the column picker below still
              // drives spec/convention, so paste behaves like any other source.
              setFields([{ name: pasteColumn.trim() || 'value', type: 'text', isText: true }]);
            }}
            rows={7}
            placeholder={'One value per line\nAT&T\natt\nVerizon'}
            className="w-full px-3 py-2 rounded-button border-[0.5px] text-xs outline-none"
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          />
          <div className="mt-2 flex items-center gap-2">
            <label className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Column name</label>
            <input
              type="text" value={pasteColumn} disabled={submitting}
              onChange={e => {
                setPasteColumn(e.target.value);
                setSelected([]);
                setFields([{ name: e.target.value.trim() || 'value', type: 'text', isText: true }]);
              }}
              className="w-40 px-2 py-1 rounded-button border-[0.5px] text-xs outline-none"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
              {effectiveRows().length.toLocaleString()} value{effectiveRows().length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}

      {/* Columns */}
      <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Columns to standardize</label>
      {columnsLoading && (
        <div className="flex items-center justify-center gap-2 py-8 rounded-[10px] border-[0.5px]" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
          <Spinner /><span className="text-xs" style={{ color: 'var(--text-muted)' }}>Reading columns…</span>
        </div>
      )}
      {!columnsLoading && columnsError && (
        <div className="rounded-[10px] border-[0.5px] px-3.5 py-3 text-xs leading-relaxed" style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
          {columnsError}
          {needsConnect && (
            <a href="/setup?next=%2Fhome" className="block mt-1.5 font-medium underline" style={{ color: '#92400E' }}>
              Connect your {warehouseLabel} account →
            </a>
          )}
        </div>
      )}
      {!columnsLoading && !columnsError && textCols.length === 0 && (
        <div className="rounded-[10px] border-[0.5px] px-3.5 py-5 text-center text-xs" style={{ borderColor: 'var(--border)', borderStyle: 'dashed', color: 'var(--text-hint)' }}>
          {sourceKind === 'warehouse' ? 'Enter a source table above to choose its columns.'
            : sourceKind === 'file' ? 'Upload a file above to choose its columns.'
            : sourceKind === 'sheets' ? 'Load a Google Sheet above to choose its columns.'
            : 'Paste some values above to continue.'}
        </div>
      )}
      {!columnsLoading && !columnsError && textCols.length > 0 && (
        <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {textCols.map((col, i) => {
              const sel = isSelected(col.name);
              const selCol = selected.find(s => s.column_name.toUpperCase() === col.name.toUpperCase());
              const blocked = !col.isText;
              return (
                <div key={col.name} style={{ borderTop: i > 0 ? '0.5px solid var(--border)' : undefined }}>
                  <button
                    type="button"
                    disabled={blocked || submitting}
                    onClick={() => toggle(col.name)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed"
                    style={{ backgroundColor: sel ? 'var(--accent-tint)' : 'transparent', opacity: blocked ? 0.55 : 1 }}
                  >
                    <span className="flex items-center justify-center flex-shrink-0"
                      style={{ width: 18, height: 18, borderRadius: 5, border: `0.5px solid ${sel ? 'var(--accent)' : 'var(--border)'}`, backgroundColor: sel ? 'var(--accent)' : 'var(--surface)' }}>
                      {sel && (
                        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="font-mono text-sm truncate" style={{ color: 'var(--text-primary)' }}>{col.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-pill uppercase tracking-wide flex-shrink-0" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
                      {col.type.toLowerCase()}
                    </span>
                    {blocked && (
                      <span className="ml-auto text-[10px] flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--text-hint)' }}>non-text</span>
                    )}
                  </button>

                  {sel && selCol && (
                    <div className="px-3 pb-3 pt-0.5" style={{ backgroundColor: 'var(--accent-tint)' }}>
                      {!selCol.showConv ? (
                        <button
                          type="button"
                          onClick={() => patchCol(col.name, { showConv: true })}
                          className="flex items-center gap-1.5 text-[11px] font-medium"
                          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
                        >
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          </svg>
                          Add standardization settings (optional)
                          {(!!selCol.description.trim() || conventionDraftHasContent(selCol.convention) || selCol.stdRules.some(r => r.trim())) && <span style={{ color: 'var(--text-muted)' }}>&middot; set</span>}
                        </button>
                      ) : (
                        <div className="rounded-button border-[0.5px] p-3" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Settings for {col.name}</span>
                            <div className="flex items-center gap-2">
                              {selected.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => applyConventionToAll(selCol.convention)}
                                  className="text-[11px] font-medium px-2 py-1 rounded-button border-[0.5px]"
                                  style={{ borderColor: 'var(--accent-border)', color: 'var(--accent)', backgroundColor: 'var(--accent-tint)' }}
                                >
                                  Apply to all columns
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => patchCol(col.name, { showConv: false })}
                                className="text-[11px]"
                                style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                              >
                                Hide
                              </button>
                            </div>
                          </div>

                          {/* Description */}
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                            Description <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
                          </label>
                          <p className="text-[11px] mb-2" style={{ color: 'var(--text-hint)' }}>
                            What are this column&rsquo;s values? Helps the AI identify them — e.g. &ldquo;US mobile carrier names&rdquo;.
                          </p>
                          <textarea
                            value={selCol.description}
                            onChange={e => patchCol(col.name, { description: e.target.value })}
                            placeholder="Describe what this column's values are…"
                            rows={2}
                            disabled={submitting}
                            className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none mb-4 resize-none disabled:opacity-50"
                            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', lineHeight: 1.5 }}
                            onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                            onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                          />

                          {/* Grouping instructions */}
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                            Grouping instructions <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
                          </label>
                          <p className="text-[11px] mb-2" style={{ color: 'var(--text-hint)' }}>
                            Rules for how values are grouped — e.g. &ldquo;group subsidiaries under the parent company name&rdquo;.
                          </p>
                          <div className="flex flex-col gap-1.5 mb-3">
                            {selCol.stdRules.map((rule, ri) => (
                              <div key={ri} className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={rule}
                                  onChange={e => {
                                    const updated = [...selCol.stdRules];
                                    updated[ri] = e.target.value;
                                    patchCol(col.name, { stdRules: updated });
                                  }}
                                  placeholder={`Rule ${ri + 1}...`}
                                  disabled={submitting}
                                  className="flex-1 text-sm px-3 py-1.5 rounded-button border-[0.5px] outline-none disabled:opacity-50"
                                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                                  onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                                />
                                {selCol.stdRules.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => patchCol(col.name, { stdRules: selCol.stdRules.filter((_, idx) => idx !== ri) })}
                                    disabled={submitting}
                                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-button border-[0.5px] text-xs transition-colors"
                                    style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#FCA5A5'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                                    title="Remove rule"
                                  >&times;</button>
                                )}
                              </div>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => patchCol(col.name, { stdRules: [...selCol.stdRules, ''] })}
                            disabled={submitting}
                            className="flex items-center gap-1.5 text-xs font-medium mb-4"
                            style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                              <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            Add rule
                          </button>

                          {/* Naming convention */}
                          <ConventionEditor
                            value={selCol.convention}
                            onChange={d => patchCol(col.name, { convention: d })}
                            disabled={submitting}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-button border-[0.5px] px-3 py-2 mt-4 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
          {error}
          {needsConnect && (
            <a href="/setup?next=%2Fhome" className="block mt-1.5 font-medium underline" style={{ color: 'var(--confidence-low)' }}>
              Connect your {warehouseLabel} account →
            </a>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 mt-5">
        <button
          type="button"
          onClick={handleStandardize}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 text-sm font-medium rounded-button px-5 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-white"
          style={{ backgroundColor: 'var(--accent)' }}
          onMouseEnter={e => { if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
        >
          {submitting ? <><Spinner /> Starting…</> : <>Standardize {selected.length > 0 ? `${selected.length} column${selected.length > 1 ? 's' : ''}` : ''}</>}
        </button>
        <span className="text-xs" style={{ color: 'var(--text-hint)' }}>
          You&rsquo;ll review the mappings before anything is written.
        </span>
      </div>
    </div>
  );
}
