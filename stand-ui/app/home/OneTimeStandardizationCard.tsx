'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ConventionEditor, {
  emptyConventionDraft, conventionDraftToConvention, conventionDraftHasContent, conventionRegexValid,
  type ConventionDraft,
} from '@/app/components/ConventionEditor';

interface TableColumn { name: string; type: string; isText: boolean }

interface SelectedCol {
  column_name: string;
  convention:  ConventionDraft;
  showConv:    boolean;
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
  const router = useRouter();

  const [tableFqn, setTableFqn] = useState('');
  const [fields, setFields]           = useState<TableColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError]     = useState<string | null>(null);

  const [selected, setSelected] = useState<SelectedCol[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch columns when the table FQN looks complete (DB.SCHEMA.TABLE).
  useEffect(() => {
    const t = tableFqn.trim();
    if (t.split('.').filter(Boolean).length !== 3) {
      setFields([]); setColumnsError(null); setColumnsLoading(false);
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
        else {
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
  }, [tableFqn]);

  function isSelected(name: string) {
    return selected.some(s => s.column_name.toUpperCase() === name.toUpperCase());
  }
  function toggle(name: string) {
    setSelected(prev => prev.some(s => s.column_name.toUpperCase() === name.toUpperCase())
      ? prev.filter(s => s.column_name.toUpperCase() !== name.toUpperCase())
      : [...prev, { column_name: name, convention: emptyConventionDraft(), showConv: false }]);
  }
  function patchCol(name: string, patch: Partial<SelectedCol>) {
    setSelected(prev => prev.map(s => s.column_name === name ? { ...s, ...patch } : s));
  }
  function applyConventionToAll(src: ConventionDraft) {
    setSelected(prev => prev.map(s => ({ ...s, convention: { ...src }, showConv: true })));
  }

  const anyRegexInvalid = selected.some(s => conventionRegexValid(s.convention) === false);
  const canSubmit = !submitting && tableFqn.trim().split('.').filter(Boolean).length === 3 && selected.length > 0 && !anyRegexInvalid;

  async function handleStandardize() {
    if (!canSubmit) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch('/api/one-time/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_relation: tableFqn.trim(),
          columns: selected.map(s => ({
            column_name: s.column_name,
            convention: conventionDraftHasContent(s.convention) ? conventionDraftToConvention(s.convention) : null,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to start the one-time standardization.');
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
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-pill" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
          no pipeline
        </span>
      </div>
      <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
        Standardize a table&rsquo;s columns once and write the result to a Snowflake table. No domain, no lookup, no ongoing pipeline — a clean one-off.
      </p>

      {/* Source table */}
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
        </div>
      )}
      {!columnsLoading && !columnsError && textCols.length === 0 && (
        <div className="rounded-[10px] border-[0.5px] px-3.5 py-5 text-center text-xs" style={{ borderColor: 'var(--border)', borderStyle: 'dashed', color: 'var(--text-hint)' }}>
          Enter a source table above to choose its columns.
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
                    <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide flex-shrink-0" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
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
                          Add naming convention (optional)
                          {conventionDraftHasContent(selCol.convention) && <span style={{ color: 'var(--text-muted)' }}>· set</span>}
                        </button>
                      ) : (
                        <div className="rounded-button border-[0.5px] p-3" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Naming convention for {col.name}</span>
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
