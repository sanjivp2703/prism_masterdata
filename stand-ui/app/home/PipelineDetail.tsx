'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Pipeline } from './PipelinesView';

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

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
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
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

/** Circular progress ring — fills clockwise from 12 o'clock as pct goes 0→100. */
function RefreshRing({ pct }: { pct: number }) {
  const r = 15;
  const cx = 20, cy = 20;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, pct / 100)));
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Track */}
      <circle cx={cx} cy={cy} r={r} stroke="var(--border)" strokeWidth="2.5" />
      {/* Progress arc */}
      <circle
        cx={cx} cy={cy} r={r}
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset 1s linear' }}
      />
    </svg>
  );
}

// ── Tab: Activity ─────────────────────────────────────────────────────────────

// Inline SVG icons for the timeline (replaces emojis)
function IcoCreated()     { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5 2v2M9 2v2M2 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function IcoPolled()      { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoStandardized(){ return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M4.5 7l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function IcoFound()       { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="M9.5 9.5l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function IcoMapped()      { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 5l3-2 4 2 3-2v6l-3 2-4-2-3 2V5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M5 3v6M9 5v6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function IcoQueue()       { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4h10M2 7h7M2 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }

interface PipelineStats {
  source_row_count:       number;
  standardized_row_count: number;
  needs_standardization:  number;
}

function ActivityTab({ pipeline: initialPipeline }: { pipeline: Pipeline }) {
  // Keep a local copy of the pipeline row so we can refresh last_polled_at
  // independently of the parent's 30 s fetch cycle.
  const [pipeline, setPipeline] = useState<Pipeline>(initialPipeline);
  // Sync if the parent passes a newer snapshot (e.g. on domain re-fetch)
  useEffect(() => { setPipeline(initialPipeline); }, [initialPipeline]);

  const isLive = pipeline.status === 'active';

  // Client-side 1 s ticker for the countdown ring
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [isLive]);

  // Independently re-fetch this pipeline row every 15 s so last_polled_at
  // stays current without waiting for the parent PipelinesView's 30 s cycle.
  const refreshPipelineRow = useCallback(async () => {
    if (!isLive) return;
    try {
      const res  = await fetch('/api/pipelines');
      const body = await res.json().catch(() => ({}));
      const updated = (body.pipelines ?? []).find(
        (p: Pipeline) => p.pipeline_id === pipeline.pipeline_id,
      );
      if (updated) setPipeline(updated);
    } catch { /* ignore — stale data is acceptable */ }
  }, [isLive, pipeline.pipeline_id]);

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(refreshPipelineRow, 15_000);
    return () => clearInterval(t);
  }, [isLive, refreshPipelineRow]);

  // Countdown from last_polled_at
  const lastPollMs       = pipeline.last_polled_at ? new Date(pipeline.last_polled_at).getTime() : null;
  const secondsSince     = lastPollMs != null ? Math.max(0, Math.floor((now - lastPollMs) / 1_000)) : null;
  const secondsUntilNext = secondsSince != null ? Math.max(0, 30 - secondsSince) : null;
  // Ring fills from 0→100 over 30 s, then resets and fills again if overdue
  const ringPct = secondsSince != null ? (secondsSince % 30) / 30 * 100 : 0;

  // Live source-table stats (fetched once on mount, refreshed every 30 s)
  const [stats,      setStats]      = useState<PipelineStats | null>(null);
  const [statsError, setStatsError] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const res  = await fetch(`/api/pipelines/${pipeline.pipeline_id}/stats`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setStatsError(true); return; }
      setStats(body);
      setStatsError(false);
    } catch { setStatsError(true); }
  }, [pipeline.pipeline_id]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  // Milestones (timeline rows below the stat cards)
  const milestones: { Icon: () => JSX.Element; label: string; value: string; highlight?: boolean }[] = [
    { Icon: IcoCreated,      label: 'Created',           value: fmtDate(pipeline.created_at) },
    { Icon: IcoPolled,       label: 'Last updated',      value: pipeline.last_polled_at ? fmtDate(pipeline.last_polled_at) : 'Never' },
    { Icon: IcoStandardized, label: 'Last standardized', value: pipeline.last_queue_empty_at ? fmtDate(pipeline.last_queue_empty_at) : (pipeline.created_at ? fmtDate(pipeline.created_at) : '—'), highlight: true },
    { Icon: IcoFound,        label: 'Values detected',   value: pipeline.total_new_values.toLocaleString() },
  ];

  // ── Stat card sub-component ────────────────────────────────────────────────
  function StatCard({
    value, label, tooltip,
    bg = 'var(--page-bg)', border = 'var(--border)', valueColor = 'var(--text-primary)',
  }: {
    value:      string;
    label:      string;
    tooltip:    string;
    bg?:        string;
    border?:    string;
    valueColor?: string;
  }) {
    const [hovered, setHovered] = useState(false);
    return (
      <div
        className="rounded-button p-3 relative cursor-default"
        style={{ backgroundColor: bg, border: `0.5px solid ${border}` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <p className="text-lg font-semibold leading-none mb-1" style={{ color: valueColor }}>
          {value}
        </p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</p>

        {/* Tooltip */}
        {hovered && (
          <div
            className="absolute z-50 text-[11px] leading-relaxed rounded-button shadow-lg px-3 py-2 pointer-events-none"
            style={{
              bottom: 'calc(100% + 6px)',
              left: '50%',
              transform: 'translateX(-50%)',
              minWidth: 200,
              maxWidth: 260,
              backgroundColor: 'var(--surface)',
              border: '0.5px solid var(--border)',
              color: 'var(--text-secondary)',
              whiteSpace: 'normal',
            }}
          >
            {tooltip}
          </div>
        )}
      </div>
    );
  }

  const sourceVal  = stats ? stats.source_row_count.toLocaleString()       : '—';
  const stdVal     = stats ? stats.standardized_row_count.toLocaleString() : '—';
  const unstdCount = stats ? Math.max(0, stats.source_row_count - stats.standardized_row_count) : null;
  const unstdVal   = unstdCount != null ? unstdCount.toLocaleString() : '—';
  const hasUnstd   = unstdCount != null && unstdCount > 0;

  return (
    <div>
      {/* ── Live update status (active pipelines only) ────────────────── */}
      {isLive && (
        <div className="mb-4 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <RefreshRing pct={ringPct} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <PulseDot color="#16a34a" />
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Live</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>· refreshes every 30s</span>
              </div>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {secondsUntilNext === null
                  ? 'Waiting for first update…'
                  : secondsUntilNext === 0
                  ? secondsSince != null && secondsSince > 60
                    ? `Last updated ${Math.floor(secondsSince / 60)}m ago`
                    : 'Polling…'
                  : `Next refresh in ${secondsUntilNext}s`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── 3 stat cards — shown for all pipeline statuses ───────────── */}
      <div className="mb-5 pb-5" style={{ borderBottom: '0.5px solid var(--border)' }}>
        {statsError ? (
          <p className="text-[11px] text-center py-2" style={{ color: 'var(--text-muted)' }}>
            Could not load source stats
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              value={sourceVal}
              label="Source Values"
              tooltip={`Total non-null rows in ${pipeline.table_fqn}.${pipeline.column_name} — includes duplicate occurrences, not just unique values.`}
              bg="var(--page-bg)"
              border="var(--border)"
            />
            <StatCard
              value={stdVal}
              label="Standardized"
              tooltip={`Source rows whose value has a confirmed canonical mapping — counts every row, not just distinct values. Standardized + Unstandardized = Source Values.`}
              bg="var(--accent-tint)"
              border="var(--accent-border)"
              valueColor="var(--text-primary)"
            />
            <StatCard
              value={unstdVal}
              label="Unstandardized"
              tooltip={`Source rows whose value has no confirmed mapping yet — i.e. Source Values minus Standardized. Includes values currently in the queue.`}
              bg={hasUnstd ? '#FFFBEB' : 'var(--page-bg)'}
              border={hasUnstd ? '#FDE68A' : 'var(--border)'}
              valueColor={hasUnstd ? '#92400E' : 'var(--text-muted)'}
            />
          </div>
        )}
      </div>

      {/* ── Milestones ────────────────────────────────────────────────── */}
      <div className="flex flex-col" style={{ gap: 1 }}>
        {milestones.map(({ Icon, label, value, highlight }) => (
          <div
            key={label}
            className="flex items-center justify-between py-2.5 px-1"
            style={{ borderBottom: '0.5px solid var(--border)' }}
          >
            <div className="flex items-center gap-2.5">
              <span style={{ color: highlight ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, display: 'flex' }}>
                <Icon />
              </span>
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
            </div>
            <span
              className="text-xs font-mono"
              style={{ color: highlight ? 'var(--accent)' : 'var(--text-primary)', fontWeight: highlight ? 500 : 400 }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: Mappings ─────────────────────────────────────────────────────────────

function MappingsTab({ pipeline }: { pipeline: Pipeline }) {
  const [mappings,  setMappings]  = useState<Mapping[]>([]);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [total,     setTotal]     = useState(0);
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const fetchMappings = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (q) params.set('search', q);
      const [mRes, qRes] = await Promise.all([
        fetch(`/api/pipelines/${pipeline.pipeline_id}/mappings?${params}`),
        fetch(`/api/pipelines/${pipeline.pipeline_id}/queue`),
      ]);
      const [mBody, qBody] = await Promise.all([mRes.json().catch(() => ({})), qRes.json().catch(() => ({}))]);
      if (!mRes.ok) throw new Error(mBody?.error ?? `HTTP ${mRes.status}`);
      setMappings(mBody.mappings ?? []);
      setTotal(mBody.total ?? 0);
      setQueueItems(qBody.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load mappings');
    } finally {
      setLoading(false);
    }
  }, [pipeline.pipeline_id]);

  useEffect(() => { fetchMappings(''); }, [fetchMappings]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => fetchMappings(search), 300);
    return () => clearTimeout(t);
  }, [search, fetchMappings]);

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
    a.download = `${pipeline.table_fqn}_${pipeline.column_name}_mappings.csv`; a.click();
  }

  const filteredQueue = search
    ? queueItems.filter(i => i.literal_value.toLowerCase().includes(search.toLowerCase()))
    : queueItems;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {total.toLocaleString()} confirmed · {queueItems.length} pending
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mappings.length > 0 && (
            <button
              onClick={exportCsv}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors flex items-center gap-1"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
              title="Export mappings as CSV"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 1v7M3 5.5L6 9l3-3.5M2 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export CSV
            </button>
          )}
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>
              <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search mappings…"
              className="text-xs rounded-button border-[0.5px] outline-none pl-7 pr-3 py-1.5 w-44"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      </div>

      {loading && <div className="flex justify-center py-8"><Spinner /></div>}
      {error   && <p className="text-xs py-4 text-center" style={{ color: 'var(--confidence-low)' }}>{error}</p>}

      {!loading && !error && mappings.length === 0 && queueItems.length === 0 && (
        <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {search ? 'No mappings match your search.' : 'No confirmed mappings yet.'}
        </p>
      )}

      {!loading && !error && (mappings.length > 0 || filteredQueue.length > 0) && (
        <div
          className="rounded-card border-[0.5px] overflow-hidden"
          style={{ borderColor: 'var(--border)' }}
        >
          {/* Header */}
          <div
            className="grid text-[11px] font-medium px-3 py-2"
            style={{
              gridTemplateColumns: '1fr 1fr auto',
              backgroundColor: 'var(--accent-tint)',
              color: 'var(--text-secondary)',
              borderBottom: '0.5px solid var(--border)',
              gap: 8,
            }}
          >
            <span>Raw value</span>
            <span>Canonical name</span>
            <span>Status</span>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {/* Pending queue items — shown at the top */}
            {filteredQueue.map((qi, i) => (
              <div
                key={`q-${qi.literal_value}`}
                className="grid px-3 py-2 text-xs items-center"
                style={{
                  gridTemplateColumns: '1fr 1fr auto',
                  borderTop: i > 0 ? '0.5px solid var(--border)' : undefined,
                  backgroundColor: '#FFFBEB',
                  gap: 8,
                }}
              >
                <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={qi.literal_value}>{qi.literal_value}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>pending standardization</span>
                <span
                  className="text-[11px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap"
                  style={{ backgroundColor: '#FEF9C3', color: '#A16207' }}
                >
                  In queue
                </span>
              </div>
            ))}
            {/* Confirmed mappings */}
            {mappings.map((m, i) => (
              <div
                key={`m-${m.literal_value}`}
                className="grid px-3 py-2 text-xs items-center"
                style={{
                  gridTemplateColumns: '1fr 1fr auto',
                  borderTop: (i > 0 || filteredQueue.length > 0) ? '0.5px solid var(--border)' : undefined,
                  backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent',
                  gap: 8,
                }}
              >
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

// ── Tab: Queue ────────────────────────────────────────────────────────────────

function QueueTab({ pipeline }: { pipeline: Pipeline }) {
  const [items,   setItems]   = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`/api/pipelines/${pipeline.pipeline_id}/queue`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setItems(body.items ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load queue');
      } finally {
        setLoading(false);
      }
    })();
  }, [pipeline.pipeline_id]);

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        Values detected by polling that are waiting to be standardized.
      </p>

      {loading && <div className="flex justify-center py-8"><Spinner /></div>}
      {error   && <p className="text-xs py-4 text-center" style={{ color: 'var(--confidence-low)' }}>{error}</p>}

      {!loading && !error && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ opacity: 0.25 }}>
            <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
            <path d="M10 16l4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Queue is empty</p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>All detected values have been standardized.</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <div
            className="grid text-[11px] font-medium px-3 py-2"
            style={{ gridTemplateColumns: '1fr auto', backgroundColor: 'var(--accent-tint)', color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)' }}
          >
            <span>Value</span>
            <span>Waiting</span>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {items.map((item, i) => (
              <div
                key={item.literal_value}
                className="grid px-3 py-2 text-xs items-center"
                style={{ gridTemplateColumns: '1fr auto', borderTop: i > 0 ? '0.5px solid var(--border)' : undefined, backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent' }}
              >
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

// ── Tab: Settings ─────────────────────────────────────────────────────────────

interface SettingsTabProps {
  pipeline:      Pipeline;
  onUpdate:      (updated: Partial<Pipeline>) => void;
  onDelete:      () => void;
}

function SettingsTab({ pipeline, onUpdate, onDelete }: SettingsTabProps) {
  const [name,            setName]            = useState(pipeline.name ?? '');
  const [mode,            setMode]            = useState<'auto' | 'manual'>(pipeline.mode as 'auto' | 'manual');
  const [exportTableFqn,  setExportTableFqn]  = useState(pipeline.export_table_fqn ?? '');
  const [saving,          setSaving]          = useState(false);
  const [saved,           setSaved]           = useState(false);
  const [refreshing,      setRefreshing]      = useState(false);
  const [refreshResult,   setRefreshResult]   = useState<{ ok: boolean; rows?: number; error?: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    try {
      const exportVal = exportTableFqn.trim() || null;
      await fetch(`/api/pipelines/${pipeline.pipeline_id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name || null, mode, export_table_fqn: exportVal }),
      });
      onUpdate({ name: name || null, mode, export_table_fqn: exportVal });
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
      const res  = await fetch(`/api/pipelines/${pipeline.pipeline_id}/refresh-export`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefreshResult({ ok: false, error: body?.error ?? `HTTP ${res.status}` });
      } else {
        setRefreshResult({ ok: true, rows: body.rows_written });
        setTimeout(() => setRefreshResult(null), 6000);
      }
    } catch (e) {
      setRefreshResult({ ok: false, error: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setRefreshing(false);
    }
  }

  const tableShort = (() => {
    const parts = pipeline.table_fqn.split('.');
    return parts[parts.length - 1] ?? pipeline.table_fqn;
  })();

  return (
    <div className="flex flex-col gap-5">
      {/* Source (read-only) */}
      <div>
        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Source</p>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Table</span>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{tableShort}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Column</span>
            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{pipeline.column_name}</span>
          </div>
          {pipeline.domain_name && (
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--text-muted)' }}>Domain</span>
              <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{pipeline.domain_name}</span>
            </div>
          )}
          {pipeline.export_table_fqn && (
            <div className="flex justify-between text-xs gap-4">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Export table</span>
              <span
                className="font-mono truncate text-right"
                style={{ color: 'var(--text-primary)' }}
                title={pipeline.export_table_fqn}
              >
                {pipeline.export_table_fqn}
              </span>
            </div>
          )}
        </div>
      </div>

      <div style={{ borderTop: '0.5px solid var(--border)' }} />

      {/* Editable fields */}
      <div>
        <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Configuration</p>
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={`${tableShort}.${pipeline.column_name}`}
              className="w-full text-xs px-3 py-2 rounded-button border-[0.5px] outline-none"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>Leave blank to auto-generate from table.column</p>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Mode</label>
            <div className="flex gap-2">
              {(['auto', 'manual'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className="flex-1 py-1.5 text-xs font-medium rounded-button border-[0.5px] transition-colors"
                  style={{
                    borderColor:     mode === m ? 'var(--accent)' : 'var(--border)',
                    backgroundColor: mode === m ? 'var(--accent-tint)' : 'transparent',
                    color:           mode === m ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {m === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>
              {mode === 'auto' ? 'New values are standardized and exported automatically.' : 'New values queue up for manual review before export.'}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
              Export table
            </label>
            <input
              type="text"
              value={exportTableFqn}
              onChange={e => setExportTableFqn(e.target.value)}
              placeholder="DB.SCHEMA.TABLE_STANDARDIZED"
              className="w-full text-xs px-3 py-2 rounded-button border-[0.5px] outline-none font-mono"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-hint)' }}>
              Snowflake table that mirrors the source table with standardized values.
              Only rows with confirmed mappings are included; rebuilt on every standardization pass.
            </p>

            {/* Manual refresh */}
            {(pipeline.export_table_fqn || exportTableFqn.trim()) && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={handleRefreshExport}
                  disabled={refreshing}
                  className="text-[11px] font-medium px-2.5 py-1.5 rounded-button border-[0.5px] transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
                  onMouseEnter={e => { if (!refreshing) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
                >
                  {refreshing ? (
                    <>
                      <Spinner className="w-3 h-3" />
                      Rebuilding…
                    </>
                  ) : (
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
                  <p
                    className="text-[11px] mt-1.5"
                    style={{ color: refreshResult.ok ? '#15803D' : 'var(--confidence-low)' }}
                  >
                    {refreshResult.ok
                      ? `✓ Done — ${refreshResult.rows?.toLocaleString() ?? 0} row(s) written`
                      : `✗ ${refreshResult.error}`}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="mt-3 w-full py-1.5 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50"
          style={{ backgroundColor: saved ? '#16a34a' : 'var(--accent)' }}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
        </button>
      </div>

      <div style={{ borderTop: '0.5px solid var(--border)' }} />

      {/* Danger zone */}
      <div>
        <p className="text-xs font-medium mb-3" style={{ color: '#DC2626' }}>Danger zone</p>
        <button
          onClick={onDelete}
          className="w-full py-1.5 text-xs font-medium rounded-button border-[0.5px] transition-colors"
          style={{ borderColor: '#FECACA', color: '#DC2626', backgroundColor: '#FEF2F2' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEE2E2'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEF2F2'; }}
        >
          Delete pipeline
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
  pipeline:    Pipeline;
  initialTab?: DetailTab;
  onUpdate:    (updated: Partial<Pipeline>) => void;
  onDelete:    () => void;
}

export default function PipelineDetail({ pipeline, initialTab = 'activity', onUpdate, onDelete }: Props) {
  const [tab, setTab] = useState<DetailTab>(initialTab);

  // Sync when the parent changes the tab (e.g. clicking "Mapping" button on the row)
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const TABS: { id: DetailTab; label: string }[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'mappings', label: `Mappings` },
    { id: 'queue',    label: `Queue${pipeline.queue_size > 0 ? ` (${pipeline.queue_size})` : ''}` },
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
              style={{
                color:        tab === id ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
                marginBottom: '-0.5px',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: '16px 0 20px' }}>
          {tab === 'activity' && <ActivityTab pipeline={pipeline} />}
          {tab === 'mappings' && <MappingsTab pipeline={pipeline} />}
          {tab === 'queue'    && <QueueTab    pipeline={pipeline} />}
          {tab === 'settings' && <SettingsTab pipeline={pipeline} onUpdate={onUpdate} onDelete={onDelete} />}
        </div>
      </div>
    </div>
  );
}
