'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useRef, useCallback, useEffect } from 'react';
import { getAppMode } from '@/app/api/_lib/feature-flags';
import AutoExportHome from './AutoExportHome';

// ── Prism mark (inline SVG — matches brand reference) ─────────────────────
function PrismMark({ size = 40 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.28);
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <polygon points={`0,0 0,${h} ${cx},${cy}`} fill="#1A1A2E" />
      <polygon points={`${w},0 ${w},${h} ${cx},${cy}`} fill="#378ADD" />
      <circle cx={cx} cy={cy} r={size * 0.065} fill="white" />
    </svg>
  );
}

// ── Step icons ─────────────────────────────────────────────────────────────
function IconUpload() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M11 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 6.5L11 3l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v3.5A1.5 1.5 0 005.5 19h11a1.5 1.5 0 001.5-1.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGroup() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="5" cy="11" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="6"  r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="16" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 6.5 Q13 6.5 13 11 Q13 15.5 7 15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="15" cy="11" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconExport() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="18" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="8" x2="20" y2="8" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="8" x2="10" y2="20" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────
function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Back button ─────────────────────────────────────────────────────────────
function BackBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex justify-center mt-3">
      <button
        onClick={onClick}
        disabled={disabled}
        className="flex items-center gap-1 text-xs transition-colors disabled:opacity-40"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────
type ParsedTable = { title: string; headers: string[]; rows: string[][] };
type UploadStep = 'idle' | 'parsing' | 'error' | 'select-sheet' | 'select-column' | 'preview' | 'submitting';

const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some(ext => name.endsWith(ext));
}

function isTitleRow(cells: string[]): boolean {
  // A title row has exactly one populated cell (and it's not a number)
  const filled = cells.filter(c => c !== '');
  return filled.length === 1 && isNaN(Number(filled[0]));
}

function looksLikeHeaders(cells: string[]): boolean {
  const filled = cells.filter(c => c !== '');
  if (filled.length === 0) return false;
  // All non-empty cells must be non-numeric
  return filled.every(c => isNaN(Number(c)));
}

