'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { SpecInfoIcon, type Pipeline, type PipelineGroup } from './PipelinesView';
import UpdateScheduleEditor from '@/app/components/UpdateScheduleEditor';
import ExportLookupModal from '@/app/components/ExportLookupModal';
import { showToast } from '@/app/components/Toast';
import { isScheduleActiveNow, scheduleLabel, type UpdateSchedule } from '@/app/api/_lib/update-schedule';
import type { ColumnSpec } from '@/app/components/spec-types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Mapping {
  match_id:      number;
  alias_id:      number;
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

// The standardization tick fires on every wall-clock 10-minute mark
// (:00, :10, :20, …) — matches startQueueProcessor in
// pipeline-hourly-processor.ts. Returns null when there's no automatic tick
// to promise a time for: manual-only schedules, or a window schedule that's
// currently closed (the note falls back to explaining why instead).
function nextTickLabel(schedule: UpdateSchedule): string | null {
  if (schedule.type === 'manual') return null;
  const now = new Date();
  if (schedule.type === 'window' && !isScheduleActiveNow(schedule, now)) return null;
  const TICK_MS = 10 * 60_000;
  const next = new Date((Math.floor(now.getTime() / TICK_MS) + 1) * TICK_MS);
  return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

// Inline SVG icons for the timeline (replaces emojis)

// ── Tab: Activity ─────────────────────────────────────────────────────────────

function ActivityTab({ group, isStandardizing = false, specsById }: { group: PipelineGroup; isStandardizing?: boolean; specsById: Map<number, ColumnSpec> }) {
  const isLive = group.status === 'active';

  // Detection-mode hint (SQL Server warehouses only — Snowflake 'stream' and
  // file pipelines show nothing). 'diff' carries the upgrade nudge.
  const detectionHint = (() => {
    const first = group.columns[0] as (typeof group.columns)[number] & { detection_mode?: string | null; detection_reason?: string | null };
    if (first?.detection_mode === 'ct') {
      return { label: 'Change Tracking', tooltip: 'New values are detected through SQL Server Change Tracking — the fastest detection.' };
    }
    if (first?.detection_mode === 'diff') {
      const reason = first.detection_reason;
      // Each cause needs its OWN fix. 'ct_no_grant' used to be reported as
      // 'ct_disabled', so this tooltip told the customer to enable Change
      // Tracking that was ALREADY enabled, and never named the one statement
      // that would actually fix it — making the misconfiguration effectively
      // undiscoverable (INS-M09).
      const tooltip =
        reason === 'pg_diff'
          ? 'New values are found by periodically scanning the column, with a free write-activity check each minute so an unchanged table is never read. This is how detection works on PostgreSQL.'
        : reason === 'mysql_diff'
          ? 'New values are found by periodically scanning the column, with a free last-write check each minute so an unchanged table is never read. This is how detection works on MySQL.'
        : reason === 'no_pk'
          ? 'New values are found by periodically scanning the column — the table has no primary key, which Change Tracking requires. Adding one enables the fastest detection.'
        : reason === 'ct_no_grant'
          ? 'Change Tracking is already enabled on this table, but Prism has not been given permission to read it. Ask your database admin to run: GRANT VIEW CHANGE TRACKING ON <schema>.<table> TO <the Prism login>; — then this switches to the fastest detection automatically.'
        : reason === 'ct_error'
          ? 'New values are found by periodically scanning the column — Change Tracking could not be read on this table. Ask your database admin to check it is enabled and that Prism can read it.'
          : 'New values are found by periodically scanning the column. Ask your database admin to enable Change Tracking on the database and this table for the fastest detection.';
      return { label: 'Scheduled scan', tooltip };
    }
    return null;
  })();


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

  // Explains the pending count instead of just showing a number — when the
  // next automatic tick will pick these up, or why there isn't one right now.
  const standardizeNote = !hasUnstd ? null
    : !isLive ? 'Paused — resume this pipeline or run Update Standardizations to process these values.'
    : (() => {
        const label = nextTickLabel(group.update_schedule);
        if (label) return `Will be standardized automatically at ${label}.`;
        if (group.update_schedule.type === 'manual') return 'Will be standardized the next time you run Update Standardizations.';
        return `Outside the update window (${scheduleLabel(group.update_schedule)}) — will be standardized once it reopens, or run Update Standardizations now.`;
      })();

  return (
    <div>
      {/* ── Top row: live status + last updated ───────────────────────── */}
      {/* "Last updated" is THE freshness timestamp: the last time the
          standardized table was verified fully up to date — the source was
          checked and everything found was already standardized and exported
          (advances on empty-check polls, 10-minute ticks, and manual "Update
          Standardizations" passes; freezes while values wait in the queue). */}
      <div className="mb-4 pb-4 flex items-center justify-between gap-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="min-w-0">
          {/* Standardizing is shown for a PAUSED pipeline too.
              The gate used to be `isLive` alone, so the amber "Standardizing
              data" block never rendered while paused — even though the UI
              actively routes users there: the "Update Standardizations"
              dropdown is offered for any non-pending_baseline status, paused
              included, and that trigger really does run a pass. So the one
              moment a paused pipeline IS doing work was the one moment the card
              showed nothing (TICK-11). `isLive` still gates the steady-state
              "Live · watching" line, which genuinely only applies when active. */}
          {(isLive || isStandardizing) && (isStandardizing ? (
            <>
              <div className="flex items-center gap-1.5 mb-0.5">
                <PulseDot color="#D97706" />
                <span className="text-xs font-medium" style={{ color: '#92400E' }}>Standardizing data</span>
              </div>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>New values are being standardized and exported</p>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <PulseDot color="#16a34a" />
              <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Live</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>· watching for new values</span>
              {detectionHint && (
                <span className="text-xs" style={{ color: 'var(--text-hint)' }} title={detectionHint.tooltip}>· {detectionHint.label}</span>
              )}
            </div>
          ))}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Standardized table last updated</p>
          <p
            className="text-xs font-mono"
            style={{ color: 'var(--accent)', fontWeight: 500 }}
            title="The last time the standardized table was verified fully up to date — the source was checked and every value was standardized and in the export"
          >
            {group.fully_synced_at ? fmtDate(group.fully_synced_at) : 'Not yet'}
          </p>
        </div>
      </div>

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
        {standardizeNote && (
          <p className="text-[11px] mt-2" style={{ color: '#92400E' }}>{standardizeNote}</p>
        )}
      </div>

      {/* ── Per-column breakdown — every card, incl. single-column. The ⓘ next
             to the domain shows its standardization rules + naming convention
             on hover or click. ───────────────────────────────────────────── */}
      <div className="mb-5 pb-5" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Columns</p>
        <div className="rounded-button border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}>
          {/* Header row */}
          <div
            className="grid text-[10px] font-semibold uppercase tracking-wide px-3 py-2"
            style={{ gridTemplateColumns: '1fr 150px 130px', gap: 8, color: 'var(--text-muted)', borderBottom: '0.5px solid var(--accent-border)', backgroundColor: 'var(--surface)' }}
          >
            <span>Column</span>
            <span>Spec</span>
            <span className="text-right">Standardized</span>
          </div>
          {group.columns.map((c, i) => {
            const cUnstd = Math.max(0, (c.total_source_values || 0) - (c.total_mapped || 0));
            return (
              <div
                key={`${c.pipeline_id}_${c.column_name}`}
                className="grid items-center px-3 py-2.5"
                style={{ gridTemplateColumns: '1fr 150px 130px', gap: 8, borderTop: i > 0 ? '0.5px solid var(--accent-border)' : undefined }}
              >
                <span className="text-xs font-medium font-mono truncate" style={{ color: 'var(--text-primary)' }}>{c.column_name}</span>
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  {(() => {
                    const spec = c.domain_id != null ? (specsById.get(c.domain_id) ?? null) : null;
                    if (!spec) return <span className="text-[10px]" style={{ color: 'var(--text-hint)' }}>—</span>;
                    return (
                      <>
                        <span className="text-[10px] truncate" style={{ color: 'var(--accent)' }} title={spec.description}>
                          {spec.description || 'Details'}
                        </span>
                        <SpecInfoIcon spec={spec} />
                      </>
                    );
                  })()}
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
  const [showExport, setShowExport] = useState(false);

  // ── Inline editing ──────────────────────────────────────────────────────
  const [editingMatchId, setEditingMatchId] = useState<number | null>(null);
  const [editText,       setEditText]       = useState('');
  const [savingMatchId,  setSavingMatchId]  = useState<number | null>(null);
  // Set only when the edited alias is shared by other literals too — the
  // choice between reassigning just this value vs renaming everywhere is
  // only meaningful (and only shown) in that case.
  const [pendingChoice, setPendingChoice] = useState<{ matchId: number; newName: string; sharedCount: number } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, qRes] = await Promise.all([
        fetch(`/api/pipelines/${pipeline.pipeline_id}/mappings?limit=500`),
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchAll();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.pipeline_id]);

  const q = search.trim().toLowerCase();
  const filteredMappings = q
    ? mappings.filter(m => m.literal_value.toLowerCase().includes(q) || m.alias_name.toLowerCase().includes(q))
    : mappings;
  const filteredQueue = q
    ? queueItems.filter(i => i.literal_value.toLowerCase().includes(q))
    : queueItems;

  function startEdit(m: Mapping) {
    if (savingMatchId != null) return;
    setEditingMatchId(m.match_id);
    setEditText(m.alias_name);
  }

  function cancelEdit() {
    setEditingMatchId(null);
    setEditText('');
  }

  async function submitEdit(matchId: number, newName: string, scope: 'this_value' | 'all_shared') {
    setPendingChoice(null);
    setEditingMatchId(null);
    setSavingMatchId(matchId);
    showToast('Saving — rebuilding the standardized export…', 'info');
    try {
      const res  = await fetch(`/api/pipelines/${pipeline.pipeline_id}/mappings`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ match_id: matchId, new_alias_name: newName, scope }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      await fetchAll();
      showToast(body.rebuilt ? 'Mapping updated — export rebuilt.' : 'Mapping updated.', 'info');
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't update the mapping — check your connection.", 'error');
    } finally {
      setSavingMatchId(null);
    }
  }

  function attemptSubmitEdit(m: Mapping) {
    // Guards against a stale re-fire: submitting on Enter clears editingMatchId,
    // which unmounts the input and can trigger a second call via its blur event.
    if (editingMatchId !== m.match_id) return;
    const newName = editText.trim();
    if (!newName || newName === m.alias_name) { cancelEdit(); return; }
    const sharedCount = mappings.filter(x => x.alias_id === m.alias_id).length;
    if (sharedCount > 1) {
      setPendingChoice({ matchId: m.match_id, newName, sharedCount });
    } else {
      submitEdit(m.match_id, newName, 'this_value');
    }
  }

  const exportButton = pipeline.domain_id != null ? (
    <button
      onClick={() => setShowExport(true)}
      className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors flex items-center gap-1 shrink-0"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
      title="Export this column's lookup table"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 1v7M3 5.5L6 9l3-3.5M2 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Export lookup table
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
      {/* Header row: column name + count on left, search + export on right */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          {showHeading && (
            <>
              <span className="text-xs font-semibold font-mono truncate" style={{ color: 'var(--text-primary)' }}>{pipeline.column_name}</span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{total.toLocaleString()} confirmed · {queueItems.length} pending</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {searchBox}
          {exportButton}
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
            {filteredMappings.map((m, i) => {
              const isEditing = editingMatchId === m.match_id;
              const isSaving  = savingMatchId === m.match_id;
              return (
                <div key={`m-${m.match_id}`} className="grid px-3 py-2 text-xs items-center"
                  style={{ gridTemplateColumns: '1fr 1fr auto', borderTop: (i > 0 || filteredQueue.length > 0) ? '0.5px solid var(--border)' : undefined, backgroundColor: i % 2 === 0 ? 'var(--surface)' : 'transparent', gap: 8 }}>
                  <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }} title={m.literal_value}>{m.literal_value}</span>
                  {isEditing ? (
                    <input
                      autoFocus
                      type="text"
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') attemptSubmitEdit(m);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      onBlur={() => attemptSubmitEdit(m)}
                      maxLength={200}
                      className="text-xs rounded-button border-[0.5px] outline-none px-2 py-1 w-full font-medium"
                      style={{ borderColor: 'var(--accent)', backgroundColor: 'var(--surface)', color: 'var(--accent)' }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(m)}
                      disabled={isSaving}
                      className="truncate font-medium text-left disabled:opacity-50"
                      style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: isSaving ? 'wait' : 'text' }}
                      title={`${m.alias_name} — click to edit`}
                    >
                      {isSaving ? <Spinner className="w-3 h-3" /> : m.alias_name}
                    </button>
                  )}
                  <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{relativeTime(m.confirmed_at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showExport && (
        <ExportLookupModal
          domainId={pipeline.domain_id ?? undefined}
          domainName={pipeline.column_name}
          onClose={() => setShowExport(false)}
        />
      )}

      {pendingChoice && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} onClick={() => setPendingChoice(null)}>
          <div
            className="rounded-card border-[0.5px] w-full max-w-sm mx-4 p-5"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Update shared canonical name</h3>
            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              {pendingChoice.sharedCount} values currently map to this same canonical name. Choose whether to change
              just this one value or rename it for all {pendingChoice.sharedCount}.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => submitEdit(pendingChoice.matchId, pendingChoice.newName, 'this_value')}
                className="text-xs font-medium px-3 py-2 rounded-button border-[0.5px] text-left transition-colors"
                style={{ borderColor: 'var(--border)', color: 'var(--text-primary)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
              >
                Just this value — move it to &ldquo;{pendingChoice.newName}&rdquo;, leave the other {pendingChoice.sharedCount - 1} unchanged
              </button>
              <button
                type="button"
                onClick={() => submitEdit(pendingChoice.matchId, pendingChoice.newName, 'all_shared')}
                className="text-xs font-medium px-3 py-2 rounded-button border-[0.5px] text-left transition-colors"
                style={{ borderColor: 'var(--border)', color: 'var(--text-primary)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
              >
                Rename for all {pendingChoice.sharedCount} values sharing it
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPendingChoice(null)}
              className="text-[11px] font-medium mt-3"
              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MappingsTab({ group }: { group: PipelineGroup }) {
  // One section per column (specs are per-column now — no domain grouping).
  type ColGroup = { key: string; columnName: string; columns: Pipeline[] };
  const colGroups: ColGroup[] = group.columns.map(col => ({
    key:        `${col.pipeline_id}:${col.column_name}`,
    columnName: col.column_name,
    columns:    [col],
  }));

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggleSpec(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div>

      <div className="rounded-card border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        {colGroups.map((dg, idx) => {
          const key = dg.key;
          const isOpen = expanded.has(key);
          const totalMapped = dg.columns.reduce((s, c) => s + c.total_mapped, 0);
          const totalQueue  = dg.columns.reduce((s, c) => s + c.queue_size, 0);
          return (
            <div key={key} style={{ borderTop: idx > 0 ? '0.5px solid var(--border)' : undefined }}>
              {/* Column header row */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                style={{ backgroundColor: isOpen ? 'var(--page-bg)' : 'var(--surface)' }}
                onClick={() => toggleSpec(key)}
                onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
              >
                <svg
                  width="11" height="11" viewBox="0 0 12 12" fill="none"
                  style={{ color: 'var(--text-muted)', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>

                <span className="text-sm font-semibold font-mono flex-1 text-left truncate" style={{ color: 'var(--text-primary)' }}>
                  {dg.columnName}
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
  onDeleteMember: (p: Pipeline) => void | Promise<void>;
  onDeleteGroup:  () => void;
}

function SettingsTab({ group, onUpdateMember, onDeleteMember, onDeleteGroup }: SettingsTabProps) {
  const [name,           setName]           = useState(group.name ?? '');
  const [updateSchedule, setUpdateSchedule] = useState<UpdateSchedule>(group.update_schedule);
  const [exportTableFqn, setExportTableFqn] = useState(group.export_table_fqn ?? '');
  const [saving,         setSaving]         = useState(false);
  const [saved,          setSaved]          = useState(false);
  const [refreshing,     setRefreshing]     = useState(false);
  const [refreshResult,  setRefreshResult]  = useState<{ ok: boolean; rows?: number; error?: string } | null>(null);
  const [deletingColKey, setDeletingColKey] = useState<string | null>(null);

  // Column-mode pipelines write onto the source table itself — there is no
  // separate destination to edit, and the PATCH must not touch export_table_fqn
  // (it is pinned to the source table).
  const isColumnKind = group.export_kind === 'column';
  // "Export unstandardized values" only shapes a table/view export's row set —
  // column mode has no row filtering (unmapped rows just carry a NULL
  // companion) and lookup-only has no export object at all.
  const hasUnmappedSetting = !isColumnKind && !!group.export_table_fqn;
  const [exportUnmapped, setExportUnmapped] = useState(group.export_unmapped_rows !== false);

  async function handleSave() {
    setSaving(true);
    try {
      const exportVal = exportTableFqn.trim() || null;
      const unmappedChanged = hasUnmappedSetting && exportUnmapped !== (group.export_unmapped_rows !== false);
      const patch = {
        name: name || null,
        update_schedule: updateSchedule,
        ...(isColumnKind ? {} : { export_table_fqn: exportVal }),
        ...(hasUnmappedSetting ? { export_unmapped_rows: exportUnmapped } : {}),
      };
      // Config applies to every column in the card.
      await Promise.all(group.columns.map(c =>
        fetch(`/api/pipelines/${c.pipeline_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => {})));
      for (const c of group.columns) onUpdateMember(c, patch);
      // The stored setting only shapes the next build — rebuild the shared
      // export once now (recreates the view for view pipelines) so the change
      // is live immediately. Fire-and-forget: a large table rebuild can take a
      // while and must not pin the Save button; SSE metrics refresh will land.
      if (unmappedChanged) {
        fetch(`/api/pipelines/${group.columns[0].pipeline_id}/refresh-export`, { method: 'POST' }).catch(() => {});
      }
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
          {group.export_kind === 'column' ? (
            <div className="flex justify-between text-xs gap-4">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Output</span>
              <span style={{ color: 'var(--text-primary)' }}>Standardized column(s) on the source table</span>
            </div>
          ) : group.export_table_fqn && (
            <div className="flex justify-between text-xs gap-4">
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{group.export_kind === 'view' ? 'Export view' : 'Export table'}</span>
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
              </div>
              <button
                disabled={deletingColKey != null}
                onClick={async () => {
                  if (!confirm(`Stop standardizing column "${c.column_name}"? This removes it from the pipeline.`)) return;
                  const key = `${c.pipeline_id}_${c.column_name}`;
                  setDeletingColKey(key);
                  try { await Promise.resolve(onDeleteMember(c)); }
                  finally { setDeletingColKey(null); }
                }}
                className="w-5 h-5 flex items-center justify-center rounded transition-colors flex-shrink-0 disabled:opacity-50"
                style={{ color: 'var(--text-muted)', backgroundColor: 'transparent', border: 'none' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                title="Remove this column"
              >
                {deletingColKey === `${c.pipeline_id}_${c.column_name}` ? (
                  <Spinner className="w-3 h-3" />
                ) : (
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                )}
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
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Update window</label>
            <UpdateScheduleEditor value={updateSchedule} onChange={setUpdateSchedule} disabled={saving} />
          </div>

          {hasUnmappedSetting && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-xs font-medium block" style={{ color: 'var(--text-primary)' }}>
                  Export unstandardized values
                </label>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                  {exportUnmapped
                    ? `Every source row appears in the export ${group.export_kind === 'view' ? 'view' : 'table'}; values without a confirmed standardization show their raw value until standardized.`
                    : `Only rows whose values have a confirmed standardization appear in the export ${group.export_kind === 'view' ? 'view' : 'table'}. Rows appear once their values are standardized.`}
                  {' '}Saving rebuilds the {group.export_kind === 'view' ? 'view' : 'export table'} with the new behavior.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={exportUnmapped}
                onClick={() => setExportUnmapped(v => !v)}
                disabled={saving}
                className="flex-shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50"
                style={{ backgroundColor: exportUnmapped ? 'var(--accent)' : '#D1D5DB' }}
              >
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
                  style={{ transform: exportUnmapped ? 'translateX(18px)' : 'translateX(3px)' }}
                />
              </button>
            </div>
          )}

          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
              {isColumnKind ? 'Standardized columns' : group.export_kind === 'view' ? 'Export view' : 'Export table'}
            </label>
            {!isColumnKind && (
              <input
                type="text" value={exportTableFqn} onChange={e => setExportTableFqn(e.target.value)}
                placeholder="DB.SCHEMA.TABLE_STANDARDIZED"
                className="w-full text-xs px-3 py-2 rounded-button border-[0.5px] outline-none font-mono"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
              />
            )}
            <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-hint)' }}>
              {isColumnKind
                ? `Standardized values are written to a companion column on the source table (e.g. ${group.columns[0]?.column_name ?? 'COLUMN'}_STANDARDIZED) — empty until the raw value is standardized. There is no separate destination to configure.`
                : group.export_kind === 'view'
                ? 'Shared destination view for every column in this pipeline. Created once — always reflects the live data, never rebuilt.'
                : 'Shared destination table for every column in this pipeline. Rebuilt on every standardization pass.'}
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
                      {isColumnKind ? 'Sync standardized columns now'
                        : group.export_kind === 'view' ? 'Recreate view now'
                        : 'Rebuild export table now'}
                    </>
                  )}
                </button>
                {refreshResult && (
                  <p className="text-[11px] mt-1.5" style={{ color: refreshResult.ok ? '#15803D' : 'var(--confidence-low)' }}>
                    {refreshResult.ok
                      ? group.export_kind === 'view'
                        ? `✓ View recreated — ${refreshResult.rows?.toLocaleString() ?? 0} row(s) visible`
                        : `✓ Done — ${refreshResult.rows?.toLocaleString() ?? 0} row(s) ${isColumnKind ? 'standardized' : 'written'}`
                      : `✗ ${refreshResult.error}`}
                  </p>
                )}
              </div>
            )}
            {group.export_kind === 'view' && group.export_table_fqn && (
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-hint)' }}>
                A view always reflects the current data live — day to day there is nothing to rebuild.
                Use the button above only if the view is missing or was dropped (it recreates it in place).
              </p>
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
          Removes the pipeline configuration. Historical mappings are preserved for this column.
        </p>
      </div>

      {/* Creation date — moved here from the Activity tab */}
      <p className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
        Pipeline created {fmtDate(group.created_at)}
      </p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type DetailTab = 'activity' | 'mappings' | 'queue' | 'settings';

interface Props {
  group:            PipelineGroup;
  initialTab?:      DetailTab;
  isStandardizing?: boolean;
  /** Full column-spec records (from /api/column-specs, keyed by spec_id) for the spec ⓘ tooltip. */
  specsById?:       Map<number, ColumnSpec>;
  onUpdateMember:   (p: Pipeline, patch: Partial<Pipeline>) => void;
  onDeleteMember:   (p: Pipeline) => void | Promise<void>;
  onDeleteGroup:    () => void;
}

export default function PipelineDetail({ group, initialTab = 'activity', isStandardizing = false, specsById = new Map(), onUpdateMember, onDeleteMember, onDeleteGroup }: Props) {
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
          {tab === 'activity' && <ActivityTab group={group} isStandardizing={isStandardizing} specsById={specsById} />}
          {tab === 'mappings' && <MappingsTab group={group} />}
          {tab === 'queue'    && <QueueTab    group={group} />}
          {tab === 'settings' && <SettingsTab group={group} onUpdateMember={onUpdateMember} onDeleteMember={onDeleteMember} onDeleteGroup={onDeleteGroup} />}
        </div>
      </div>
    </div>
  );
}
