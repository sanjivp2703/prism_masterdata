'use client';

/**
 * OneTimeArchiveView — the archive of completed one-time ("clean a list once")
 * standardizations. Extracted from the deleted StandardizationsView (the domain
 * library). One-time sessions never touched any lookup, so this view has nothing
 * to do with the removed domains concept — it just lists past sessions and the
 * mappings the user selected.
 */

import { useEffect, useState } from 'react';

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

interface ArchiveEntry {
  ots_id:          number;
  source_relation: string;
  columns:         string[];
  export_target:   string;
  export_mode:     string;
  mappings:        Record<string, { raw: string; standardized: string }[]>;
  exported_at:     string | null;
}

function humanizeTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ArchiveCard({ entry }: { entry: ArchiveEntry }) {
  const [open, setOpen] = useState(false);
  const totalMappings = Object.values(entry.mappings ?? {}).reduce((s, arr) => s + (arr?.length ?? 0), 0);

  return (
    <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
        style={{ backgroundColor: open ? 'var(--page-bg)' : 'var(--surface)', border: 'none', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
          style={{ color: 'var(--text-muted)', flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold font-mono truncate" style={{ color: 'var(--text-primary)' }}>{entry.export_target}</p>
          <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            from <span className="font-mono">{entry.source_relation}</span> · {entry.columns.length} column{entry.columns.length !== 1 ? 's' : ''} · {humanizeTs(entry.exported_at)}
          </p>
        </div>
        {entry.export_mode === 'overwrite' && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-pill flex-shrink-0" style={{ backgroundColor: '#FFF7ED', color: '#92400E', border: '0.5px solid #FED7AA' }}>overwrote</span>
        )}
        {!open && <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{totalMappings.toLocaleString()} mappings</span>}
      </button>

      {open && (
        <div style={{ borderTop: '0.5px solid var(--border)' }}>
          {entry.columns.map((col) => {
            const rows = entry.mappings?.[col] ?? [];
            return (
              <div key={col} style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
                <div className="px-4 py-2" style={{ backgroundColor: 'var(--page-bg)' }}>
                  <span className="text-[11px] font-semibold font-mono" style={{ color: 'var(--text-secondary)' }}>{col}</span>
                  <span className="text-[10px] ml-2" style={{ color: 'var(--text-hint)' }}>{rows.length.toLocaleString()} mappings</span>
                </div>
                {rows.length > 0 && (
                  <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                    {rows.map((m, i) => (
                      <div key={`${m.raw}::${i}`} className="grid px-4 py-1.5 text-xs items-center"
                        style={{ gridTemplateColumns: '1fr 1fr', borderTop: i > 0 ? '0.5px solid var(--border-subtle)' : undefined, gap: 8 }}>
                        <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={m.raw}>{m.raw}</span>
                        <span className="truncate font-medium" style={{ color: 'var(--accent)' }} title={m.standardized}>{m.standardized}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OneTimeArchiveView({ onBack }: { onBack?: () => void }) {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch('/api/one-time/archive');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setEntries(body.archive ?? []);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load archive');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto" style={{ padding: 'var(--page-padding-y) 32px' }}>
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4"
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5l-4 3.5 4 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back
        </button>
      )}

      <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>One-time standardizations archive</h2>
      <p className="text-xs mt-1 mb-5" style={{ color: 'var(--text-muted)' }}>
        Your past one-off standardizations and the mappings you selected. These are fully independent of your pipelines.
      </p>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16"><Spinner className="w-5 h-5" /><span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading archive…</span></div>
      )}
      {!loading && error && (
        <div className="rounded-card border-[0.5px] px-4 py-3 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: '#DC2626' }}>{error}</div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ opacity: 0.2 }}>
            <rect x="6" y="8" width="36" height="32" rx="5" stroke="currentColor" strokeWidth="2.5" />
            <path d="M14 18h20M14 24h20M14 30h12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No one-time standardizations yet</p>
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 280 }}>
            Run a one-time standardization from the Connect tab and it&rsquo;ll appear here once exported.
          </p>
        </div>
      )}
      {!loading && !error && entries.length > 0 && (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {entries.map((e) => <ArchiveCard key={e.ots_id} entry={e} />)}
        </div>
      )}
    </div>
  );
}
