'use client';

import { useRouter } from 'next/navigation';
import { useState, useMemo } from 'react';

// ── Prism mark (inline SVG — matches brand reference) ─────────────────────
function PrismMark({ size = 40 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.28); // ~aspect ratio of the mark
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      {/* Left — dark navy */}
      <polygon points={`0,0 0,${h} ${cx},${cy}`} fill="#1A1A2E" />
      {/* Right — brand blue */}
      <polygon points={`${w},0 ${w},${h} ${cx},${cy}`} fill="#378ADD" />
      {/* Centre dot */}
      <circle cx={cx} cy={cy} r={size * 0.065} fill="white" />
    </svg>
  );
}

// ── Step icons ─────────────────────────────────────────────────────────────
function IconTable() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="18" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="8" x2="20" y2="8" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="8" x2="10" y2="20" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconGroup() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      {/* Three dots merging into one */}
      <circle cx="5"  cy="11" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5"  cy="6"  r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5"  cy="16" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 6.5 Q13 6.5 13 11 Q13 15.5 7 15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="15" cy="11" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconExport() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M11 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 6.5L11 3l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v3.5A1.5 1.5 0 005.5 19h11a1.5 1.5 0 001.5-1.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Paste parsing ───────────────────────────────────────────────────────────
type ParsedTable = { title: string; headers: string[]; rows: string[][] };