async function parseUploadedFile(file: File, sheetName?: string): Promise<ParsedTable> {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });

  const targetSheet = sheetName ?? workbook.SheetNames[0];
  if (!targetSheet) throw new Error('The file appears to be empty.');
  if (!workbook.Sheets[targetSheet]) throw new Error(`Sheet "${targetSheet}" was not found in the file.`);

  const sheet = workbook.Sheets[targetSheet];
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  }) as (string | number | boolean | null)[][];

  const allRows: string[][] = rawRows.map(row =>
    row.map(cell => (cell == null ? '' : String(cell).trim()))
  );

  // Skip leading blank rows
  const firstNonBlankIdx = allRows.findIndex(row => row.some(c => c !== ''));
  if (firstNonBlankIdx === -1) {
    throw new Error('The file appears to be empty — no data was found.');
  }

  let title = '';
  let headerRowIdx = firstNonBlankIdx;

  // Detect title row: single cell with a value, rest empty
  if (isTitleRow(allRows[firstNonBlankIdx])) {
    title = allRows[firstNonBlankIdx].find(c => c !== '') ?? '';
    headerRowIdx = firstNonBlankIdx + 1;
    // Skip any further blank rows
    while (headerRowIdx < allRows.length && !allRows[headerRowIdx].some(c => c !== '')) {
      headerRowIdx++;
    }
  }

  if (headerRowIdx >= allRows.length) {
    throw new Error(
      'Could not find column headers. Make sure your file has a header row with column names followed by data rows. ' +
      'If there is a title above your headers, that is fine — but the file must have at least one header row and one data row.'
    );
  }

  const headerCells = allRows[headerRowIdx];

  if (!looksLikeHeaders(headerCells)) {
    throw new Error(
      'The first row contains numbers instead of column names. ' +
      'Please make sure your column headers are text, in the first row, with no title rows above them. ' +
      'Your data rows should start in the row immediately below the headers.'
    );
  }

  const nonEmptyHeaders = headerCells.filter(c => c !== '');
  if (nonEmptyHeaders.length === 0) {
    throw new Error(
      'No column headers were found. Make sure the first row contains column names.'
    );
  }

  const dataRows = allRows
    .slice(headerRowIdx + 1)
    .filter(row => row.some(c => c !== ''))
    .map(row => {
      const padded = [...row];
      while (padded.length < headerCells.length) padded.push('');
      return padded.slice(0, headerCells.length);
    });

  if (dataRows.length === 0) {
    throw new Error('No data rows were found below the header row.');
  }

  return { title, headers: headerCells, rows: dataRows };
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function HomePage() {
  // ── Mode gate ──────────────────────────────────────────────────────────
  if (getAppMode() === 'premium') return <AutoExportHome />;

  const router = useRouter();

  // ── Role: null = loading, true = admin, false = user ──────────────────
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => r.json())
      .then(d => setIsAdmin(d.role === 'admin'))
      .catch(() => setIsAdmin(false));
  }, []);

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'upload' | 'snowflake'>('upload');

  // ── Snowflake tab state ────────────────────────────────────────────────
  const [tableFqn,   setTableFqn]   = useState('TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS');
  const [columnName, setColumnName] = useState('RAW_CARRIER_VALUE');
  const [loading,    setLoading]    = useState(false);
  const [sfError,    setSfError]    = useState<string | null>(null);

  // ── Upload tab state ───────────────────────────────────────────────────
  const [uploadStep,     setUploadStep]     = useState<UploadStep>('idle');
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [parsedTable,    setParsedTable]    = useState<ParsedTable | null>(null);
  const [selectedColumn, setSelectedColumn] = useState('');
  const [previewValues,  setPreviewValues]  = useState<string[]>([]);
  const [totalRowCount,  setTotalRowCount]  = useState(0);
  const [distinctCount,  setDistinctCount]  = useState(0);
  const [isDragging,     setIsDragging]     = useState(false);
  // Sheet selection state
  const [currentFile,    setCurrentFile]    = useState<File | null>(null);
  const [sheetNames,     setSheetNames]     = useState<string[]>([]);
  const [selectedSheet,  setSelectedSheet]  = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Non-empty headers for selection dropdown
  const availableHeaders = parsedTable
    ? parsedTable.headers.filter(h => h !== '')
    : [];

  function computePreview(table: ParsedTable, column: string) {
    const colIdx = table.headers.findIndex(
      h => h.toLowerCase() === column.toLowerCase()
    );
    if (colIdx === -1) return;

    const allVals = table.rows
      .map(r => (r[colIdx] ?? '').trim())
      .filter(v => v !== '');

    const distinct = [...new Set(allVals)];
    setTotalRowCount(allVals.length);
    setDistinctCount(distinct.length);
    setPreviewValues(distinct.slice(0, 15));
  }

  // Shared: parse a specific sheet and advance to the next step.
  // Must be defined before processFile / handleSheetConfirm since both call it.
  const parseAndAdvance = useCallback(async (file: File, sheet: string) => {
    setUploadStep('parsing');
    setUploadError(null);
    setParsedTable(null);
    setSelectedColumn('');
    try {
      const table = await parseUploadedFile(file, sheet);
      setParsedTable(table);
      const nonEmpty = table.headers.filter(h => h !== '');
      if (nonEmpty.length === 1) {
        const col = nonEmpty[0];
        setSelectedColumn(col);
        computePreview(table, col);
        setUploadStep('preview');
      } else {
        setUploadStep('select-column');
      }
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : 'Failed to read the file. Please check the format and try again.'
      );
      setUploadStep('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processFile = useCallback(async (file: File) => {
    if (!isAcceptedFile(file)) {
      const ext = file.name.includes('.')
        ? file.name.split('.').pop()?.toUpperCase()
        : 'unknown';
      setUploadError(
        `.${ext} files are not supported. Please upload a .xlsx, .xls, or .csv file.`
      );
      setUploadStep('error');
      return;
    }

    setUploadStep('parsing');
    setCurrentFile(file);
    setUploadError(null);

    try {
      // Quick read: just get sheet names (bookSheets skips full cell parsing)
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', bookSheets: true });
      const names: string[] = wb.SheetNames;

      if (names.length > 1) {
        setSheetNames(names);
        setSelectedSheet(names[0]);
        setUploadStep('select-sheet');
        return;
      }

      // Single sheet — skip selection, go straight to parsing
      await parseAndAdvance(file, names[0] ?? '');
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : 'Failed to read the file. Please check the format and try again.'
      );
      setUploadStep('error');
    }
  }, [parseAndAdvance]);

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  // Single back handler — goes to the natural previous step.
  function handleBack() {
    switch (uploadStep) {
      case 'error':
      case 'select-sheet':
        resetUpload();
        break;
      case 'select-column':
        if (sheetNames.length > 1) setUploadStep('select-sheet');
        else resetUpload();
        break;
      case 'preview':
        if (availableHeaders.length > 1) setUploadStep('select-column');
        else if (sheetNames.length > 1) setUploadStep('select-sheet');
        else resetUpload();
        break;
    }
  }

  async function handleSheetConfirm() {
    if (!currentFile || !selectedSheet) return;
    await parseAndAdvance(currentFile, selectedSheet);
  }

  function handleColumnConfirm() {
    if (!parsedTable || !selectedColumn) return;
    computePreview(parsedTable, selectedColumn);
    setUploadStep('preview');
  }

  function resetUpload() {
    setUploadStep('idle');
    setUploadError(null);
    setParsedTable(null);
    setSelectedColumn('');
    setPreviewValues([]);
    setTotalRowCount(0);
    setDistinctCount(0);
    setCurrentFile(null);
    setSheetNames([]);
    setSelectedSheet('');
  }

  async function handleUploadSubmit() {
    if (!parsedTable || !selectedColumn) return;
    setUploadStep('submitting');

    try {
      const exactColName =
        parsedTable.headers.find(
          h => h.toLowerCase() === selectedColumn.toLowerCase()
        ) ?? selectedColumn;

      const res = await fetch('/api/run/create-from-paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_column: exactColName,
          table_json:    JSON.stringify(parsedTable),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to create run');
      const run_id = body?.data?.run_id;
      if (!run_id) throw new Error('Run was created but no ID was returned.');
      router.push(`/run/${run_id}`);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      );
      setUploadStep('error');
    }
  }

  // ── Snowflake submit ───────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const table  = tableFqn.trim();
    const column = columnName.trim();
    if (!table || !column || loading) return;

    setLoading(true);
    setSfError(null);

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          concept_key: 'mobile_carrier',
          table_fqn:   table,
          column_name: column,
          mode:        'review',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to create run');
      const run_id = body?.data?.run_id;
      if (!run_id) throw new Error('Run was created but no ID was returned.');
      router.push(`/run/${run_id}`);
    } catch (err) {
      setSfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  const canSubmit = tableFqn.trim().length > 0 && columnName.trim().length > 0 && !loading;

  const steps = [
    {
      icon:  <IconUpload />,
      label: 'Upload or connect your data',
      sub:   'Point Prism at the source values you want to standardize',
    },
    {
      icon:  <IconGroup />,
      label: 'Verify groupings',
      sub:   'Review how values were clustered and adjust any groupings',
    },
    {
      icon:  <IconExport />,
      label: 'Export clean mappings',
      sub:   "Write canonical mappings back when you're happy with the result",
    },
  ];

  return (
    <div
      className="min-h-screen flex flex-col justify-center"
      style={{
        backgroundColor: 'var(--page-bg)',
        padding: 'var(--page-padding-y) var(--page-padding-x)',
        paddingTop: 'calc(var(--page-padding-y) + 44px)',
      }}
    >
      <div className="w-full max-w-5xl mx-auto">

        {/* ── Top bar ────────────────────────────────────────────────────── */}
        <div className="flex justify-end mb-6" style={{ paddingRight: 52 }}>
          {/* null = still loading (keep space but hide); false = user (render nothing) */}
          {isAdmin !== false && (
          <Link
            href="/invite"
            style={{ visibility: isAdmin === true ? 'visible' : 'hidden' }}
            className="inline-flex items-center gap-2 text-sm font-medium rounded-[8px] px-3.5 py-2 border-[0.5px] transition-colors"
            style={{
              borderColor: 'var(--accent-border)',
              backgroundColor: 'var(--accent-tint)',
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="5.5" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M1 12c0-2.5 2-4 4.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M10.5 8v4M8.5 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            Invite teammate
          </Link>
          )}
        </div>

        {/* ── Two-column layout ──────────────────────────────────────────── */}
        <div className="grid grid-cols-[1fr_1fr] gap-16 items-center">

          {/* ── Left: logo, tagline, steps ───────────────────────────────── */}
          <div>
            <div className="flex items-center gap-3 mb-5">
              <PrismMark size={42} />
              <span
                className="text-[32px] font-semibold tracking-tight"
                style={{ color: 'var(--text-primary)' }}
              >
                Prism
              </span>
            </div>

            <p
              className="text-[15px] leading-relaxed mb-12"
              style={{ color: 'var(--text-secondary)', maxWidth: 360 }}
            >
              Automatically unify inconsistent categorical values across your
              Snowflake tables — turning messy raw strings into clean,
              canonical data.
            </p>

            <div className="flex flex-col gap-6">
              {steps.map(({ icon, label, sub }, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div
                    className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}
                  >
                    {icon}
                  </div>
                  <div className="pt-0.5">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {label}
                    </p>
                    <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {sub}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Global Standardizations link ─────────────────────────── */}
            <div className="mt-10 pt-6" style={{ borderTop: '0.5px solid var(--border)' }}>
              <Link
                href="/global-standardizations"
                className="group inline-flex items-center gap-3 w-full rounded-card border-[0.5px] px-4 py-3.5 transition-colors"
                style={{ borderColor: '#C7D2FE', backgroundColor: '#EEF2FF' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.backgroundColor = '#E0E7FF';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.backgroundColor = '#EEF2FF';
                }}
              >
                <div
                  className="w-8 h-8 rounded-[8px] flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: '#6366F1', color: 'white' }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" />
                    <rect x="1" y="7" width="10" height="2" rx="1" fill="currentColor" />
                    <rect x="1" y="11" width="12" height="2" rx="1" fill="currentColor" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: '#3730A3' }}>
                    Global Standardizations
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#6366F1' }}>
                    View &amp; edit the canonical library across all runs
                  </p>
                </div>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: '#6366F1' }}>
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            </div>
          </div>

          {/* ── Right: tabs + form ───────────────────────────────────────── */}
          <div>

            {/* Tab navigation */}
            <div
              className="flex gap-0 mb-[-0.5px]"
              style={{ borderBottom: '0.5px solid var(--border)' }}
            >
              {([
                { id: 'upload',    label: 'Upload File' },
                { id: 'snowflake', label: 'Snowflake Table' },
              ] as const).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className="px-4 pb-3 pt-0 text-sm font-medium transition-colors"
                  style={{
                    color:        activeTab === id ? 'var(--accent)' : 'var(--text-muted)',
                    borderBottom: `2px solid ${activeTab === id ? 'var(--accent)' : 'transparent'}`,
                    marginBottom: '-0.5px',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Card */}
            <div
              className="rounded-card border-[0.5px]"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor:     'var(--border)',
                padding:         'var(--card-padding)',
                borderTopLeftRadius: activeTab === 'upload' ? 0 : undefined,
              }}
            >

              {/* ── Upload tab ────────────────────────────────────────────── */}
              {activeTab === 'upload' && (
                <div>

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleFileInputChange}
                  />

                  {/* ── Step: idle (drop zone) ─────────────────────────── */}
                  {uploadStep === 'idle' && (
                    <div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
                        onDrop={handleDrop}
                        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                        onDragEnter={e => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        className="w-full flex flex-col items-center justify-center gap-3 rounded-[10px] border-[1.5px] border-dashed cursor-pointer transition-colors py-10"
                        style={{
                          borderColor:     isDragging ? 'var(--accent)' : 'var(--border)',
                          backgroundColor: isDragging ? 'var(--accent-tint)' : 'transparent',
                        }}
                      >
                        <div
                          className="w-11 h-11 rounded-[10px] flex items-center justify-center"
                          style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}
                        >
                          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                            <path d="M11 13V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            <path d="M7.5 6L11 2.5L14.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M4 13.5V17A1.5 1.5 0 005.5 18.5h11A1.5 1.5 0 0018 17v-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {isDragging ? 'Drop file here' : 'Drop your file here'}
                          </p>
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            or{' '}
                            <span style={{ color: 'var(--accent)' }}>browse to upload</span>
                          </p>
                        </div>
                        <p className="text-xs" style={{ color: 'var(--text-hint)' }}>
                          Accepts .xlsx, .xls, .csv
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── Step: parsing ─────────────────────────────────── */}
                  {uploadStep === 'parsing' && (
                    <div className="flex flex-col items-center justify-center gap-3 py-12">
                      <Spinner className="w-6 h-6" />
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Reading file…
                      </p>
                    </div>
                  )}

                  {/* ── Step: error ───────────────────────────────────── */}
                  {uploadStep === 'error' && (
                    <div>
                      <div
                        className="rounded-[10px] border-[0.5px] px-4 py-4 mb-5 text-sm leading-relaxed"
                        style={{
                          backgroundColor: '#FEF2F2',
                          borderColor:     '#FECACA',
                          color:           'var(--confidence-low)',
                        }}
                      >
                        {uploadError}
                      </div>
                      <BackBtn onClick={handleBack} />
                    </div>
                  )}

                  {/* ── Step: select-sheet ────────────────────────────── */}
                  {uploadStep === 'select-sheet' && (
                    <div>
                      <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                        This file has multiple sheets. Which one should we use?
                      </p>
                      <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
                        {sheetNames.length} sheets found
                      </p>

                      <div className="mb-6">
                        {sheetNames.map(name => (
                          <button
                            key={name}
                            onClick={() => setSelectedSheet(name)}
                            className="w-full text-left px-3.5 py-2.5 rounded-[8px] text-sm mb-1.5 border-[0.5px] transition-colors"
                            style={{
                              borderColor:     selectedSheet === name ? 'var(--accent)' : 'var(--border)',
                              backgroundColor: selectedSheet === name ? 'var(--accent-tint)' : 'var(--surface)',
                              color:           selectedSheet === name ? 'var(--accent)' : 'var(--text-primary)',
                              fontWeight:      selectedSheet === name ? 500 : 400,
                            }}
                          >
                            {name}
                          </button>
                        ))}
                      </div>

                      <button
                        onClick={handleSheetConfirm}
                        disabled={!selectedSheet}
                        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)' }}
                        onMouseEnter={e => {
                          if (selectedSheet) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                        }}
                      >
                        Use &ldquo;{selectedSheet}&rdquo;
                      </button>

                      <BackBtn onClick={handleBack} />
                    </div>
                  )}

                  {/* ── Step: select-column ───────────────────────────── */}
                  {uploadStep === 'select-column' && parsedTable && (
                    <div>
                      <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                        Which column contains the values to standardize?
                      </p>
                      <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
                        {availableHeaders.length} column{availableHeaders.length !== 1 ? 's' : ''} detected
                        {parsedTable.title && (
                          <> · <span style={{ color: 'var(--text-secondary)' }}>{parsedTable.title}</span></>
                        )}
                      </p>

                      <div className="mb-6">
                        <select
                          value={selectedColumn}
                          onChange={e => setSelectedColumn(e.target.value)}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors"
                          style={{
                            borderColor:     selectedColumn ? 'var(--accent)' : 'var(--border)',
                            backgroundColor: 'var(--surface)',
                            color:           selectedColumn ? 'var(--text-primary)' : 'var(--text-muted)',
                          }}
                        >
                          <option value="" disabled>Select a column…</option>
                          {availableHeaders.map(h => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                        </select>
                      </div>

                      <button
                        onClick={handleColumnConfirm}
                        disabled={!selectedColumn}
                        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)' }}
                        onMouseEnter={e => {
                          if (selectedColumn) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                        }}
                      >
                        Continue
                      </button>

                      <BackBtn onClick={handleBack} />
                    </div>
                  )}

                  {/* ── Step: preview / submitting ────────────────────── */}
                  {(uploadStep === 'preview' || uploadStep === 'submitting') && parsedTable && (
                    <div>
                      {/* Stats row */}
                      <div
                        className="flex items-center gap-4 rounded-[8px] px-4 py-3 mb-5"
                        style={{ backgroundColor: 'var(--accent-tint)' }}
                      >
                        <div className="text-center">
                          <p className="text-lg font-semibold leading-none" style={{ color: 'var(--accent)' }}>
                            {totalRowCount.toLocaleString()}
                          </p>
                          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>total rows</p>
                        </div>
                        <div
                          className="w-px h-8 flex-shrink-0"
                          style={{ backgroundColor: 'var(--border)' }}
                        />
                        <div className="text-center">
                          <p className="text-lg font-semibold leading-none" style={{ color: 'var(--accent)' }}>
                            {distinctCount.toLocaleString()}
                          </p>
                          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>distinct values</p>
                        </div>
                        <div className="ml-auto text-right">
                          <p className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {selectedColumn}
                          </p>
                          {parsedTable.title && (
                            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {parsedTable.title}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Preview list */}
                      <div className="mb-1">
                        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                          Preview{previewValues.length < distinctCount ? ` (first ${previewValues.length} of ${distinctCount.toLocaleString()})` : ''}
                        </p>
                        <div
                          className="rounded-[8px] border-[0.5px] overflow-hidden"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          {previewValues.map((val, i) => (
                            <div
                              key={i}
                              className="px-3.5 py-2 text-sm"
                              style={{
                                color:           'var(--text-primary)',
                                borderTop:       i > 0 ? '0.5px solid var(--border)' : undefined,
                                backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent',
                              }}
                            >
                              {val}
                            </div>
                          ))}
                        </div>
                      </div>

                      <p className="text-[11px] mb-5 mt-2" style={{ color: 'var(--text-muted)' }}>
                        Duplicate rows were removed silently. The run will use {distinctCount.toLocaleString()} distinct value{distinctCount !== 1 ? 's' : ''}.
                      </p>

                      {uploadError && (
                        <div
                          className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm"
                          style={{
                            backgroundColor: '#FEF2F2',
                            borderColor:     '#FECACA',
                            color:           'var(--confidence-low)',
                          }}
                        >
                          {uploadError}
                        </div>
                      )}

                      <button
                        onClick={handleUploadSubmit}
                        disabled={uploadStep === 'submitting'}
                        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)' }}
                        onMouseEnter={e => {
                          if (uploadStep !== 'submitting') (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                        }}
                      >
                        {uploadStep === 'submitting' ? (
                          <span className="inline-flex items-center justify-center gap-2">
                            <Spinner />
                            Creating run…
                          </span>
                        ) : (
                          'Looks right — start standardization'
                        )}
                      </button>

                      <BackBtn onClick={handleBack} disabled={uploadStep === 'submitting'} />
                    </div>
                  )}

                </div>
              )}

              {/* ── Snowflake tab ──────────────────────────────────────────── */}
              {activeTab === 'snowflake' && (
                <form onSubmit={handleSubmit}>
                  <div className="mb-5">
                    <label
                      htmlFor="table-fqn"
                      className="block text-sm font-medium mb-1.5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Source table
                    </label>
                    <input
                      id="table-fqn"
                      type="text"
                      value={tableFqn}
                      onChange={e => setTableFqn(e.target.value)}
                      placeholder="DATABASE.SCHEMA.TABLE_NAME"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={loading}
                      className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                      style={{
                        borderColor:     'var(--border)',
                        backgroundColor: 'var(--surface)',
                        color:           'var(--text-primary)',
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                    />
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                      Fully qualified — database, schema, and table name separated by dots
                    </p>
                  </div>

                  <div className="mb-7">
                    <label
                      htmlFor="column-name"
                      className="block text-sm font-medium mb-1.5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Column
                    </label>
                    <input
                      id="column-name"
                      type="text"
                      value={columnName}
                      onChange={e => setColumnName(e.target.value)}
                      placeholder="COLUMN_NAME"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={loading}
                      className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                      style={{
                        borderColor:     'var(--border)',
                        backgroundColor: 'var(--surface)',
                        color:           'var(--text-primary)',
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                    />
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                      The column containing the raw values to standardize
                    </p>
                  </div>

                  {sfError && (
                    <div
                      className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
                      style={{
                        backgroundColor: '#FEF2F2',
                        borderColor:     '#FECACA',
                        color:           'var(--confidence-low)',
                      }}
                    >
                      {sfError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--accent)' }}
                    onMouseEnter={e => {
                      if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                    }}
                  >
                    {loading ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <Spinner />
                        Creating run…
                      </span>
                    ) : (
                      'Start standardization →'
                    )}
                  </button>

                  <p className="mt-4 text-xs text-center" style={{ color: 'var(--text-hint)' }}>
                    Nothing is written back until you export after reviewing.
                  </p>
                </form>
              )}

            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
