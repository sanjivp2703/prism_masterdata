'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Domain } from '@/app/components/DomainSelector';
import CompactDomainPicker from '@/app/components/CompactDomainPicker';

export type FileSourceType = 'csv' | 'excel' | 'sheets';

interface SheetInfo { name: string; index: number; id: number }

interface SheetsColEntry {
  columnName: string;
  domain: Domain | null;
}

interface Props {
  sourceType:       FileSourceType;
  domains:          Domain[];
  domainsLoading:   boolean;
  onDomainCreated:  (d: Domain) => void;
}

const COL_WIZARD_KEY = 'prism_ae_col_wizard';

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

const inputCss: React.CSSProperties = {
  borderColor: 'var(--border)', backgroundColor: 'var(--surface)',
  color: 'var(--text-primary)', fontFamily: 'monospace',
};

export default function FilePipelineConnectForm({ sourceType, domains, domainsLoading, onDomainCreated }: Props) {
  const router = useRouter();

  // ── CSV / Excel state ─────────────────────────────────────────────────────
  const fileRef               = useRef<HTMLInputElement>(null);
  const [fileName,   setFileName]   = useState('');
  const [fileSheets, setFileSheets] = useState<string[]>([]);
  const [activeTab,  setActiveTab]  = useState('');
  const [fileHeaders,setFileHeaders]= useState<string[]>([]);
  const [fileRows,   setFileRows]   = useState<Record<string,any>[]>([]);
  const [fileError,  setFileError]  = useState<string | null>(null);
  const [fileLoading,setFileLoading]= useState(false);

  // ── Sheets state ──────────────────────────────────────────────────────────
  const [sheetsUrl,       setSheetsUrl]       = useState('');
  const [sheetsId,        setSheetsId]        = useState('');
  const [sheetsTitle,     setSheetsTitle]     = useState('');
  const [sheetsList,      setSheetsList]      = useState<SheetInfo[]>([]);
  const [sheetsActiveTab, setSheetsActiveTab] = useState('');
  const [sheetsColumns,   setSheetsColumns]   = useState<string[]>([]);
  const [sheetsLoading,   setSheetsLoading]   = useState(false);
  const [sheetsError,     setSheetsError]     = useState<string | null>(null);
  const [sheetsNeedsAuth, setSheetsNeedsAuth] = useState(false);

  // Multi-column selection for Sheets
  const [sheetsColumnEntries, setSheetsColumnEntries] = useState<SheetsColEntry[]>([]);
  const [sheetsColumnValues,  setSheetsColumnValues]  = useState<Map<string, string[]>>(new Map());
  const [pipelineName,        setPipelineName]        = useState('');

  // ── CSV/Excel single-column state ─────────────────────────────────────────
  const [selectedColumn, setSelectedColumn] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);

  // ── Submit state ──────────────────────────────────────────────────────────
  const [submitting,   setSubmitting]   = useState(false);
  const [submitError,  setSubmitError]  = useState<string | null>(null);

  // Reset CSV/Excel column selection when headers change.
  useEffect(() => { setSelectedColumn(''); }, [fileHeaders]);

  // ── CSV / Excel file parsing ──────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError(null);
    setFileLoading(true);
    setFileName(file.name);
    setFileSheets([]); setActiveTab(''); setFileHeaders([]); setFileRows([]);

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      setFileError('Only .csv, .xlsx, and .xls files are supported.');
      setFileLoading(false);
      return;
    }

    try {
      const XLSX = await import('xlsx');
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });

      if (wb.SheetNames.length === 0) {
        setFileError('The file has no sheets.'); setFileLoading(false); return;
      }

      if (wb.SheetNames.length > 1) {
        setFileSheets(wb.SheetNames);
        setActiveTab(wb.SheetNames[0]);
        loadXlsxSheet(XLSX, wb, wb.SheetNames[0]);
      } else {
        setFileSheets([]);
        setActiveTab(wb.SheetNames[0]);
        loadXlsxSheet(XLSX, wb, wb.SheetNames[0]);
      }
    } catch {
      setFileError('Could not parse the file. Make sure it is a valid CSV or Excel file.');
    } finally {
      setFileLoading(false);
    }
  }

  function loadXlsxSheet(XLSX: any, wb: any, sheetName: string) {
    const ws   = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
    if (data.length === 0) { setFileHeaders([]); setFileRows([]); return; }

    const headers = (data[0] as any[]).map(String);
    const rows    = data.slice(1).map(row => {
      const obj: Record<string, any> = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      return obj;
    });
    setFileHeaders(headers);
    setFileRows(rows);
    setActiveTab(sheetName);
  }

  function handleTabChange(tab: string) {
    setActiveTab(tab);
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setFileLoading(true);
    import('xlsx').then(XLSX => {
      file.arrayBuffer().then(buf => {
        const wb = XLSX.read(buf, { type: 'array' });
        loadXlsxSheet(XLSX, wb, tab);
        setFileLoading(false);
      });
    });
  }

  // ── Sheets: load columns ─────────────────────────────────────────────────
  async function loadSheetsColumns(tabName?: string) {
    const url = sheetsUrl.trim();
    if (!url) return;
    setSheetsLoading(true); setSheetsError(null); setSheetsNeedsAuth(false);
    setSheetsColumns([]); setSheetsColumnEntries([]); setSheetsColumnValues(new Map());

    const params = new URLSearchParams({ url });
    if (tabName) params.set('tab', tabName);

    try {
      const res  = await fetch(`/api/sheets/columns?${params}`);
      const body = await res.json().catch(() => ({}));
      if (body.needsAuth) { setSheetsNeedsAuth(true); setSheetsLoading(false); return; }
      if (!res.ok) { setSheetsError(body?.error ?? 'Failed to read sheet'); setSheetsLoading(false); return; }
      const title      = String(body.title ?? '');
      const activeTab  = String(body.activeSheet ?? tabName ?? '');
      setSheetsId(body.spreadsheetId ?? '');
      setSheetsTitle(title);
      setSheetsList(body.sheets ?? []);
      setSheetsActiveTab(activeTab);
      setSheetsColumns(body.columns ?? []);
      // Auto-populate pipeline name; can be overridden by the user.
      setPipelineName(title ? (activeTab ? `${title} / ${activeTab}` : title) : activeTab);
    } catch {
      setSheetsError('Failed to connect to Google Sheets.');
    } finally {
      setSheetsLoading(false);
    }
  }

  async function handleSheetsTabChange(tab: string) {
    setSheetsActiveTab(tab);
    setSheetsColumnEntries([]);
    setSheetsColumnValues(new Map());
    setPipelineName('');
    await loadSheetsColumns(tab);
  }

  // Read distinct values for a Sheets column (for the initial run).
  async function readSheetsColumnValues(col: string): Promise<string[]> {
    if (!sheetsId || !col) return [];
    try {
      const tabPart = sheetsActiveTab ? `'${sheetsActiveTab.replace(/'/g, "\\'")}'!` : '';
      const colIdx  = sheetsColumns.indexOf(col);
      if (colIdx < 0) return [];
      const colLetter = String.fromCharCode(65 + colIdx);
      const range = `${tabPart}${colLetter}2:${colLetter}5001`;
      const res = await fetch(`/api/sheets/values?id=${encodeURIComponent(sheetsId)}&range=${encodeURIComponent(range)}`);
      if (!res.ok) return [];
      const body = await res.json().catch(() => ({}));
      const vals: string[] = (body.values ?? []).map(String).filter((v: string) => v.trim());
      return [...new Set(vals.map(v => v.trim()))].filter(Boolean);
    } catch { return []; }
  }

  // Toggle a column's selection (Sheets only).
  async function toggleSheetsColumn(colName: string) {
    const existing = sheetsColumnEntries.find(e => e.columnName === colName);
    if (existing) {
      setSheetsColumnEntries(prev => prev.filter(e => e.columnName !== colName));
      setSheetsColumnValues(prev => { const m = new Map(prev); m.delete(colName); return m; });
    } else {
      setSheetsColumnEntries(prev => [...prev, { columnName: colName, domain: null }]);
      // Read values in background.
      readSheetsColumnValues(colName).then(vals => {
        setSheetsColumnValues(prev => new Map(prev).set(colName, vals));
      });
    }
  }

  function setSheetsEntryDomain(colName: string, domain: Domain | null) {
    setSheetsColumnEntries(prev =>
      prev.map(e => e.columnName === colName ? { ...e, domain } : e),
    );
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    if (sourceType === 'sheets') {
      if (sheetsColumnEntries.length === 0) return;
      if (sheetsColumnEntries.some(en => !en.domain)) return;
    } else {
      if (!selectedColumn || !selectedDomain) return;
    }

    setSubmitting(true); setSubmitError(null);

    try {
      const bodyObj: Record<string, any> = { source_type: sourceType };

      if (sourceType === 'sheets') {
        if (!sheetsId) throw new Error('Load the sheet columns first.');
        bodyObj.spreadsheet_url   = sheetsUrl;
        bodyObj.spreadsheet_id    = sheetsId;
        bodyObj.sheet_tab_name    = sheetsActiveTab;
        bodyObj.spreadsheet_title = sheetsTitle;
        bodyObj.display_name      = pipelineName.trim() || undefined;
        bodyObj.columns = sheetsColumnEntries.map(en => ({
          column_name:    en.columnName,
          domain_id:      en.domain!.domain_id,
          initial_values: sheetsColumnValues.get(en.columnName) ?? [],
        }));
      } else {
        if (!fileName || fileRows.length === 0) throw new Error('No file data loaded.');
        bodyObj.column_name = selectedColumn;
        bodyObj.domain_id   = selectedDomain!.domain_id;
        bodyObj.file_name   = fileName;
        bodyObj.rows        = fileRows;
      }

      const res  = await fetch('/api/pipelines/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg    = data?.error ?? 'Failed to create pipeline';
        const detail = data?.details ? `\n\nDetails: ${data.details}` : '';
        throw new Error(msg + detail);
      }

      if (sourceType === 'sheets') {
        // Response: { pipeline_id, run_ids, column_names }
        // All columns share ONE pipeline_id now (one pipeline per tab).
        const pipelineId: number    = data.pipeline_id ?? (data.pipeline_ids?.[0] ?? 0);
        const runIds: (number | null)[] = data.run_ids ?? (data.run_id != null ? [data.run_id] : [null]);
        const colNames: string[]    = data.column_names ?? sheetsColumnEntries.map(e => e.columnName);
        const firstRunId = runIds.find(r => r != null) ?? null;

        if (runIds.filter(r => r != null).length > 1) {
          // Multi-column wizard: all runs share the same pipeline_id.
          const wizard = { kind: 'create', pids: runIds.map(() => pipelineId), cols: colNames, runs: runIds };
          try { sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(wizard)); } catch { /* ignore */ }
        } else {
          try { sessionStorage.removeItem(COL_WIZARD_KEY); } catch { /* ignore */ }
        }

        if (firstRunId) {
          router.push(`/run/${firstRunId}`);
        } else {
          router.push('/home?tab=pipelines');
        }
      } else {
        // CSV / Excel single-column response: { pipeline_id, run_id }
        if (data.run_id) {
          router.push(`/run/${data.run_id}`);
        } else {
          router.push('/home?tab=pipelines');
        }
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  const fileHeaders_all = sourceType === 'sheets' ? sheetsColumns : fileHeaders;
  const hasSource       = sourceType === 'sheets' ? sheetsColumns.length > 0 : fileHeaders.length > 0;

  const canSubmit = sourceType === 'sheets'
    ? hasSource && sheetsColumnEntries.length > 0 && sheetsColumnEntries.every(e => e.domain !== null) && !submitting
    : hasSource && !!selectedColumn && !!selectedDomain && !submitting;

  const showExportNote = sourceType === 'sheets'
    ? sheetsColumnEntries.length > 0
    : hasSource && !!selectedColumn;

  return (
    <form onSubmit={handleSubmit}>
      {/* ── CSV / Excel file picker ── */}
      {(sourceType === 'csv' || sourceType === 'excel') && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
            {sourceType === 'csv' ? 'CSV file' : 'Excel file'}
          </label>
          <div
            className="flex items-center gap-3 rounded-button border-[0.5px] px-3.5 py-2.5 cursor-pointer transition-colors"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', borderStyle: fileName ? 'solid' : 'dashed' }}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
              <path d="M3 13V5l4-4h6v12H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M7 1v4H3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-sm flex-1 truncate" style={{ color: fileName ? 'var(--text-primary)' : 'var(--text-hint)', fontFamily: 'monospace' }}>
              {fileName || `Click to upload a .${sourceType === 'csv' ? 'csv' : 'xlsx / .xls'} file`}
            </span>
            {fileLoading && <Spinner className="w-4 h-4" />}
          </div>
          <input
            ref={fileRef} type="file"
            accept={sourceType === 'csv' ? '.csv' : '.xlsx,.xls'}
            className="hidden"
            onChange={handleFileChange}
            disabled={submitting}
          />
          {fileError && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--confidence-low)' }}>{fileError}</p>
          )}
        </div>
      )}

      {/* ── Sheets URL + load button ── */}
      {sourceType === 'sheets' && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Google Sheets URL</label>
          <div className="flex gap-2">
            <input
              type="url" value={sheetsUrl}
              onChange={e => { setSheetsUrl(e.target.value); setSheetsColumns([]); setSheetsId(''); setSheetsColumnEntries([]); setSheetsColumnValues(new Map()); setPipelineName(''); }}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              autoComplete="off" autoCorrect="off" spellCheck={false}
              disabled={submitting}
              className="flex-1 px-3.5 py-2.5 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
              style={inputCss}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
            <button
              type="button"
              onClick={() => loadSheetsColumns()}
              disabled={!sheetsUrl.trim() || sheetsLoading || submitting}
              className="px-3 py-2.5 rounded-button border-[0.5px] text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'var(--accent-tint)' }}
            >
              {sheetsLoading ? <><Spinner className="w-3.5 h-3.5" />Loading…</> : 'Load columns'}
            </button>
          </div>

          {sheetsNeedsAuth && (
            <div className="mt-2 rounded-button border-[0.5px] px-3 py-2 flex items-center gap-2" style={{ backgroundColor: '#EAF1FE', borderColor: '#C5D8FC' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6.5" stroke="#378ADD" strokeWidth="1"/>
                <path d="M7 6v4" stroke="#378ADD" strokeWidth="1.2" strokeLinecap="round"/>
                <circle cx="7" cy="4.5" r="0.6" fill="#378ADD"/>
              </svg>
              <span className="text-xs" style={{ color: '#185FA5' }}>
                Your Google session has expired.{' '}
                <a href="/api/auth/google?returnTo=/home" className="font-medium underline">Sign in again</a>
                {' '}to re-enable Sheets access.
              </span>
            </div>
          )}
          {sheetsError && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--confidence-low)' }}>{sheetsError}</p>
          )}
          {sheetsTitle && (
            <p className="mt-1.5 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{sheetsTitle}</p>
          )}

          {/* Instructions — shown once URL is entered */}
          {sheetsUrl.trim() && (
            <div className="mt-2.5 rounded-button border-[0.5px] px-3 py-2.5" style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)' }}>
              <p className="text-[11px]" style={{ color: 'var(--accent-strong)', lineHeight: 1.5 }}>
                <span className="font-semibold">Before connecting:</span> Make sure your sheet has column names in the first row. Prism will name the pipeline after your spreadsheet file and tab.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Excel tab selector ── */}
      {sourceType !== 'sheets' && fileSheets.length > 1 && (
        <div className="mb-4">
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Sheet</label>
          <div className="flex flex-wrap gap-1.5">
            {fileSheets.map(s => (
              <button
                key={s} type="button"
                onClick={() => handleTabChange(s)}
                className="text-[11px] px-2.5 py-1 rounded-pill border-[0.5px] transition-colors"
                style={{
                  borderColor: activeTab === s ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: activeTab === s ? 'var(--accent-tint)' : 'transparent',
                  color: activeTab === s ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Sheets tab selector ── */}
      {sourceType === 'sheets' && sheetsList.length > 1 && (
        <div className="mb-4">
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Tab</label>
          <div className="flex flex-wrap gap-1.5">
            {sheetsList.map(s => (
              <button
                key={s.id} type="button"
                onClick={() => handleSheetsTabChange(s.name)}
                className="text-[11px] px-2.5 py-1 rounded-pill border-[0.5px] transition-colors"
                style={{
                  borderColor: sheetsActiveTab === s.name ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: sheetsActiveTab === s.name ? 'var(--accent-tint)' : 'transparent',
                  color: sheetsActiveTab === s.name ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Pipeline name (Sheets only, shown once columns load) ── */}
      {sourceType === 'sheets' && sheetsColumns.length > 0 && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Table name</label>
          <input
            type="text"
            value={pipelineName}
            onChange={e => setPipelineName(e.target.value)}
            placeholder="e.g. Spreadsheet Title / Tab Name"
            disabled={submitting}
            className="w-full px-3.5 py-2.5 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
          />
        </div>
      )}

      {/* ── Column picker ── */}
      {hasSource && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
            {sourceType === 'sheets' ? 'Columns to standardize' : 'Column to standardize'}
          </label>

          {/* ── Sheets: multi-column checkboxes with inline domain pickers ── */}
          {sourceType === 'sheets' ? (
            <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)', maxHeight: 360, overflowY: 'auto' }}>
              {sheetsColumns.map((h, i) => {
                const entry   = sheetsColumnEntries.find(e => e.columnName === h);
                const checked = !!entry;
                return (
                  <div key={h} style={{ borderTop: i > 0 ? '0.5px solid var(--border)' : undefined }}>
                    {/* Column row */}
                    <button
                      type="button"
                      onClick={() => toggleSheetsColumn(h)}
                      disabled={submitting}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed"
                      style={{ backgroundColor: checked ? 'var(--accent-tint)' : 'transparent' }}
                    >
                      {/* Checkbox */}
                      <span
                        className="flex-shrink-0 flex items-center justify-center"
                        style={{
                          width: 16, height: 16,
                          borderRadius: 3,
                          border: `0.5px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                          backgroundColor: checked ? 'var(--accent)' : 'var(--surface)',
                        }}
                      >
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                            <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>{h}</span>
                    </button>
                    {/* Inline domain picker when checked */}
                    {checked && (
                      <div className="px-3 pb-3 pt-0" style={{ backgroundColor: 'var(--accent-tint)' }}>
                        <p className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Domain for <span className="font-mono font-medium">{h}</span></p>
                        <CompactDomainPicker
                          domains={domains}
                          isLoading={domainsLoading}
                          value={entry.domain}
                          onChange={domain => setSheetsEntryDomain(h, domain)}
                          onDomainCreated={d => { onDomainCreated(d); setSheetsEntryDomain(h, d); }}
                          disabled={submitting}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* CSV / Excel: single-column radio */
            <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)', maxHeight: 260, overflowY: 'auto' }}>
              {fileHeaders_all.map((h, i) => (
                <button
                  key={h} type="button"
                  onClick={() => setSelectedColumn(h)}
                  disabled={submitting}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed"
                  style={{
                    borderTop: i > 0 ? '0.5px solid var(--border)' : undefined,
                    backgroundColor: selectedColumn === h ? 'var(--accent-tint)' : 'transparent',
                  }}
                >
                  <span className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 16, height: 16, borderRadius: '50%', border: `0.5px solid ${selectedColumn === h ? 'var(--accent)' : 'var(--border)'}`, backgroundColor: selectedColumn === h ? 'var(--accent)' : 'var(--surface)' }}>
                    {selectedColumn === h && (
                      <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <circle cx="5" cy="5" r="3" fill="white" />
                      </svg>
                    )}
                  </span>
                  <span className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>{h}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CSV/Excel domain picker ── */}
      {sourceType !== 'sheets' && hasSource && selectedColumn && (
        <div className="mb-5">
          <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Domain</label>
          <CompactDomainPicker
            domains={domains} isLoading={domainsLoading}
            value={selectedDomain}
            onChange={setSelectedDomain}
            onDomainCreated={onDomainCreated}
            disabled={submitting}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>
            Standardized mappings are scoped to this domain and reuse any previously confirmed values.
          </p>
        </div>
      )}

      {/* ── Export note ── */}
      {showExportNote && (
        <div className="mb-5 rounded-button border-[0.5px] px-3.5 py-3" style={{ backgroundColor: '#F8FAFC', borderColor: '#CBD5E1' }}>
          {sourceType === 'sheets' ? (
            <p className="text-[11px]" style={{ color: '#475569' }}>
              <span className="font-semibold" style={{ color: '#1E40AF' }}>Export: </span>
              After each standardization pass Prism replaces the standardized column values in a dedicated output Google Sheet. All source columns are included.
            </p>
          ) : (
            <p className="text-[11px]" style={{ color: '#475569' }}>
              <span className="font-semibold" style={{ color: '#1E40AF' }}>Export: </span>
              Use the <span className="font-semibold">Download standardized table</span> button on the pipeline card to download a CSV of your data with the standardized values.
            </p>
          )}
        </div>
      )}

      {/* ── Mode note ── */}
      <div className="mb-5 rounded-button border-[0.5px] px-3 py-2 flex items-center gap-2" style={{ backgroundColor: 'var(--page-bg)', borderColor: 'var(--border)' }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
          <circle cx="6" cy="6" r="5.5" stroke="currentColor" strokeWidth="1"/>
          <path d="M6 5v3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <circle cx="6" cy="3.5" r="0.6" fill="currentColor"/>
        </svg>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          File-based pipelines run in <span className="font-medium">manual mode</span> — you trigger each standardization pass.
        </span>
      </div>

      {submitError && (
        <div className="rounded-button border-[0.5px] px-3 py-2 mb-4 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
          {submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: 'var(--accent)' }}
        onMouseEnter={e => { if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
      >
        {submitting
          ? <span className="inline-flex items-center gap-2 justify-center"><Spinner />Setting up…</span>
          : sourceType === 'sheets' ? 'Connect sheet' : `Connect ${sourceType.toUpperCase()} file`}
      </button>
    </form>
  );
}