function parsePastedTable(text: string): ParsedTable | null {
  // Strip \r, drop trailing blank lines
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const nonEmpty = lines.filter(l => l.trim() !== '');
  if (nonEmpty.length < 3) return null; // need title + headers + ≥1 data row

  const title   = (nonEmpty[0].split('\t')[0] ?? '').trim();
  const headers = nonEmpty[1].split('\t').map(h => h.trim());
  if (headers.length === 0 || headers.every(h => h === '')) return null;

  const rows = nonEmpty.slice(2).map(l => {
    const cells = l.split('\t');
    return headers.map((_, i) => (cells[i] ?? '').trim());
  });

  return { title, headers, rows };
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function HomePage() {
  const router = useRouter();

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'snowflake' | 'paste'>('snowflake');

  // ── Snowflake tab state ────────────────────────────────────────────────
  const [tableFqn,    setTableFqn]    = useState('TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS');
  const [columnName,  setColumnName]  = useState('RAW_CARRIER_VALUE');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Paste tab state ────────────────────────────────────────────────────
  const [pasteText,         setPasteText]         = useState('');
  const [pasteSourceColumn, setPasteSourceColumn] = useState('');
  const [pasteLoading,      setPasteLoading]      = useState(false);
  const [pasteError,        setPasteError]        = useState<string | null>(null);

  const parsedTable = useMemo(() => parsePastedTable(pasteText), [pasteText]);

  // index of the typed source column in the detected headers (-1 = not found / not yet typed)
  const pasteColIdx = parsedTable && pasteSourceColumn.trim()
    ? parsedTable.headers.findIndex(h => h.toLowerCase() === pasteSourceColumn.trim().toLowerCase())
    : -1;

  // ── Snowflake submit ───────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const table  = tableFqn.trim();
    const column = columnName.trim();
    if (!table || !column || loading) return;

    setLoading(true);
    setError(null);

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
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  // ── Paste submit ───────────────────────────────────────────────────────
  async function handlePasteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsedTable || pasteColIdx === -1 || pasteLoading) return;

    setPasteLoading(true);
    setPasteError(null);

    try {
      // Use exact casing from detected headers
      const exactColName = parsedTable.headers[pasteColIdx];

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
      setPasteError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setPasteLoading(false);
    }
  }

  const canSubmit      = tableFqn.trim().length > 0 && columnName.trim().length > 0 && !loading;
  const pasteCanSubmit = parsedTable !== null && pasteColIdx !== -1 && !pasteLoading;

  const steps = [
    {
      icon:  <IconTable />,
      label: 'Enter table & column',
      sub:   'Point Prism at the source data you want to clean up',
    },
    {
      icon:  <IconGroup />,
      label: 'Verify groupings',
      sub:   'Review how values were clustered and adjust any groupings',
    },
    {
      icon:  <IconExport />,
      label: 'Export to Snowflake',
      sub:   "Write canonical mappings back when you're happy with the result",
    },
  ];

  return (
    <div
      className="min-h-screen flex flex-col justify-center"
      style={{
        backgroundColor: 'var(--page-bg)',
        padding: 'var(--page-padding-y) var(--page-padding-x)',
      }}
    >
      <div className="w-full max-w-5xl mx-auto">

        {/* ── Two-column layout ───────────────────────────────────────── */}
        <div className="grid grid-cols-[1fr_1fr] gap-16 items-center">

          {/* ── Left: logo, tagline, steps ───────────────────────────── */}
          <div>
            {/* Lockup */}
            <div className="flex items-center gap-3 mb-5">
              <PrismMark size={42} />
              <span
                className="text-[32px] font-semibold tracking-tight"
                style={{ color: 'var(--text-primary)' }}
              >
                Prism
              </span>
            </div>

            {/* Tagline */}
            <p
              className="text-[15px] leading-relaxed mb-12"
              style={{ color: 'var(--text-secondary)', maxWidth: 360 }}
            >
              Automatically unify inconsistent categorical values across your
              Snowflake tables — turning messy raw strings into clean,
              canonical data.
            </p>

            {/* Steps */}
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
          </div>

          {/* ── Right: tabs + form ───────────────────────────────────── */}
          <div>

            {/* Tab navigation */}
            <div
              className="flex gap-0 mb-[-0.5px]"
              style={{ borderBottom: '0.5px solid var(--border)' }}
            >
              {([
                { id: 'snowflake', label: 'Snowflake Table' },
                { id: 'paste',     label: 'Excel / Google Sheets' },
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
                borderTopLeftRadius: activeTab === 'snowflake' ? 0 : undefined,
              }}
            >

              {/* ── Snowflake tab ─────────────────────────────────────── */}
              {activeTab === 'snowflake' && (
                <form onSubmit={handleSubmit}>
                  {/* Source table */}
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
                      onChange={(e) => setTableFqn(e.target.value)}
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
                      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                    />
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                      Fully qualified — database, schema, and table name separated by dots
                    </p>
                  </div>

                  {/* Column */}
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
                      onChange={(e) => setColumnName(e.target.value)}
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
                      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                    />
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                      The column containing the raw values to standardize
                    </p>
                  </div>

                  {error && (
                    <div
                      className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
                      style={{
                        backgroundColor: '#FEF2F2',
                        borderColor:     '#FECACA',
                        color:           'var(--confidence-low)',
                      }}
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--accent)' }}
                    onMouseEnter={(e) => {
                      if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                    }}
                  >
                    {loading ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                        </svg>
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

              {/* ── Paste tab ─────────────────────────────────────────── */}
              {activeTab === 'paste' && (
                <form onSubmit={handlePasteSubmit}>
                  <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                    Copy your spreadsheet from Excel or Google Sheets and paste it below.
                    The <strong>first row</strong> is the title,
                    the <strong>second row</strong> is column headers,
                    and the remaining rows are data.
                  </p>

                  {/* Table textarea */}
                  <div className="mb-5">
                    <label
                      htmlFor="paste-table"
                      className="block text-sm font-medium mb-1.5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Paste table
                    </label>
                    <textarea
                      id="paste-table"
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste here…"
                      rows={8}
                      disabled={pasteLoading}
                      className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50 resize-y font-mono"
                      style={{
                        borderColor:     'var(--border)',
                        backgroundColor: 'var(--surface)',
                        color:           'var(--text-primary)',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                    />
                    {parsedTable && (
                      <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                        {parsedTable.title && (
                          <><strong style={{ color: 'var(--text-secondary)' }}>{parsedTable.title}</strong>{' · '}</>
                        )}
                        {parsedTable.headers.length} column{parsedTable.headers.length !== 1 ? 's' : ''}
                        {' · '}
                        {parsedTable.rows.length} row{parsedTable.rows.length !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>

                  {/* Source column textbox */}
                  <div className="mb-7">
                    <label
                      htmlFor="paste-source-col"
                      className="block text-sm font-medium mb-1.5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Source column
                    </label>
                    <input
                      id="paste-source-col"
                      type="text"
                      list="paste-col-hints"
                      value={pasteSourceColumn}
                      onChange={(e) => setPasteSourceColumn(e.target.value)}
                      placeholder="Column name to standardize"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pasteLoading}
                      className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                      style={{
                        borderColor:     pasteSourceColumn.trim() && parsedTable && pasteColIdx === -1
                          ? '#FECACA' : 'var(--border)',
                        backgroundColor: 'var(--surface)',
                        color:           'var(--text-primary)',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e)  => {
                        e.currentTarget.style.borderColor =
                          pasteSourceColumn.trim() && parsedTable && pasteColIdx === -1
                            ? '#FECACA' : 'var(--border)';
                      }}
                    />
                    {parsedTable && (
                      <datalist id="paste-col-hints">
                        {parsedTable.headers.map(h => <option key={h} value={h} />)}
                      </datalist>
                    )}
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-hint)' }}>
                      {pasteSourceColumn.trim() && parsedTable && pasteColIdx === -1
                        ? <span style={{ color: 'var(--confidence-low)' }}>
                            Column not found. Available: {parsedTable.headers.join(', ')}
                          </span>
                        : pasteColIdx !== -1
                        ? <span style={{ color: 'var(--confidence-high)' }}>
                            ✓ Found — {[...new Set(parsedTable!.rows.map(r => r[pasteColIdx]).filter(Boolean))].length} distinct values
                          </span>
                        : 'The column containing the raw values to standardize'
                      }
                    </p>
                  </div>

                  {pasteError && (
                    <div
                      className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
                      style={{
                        backgroundColor: '#FEF2F2',
                        borderColor:     '#FECACA',
                        color:           'var(--confidence-low)',
                      }}
                    >
                      {pasteError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!pasteCanSubmit}
                    className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--accent)' }}
                    onMouseEnter={(e) => {
                      if (pasteCanSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                    }}
                  >
                    {pasteLoading ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                        </svg>
                        Creating run…
                      </span>
                    ) : (
                      'Run Standardization →'
                    )}
                  </button>

                  <p className="mt-4 text-xs text-center" style={{ color: 'var(--text-hint)' }}>
                    Your full table will be exported with the standardized column added.
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
