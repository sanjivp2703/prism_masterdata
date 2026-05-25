'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import PipelineDetail from './PipelineDetail';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PipelineStatus = 'active' | 'paused' | 'pending_baseline';

export interface Pipeline {
  pipeline_id:         number;
  name:                string | null;
  table_fqn:           string;
  column_name:         string;
  export_table_fqn:    string | null;
  domain_id:           number | null;
  domain_name:         string | null;
  status:              PipelineStatus;
  mode:                string;
  queue_size:          number;
  total_new_values:    number;
  total_mapped:        number;
  last_polled_at:      string | null;
  last_queue_empty_at: string | null;
  created_at:          string | null;
  updated_at:          string | null;
}

interface Props {
  onActivate:          (p: Pipeline) => void;
  activePipelineId:    number | null;
  defaultExpandedId?:  number | null;
  defaultExpandedTab?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function displayName(p: Pipeline): string {
  if (p.name) return p.name;
  const parts = p.table_fqn.split('.');
  const table = parts[parts.length - 1] ?? p.table_fqn;
  return `${table}.${p.column_name}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function PulseDot({ color }: { color: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', backgroundColor: color, opacity: 0.4, animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite' }} />
      <span style={{ borderRadius: '50%', width: 8, height: 8, backgroundColor: color, display: 'block' }} />
    </span>
  );
}

function StatusPill({ status }: { status: PipelineStatus }) {
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}>
      <PulseDot color="#16a34a" /> Live
    </span>
  );
  if (status === 'pending_baseline') return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: '#FEF9C3', color: '#92400E' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: '#D97706', flexShrink: 0, display: 'inline-block' }} />
      Setting up
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: 'var(--text-muted)', flexShrink: 0, display: 'inline-block' }} />
      Paused
    </span>
  );
}

// ── Pipeline row ──────────────────────────────────────────────────────────────

interface RowProps {
  pipeline:        Pipeline;
  isExpanded:      boolean;
  expandedTab:     string | null;
  onToggle:        () => void;
  onActivate:      (p: Pipeline) => void;
  onStandardize:   (p: Pipeline) => void;
  onPause:         (p: Pipeline) => void;
  onDelete:        (p: Pipeline) => void;
  onUpdate:        (p: Pipeline, patch: Partial<Pipeline>) => void;
  actionLoading:   number | null;
  standardizing:   number | null;
}

function PipelineRow({
  pipeline: p, isExpanded, expandedTab, onToggle,
  onActivate, onStandardize, onPause, onDelete, onUpdate,
  actionLoading, standardizing,
}: RowProps) {
  const busy    = actionLoading === p.pipeline_id;
  const running = standardizing === p.pipeline_id;

  // "Last standardized" = last_queue_empty_at ?? created_at
  const lastStd = p.last_queue_empty_at ?? p.created_at;

  return (
    <div style={{ borderBottom: '0.5px solid var(--border)' }}>
      {/* ── Main row ────────────────────────────────────────────────────── */}
      <div
        className="grid items-center cursor-pointer"
        style={{
          gridTemplateColumns: '20px minmax(160px,2fr) 120px 100px 130px 110px 72px auto',
          padding: '11px 16px',
          gap: 14,
          transition: 'background-color 0.1s',
          backgroundColor: isExpanded ? 'var(--page-bg)' : undefined,
        }}
        onClick={onToggle}
        onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--page-bg)'; }}
        onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
      >
        {/* Expand chevron */}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}
        >
          <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* Name */}
        <div className="min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {displayName(p)}
          </p>
          <p className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--text-muted)' }} title={p.table_fqn}>
            {p.table_fqn}
          </p>
        </div>

        {/* Domain */}
        <div>
          {p.domain_name ? (
            <span
              className="text-[11px] font-medium rounded-full px-2 py-0.5"
              style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}
            >
              {p.domain_name}
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </div>

        {/* Status */}
        <StatusPill status={p.status} />

        {/* Last standardized */}
        <div>
          <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{relativeTime(lastStd)}</p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>standardized</p>
        </div>

        {/* Queue + Mapped */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <span
              className="text-[11px] font-medium tabular-nums"
              style={{ color: p.queue_size > 0 ? '#B45309' : 'var(--text-muted)' }}
            >
              {p.queue_size}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>in queue</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-medium tabular-nums" style={{ color: p.total_mapped > 0 ? '#15803D' : 'var(--text-muted)' }}>
              {p.total_mapped.toLocaleString()}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>standardized</span>
          </div>
        </div>

        {/* Mode */}
        <div>
          <span
            className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded"
            style={{
              backgroundColor: p.mode === 'auto' ? '#F5F3FF' : 'var(--page-bg)',
              color:           p.mode === 'auto' ? '#7C3AED' : 'var(--text-muted)',
              border:          `0.5px solid ${p.mode === 'auto' ? '#DDD6FE' : 'var(--border)'}`,
            }}
          >
            {p.mode}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 justify-end" onClick={e => e.stopPropagation()}>
          {/* Standardize — only when queue > 0 (bulk-processes queue through LLM immediately) */}
          {p.queue_size > 0 && p.status !== 'pending_baseline' && (
            <button
              onClick={() => onStandardize(p)}
              disabled={busy || running}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--accent)', color: running ? 'white' : 'var(--accent)', backgroundColor: running ? 'var(--accent)' : 'var(--accent-tint)' }}
              onMouseEnter={e => { if (!busy && !running) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'white'; } }}
              onMouseLeave={e => { if (!running) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-tint)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
            >
              {running && <Spinner className="w-3 h-3" />}
              {running ? 'Processing…' : 'Standardize'}
            </button>
          )}

          {/* Pause — shown for any active pipeline */}
          {p.status === 'active' && (
            <button
              onClick={() => onPause(p)}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
            >
              Pause
            </button>
          )}

          {/* Delete */}
          <button
            onClick={() => onDelete(p)}
            className="w-7 h-7 flex items-center justify-center rounded-button border-[0.5px] transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#FCA5A5'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
            title="Delete pipeline"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M2 3.5h9M5 3.5V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1M5.5 6v3.5M7.5 6v3.5M3 3.5l.5 7a.5.5 0 00.5.5h5a.5.5 0 00.5-.5l.5-7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Expanded detail ──────────────────────────────────────────────── */}
      {isExpanded && (
        <PipelineDetail
          pipeline={p}
          initialTab={expandedTab as any ?? 'activity'}
          onUpdate={patch => onUpdate(p, patch)}
          onDelete={() => onDelete(p)}
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PipelinesView({ onActivate, activePipelineId, defaultExpandedId, defaultExpandedTab }: Props) {
  const router = useRouter();
  const [pipelines,     setPipelines]     = useState<Pipeline[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [actionLoading,  setActionLoading]  = useState<number | null>(null);
  const [standardizing,  setStandardizing]  = useState<number | null>(null);
  const [expandedId,     setExpandedId]     = useState<number | null>(null);
  const [expandedTab,   setExpandedTab]   = useState<string | null>(null);
  const [search,        setSearch]        = useState('');
  // Track whether we've already applied the defaultExpandedId to avoid re-expanding on re-renders
  const [autoExpanded,  setAutoExpanded]  = useState(false);

  const fetchPipelines = useCallback(async () => {
    try {
      const res  = await fetch('/api/pipelines');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setPipelines(body.pipelines ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPipelines(); }, [fetchPipelines]);

  // Auto-refresh every 30 s so pipeline stats stay current without any browser polling
  useEffect(() => {
    const interval = setInterval(fetchPipelines, 30_000);
    return () => clearInterval(interval);
  }, [fetchPipelines]);

  // Auto-expand the specified pipeline once it has loaded (e.g. after Begin Standardization)
  useEffect(() => {
    if (autoExpanded || !defaultExpandedId || pipelines.length === 0) return;
    const exists = pipelines.some(p => p.pipeline_id === defaultExpandedId);
    if (!exists) return;
    setExpandedId(defaultExpandedId);
    setExpandedTab(defaultExpandedTab ?? 'activity');
    setAutoExpanded(true);
  }, [defaultExpandedId, defaultExpandedTab, pipelines, autoExpanded]);

  async function handlePause(p: Pipeline) {
    setActionLoading(p.pipeline_id);
    try {
      await fetch(`/api/pipelines/${p.pipeline_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) });
      setPipelines(prev => prev.map(x => x.pipeline_id === p.pipeline_id ? { ...x, status: 'paused' } : x));
    } finally { setActionLoading(null); }
  }

  async function handleDelete(p: Pipeline) {
    if (!confirm(`Delete "${displayName(p)}"? This cannot be undone.`)) return;
    setActionLoading(p.pipeline_id);
    try {
      await fetch(`/api/pipelines/${p.pipeline_id}`, { method: 'DELETE' });
      setPipelines(prev => prev.filter(x => x.pipeline_id !== p.pipeline_id));
      if (expandedId === p.pipeline_id) setExpandedId(null);
    } finally { setActionLoading(null); }
  }

  function handleUpdate(p: Pipeline, patch: Partial<Pipeline>) {
    setPipelines(prev => prev.map(x => x.pipeline_id === p.pipeline_id ? { ...x, ...patch } : x));
  }

  async function handleStandardize(p: Pipeline) {
    setStandardizing(p.pipeline_id);
    try {
      const res  = await fetch(`/api/pipelines/${p.pipeline_id}/process-queue`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`[Standardize] Pipeline ${p.pipeline_id} failed:`, body?.error);
      }
      // Refresh pipeline stats so queue_size / total_mapped update immediately
      await fetchPipelines();
    } finally {
      setStandardizing(null);
    }
  }

  function handleToggle(p: Pipeline) {
    if (expandedId === p.pipeline_id) {
      setExpandedId(null);
      setExpandedTab(null);
    } else {
      setExpandedId(p.pipeline_id);
      setExpandedTab('activity');
    }
  }

  function handleOpenMappings(p: Pipeline) {
    setExpandedId(p.pipeline_id);
    setExpandedTab('mappings');
  }

  // Filter by search
  const filtered = pipelines.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      displayName(p).toLowerCase().includes(q) ||
      p.table_fqn.toLowerCase().includes(q) ||
      (p.domain_name ?? '').toLowerCase().includes(q) ||
      p.column_name.toLowerCase().includes(q)
    );
  });

  // Group by domain (sort: live first → active → pending → paused, then by last_polled_at)
  const domainMap = new Map<string, { name: string | null; domainId: number | null; pipelines: Pipeline[] }>();
  for (const p of filtered) {
    const key = p.domain_id != null ? String(p.domain_id) : '__none__';
    if (!domainMap.has(key)) domainMap.set(key, { name: p.domain_name, domainId: p.domain_id, pipelines: [] });
    domainMap.get(key)!.pipelines.push(p);
  }
  const statusOrder: Record<string, number> = { active: 2, pending_baseline: 1, paused: 0 };
  for (const g of domainMap.values()) {
    g.pipelines.sort((a, b) => {
      if (a.pipeline_id === activePipelineId) return -1;
      if (b.pipeline_id === activePipelineId) return 1;
      const sd = (statusOrder[b.status] ?? 0) - (statusOrder[a.status] ?? 0);
      if (sd !== 0) return sd;
      return (b.last_polled_at ? new Date(b.last_polled_at).getTime() : 0) -
             (a.last_polled_at ? new Date(a.last_polled_at).getTime() : 0);
    });
  }
  const sortedGroups = [...domainMap.entries()].sort(([, ga], [, gb]) => {
    const aLive = ga.pipelines.some(p => p.pipeline_id === activePipelineId) ? 1 : 0;
    const bLive = gb.pipelines.some(p => p.pipeline_id === activePipelineId) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    if (ga.name === null) return 1;
    if (gb.name === null) return -1;
    return (ga.name ?? '').localeCompare(gb.name ?? '');
  });

  const liveCount   = pipelines.filter(p => p.status === 'active').length;
  const pausedCount = pipelines.filter(p => p.status === 'paused').length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      <style>{`@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>

      {/* Toolbar: stats + search */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {liveCount > 0 && <><span style={{ color: '#15803D', fontWeight: 500 }}>{liveCount} live</span></>}
          {liveCount > 0 && pausedCount > 0 && <span> · </span>}
          {pausedCount > 0 && <><span style={{ color: 'var(--text-muted)' }}>{pausedCount} paused</span></>}
          {pipelines.length === 0 && <span>No pipelines configured</span>}
        </p>
        {pipelines.length > 0 && (
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}>
              <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, table, domain…"
              className="text-xs rounded-button border-[0.5px] outline-none pl-7 pr-3 py-1.5 w-60"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16">
          <Spinner className="w-5 h-5" />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading pipelines…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-card border-[0.5px] px-4 py-3 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: '#DC2626' }}>
          {error}
        </div>
      )}

      {!loading && !error && pipelines.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ opacity: 0.2 }}>
            <rect x="4" y="12" width="40" height="26" rx="5" stroke="currentColor" strokeWidth="2.5" />
            <path d="M16 24h16M16 30h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="38" cy="12" r="6" fill="currentColor" />
          </svg>
          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No pipelines yet</p>
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 240 }}>
            Use the Connect tab to set up your first Snowflake pipeline.
          </p>
        </div>
      )}

      {/* Pipeline table — one binder-tab card per domain */}
      {!loading && !error && sortedGroups.length > 0 && (
        <div className="flex flex-col" style={{ gap: 20 }}>

          {/* Sticky column header — aligns with the grid inside each card */}
          <div
            className="grid text-[10px] font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '20px minmax(160px,2fr) 120px 100px 130px 110px 72px auto',
              padding: '0 16px',
              gap: 14,
              color: 'var(--text-muted)',
            }}
          >
            <span />
            <span>Pipeline</span>
            <span>Domain</span>
            <span>Status</span>
            <span>Standardized</span>
            <span>Queue / Mapped</span>
            <span>Mode</span>
            <span className="text-right">Actions</span>
          </div>

          {sortedGroups.map(([key, group]) => (
            <div key={key}>
              {/* ── Binder tab ──────────────────────────────────────── */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 1 }}>
                <div
                  className="inline-flex items-center gap-2.5"
                  style={{
                    padding: '5px 14px',
                    borderTop:    '0.5px solid var(--border)',
                    borderLeft:   '0.5px solid var(--border)',
                    borderRight:  '0.5px solid var(--border)',
                    borderBottom: '0.5px solid var(--surface)',
                    borderRadius: '7px 7px 0 0',
                    backgroundColor: 'var(--surface)',
                    marginBottom: -1,
                  }}
                >
                  <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {group.name ?? 'No domain'}
                  </span>
                  <span
                    className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'var(--border)', color: 'var(--text-muted)' }}
                  >
                    {group.pipelines.length}
                  </span>
                  {group.domainId != null && (
                    <>
                      <span style={{ width: 1, height: 14, backgroundColor: 'var(--border)', display: 'inline-block', flexShrink: 0 }} />
                      <button
                        onClick={() => router.push(`/global-standardizations?domain_id=${group.domainId}`)}
                        className="text-[11px] font-medium transition-colors flex items-center gap-1"
                        style={{ color: 'var(--text-muted)', backgroundColor: 'transparent', border: 'none', padding: 0 }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M2 3h8M2 6h6M2 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                        </svg>
                        View Mappings
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* ── Pipeline card ────────────────────────────────────── */}
              <div
                style={{
                  border: '0.5px solid var(--border)',
                  borderRadius: '0 7px 7px 7px',
                  overflow: 'hidden',
                  backgroundColor: 'var(--surface)',
                  position: 'relative',
                  zIndex: 0,
                }}
              >
                {group.pipelines.map(p => (
                  <PipelineRow
                    key={p.pipeline_id}
                    pipeline={p}
                    isExpanded={expandedId === p.pipeline_id}
                    expandedTab={expandedId === p.pipeline_id ? expandedTab : null}
                    onToggle={() => handleToggle(p)}
                    onActivate={onActivate}
                    onStandardize={handleStandardize}
                    onPause={handlePause}
                    onDelete={handleDelete}
                    onUpdate={handleUpdate}
                    actionLoading={actionLoading}
                    standardizing={standardizing}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
