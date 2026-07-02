'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ExportLookupModal from '@/app/components/ExportLookupModal';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Domain {
  domain_id:             number;
  name:                  string;
  description:           string | null;
  standardization_rules: string | null;  // JSON array of strings
  convention_type:       string | null;
  convention_value:      string | null;
  usage_count:           number;
  last_used_at:          string | null;
  created_at:            string | null;
}

interface MappingRow {
  literal_value: string;
  alias_name:    string;
}

const ROW_CAP = 500;

// ── Sub-components ──────────────────────────────────────────────────────────────

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/** One domain: collapsible card showing its confirmed mappings. */
function DomainCard({ domain, defaultOpen }: { domain: Domain; defaultOpen: boolean }) {
  const router = useRouter();
  const [open,    setOpen]    = useState(defaultOpen);
  const [rows,    setRows]    = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [search,  setSearch]  = useState('');
  const [showExportLookup, setShowExportLookup] = useState(false);
  // Track whether we've already fetched so re-opening the card doesn't re-fetch.
  const loadedRef = useRef(false);

  const stdRules: string[] = useMemo(() => {
    if (!domain.standardization_rules) return [];
    try { return JSON.parse(domain.standardization_rules) as string[]; } catch { return []; }
  }, [domain.standardization_rules]);

  // Load mappings once when first expanded. Deps are [open, domain.domain_id] only —
  // including loading/rows here would cancel the in-flight request when those change.
  useEffect(() => {
    if (!open || loadedRef.current) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/global-standardizations?domain_id=${domain.domain_id}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        const data = (body?.data ?? {}) as Record<string, { items: Array<{ literal_value: string }> }>;
        const flat: MappingRow[] = [];
        for (const [aliasName, group] of Object.entries(data)) {
          for (const it of group.items) flat.push({ literal_value: it.literal_value, alias_name: aliasName });
        }
        flat.sort((a, b) => a.alias_name.localeCompare(b.alias_name) || a.literal_value.localeCompare(b.literal_value));
        setRows(flat);
        loadedRef.current = true;
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load mappings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, domain.domain_id]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(r => r.literal_value.toLowerCase().includes(q) || r.alias_name.toLowerCase().includes(q))
    : rows;
  const shown    = filtered.slice(0, ROW_CAP);
  const overflow = filtered.length - shown.length;

  function openEditor() {
    router.push(`/global-standardizations?domain_id=${domain.domain_id}`);
  }

  return (
    <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}>
      {/* Collapsible header */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
        style={{ backgroundColor: open ? 'var(--page-bg)' : 'var(--surface)', border: 'none', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
        onMouseEnter={e => { if (!open) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
      >
        <svg
          width="11" height="11" viewBox="0 0 12 12" fill="none"
          style={{ color: 'var(--text-muted)', flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-semibold flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{domain.name}</span>
        {!open && rows.length > 0 && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{rows.length.toLocaleString()} mappings</span>
        )}
      </button>

      {/* Expanded content */}
      {open && (
        <div style={{ borderTop: '0.5px solid var(--border)' }}>

          {/* Domain metadata: description, convention, standardization rules */}
          {(domain.description || domain.convention_type || stdRules.length > 0) && (
            <div className="px-4 py-3 flex flex-col gap-2.5" style={{ borderBottom: '0.5px solid var(--border)', backgroundColor: 'var(--page-bg)' }}>
              {domain.description && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>Description</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{domain.description}</p>
                </div>
              )}
              {domain.convention_type && domain.convention_value && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>Naming convention</p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium capitalize" style={{ color: 'var(--text-primary)' }}>{domain.convention_type}</span>
                    {' — '}
                    {domain.convention_type === 'examples'
                      ? domain.convention_value.split('\n').filter(Boolean).join(', ')
                      : domain.convention_value}
                  </p>
                </div>
              )}
              {stdRules.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Standardization rules</p>
                  <ul className="flex flex-col gap-0.5">
                    {stdRules.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }}>•</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Toolbar: search + Standardize button */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
            <div className="relative flex-1 max-w-xs">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>
                <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
                <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search mappings…"
                className="text-xs rounded-button border-[0.5px] outline-none pl-7 pr-3 py-1.5 w-full"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setShowExportLookup(true)}
                className="text-[11px] font-medium px-2.5 py-1.5 rounded-button border-[0.5px] transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
                title="Download the lookup table for this domain"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 2v6M3.5 5.5L6 8l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 10h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
                Lookup table
              </button>
              <button
                onClick={openEditor}
                className="text-[11px] font-medium px-3 py-1.5 rounded-button border-[0.5px] transition-colors whitespace-nowrap shrink-0"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'var(--accent-tint)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'white'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-tint)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
              >
                Standardize
              </button>
            </div>
            {showExportLookup && (
              <ExportLookupModal
                domainId={domain.domain_id}
                domainName={domain.name}
                onClose={() => setShowExportLookup(false)}
              />
            )}
          </div>

          {loading && <div className="flex justify-center py-8"><Spinner /></div>}
          {error   && <p className="text-xs py-5 text-center" style={{ color: 'var(--confidence-low)' }}>{error}</p>}

          {!loading && !error && filtered.length === 0 && (
            <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              {q ? 'No mappings match your search.' : 'No confirmed mappings in this domain yet.'}
            </p>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div>
              <div
                className="grid text-[11px] font-medium px-4 py-2"
                style={{ gridTemplateColumns: '1fr 1fr', backgroundColor: 'var(--accent-tint)', color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)', gap: 8 }}
              >
                <span>Raw value</span>
                <span>Canonical name</span>
              </div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {shown.map((m, i) => (
                  <div
                    key={`${m.alias_name}::${m.literal_value}`}
                    className="grid px-4 py-2 text-xs items-center"
                    style={{ gridTemplateColumns: '1fr 1fr', borderTop: i > 0 ? '0.5px solid var(--border)' : undefined, backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent', gap: 8 }}
                  >
                    <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={m.literal_value}>{m.literal_value}</span>
                    <span className="truncate font-medium" style={{ color: 'var(--accent)' }} title={m.alias_name}>{m.alias_name}</span>
                  </div>
                ))}
              </div>
              {overflow > 0 && (
                <button
                  onClick={openEditor}
                  className="w-full text-[11px] font-medium py-2 transition-colors"
                  style={{ color: 'var(--text-muted)', backgroundColor: 'var(--page-bg)', borderTop: '0.5px solid var(--border)', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                >
                  +{overflow.toLocaleString()} more — open the editor
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── One-time standardizations archive ────────────────────────────────────────

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

function OneTimeArchiveView({ onBack }: { onBack: () => void }) {
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
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4"
        style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5l-4 3.5 4 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Back to standardizations
      </button>

      <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>One-time standardizations archive</h2>
      <p className="text-xs mt-1 mb-5" style={{ color: 'var(--text-muted)' }}>
        Your past one-off standardizations and the mappings you selected. These never affected any domain lookup.
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

// ── Main component ──────────────────────────────────────────────────────────────

export default function StandardizationsView({ initialOpenDomainId }: { initialOpenDomainId?: number | null }) {
  const [showArchive, setShowArchive] = useState(false);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [domainSearch, setDomainSearch] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch('/api/domains');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setDomains(body.domains ?? []);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load domains');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sorted = useMemo(() => {
    if (domains.length < 10) return domains;
    return [...domains].sort((a, b) => a.name.localeCompare(b.name));
  }, [domains]);

  const q = domainSearch.trim().toLowerCase();
  const filteredDomains = q ? sorted.filter(d => d.name.toLowerCase().includes(q)) : sorted;

  if (showArchive) return <OneTimeArchiveView onBack={() => setShowArchive(false)} />;

  return (
    <div className="w-full max-w-5xl mx-auto" style={{ padding: 'var(--page-padding-y) 32px' }}>
      <style>{`@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>

      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Standardizations</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            The confirmed lookup mappings for each domain. Open the editor to add, move, or remove mappings.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Domain search */}
          {!loading && sorted.length > 3 && (
            <div className="relative">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>
                <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
                <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                type="text" value={domainSearch} onChange={e => setDomainSearch(e.target.value)}
                placeholder="Search domains…"
                className="text-xs rounded-button border-[0.5px] outline-none pl-7 pr-3 py-1.5 w-44"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              />
            </div>
          )}
          <button
            onClick={() => setShowArchive(true)}
            className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-button border-[0.5px] whitespace-nowrap transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 4.5h10M2 7h10M2 9.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            One-time archive
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16">
          <Spinner className="w-5 h-5" />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading domains…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-card border-[0.5px] px-4 py-3 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: '#DC2626' }}>
          {error}
        </div>
      )}

      {!loading && !error && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ opacity: 0.2 }}>
            <rect x="6" y="8" width="36" height="32" rx="5" stroke="currentColor" strokeWidth="2.5" />
            <path d="M14 18h20M14 24h20M14 30h12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No domains yet</p>
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 260 }}>
            Domains are created when you set up a pipeline. Their confirmed mappings will appear here.
          </p>
        </div>
      )}

      {!loading && !error && filteredDomains.length === 0 && domainSearch && (
        <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>No domains match &ldquo;{domainSearch}&rdquo;</p>
      )}

      {!loading && !error && filteredDomains.length > 0 && (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {filteredDomains.map((d, i) => (
            <DomainCard
              key={d.domain_id}
              domain={d}
              defaultOpen={
                initialOpenDomainId != null
                  ? d.domain_id === initialOpenDomainId
                  : i === 0
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
