'use client';

import { useState, useEffect, useRef } from 'react';
import type { Pipeline, PipelineGroup } from './PipelinesView';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Mapping {
  literal_value: string;
  alias_name:    string;
  run_id:        number;
  confirmed_at:  string | null;
}

interface QueueItem {
  literal_value: string;
  detected_at:   string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Snowflake returns timestamps like "2024-01-15 10:30:00.000" with no timezone.
// Without coercion, browsers parse the space-separated form as LOCAL time, so
// all displayed times are off by the user's UTC offset. Force UTC by normalizing
// to ISO-T format + appending Z when there's no timezone suffix.
function parseUtc(iso: string): Date {
  let s = iso.trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');
  if (!s.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return new Date(s);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = parseUtc(iso);
  if (isNaN(d.getTime())) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = parseUtc(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function tableShort(fqn: string): string {
  const parts = fqn.split('.');
  return parts[parts.length - 1] ?? fqn;
}

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function PulseDot({ color = '#16a34a' }: { color?: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', backgroundColor: color, opacity: 0.4, animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite' }} />
      <span style={{ borderRadius: '50%', width: 8, height: 8, backgroundColor: color, display: 'block' }} />
    </span>
  );
}

/** Circular progress ring — fills clockwise from 12 o'clock as pct goes 0→100.
 *  There is NO reset animation: when pct DROPS (cycle end / wrap, or switching to a
 *  held state) the transition is suppressed so the ring snaps instantly instead of
 *  animating a retract. The cycle end is masked by the scanning state taking over.
 *  mode: 'normal' = blue counting, 'scanning' = teal held at 0%, 'standardizing' = amber held at 100%. */
function RefreshRing({ pct, mode = 'normal' }: { pct: number; mode?: 'normal' | 'scanning' | 'standardizing' }) {
  const r = 15;
  const cx = 20, cy = 20;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, pct / 100)));
  const arcColor = mode === 'standardizing' ? '#D97706' : mode === 'scanning' ? '#0891B2' : 'var(--accent)';

  // Only animate while the ring is FILLING (pct rising). Any drop — the 100→0 wrap,
  // or normal→scanning/standardizing — snaps with no transition, so the reset
  // retract the user asked to remove never plays. (State, not a ref, so we never
  // read a ref during render; the extra render is harmless for a tiny SVG.)
  const [prevPct, setPrevPct] = useState(pct);
  const filling = pct >= prevPct;
  useEffect(() => { setPrevPct(pct); }, [pct]);

  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx={cx} cy={cy} r={r}
        stroke={arcColor}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: (mode === 'normal' && filling) ? 'stroke-dashoffset 1s linear' : 'none' }}
      />
    </svg>
  );
}

// Inline SVG icons for the timeline (replaces emojis)
function IcoCreated()     { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5 2v2M9 2v2M2 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function IcoPolled()      { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoStandardized(){ return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M4.5 7l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoFound()       { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M9.5 9.5l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }

// ── Tab: Activity ─────────────────────────────────────────────────────────────

function ActivityTab({ group, isStandardizing = false, isScanning: scanningProp = false, cycleResetMs = 0 }: { group: PipelineGroup; isStandardizing?: boolean; isScanning?: boolean; cycleResetMs?: number }) {
  const isLive = group.status === 'active';

  // Client-side 1 s ticker for the countdown ring
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [isLive]);

  // Countdown anchor — wraps 0→100 every 30 s.
  // We count from the LATER of last_polled_at (server timestamp, refreshed via the
  // metrics_updated refetch) and cycleResetMs (a client-clock timestamp set the
  // instant scanning/standardizing FINISHES). The reset event arrives before the
  // async refetch lands, so without this the ring would briefly show the stale
  // pre-cycle position (e.g. ~16% for a 5 s scan) and snap back to 0 — the
  // "continue a little, reset, continue" jank. Anchoring to the reset kills it.
  const lastPollMs       = group.last_polled_at ? new Date(group.last_polled_at).getTime() : null;
  const anchorMs         = Math.max(lastPollMs ?? 0, cycleResetMs) || null;
  const secondsSince     = anchorMs != null ? Math.max(0, Math.floor((now - anchorMs) / 1_000)) : null;
  const secondsUntilNext = secondsSince != null ? Math.max(0, 30 - secondsSince) : null;
  const ringPct          = secondsSince != null ? (secondsSince % 30) / 30 * 100 : 0;

  // Scanning is event-driven: the poller emits scanning_started/finished around the
  // classification of new stream data, and PipelinesView turns that into this prop.
  // The ring holds at the START of the cycle (0%) for the whole check — it never
  // advances-then-snaps-back. Standardization (amber) takes precedence.
  const isScanning = scanningProp && !isStandardizing;

  const milestones: { Icon: () => React.JSX.Element; label: string; value: string; highlight?: boolean }[] = [
    { Icon: IcoCreated,      label: 'Created',           value: fmtDate(group.created_at) },
    { Icon: IcoPolled,       label: 'Last updated',      value: group.last_polled_at ? fmtDate(group.last_polled_at) : 'Never' },
    { Icon: IcoStandardized, label: 'Last standardized', value: group.last_queue_empty_at ? fmtDate(group.last_queue_empty_at) : (group.created_at ? fmtDate(group.created_at) : '—'), highlight: true },
  ];

  function StatCard({
    value, label, tooltip,
    bg = 'var(--page-bg)', border = 'var(--border)', valueColor = 'var(--text-primary)',
  }: {
    value: string; label: string; tooltip: string;
    bg?: string; border?: string; valueColor?: string;
  }) {
    const [hovered, setHovered] = useState(false);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const show = () => { clearTimeout(hideTimer.current); setHovered(true); };
    const hide = () => { hideTimer.current = setTimeout(() => setHovered(false), 300); };
    return (
      <div
        className="rounded-button p-3 relative cursor-default"
        style={{ backgroundColor: bg, border: `0.5px solid ${border}` }}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <p className="text-lg font-semibold leading-none mb-1" style={{ color: valueColor }}>{value}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</p>
        {hovered && (
          <div
            className="absolute z-50 text-[11px] leading-relaxed rounded-button shadow-lg px-3 py-2"
            style={{ bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', minWidth: 200, maxWidth: 280, backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'normal' }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {tooltip}
          </div>
        )}
      </div>
    );
  }

  // Aggregated across all columns in the card.
  const hasMetrics  = group.total_source_values > 0;
  const sourceVal   = hasMetrics ? group.total_source_values.toLocaleString() : '—';
  const stdVal      = hasMetrics ? group.total_mapped.toLocaleString() : '—';
  const unstdCount  = Math.max(0, group.total_source_values - group.total_mapped);
  const unstdVal    = hasMetrics ? unstdCount.toLocaleString() : '—';
  const hasUnstd    = hasMetrics && unstdCount > 0;

  return (
    <div>
      {/* ── Live update status (active cards only) ────────────────────── */}
      {isLive && (
        <div className="mb-4 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <RefreshRing
              pct={isStandardizing ? 100 : isScanning ? 0 : ringPct}
              mode={isStandardizing ? 'standardizing' : isScanning ? 'scanning' : 'normal'}
            />
            <div className="flex-1 min-w-0">
              {isStandardizing ? (
                <>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <PulseDot color="#D97706" />
                    <span className="text-xs font-medium" style={{ color: '#92400E' }}>Standardizing data</span>
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Polling paused — resumes when complete</p>
                </>
              ) : isScanning ? (
                <>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <PulseDot color="#0891B2" />
                    <span className="text-xs font-medium" style={{ color: '#0E7490' }}>Checking for new values</span>
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Identifying new values — cycle resumes when done</p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <PulseDot color="#16a34a" />
                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Live</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>· refreshes every 30s</span>
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {secondsUntilNext === null
                      ? 'Waiting for first update…'
                      : `Next refresh in ${secondsUntilNext}s`}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 3 stat cards — aggregated across columns ──────────────────── */}
      <div className="mb-5 pb-5" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="grid grid-cols-3 gap-2">
          <StatCard
            value={sourceVal}
            label="Source Values"
            tooltip={`Number of values in ${group.columns.map(c => c.column_name).join(', ')} (including nulls, which are automatically standardized)`}
            bg="var(--page-bg)" border="var(--border)"
          />
          <StatCard
            value={stdVal}
            label="Standardized"
            tooltip={`Number of values standardized in ${group.export_table_fqn ?? 'the export table'}`}
            bg="var(--accent-tint)" border="var(--accent-border)" valueColor="var(--text-primary)"
          />
          <StatCard
            value={unstdVal}
            label="Unstandardized"
            tooltip={`Number of values in ${tableShort(group.table_fqn)} unconfirmed to be standardized and thus not in ${group.export_table_fqn ?? 'the export table'}`}
            bg={hasUnstd ? '#FFFBEB' : 'var(--page-bg)'}
            border={hasUnstd ? '#FDE68A' : 'var(--border)'}
            valueColor={hasUnstd ? '#92400E' : 'var(--text-muted)'}
          />
        </div>
      </div>

      {/* ── Per-column breakdown (multi-column only) ──────────────────── */}
      {group.columns.length > 1 && <div className="mb-5 pb-5" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Columns</p>
        <div className="rounded-button border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}>
          {/* Header row */}
          <div
            className="grid text-[10px] font-semibold uppercase tracking-wide px-3 py-2"
            style={{ gridTemplateColumns: '1fr 90px 56px 130px', gap: 8, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--accent-border)', backgroundColor: 'var(--surface)' }}
          >
            <span>Column</span>
            <span>Domain</span>
            <span>Mode</span>
            <span className="text-right">Standardized</span>
          </div>
          {group.columns.map((c, i) => {
            const cUnstd = Math.max(0, (c.total_source_values || 0) - (c.total_mapped || 0));
            return (
              <div
                key={`${c.pipeline_id}_${c.column_name}`}
                className="grid items-center px-3 py-2.5"
                style={{ gridTemplateColumns: '1fr 90px 56px 130px', gap: 8, borderTop: i > 0 ? '0.5px solid var(--accent-border)' : undefined }}
              >
                <span className="text-xs font-medium font-mono truncate" style={{ color: 'var(--text-primary)' }}>{c.column_name}</span>
                <span className="text-[10px] truncate" style={{ color: 'var(--accent)' }}>{c.domain_name ?? '—'}</span>
                <span
                  className="text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded self-start whitespace-nowrap"
                  style={{ backgroundColor: c.mode === 'auto' ? '#F5F3FF' : 'var(--surface)', color: c.mode === 'auto' ? '#7C3AED' : 'var(--text-muted)', border: `0.5px solid ${c.mode === 'auto' ? '#DDD6FE' : 'var(--border)'}` }}
                >
                  {c.mode}
                </span>
                <span className="text-[11px] tabular-nums text-right" style={{ color: 'var(--text-muted)' }}>
                  <span style={{ color: '#15803D', fontWeight: 500 }}>{(c.total_mapped || 0).toLocaleString()}</span>
                  {' / '}{(c.total_source_values || 0).toLocaleString()}
                  {cUnstd > 0 && <span style={{ color: '#92400E' }}> · {cUnstd} left</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>}

      {/* ── Milestones ────────────────────────────────────────────────── */}
      <div className="flex flex-col" style={{ gap: 1 }}>
        {milestones.map(({ Icon, label, value, highlight }) => (
          <div key={label} className="flex items-center justify-between py-2.5 px-1" style={{ borderBottom: '0.5px solid var(--border)' }}>
            <div className="flex items-center gap-2.5">
              <span style={{ color: highlight ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, display: 'flex' }}><Icon /></span>
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
            </div>
            <span className="text-xs font-mono" style={{ color: highlight ? 'var(--accent)' : 'var(--text-primary)', fontWeight: highlight ? 500 : 400 }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: Mappings (one section per column) ──────────────────────────────────────

/** Confirmed mappings + pending queue for a single column. Search is internal per-column. */
function ColumnMappingsSection({ pipeline, showHeading }: { pipeline: Pipeline; showHeading: boolean }) {
  const [mappings,   setMappings]   = useState<Mapping[]>([]);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [search,     setSearch]     = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [mRes, qRes] = await Promise.all([
          fetch(`/api/pipelines/${pipeline.pipeline_id}/mappings?limit=500`),
          fetch(`/api/pipelines/${pipeline.pipeline_id}/queue`),
        ]);
        const [mBody, qBody] = await Promise.all([mRes.json().catch(() => ({})), qRes.json().catch(() => ({}))]);
        if (!mRes.ok) throw new Error(mBody?.error ?? `HTTP ${mRes.status}`);
        if (cancelled) return;
        setMappings(mBody.mappings ?? []);
        setTotal(mBody.total ?? 0);
        setQueueItems(qBody.items ?? []);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load mappings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pipeline.pipeline_id]);

  const q = search.trim().toLowerCase();
  const filteredMappings = q
    ? mappings.filter(m => m.literal_value.toLowerCase().includes(q) || m.alias_name.toLowerCase().includes(q))
    : mappings;
  const filteredQueue = q
    ? queueItems.filter(i => i.literal_value.toLowerCase().includes(q))
    : queueItems;

  function exportCsv() {
    const rows = [
      ['raw_value', 'canonical_name', 'confirmed_at'],
      ...mappings.map(m => [
        `"${m.literal_value.replace(/"/g, '""')}"`,
        `"${m.alias_name.replace(/"/g, '""')}"`,
        m.confirmed_at ?? '',
      ]),
    ];
    const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${tableShort(pipeline.table_fqn)}_${pipeline.column_name}_mappings.csv`; a.click();
  }

  const csvButton = mappings.length > 0 ? (
    <button
      onClick={exportCsv}
      className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors flex items-center gap-1 shrink-0"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
      title="Export this column's mappings as CSV"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 1v7M3 5.5L6 9l3-3.5M2 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Export CSV
    </button>
  ) : null;

  const searchBox = (
    <div className="relative">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>
        <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search…"
        className="text-xs rounded-button border-[0.5px] outline-none pl-6 pr-3 py-1 w-36"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
      />
    </div>
  );

  return (
    <div>
      {/* Header row: column name + count on left, search + CSV on right */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          {showHeading && (
            <>
              <span className="text-xs font-semibold font-mono truncate" style={{ color: 'var(--text-primary)' }}>{pipeline.column_name}</span>
              {pipeline.domain_name && <span className="text-[10px]" style={{ color: 'var(--accent)' }}>{pipeline.domain_name}</span>}
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{total.toLocaleString()} confirmed · {queueItems.length} pending</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {searchBox}
          {csvButton}
        </div>
      </div>

      {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      {error   && <p className="text-xs py-3 text-center" style={{ color: 'var(--confidence-low)' }}>{error}</p>}

      {!loading && !error && filteredMappings.length === 0 && filteredQueue.length === 0 && (
        <p className="text-xs py-5 text-center" style={{ color: 'var(--text-muted)' }}>
          {q ? 'No mappings match your search.' : 'No confirmed mappings yet.'}
        </p>
      )}

      {!loading && !error && (filteredMappings.length > 0 || filteredQueue.length > 0) && (
        <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <div
            className="grid text-[11px] font-medium px-3 py-2"
            style={{ gridTemplateColumns: '1fr 1fr auto', backgroundColor: 'var(--accent-tint)', color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)', gap: 8 }}
          >
            <span>Raw value</span>
            <span>Canonical name</span>
            <span>Status</span>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {filteredQueue.map((qi, i) => (
              <div key={`q-${qi.literal_value}`} className="grid px-3 py-2 text-xs items-center"
                style={{ gridTemplateColumns: '1fr 1fr auto', borderTop: i > 0 ? '0.5px solid var(--border)' : undefined, backgroundColor: '#FFFBEB', gap: 8 }}>
                <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={qi.literal_value}>{qi.literal_value}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>pending standardization</span>
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-pill whitespace-nowrap" style={{ backgroundColor: '#FEF9C3', color: '#A16207' }}>In queue</span>
              </div>
            ))}
            {filteredMappings.map((m, i) => (
              <div key={`m-${m.literal_value}`} className="grid px-3 py-2 text-xs items-center"
                style={{ gridTemplateColumns: '1fr 1fr auto', borderTop: (i > 0 || filteredQueue.length > 0) ? '0.5px solid var(--border)' : undefined, backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent', gap: 8 }}>
                <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={m.literal_value}>{m.literal_value}</span>
                <span className="truncate font-medium" style={{ color: 'var(--accent)' }} title={m.alias_name}>{m.alias_name}</span>
                <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{relativeTime(m.confirmed_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MappingsTab({ group }: { group: PipelineGroup }) {
  // Group columns by domain (domain_id + domain_name).
  type DomainGroup = { domainId: number | null; domainName: string | null; columns: Pipeline[] };
  const domainGroups: DomainGroup[] = [];
  for (const col of group.columns) {
    const existing = domainGroups.find(d => d.domainId === col.domain_id);
    if (existing) existing.columns.push(col);
    else domainGroups.push({ domainId: col.domain_id, domainName: col.domain_name, columns: [col] });
  }

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggleDomain(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div>

      <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        {domainGroups.map((dg, idx) => {
          const key = String(dg.domainId ?? '__none__');
          const isOpen = expanded.has(key);
          const totalMapped = dg.columns.reduce((s, c) => s + c.total_mapped, 0);
          const totalQueue  = dg.columns.reduce((s, c) => s + c.queue_size, 0);
          return (
            <div key={key} style={{ borderTop: idx > 0 ? '0.5px solid var(--border)' : undefined }}>
              {/* Domain header row */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                style={{ backgroundColor: isOpen ? 'var(--page-bg)' : 'var(--surface)' }}
                onClick={() => toggleDomain(key)}
                onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
              >
                <svg
                  width="11" height="11" viewBox="0 0 12 12" fill="none"
                  style={{ color: 'var(--text-muted)', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>

                <span className="text-sm font-semibold flex-1 text-left truncate" style={{ color: 'var(--text-primary)' }}>
                  {dg.domainName ?? 'No domain'}
                </span>

                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {totalMapped.toLocaleString()} standardized
                  {totalQueue > 0 && <span style={{ color: '#B45309' }}> · {totalQueue} pending</span>}
                </span>
              </button>

              {/* Expanded content */}
              {isOpen && (
                <div className="px-4 pb-4 pt-1" style={{ borderTop: '0.5px solid var(--border-subtle)', backgroundColor: 'var(--page-bg)' }}>
                  <div className="flex flex-col gap-5 pt-3">
                    {dg.columns.map(c => (
                      <ColumnMappingsSection key={`${c.pipeline_id}_${c.column_name}`} pipeline={c} showHeading={dg.columns.length > 1} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tab: Queue (one section per column) ─────────────────────────────────────────

function ColumnQueueSection({ pipeline, showHeading }: { pipeline: Pipeline; showHeading: boolean }) {
  const [items,   setItems]   = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch(`/api/pipelines/${pipeline.pipeline_id}/queue`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (!cancelled) setItems(body.items ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load queue');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pipeline.pipeline_id]);

  return (
    <div>
      {showHeading && (
        <div className="flex items-baseline gap-2 mb-2 min-w-0">
          <span className="text-xs font-semibold font-mono truncate" style={{ color: 'var(--text-primary)' }}>{pipeline.column_name}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{items.length} pending</span>
        </div>
      )}

      {loading && <div className="flex justify-center py-6"><Spinner /></div>}
      {error   && <p className="text-xs py-3 text-center" style={{ color: 'var(--confidence-low)' }}>{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>Queue is empty — all detected values standardized.</p>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <div className="grid text-[11px] font-medium px-3 py-2" style={{ gridTemplateColumns: '1fr auto', backgroundColor: 'var(--accent-tint)', color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)' }}>
            <span>Value</span>
            <span>Waiting</span>
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {items.map((item, i) => (
              <div key={item.literal_value} className="grid px-3 py-2 text-xs items-center"
                style={{ gridTemplateColumns: '1fr auto', borderTop: i > 0 ? '0.5px solid var(--border)' : undefined, backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent' }}>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{item.literal_value}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{relativeTime(item.detected_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QueueTab({ group }: { group: PipelineGroup }) {
  const multi = group.columns.length > 1;
  return (
    <div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        Values detected by polling that are waiting to be standardized.
      </p>
      <div className="flex flex-col gap-5">
        {group.columns.map(c => (
          <ColumnQueueSection key={`${c.pipeline_id}_${c.column_name}`} pipeline={c} showHeading={multi} />
        ))}
      </div>
    </div>
  );
}

// ── Tab: Settings ─────────────────────────────────────────────────────────────

interface SettingsTabProps {
  group:          PipelineGroup;
  onUpdateMember: (p: Pipeline, patch: Partial<Pipeline>) => void;
  onDeleteMember: (p: Pipeline) => void;
  onDeleteGroup:  () => void;
}

function SettingsTab({ group, onUpdateMember, onDeleteMember, onDeleteGroup }: SettingsTabProps) {
  const [name,           setName]           = useState(group.name ?? '');
  const [mode,           setMode]           = useState<'auto' | 'manual'>(group.mode === 'manual' ? 'manual' : 'auto');
  const [exportTableFqn, setExportTableFqn] = useState(group.export_table_fqn ?? '');
  const [saving,         setSaving]         = useState(false);
  const [saved,          setSaved]          = useState(false);
  const [refreshing,     setRefreshing]     = useState(false);
  const [refreshResult,  setRefreshResult]  = useState<{ ok: boolean; rows?: number; error?: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    try {
      const exportVal = exportTableFqn.trim() || null;
      // Config applies to every column in the card.
      await Promise.all(group.columns.map(c =>
        fetch(`/api/pipelines/${c.pipeline_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || null, mode, export_table_fqn: exportVal }),
        }).catch(() => {})));
      for (const c of group.columns) onUpdateMember(c, { name: name || null, mode, export_table_fqn: exportVal });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshExport() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      // The export table is shared — rebuilding from any member rebuilds it all.
      const res  = await fetch(`/api/pipelines/${group.columns[0].pipeline_id}/refresh-export`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setRefreshResult({ ok: false, error: body?.error ?? `HTTP ${res.status}` });
      else { setRefreshResult({ ok: true, rows: body.rows_written }); setTimeout(() => setRefreshResult(null), 6000); }
    } catch (e) {
      setRefreshResult({ ok: false, error: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Source (read-only) */}
      <div>
        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Source</p>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Table</span>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{tableShort(group.table_fqn)}</span>
          </div>
          {group.export_table_fqn && (
            <div className="flex justify-between text-xs gap-4">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Export table</span>
              <span className="font-mono truncate text-right" style={{ color: 'var(--text-primary)' }} title={group.export_table_fqn}>{group.export_table_fqn}</span>
            </div>
          )}
        </div>

        {/* Columns with per-column delete */}
        <p className="text-xs font-medium mt-3 mb-2" style={{ color: 'var(--text-secondary)' }}>Columns ({group.columns.length})</p>
        <div className="flex flex-col gap-1">
          {group.columns.map(c => (
            <div key={`${c.pipeline_id}_${c.column_name}`} className="flex items-center justify-between text-xs rounded-button px-2 py-1.5" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)' }}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }}>{c.column_name}</span>
                {c.domain_name && <span className="text-[10px]" style={{ color: 'var(--accent)' }}>{c.domain_name}</span>}
              </div>
              <button
                onClick={() => { if (confirm(`Stop standardizing column "${c.column_name}"? This removes it from the pipeline.`)) onDeleteMember(c); }}
                className="w-5 h-5 flex items-center justify-center rounded transition-colors flex-shrink-0"
                style={{ color: 'var(--text-muted)', backgroundColor: 'transparent', border: 'none' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                title="Remove this column"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderTop: '0.5px solid var(--border)' }} />

      {/* Editable fields — apply to all columns */}
      <div>
        <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Configuration</p>
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Name</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder={tableShort(group.table_fqn)}
              className="w-full text-xs px-3 py-2 rounded-button border-[0.5px] outline-none"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>Card label — applies to the whole table pipeline.</p>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Mode</label>
            <div className="flex gap-2">
              {(['auto', 'manual'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className="flex-1 py-1.5 text-xs font-medium rounded-button border-[0.5px] transition-colors"
                  style={{ borderColor: mode === m ? 'var(--accent)' : 'var(--border)', backgroundColor: mode === m ? 'var(--accent-tint)' : 'transparent', color: mode === m ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {m === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>
              {mode === 'auto' ? 'New values are standardized and exported automatically.' : 'New values queue up for manual review before export.'}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Export table</label>
            <input
              type="text" value={exportTableFqn} onChange={e => setExportTableFqn(e.target.value)}
              placeholder="DB.SCHEMA.TABLE_STANDARDIZED"
              className="w-full text-xs px-3 py-2 rounded-button border-[0.5px] outline-none font-mono"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-hint)' }}>
              Shared destination table for every column in this pipeline. Rebuilt on every standardization pass.
            </p>

            {(group.export_table_fqn || exportTableFqn.trim()) && (
              <div className="mt-2">
                <button type="button" onClick={handleRefreshExport} disabled={refreshing}
                  className="text-[11px] font-medium px-2.5 py-1.5 rounded-button border-[0.5px] transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
                  onMouseEnter={e => { if (!refreshing) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}>
                  {refreshing ? (<><Spinner className="w-3 h-3" />Rebuilding…</>) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M10 6A4 4 0 112.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                        <path d="M2.5 1v2.5H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Rebuild export table now
                    </>
                  )}
                </button>
                {refreshResult && (
                  <p className="text-[11px] mt-1.5" style={{ color: refreshResult.ok ? '#15803D' : 'var(--confidence-low)' }}>
                    {refreshResult.ok ? `✓ Done — ${refreshResult.rows?.toLocaleString() ?? 0} row(s) written` : `✗ ${refreshResult.error}`}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="mt-3 w-full py-1.5 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50"
          style={{ backgroundColor: saved ? '#16a34a' : 'var(--accent)' }}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
        </button>
      </div>

      <div style={{ borderTop: '0.5px solid var(--border)' }} />

      {/* Danger zone — deletes the whole card */}
      <div>
        <p className="text-xs font-medium mb-3" style={{ color: '#DC2626' }}>Danger zone</p>
        <button onClick={onDeleteGroup}
          className="w-full py-1.5 text-xs font-medium rounded-button border-[0.5px] transition-colors"
          style={{ borderColor: '#FECACA', color: '#DC2626', backgroundColor: '#FEF2F2' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEE2E2'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEF2F2'; }}>
          Delete pipeline{group.columns.length > 1 ? ` (${group.columns.length} columns)` : ''}
        </button>
        <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
          Removes the pipeline configuration. Historical mappings are preserved in the domain.
        </p>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type DetailTab = 'activity' | 'mappings' | 'queue' | 'settings';

interface Props {
  group:            PipelineGroup;
  initialTab?:      DetailTab;
  isStandardizing?: boolean;
  isScanning?:      boolean;
  cycleResetMs?:    number;
  onUpdateMember:   (p: Pipeline, patch: Partial<Pipeline>) => void;
  onDeleteMember:   (p: Pipeline) => void;
  onDeleteGroup:    () => void;
}

export default function PipelineDetail({ group, initialTab = 'activity', isStandardizing = false, isScanning = false, cycleResetMs = 0, onUpdateMember, onDeleteMember, onDeleteGroup }: Props) {
  const [tab, setTab] = useState<DetailTab>(initialTab);

  // Sync when the parent changes the tab (e.g. clicking "Mapping" button on the row)
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const TABS: { id: DetailTab; label: string }[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'mappings', label: 'Mappings' },
    { id: 'queue',    label: `Queue${group.queue_size > 0 ? ` (${group.queue_size})` : ''}` },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={{ borderTop: '0.5px solid var(--border)', backgroundColor: 'var(--surface)' }}>
      <div style={{ padding: '0 16px' }}>
        {/* Tab bar */}
        <div className="flex gap-0" style={{ borderBottom: '0.5px solid var(--border)' }}>
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="px-4 py-2.5 text-xs font-medium transition-colors"
              style={{ color: tab === id ? 'var(--accent)' : 'var(--text-muted)', borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`, marginBottom: '-0.5px' }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: '16px 0 20px' }}>
          {tab === 'activity' && <ActivityTab group={group} isStandardizing={isStandardizing} isScanning={isScanning} cycleResetMs={cycleResetMs} />}
          {tab === 'mappings' && <MappingsTab group={group} />}
          {tab === 'queue'    && <QueueTab    group={group} />}
          {tab === 'settings' && <SettingsTab group={group} onUpdateMember={onUpdateMember} onDeleteMember={onDeleteMember} onDeleteGroup={onDeleteGroup} />}
        </div>
      </div>
    </div>
  );
}
