'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import PipelineDetail from './PipelineDetail';
import CompactDomainPicker from '@/app/components/CompactDomainPicker';
import ExportLookupModal from '@/app/components/ExportLookupModal';
import { showToast } from '@/app/components/Toast';
import type { Domain } from '@/app/components/domain-types';

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
  status:               PipelineStatus;
  status_message:       string | null;
  mode:                 string;
  export_unmapped_rows: boolean;
  queue_size:           number;
  total_new_values:    number;
  total_mapped:        number;
  total_source_values: number;
  last_polled_at:      string | null;
  last_queue_empty_at: string | null;
  created_by:          number | null;
  created_at:          string | null;
  updated_at:          string | null;
  // File-based pipeline fields
  source_type:         string;
  file_source_meta:    any | null;
  file_export_meta:    any | null;
}

/**
 * A card in the pipelines list: all column-pipelines that share one export file
 * (i.e. one source table standardized into one destination). The backend still
 * stores one PIPELINES row per column; this is a presentation grouping.
 */
export interface PipelineGroup {
  key:                 string;        // export_table_fqn, or `__pid_<id>` when none
  export_table_fqn:    string | null;
  table_fqn:           string;        // from the first member
  name:                string | null; // card name (first member with a name)
  columns:             Pipeline[];    // member pipelines, ordered by source ordinal
  primaryDomainId:     number | null;
  primaryDomainName:   string | null;
  multipleDomains:     boolean;
  status:               PipelineStatus; // derived: any pending_baseline → pending_baseline; all active → active; else paused
  mode:                 'auto' | 'manual' | 'mixed';
  export_unmapped_rows: boolean;        // from first column; false = mapped rows only in export
  total_source_values: number;        // summed across columns
  total_mapped:        number;        // summed across columns
  queue_size:          number;        // summed across columns
  total_new_values:    number;        // summed across columns
  created_at:          string | null; // earliest
  last_polled_at:      string | null; // latest
  last_queue_empty_at: string | null; // latest
}

interface Alert {
  id:           number;
  level:        'error' | 'warning' | 'info';
  scope:        'global' | 'pipeline';
  message:      string;
  pipeline_id?: number;
}

const ALERT_COLORS: Record<Alert['level'], { bg: string; border: string; text: string }> = {
  error:   { bg: '#FEF2F2', border: '#FECACA', text: '#A32D2D' },
  warning: { bg: '#FFFBEB', border: '#FDE9C8', text: '#BA7517' },
  info:    { bg: '#EAF1FE', border: '#C5D8FC', text: '#185FA5' },
};

interface Props {
  onActivate?:         (p: Pipeline) => void;   // legacy prop from parent; cards manage their own activate now
  activePipelineId?:   number | null;
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

/** Most recent created_at among a list of pipelines (ms timestamp, 0 if none). */
function mostRecentCreatedAt(ps: { created_at: string | null }[]): number {
  return ps.reduce((best, p) => {
    const t = p.created_at ? new Date(p.created_at).getTime() : 0;
    return t > best ? t : best;
  }, 0);
}

/** Short table name from a fully-qualified DB.SCHEMA.TABLE. */
function tableShort(fqn: string): string {
  const parts = fqn.split('.');
  return parts[parts.length - 1] ?? fqn;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/** Display label for a group (card name, else the source table's short name). */
function groupName(g: PipelineGroup): string {
  return g.name ?? tableShort(g.table_fqn);
}

/** The card key a pipeline belongs to: its export file, or table_fqn for file pipelines, else a per-pipeline key. */
function groupKeyFor(p: Pipeline): string {
  if (p.export_table_fqn && p.export_table_fqn.trim()) return `exp:${p.export_table_fqn}`;
  // File pipelines (sheets, csv, excel) have no export_table_fqn; group by table_fqn so
  // virtual multi-column entries sharing the same pipeline_id land on one card.
  if (p.source_type && p.source_type !== 'snowflake') return `file:${p.table_fqn}`;
  return `__pid_${p.pipeline_id}`;
}

/**
 * Collapse pipelines into cards by export file. All columns sharing an
 * export_table_fqn become one card (a table + its standardized columns); domain
 * differences within a card are allowed. Columns are ordered by source ordinal
 * when known. The card's metrics are summed across columns.
 */
function buildPipelineGroups(
  pipelines: Pipeline[],
  columnOrders: Map<string, Record<string, number>>,
): PipelineGroup[] {
  const map = new Map<string, Pipeline[]>();
  for (const p of pipelines) {
    const key = groupKeyFor(p);
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }

  const groups: PipelineGroup[] = [];
  for (const [key, members] of map.entries()) {
    // Order columns by source ordinal position when available.
    const orders = columnOrders.get(members[0].table_fqn) ?? {};
    const columns = [...members].sort((a, b) => {
      const ao = orders[a.column_name.toUpperCase()] ?? orders[a.column_name] ?? Infinity;
      const bo = orders[b.column_name.toUpperCase()] ?? orders[b.column_name] ?? Infinity;
      if (ao !== bo) return ao - bo;
      return a.column_name.localeCompare(b.column_name);
    });

    // Primary domain = the oldest member's domain (used for the bucket + label).
    const oldest = [...columns].sort((a, b) =>
      (a.created_at ? new Date(a.created_at).getTime() : 0) -
      (b.created_at ? new Date(b.created_at).getTime() : 0))[0];
    const distinctDomains = new Set(columns.map(c => c.domain_id ?? -1));

    // Derived status: any setting-up → setting up; all live → live; else paused.
    const status: PipelineStatus =
      columns.some(c => c.status === 'pending_baseline') ? 'pending_baseline'
        : columns.every(c => c.status === 'active') ? 'active'
          : 'paused';

    const distinctModes = new Set(columns.map(c => c.mode));
    const mode: PipelineGroup['mode'] = distinctModes.size > 1
      ? 'mixed'
      : (columns[0].mode === 'manual' ? 'manual' : 'auto');

    // All columns of a table share the same export_unmapped_rows value; use the first.
    const export_unmapped_rows = columns[0].export_unmapped_rows !== false;

    groups.push({
      key,
      export_table_fqn:    members[0].export_table_fqn,
      table_fqn:           members[0].table_fqn,
      name:                columns.find(c => c.name)?.name ?? null,
      columns,
      primaryDomainId:     oldest.domain_id,
      primaryDomainName:   oldest.domain_name,
      multipleDomains:     distinctDomains.size > 1,
      status,
      mode,
      export_unmapped_rows,
      total_source_values: columns.reduce((s, c) => s + (c.total_source_values || 0), 0),
      total_mapped:        columns.reduce((s, c) => s + (c.total_mapped || 0), 0),
      queue_size:          columns.reduce((s, c) => s + (c.queue_size || 0), 0),
      total_new_values:    columns.reduce((s, c) => s + (c.total_new_values || 0), 0),
      created_at:          columns.reduce<string | null>((acc, c) => minIso(acc, c.created_at), null),
      last_polled_at:      columns.reduce<string | null>((acc, c) => maxIso(acc, c.last_polled_at), null),
      last_queue_empty_at: columns.reduce<string | null>((acc, c) => maxIso(acc, c.last_queue_empty_at), null),
    });
  }
  return groups;
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
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-pill px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}>
      <PulseDot color="#16a34a" /> Live
    </span>
  );
  if (status === 'pending_baseline') return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-pill px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: '#FEF9C3', color: '#92400E' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: '#D97706', flexShrink: 0, display: 'inline-block' }} />
      Setting up
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-pill px-2.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: 'var(--text-muted)', flexShrink: 0, display: 'inline-block' }} />
      Paused
    </span>
  );
}

// ── Pipeline row ──────────────────────────────────────────────────────────────

interface GroupRowProps {
  group:                    PipelineGroup;
  variant:                  'table' | 'domain';
  isExpanded:               boolean;
  expandedTab:              string | null;
  onToggle:                 () => void;
  onUpdateStandardizations: (g: PipelineGroup) => void;
  onReviewInitial:          (g: PipelineGroup) => void;
  onPause:                  (g: PipelineGroup) => void;
  onResume:                 (g: PipelineGroup) => void;
  onDelete:                 (g: PipelineGroup) => void;
  onAddColumn:              (g: PipelineGroup) => void;
  addableColumns:           string[];
  onAutoStandardize:        (g: PipelineGroup) => void;
  onManualStandardize:      (g: PipelineGroup) => void;
  onUpdateMember:           (p: Pipeline, patch: Partial<Pipeline>) => void;
  onDeleteMember:           (p: Pipeline) => void;
  busy:                     boolean;
  running:                  boolean;
  scanning:                 boolean;
  cycleResetMs:             number;
}

function GroupRow({
  group: g, variant, isExpanded, expandedTab, onToggle,
  onUpdateStandardizations, onAutoStandardize, onManualStandardize, onReviewInitial,
  onPause, onResume, onDelete,
  onAddColumn, addableColumns,
  onUpdateMember, onDeleteMember, busy, running, scanning, cycleResetMs,
}: GroupRowProps) {
  const columnsLabel = g.columns.map(c => c.column_name).join(', ');
  const messages = g.columns.filter(c => c.status_message);
  const [showStdMenu, setShowStdMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const stdTriggerRef = useRef<HTMLDivElement>(null);
  const stdMenuRef    = useRef<HTMLDivElement>(null);
  const [stdJustDone, setStdJustDone] = useState(false);
  const prevRunning = useRef(false);
  const [showExportLookup, setShowExportLookup] = useState(false);

  // Detect running → idle transition to show a brief "Done" confirmation.
  useEffect(() => {
    if (prevRunning.current && !running) {
      setStdJustDone(true);
      const t = setTimeout(() => setStdJustDone(false), 3000);
      return () => clearTimeout(t);
    }
    prevRunning.current = running;
  }, [running]);

  const title   = variant === 'domain' ? (g.columns[0].name ?? g.columns[0].column_name) : groupName(g);
  const subline = variant === 'domain' ? g.table_fqn : columnsLabel;

  function openStdMenu() {
    if (stdTriggerRef.current) {
      const r = stdTriggerRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setShowStdMenu(s => !s);
  }

  // Close dropdown when clicking outside (handles both trigger and portal panel)
  useEffect(() => {
    if (!showStdMenu) return;
    function handle(e: MouseEvent) {
      const target = e.target as Node;
      if (stdTriggerRef.current?.contains(target)) return;
      if (stdMenuRef.current?.contains(target)) return;
      setShowStdMenu(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showStdMenu]);

  return (
    <div style={{ borderBottom: '0.5px solid var(--border)' }}>
      {/* ── Main row ────────────────────────────────────────────────────── */}
      <div
        className="grid items-center cursor-pointer"
        style={{
          gridTemplateColumns: '20px minmax(140px,2fr) 100px 75px 1fr',
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

        {/* Name + sub-line */}
        <div className="min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {title}
          </p>
          <p className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--text-muted)' }} title={`${g.table_fqn} — ${columnsLabel}`}>
            {subline}
          </p>
        </div>

        {/* Status */}
        <div>
          <StatusPill status={g.status} />
        </div>

        {/* Mode + export-unmapped indicator */}
        <div className="flex flex-col items-start gap-1">
          <span
            className="text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded self-start"
            style={{
              backgroundColor: g.mode === 'auto' ? '#F5F3FF' : 'var(--page-bg)',
              color:           g.mode === 'auto' ? '#7C3AED' : 'var(--text-muted)',
              border:          `0.5px solid ${g.mode === 'auto' ? '#DDD6FE' : 'var(--border)'}`,
            }}
          >
            {g.mode}
          </span>
          {g.mode !== 'auto' && !g.export_unmapped_rows && (
            <span
              className="text-[9px] font-medium px-1.5 py-0.5 rounded self-start whitespace-nowrap"
              style={{
                backgroundColor: '#FFF7ED',
                color:           '#C2410C',
                border:          '0.5px solid #FED7AA',
              }}
            >
              Mapped only
            </span>
          )}
        </div>

        {/* Actions — operate on the whole card (all columns) */}
        <div className="flex items-center gap-1 justify-end" onClick={e => e.stopPropagation()}>
          {g.status === 'pending_baseline' && (
            <button
              onClick={() => onReviewInitial(g)}
              disabled={busy}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--accent)', color: busy ? 'white' : 'var(--accent)', backgroundColor: busy ? 'var(--accent)' : 'var(--accent-tint)' }}
              onMouseEnter={e => { if (!busy) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'white'; } }}
              onMouseLeave={e => { if (!busy) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-tint)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
            >
              {busy && <Spinner className="w-3 h-3" />}
              {busy ? 'Preparing…' : 'Create initial standardizations'}
            </button>
          )}

          {/* Update Standardizations dropdown — rendered via portal to escape overflow:hidden */}
          {g.status !== 'pending_baseline' && (
            <div ref={stdTriggerRef} style={{ position: 'relative' }}>
              <button
                onClick={running || stdJustDone ? undefined : openStdMenu}
                disabled={busy || running}
                className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
                style={{
                  borderColor: stdJustDone ? '#16a34a' : 'var(--accent)',
                  color:       stdJustDone ? '#15803D' : 'var(--accent)',
                  backgroundColor: stdJustDone ? '#DCFCE7' : 'var(--accent-tint)',
                  cursor: running || stdJustDone ? 'default' : 'pointer',
                }}
                onMouseEnter={e => { if (!busy && !running && !stdJustDone) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'white'; } }}
                onMouseLeave={e => {
                  if (stdJustDone) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#DCFCE7'; (e.currentTarget as HTMLButtonElement).style.color = '#15803D'; }
                  else { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-tint)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }
                }}
              >
                {running && <Spinner className="w-3 h-3" />}
                {stdJustDone && (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6.5l3 3 5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
                {running ? 'Standardizing…' : stdJustDone ? 'Done' : 'Update Standardizations'}
                {!running && !stdJustDone && (
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
              {showStdMenu && menuPos && typeof document !== 'undefined' && createPortal(
                <div
                  ref={stdMenuRef}
                  style={{
                    position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999,
                    backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)',
                    borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                    width: 220, overflow: 'hidden',
                  }}
                >
                  {[
                    {
                      label: 'Auto-standardize',
                      desc: 'Group and map all queued values automatically using Prism\'s algorithm',
                      action: () => { onAutoStandardize(g); setShowStdMenu(false); },
                    },
                    {
                      label: 'Manual review',
                      desc: 'Open a review session to inspect and approve each proposed mapping',
                      action: () => { onManualStandardize(g); setShowStdMenu(false); },
                    },
                  ].map(opt => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={opt.action}
                      className="w-full text-left px-3 py-2.5 transition-colors"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                    >
                      <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                      <p className="text-[10px] mt-0.5 leading-snug" style={{ color: 'var(--text-muted)' }}>{opt.desc}</p>
                    </button>
                  ))}
                </div>,
                document.body,
              )}
            </div>
          )}

          {/* Add Another Column */}
          {variant === 'table' && g.status !== 'pending_baseline' && (
            <button
              onClick={() => addableColumns.length > 0 ? onAddColumn(g) : undefined}
              disabled={busy || running || addableColumns.length === 0}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
              onMouseEnter={e => { if (!busy && !running && addableColumns.length > 0) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
              title={addableColumns.length === 0 ? 'All text columns are already standardized' : `Standardize another column (${addableColumns.length} eligible)`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Add Another Column
            </button>
          )}

          {g.status === 'active' && g.mode !== 'manual' && (
            <button
              onClick={() => onPause(g)}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
            >
              Pause
            </button>
          )}

          {g.status === 'paused' && (
            <button
              onClick={() => onResume(g)}
              disabled={busy}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'var(--accent-tint)' }}
              onMouseEnter={e => { if (!busy) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'white'; } }}
              onMouseLeave={e => { if (!busy) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-tint)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
            >
              Resume
            </button>
          )}

          {/* File pipeline export actions */}
          {(() => {
            const srcType = g.columns[0]?.source_type ?? 'snowflake';
            const firstPid = g.columns[0]?.pipeline_id;
            const fileMeta = g.columns[0]?.file_export_meta;

            if (srcType === 'csv' || srcType === 'excel') {
              return (
                <a
                  href={`/api/pipelines/${firstPid}/download`}
                  download
                  className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent', textDecoration: 'none' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLAnchorElement).style.color = 'var(--accent)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'; }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M6 2v6M3.5 5.5L6 8l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 10h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  Download standardized table
                </a>
              );
            }
            if (srcType === 'sheets' && (fileMeta?.output_spreadsheet_url || fileMeta?.spreadsheet_url)) {
              return (
                <a
                  href={fileMeta.output_spreadsheet_url ?? fileMeta.spreadsheet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent', textDecoration: 'none' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLAnchorElement).style.color = 'var(--accent)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'; }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h8a1 1 0 001-1V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <path d="M8 1h3v3M11 1L7 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  View Standardized Table
                </a>
              );
            }
            return null;
          })()}

          {/* Download Lookup Table */}
          {g.status !== 'pending_baseline' && (
            <button
              onClick={() => setShowExportLookup(true)}
              className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
              title="Download the lookup table for this pipeline"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 2v6M3.5 5.5L6 8l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 10h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Lookup table
            </button>
          )}
          {showExportLookup && (
            <ExportLookupModal
              columns={g.columns.map(c => ({
                column_name: c.column_name,
                domain_id:   c.domain_id,
                domain_name: c.domain_name,
              }))}
              onClose={() => setShowExportLookup(false)}
            />
          )}

          <button
            onClick={() => onDelete(g)}
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

      {/* ── Status messages (persistent reasons while paused/blocked) ─────── */}
      {messages.map(c => (
        <div
          key={`msg-${c.pipeline_id}`}
          className="px-4 py-2 text-[11px]"
          style={{ backgroundColor: '#FFFBEB', borderTop: '0.5px solid #FDE9C8', color: '#BA7517' }}
        >
          {g.columns.length > 1 && <span className="font-medium">{c.column_name}: </span>}
          {c.status_message}
        </div>
      ))}

      {/* ── Expanded detail ──────────────────────────────────────────────── */}
      {isExpanded && (
        <PipelineDetail
          group={g}
          initialTab={(expandedTab as 'activity' | 'mappings' | 'queue' | 'settings' | null) ?? 'activity'}
          isStandardizing={running}
          isScanning={scanning}
          cycleResetMs={cycleResetMs}
          onUpdateMember={onUpdateMember}
          onDeleteMember={onDeleteMember}
          onDeleteGroup={() => onDelete(g)}
        />
      )}
    </div>
  );
}


// ── Add-column modal ──────────────────────────────────────────────────────────
// Lets the user standardize additional eligible columns on an existing table,
// assigning each a domain. Creates pending_baseline pipelines that share the
// table's export file, then the parent opens the review wizard for them.
function AddColumnModal({
  group, columns, busy, onCancel, onSubmit,
}: {
  group:    PipelineGroup;
  columns:  string[];
  busy:     boolean;
  onCancel: () => void;
  onSubmit: (selections: { column_name: string; domain_id: number }[]) => void;
}) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [domainByCol, setDomainByCol] = useState<Record<string, Domain | null>>({});

  useEffect(() => {
    fetch('/api/domains')
      .then(r => r.json())
      .then(b => setDomains(b.domains ?? []))
      .catch(() => {})
      .finally(() => setLoadingDomains(false));
  }, []);

  function toggle(col: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col); else next.add(col);
      return next;
    });
  }

  const selections = [...checked]
    .map(col => { const d = domainByCol[col]; return d ? { column_name: col, domain_id: d.domain_id } : null; })
    .filter((s): s is { column_name: string; domain_id: number } => s !== null);
  const canSubmit = !busy && checked.size > 0 && selections.length === checked.size;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} onClick={busy ? undefined : onCancel}>
      <div
        className="rounded-card border-[0.5px] w-full max-w-lg mx-4"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Standardize another column</h3>
        <p className="text-xs mb-4 font-mono truncate" style={{ color: 'var(--text-muted)' }} title={group.table_fqn}>{group.table_fqn}</p>

        <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>Pick the column(s) to standardize and assign each a domain.</p>

        {/* No overflow-hidden wrapper here: each checked column reveals a
            CompactDomainPicker whose dropdown must be free to overflow the row. */}
        <div className="flex flex-col gap-2 mb-4">
          {columns.map((col) => {
            const on = checked.has(col);
            return (
              <div
                key={col}
                className="rounded-button border-[0.5px]"
                style={{ borderColor: on ? 'var(--accent-border)' : 'var(--border)', backgroundColor: on ? 'var(--accent-tint)' : 'var(--surface)' }}
              >
                <button
                  type="button"
                  onClick={() => toggle(col)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left disabled:cursor-not-allowed"
                >
                  <span
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 18, height: 18, borderRadius: 5, border: `0.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, backgroundColor: on ? 'var(--accent)' : 'var(--surface)' }}
                  >
                    {on && (
                      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="text-xs font-mono flex-1 truncate" style={{ color: 'var(--text-primary)' }} title={col}>{col}</span>
                </button>
                {on && (
                  <div className="px-3 pb-2.5 pt-0.5 flex items-center gap-2">
                    <span className="text-[11px] font-medium flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>Domain</span>
                    <div className="flex-1 min-w-0">
                      <CompactDomainPicker
                        domains={domains}
                        isLoading={loadingDomains}
                        value={domainByCol[col] ?? null}
                        onChange={d => setDomainByCol(prev => ({ ...prev, [col]: d }))}
                        onDomainCreated={d => setDomains(prev => [d, ...prev])}
                        disabled={busy}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button" onClick={onCancel} disabled={busy}
            className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={() => onSubmit(selections)} disabled={!canSubmit}
            className="px-4 py-2 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={e => { if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
          >
            {busy ? 'Creating…' : 'Create standardizations'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Main component ────────────────────────────────────────────────────────────

export default function PipelinesView({ defaultExpandedId, defaultExpandedTab }: Props) {
  const router = useRouter();
  const [pipelines,     setPipelines]     = useState<Pipeline[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [busyKey,          setBusyKey]          = useState<string | null>(null);  // group key running a pause/delete/review action
  const [autoStdBusyKey,  setAutoStdBusyKey]   = useState<string | null>(null); // group key running an auto-standardize fetch
  const [expandedKey,    setExpandedKey]   = useState<string | null>(null);
  const [expandedTab,   setExpandedTab]   = useState<string | null>(null);
  const [search,        setSearch]        = useState('');
  const [autoExpanded,  setAutoExpanded]  = useState(false);
  const [standardizingPipelines, setStandardizingPipelines] = useState<Set<number>>(new Set());
  const [scanningPipelines, setScanningPipelines] = useState<Set<number>>(new Set());
  // Per-pipeline client-clock timestamp of the last scan/standardize completion.
  // Lets the ring reset to 0% the instant a cycle ends, without waiting for the
  // async metrics refetch to deliver a fresh server-side last_polled_at.
  const [cycleResetAt, setCycleResetAt] = useState<Map<number, number>>(new Map());
  const markCycleReset = useCallback((pid: number) => {
    setCycleResetAt(prev => new Map(prev).set(pid, Date.now()));
  }, []);
  const [alerts,        setAlerts]        = useState<Alert[]>([]);

  // Column ordinal positions per table_fqn — used to order columns within a card.
  const [columnOrders, setColumnOrders] = useState<Map<string, Record<string, number>>>(new Map());
  // Per-table eligible (text) column names, used to offer "Standardize another column".
  const [tableFields,  setTableFields]  = useState<Map<string, { name: string; isText: boolean }[]>>(new Map());
  const [addColumnGroup, setAddColumnGroup] = useState<PipelineGroup | null>(null);

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

  // Fetch column ordinal positions for all unique tables (to order columns within a card).
  useEffect(() => {
    if (pipelines.length === 0) return;
    const tables = [...new Set(pipelines.map(p => p.table_fqn))];
    const missing = tables.filter(t => !columnOrders.has(t));
    if (missing.length === 0) return;

    Promise.allSettled(
      missing.map(async (t) => {
        const res  = await fetch(`/api/columns?table_fqn=${encodeURIComponent(t)}`);
        const body = await res.json().catch(() => ({}));
        return {
          table:   t,
          columns: body.columns as Record<string, number> ?? {},
          fields:  (body.fields as { name: string; isText: boolean }[]) ?? [],
        };
      }),
    ).then(results => {
      setColumnOrders(prev => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.status === 'fulfilled') next.set(r.value.table, r.value.columns);
        }
        return next;
      });
      setTableFields(prev => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.status === 'fulfilled') next.set(r.value.table, r.value.fields);
        }
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines]);

  // ── SSE ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const source = new EventSource('/api/pipeline-events');

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as {
          type: string;
          pipeline_id?: number;
          level?: 'error' | 'warning' | 'info';
          scope?: 'global' | 'pipeline';
          message?: string;
          ttl_ms?: number;
        };
        if (event.type === 'metrics_updated') {
          fetchPipelines();
        } else if (event.type === 'scanning_started' && event.pipeline_id != null) {
          setScanningPipelines(prev => new Set([...prev, event.pipeline_id!]));
        } else if (event.type === 'scanning_finished' && event.pipeline_id != null) {
          setScanningPipelines(prev => {
            const next = new Set(prev);
            next.delete(event.pipeline_id!);
            return next;
          });
          // The cycle restarts NOW — anchor the ring to this instant so it resumes
          // from 0% immediately, before the metrics_updated refetch lands.
          markCycleReset(event.pipeline_id!);
        } else if (event.type === 'standardizing_started' && event.pipeline_id != null) {
          // Standardization supersedes scanning — drop the scanning flag so the ring
          // transitions cleanly from teal "checking" to amber "standardizing".
          setScanningPipelines(prev => {
            const next = new Set(prev);
            next.delete(event.pipeline_id!);
            return next;
          });
          setStandardizingPipelines(prev => new Set([...prev, event.pipeline_id!]));
        } else if (event.type === 'standardizing_finished' && event.pipeline_id != null) {
          setStandardizingPipelines(prev => {
            const next = new Set(prev);
            next.delete(event.pipeline_id!);
            return next;
          });
          // Standardization is the end of the cycle too — anchor the ring so it
          // resumes counting from 0% (next poll is one interval from now).
          markCycleReset(event.pipeline_id!);
          fetchPipelines();
        } else if (event.type === 'alert' && event.message) {
          const id = Date.now() + Math.random();
          setAlerts(prev => [
            ...prev.filter(a => a.message !== event.message),
            { id, level: event.level ?? 'error', scope: event.scope ?? 'global', message: event.message!, pipeline_id: event.pipeline_id },
          ].slice(-5));
          const ttl = event.ttl_ms ?? 0;
          if (ttl > 0) {
            setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), ttl);
          }
          // A pipeline-scoped alert usually accompanies a status change — refetch
          // so the persistent status_message on the card updates too.
          if (event.scope === 'pipeline') fetchPipelines();
        }
      } catch { /* ignore malformed events */ }
    };

    return () => source.close();
  }, [fetchPipelines, markCycleReset]);

  useEffect(() => {
    const interval = setInterval(fetchPipelines, 60_000);
    return () => clearInterval(interval);
  }, [fetchPipelines]);

  useEffect(() => {
    if (autoExpanded || !defaultExpandedId || pipelines.length === 0) return;
    const target = pipelines.find(p => p.pipeline_id === defaultExpandedId);
    if (!target) return;
    setExpandedKey(groupKeyFor(target));
    setExpandedTab(defaultExpandedTab ?? 'activity');
    setAutoExpanded(true);
  }, [defaultExpandedId, defaultExpandedTab, pipelines, autoExpanded]);

  // ── Whole-card actions (loop over a card's member columns) ────────────────────

  async function patchMembers(members: Pipeline[], status: 'paused' | 'active') {
    if (members.length === 0) return;
    // Optimistic flip; revert any member whose PATCH fails.
    const ids = new Set(members.map(m => m.pipeline_id));
    const prevStatuses = new Map(members.map(m => [m.pipeline_id, m.status]));
    setPipelines(prev => prev.map(x => ids.has(x.pipeline_id) ? { ...x, status } : x));

    const results = await Promise.all(members.map(async m => {
      try {
        const res = await fetch(`/api/pipelines/${m.pipeline_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        return { m, ok: res.ok };
      } catch {
        return { m, ok: false };
      }
    }));

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      const failedIds = new Set(failed.map(f => f.m.pipeline_id));
      setPipelines(prev => prev.map(x =>
        failedIds.has(x.pipeline_id)
          ? { ...x, status: prevStatuses.get(x.pipeline_id) ?? x.status }
          : x));
      const verb  = status === 'paused' ? 'pause' : 'resume';
      const what  = failed.length === 1 ? failed[0].m.column_name : `${failed.length} columns`;
      showToast(`Couldn't ${verb} ${what}. Please try again.`, 'error');
    }
  }

  async function handlePause(g: PipelineGroup) {
    setBusyKey(g.key);
    try { await patchMembers(g.columns.filter(c => c.status === 'active'), 'paused'); }
    finally { setBusyKey(null); }
  }

  async function handleResume(g: PipelineGroup) {
    setBusyKey(g.key);
    try { await patchMembers(g.columns.filter(c => c.status === 'paused'), 'active'); }
    finally { setBusyKey(null); }
  }

  async function handleDelete(g: PipelineGroup) {
    const label = `${groupName(g)}${g.columns.length > 1 ? ` (${g.columns.length} columns)` : ''}`;
    if (!confirm(`Delete the pipeline for ${label}? This cannot be undone.`)) return;
    setBusyKey(g.key);
    try {
      // Dedup: virtual multi-column entries share a pipeline_id; only delete each once.
      const seen = new Set<number>();
      await Promise.all(
        g.columns
          .filter(m => { if (seen.has(m.pipeline_id)) return false; seen.add(m.pipeline_id); return true; })
          .map(m => fetch(`/api/pipelines/${m.pipeline_id}`, { method: 'DELETE' }).catch(() => {})),
      );
      const ids = new Set(g.columns.map(m => m.pipeline_id));
      setPipelines(prev => prev.filter(x => !ids.has(x.pipeline_id)));
      if (expandedKey === g.key) setExpandedKey(null);
    } finally { setBusyKey(null); }
  }

  // Delete a single column from a card (per-column delete in Settings).
  async function handleDeleteMember(p: Pipeline) {
    await fetch(`/api/pipelines/${p.pipeline_id}`, { method: 'DELETE' }).catch(() => {});
    setPipelines(prev => prev.filter(x => x.pipeline_id !== p.pipeline_id));
  }

  function handleUpdateMember(p: Pipeline, patch: Partial<Pipeline>) {
    setPipelines(prev => prev.map(x => x.pipeline_id === p.pipeline_id ? { ...x, ...patch } : x));
  }

  // Open a review wizard over the given columns. kind='create' builds runs from
  // the full source (create-initial-run); kind='standardize' builds them from the
  // queue (standardize-run, used by manual mode). Walks the column wizard so a
  // multi-column table reviews each column in sequence.
  async function startReviewWizard(columns: Pipeline[], kind: 'create' | 'standardize', key: string) {
    if (columns.length === 0) return;
    setBusyKey(key);
    const routeFor = (pid: number) => kind === 'standardize'
      ? `/api/pipelines/${pid}/standardize-run`
      : `/api/pipelines/${pid}/create-initial-run`;
    try {
      // Find the first column that yields a run (skip ones with nothing to review).
      for (let i = 0; i < columns.length; i++) {
        const res  = await fetch(routeFor(columns[i].pipeline_id), { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.error(`[ReviewWizard] Pipeline ${columns[i].pipeline_id} failed:`, body?.error);
          showToast(
            `Couldn't prepare ${columns[i].column_name} for review${body?.error ? `: ${body.error}` : '.'}`,
            'error',
          );
          setBusyKey(null);
          return;
        }
        if (body?.run_id) {
          const remaining = columns.slice(i);
          if (remaining.length > 1) {
            const wizard = {
              kind,
              pids: remaining.map(c => c.pipeline_id),
              cols: remaining.map(c => c.column_name),
              runs: remaining.map((_, j) => (j === 0 ? Number(body.run_id) : null)),
            };
            sessionStorage.setItem('prism_ae_col_wizard', JSON.stringify(wizard));
          } else {
            sessionStorage.removeItem('prism_ae_col_wizard');
          }
          router.push(`/run/${body.run_id}`);
          return; // navigating away; keep the spinner until unmount
        }
        // run_id null (empty source/queue for this column) — try the next column.
      }
      // Nothing to review on any column — refresh so the card reflects current state.
      await fetchPipelines();
      setBusyKey(null);
    } catch {
      showToast('Couldn’t start the review — check your connection and try again.', 'error');
      setBusyKey(null);
    }
  }

  // Update Standardizations — navigates to the domain mappings page.
  // The page detects the queue on load, auto-standardizes if needed, and defaults
  // to a "new items only" filtered view when there are queued values.
  function handleUpdateStandardizations(g: PipelineGroup) {
    const params = new URLSearchParams();
    if (g.primaryDomainId != null) params.set('domain_id', String(g.primaryDomainId));
    params.set('pipeline_ids', g.columns.map(c => c.pipeline_id).join(','));
    router.push(`/global-standardizations?${params.toString()}`);
  }

  // Auto Standardize — fire process-queue for every unique pipeline in the group.
  // Virtual multi-column entries share a pipeline_id; dedup so we call once per pipeline.
  // Also expand the card so the progress ring/activity is visible while it runs.
  async function handleAutoStandardize(g: PipelineGroup) {
    setExpandedKey(g.key);
    setExpandedTab('activity');
    setAutoStdBusyKey(g.key);
    try {
      const seen = new Set<number>();
      for (const col of g.columns) {
        if (seen.has(col.pipeline_id)) continue;
        seen.add(col.pipeline_id);
        try {
          const res = await fetch(`/api/pipelines/${col.pipeline_id}/process-queue`, { method: 'POST' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(
              `Auto-standardize failed for ${col.column_name}${body?.error ? `: ${body.error}` : '.'}`,
              'error',
            );
          }
        } catch {
          showToast(`Auto-standardize failed for ${col.column_name} — check your connection.`, 'error');
        }
      }
    } finally {
      setAutoStdBusyKey(null);
    }
  }

  async function handleManualStandardize(g: PipelineGroup) {
    await startReviewWizard(g.columns, 'standardize', g.key);
  }

  // Build (or rebuild) the initial review run(s) for a card's pending_baseline
  // columns and open the first for review. Multiple columns re-enter the wizard.
  async function handleReviewInitial(g: PipelineGroup) {
    await startReviewWizard(g.columns.filter(c => c.status === 'pending_baseline'), 'create', g.key);
  }

  // Standardize an additional column on a table that already has a pipeline:
  // create a pending_baseline pipeline per chosen column (sharing the table's
  // export file + mode), then open the review wizard for them.
  async function handleAddColumns(g: PipelineGroup, selections: { column_name: string; domain_id: number }[]) {
    setAddColumnGroup(null);
    if (selections.length === 0) return;
    setBusyKey(g.key);
    const mode = g.mode === 'mixed' ? (g.columns[0]?.mode ?? 'auto') : g.mode;
    const created: Pipeline[] = [];
    for (const sel of selections) {
      try {
        const res  = await fetch('/api/pipelines', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            table_fqn:            g.table_fqn,
            column_name:          sel.column_name,
            domain_id:            sel.domain_id,
            export_table_fqn:     g.export_table_fqn,
            mode,
            export_unmapped_rows: g.export_unmapped_rows,
            status:               'pending_baseline',
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body?.pipeline) created.push(body.pipeline as Pipeline);
        else {
          console.error(`[AddColumn] Failed for ${sel.column_name}:`, body?.error);
          showToast(
            `Couldn't add column ${sel.column_name}${body?.error ? `: ${body.error}` : '.'}`,
            'error',
          );
        }
      } catch (e) {
        console.error(`[AddColumn] ${sel.column_name}:`, e);
        showToast(`Couldn't add column ${sel.column_name} — check your connection.`, 'error');
      }
    }
    if (created.length === 0) { setBusyKey(null); return; }
    await fetchPipelines();
    // startReviewWizard manages busyKey and navigates to the first run.
    await startReviewWizard(created, 'create', g.key);
  }

  function handleToggle(g: PipelineGroup) {
    if (expandedKey === g.key) {
      setExpandedKey(null);
      setExpandedTab(null);
    } else {
      setExpandedKey(g.key);
      setExpandedTab('activity');
    }
  }

  // Hide pipelines still being set up FOR THE FIRST TIME. A brand-new multi-column
  // pipeline only appears once EVERY column has been reviewed/accepted — while any
  // column is 'pending_baseline', the half-built card stays hidden.
  //
  // BUT once an export already has a live (active/paused) column, ADDING another
  // column must NOT hide the live pipeline: the new column is pending_baseline and
  // shares the same export file, and hiding the whole card makes the live pipeline
  // vanish (a blank page) while the new column's baseline run is being built/
  // reviewed — or permanently if that build errors or the user navigates back.
  const exportsWithLiveColumn = new Set(
    pipelines
      .filter(p => p.status !== 'pending_baseline' && p.export_table_fqn)
      .map(p => p.export_table_fqn as string),
  );
  const incompleteExports = new Set(
    pipelines
      .filter(p => p.status === 'pending_baseline' && p.export_table_fqn
                   && !exportsWithLiveColumn.has(p.export_table_fqn as string))
      .map(p => p.export_table_fqn as string),
  );
  const ready = pipelines.filter(p =>
    p.status !== 'pending_baseline' &&
    !(p.export_table_fqn != null && incompleteExports.has(p.export_table_fqn)),
  );

  // Filter by search (matches on table, domain, any column name)
  const filtered = ready.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      displayName(p).toLowerCase().includes(q) ||
      p.table_fqn.toLowerCase().includes(q) ||
      (p.domain_name ?? '').toLowerCase().includes(q) ||
      p.column_name.toLowerCase().includes(q) ||
      (p.export_table_fqn ?? '').toLowerCase().includes(q)
    );
  });

  // ── Table view ─────────────────────────────────────────────────────────────
  // One card per export file (a table + its columns), sorted like the original
  // "by table" view: by recency when few tables, alphabetically once there are many.
  const exportGroups = buildPipelineGroups(filtered, columnOrders);
  const tableGroups = [...exportGroups].sort((a, b) => {
    if (exportGroups.length < 10) return mostRecentCreatedAt(b.columns) - mostRecentCreatedAt(a.columns);
    return a.table_fqn.localeCompare(b.table_fqn);
  });

  const liveCount   = exportGroups.filter(g => g.status === 'active').length;
  const pausedCount = exportGroups.filter(g => g.status === 'paused').length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      <style>{`@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>

      {addColumnGroup && (() => {
        const covered = new Set(addColumnGroup.columns.map(c => c.column_name.toUpperCase()));
        const cols = (tableFields.get(addColumnGroup.table_fqn) ?? [])
          .filter(f => f.isText && !covered.has(f.name.toUpperCase()))
          .map(f => f.name);
        return (
          <AddColumnModal
            group={addColumnGroup}
            columns={cols}
            busy={busyKey === addColumnGroup.key}
            onCancel={() => setAddColumnGroup(null)}
            onSubmit={(sel) => handleAddColumns(addColumnGroup, sel)}
          />
        );
      })()}

      {/* Alert banners — global failures and pipeline notices pushed over SSE */}
      {alerts.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {alerts.map(a => {
            const c = ALERT_COLORS[a.level];
            const label = a.scope === 'pipeline' && a.pipeline_id != null
              ? pipelines.find(p => p.pipeline_id === a.pipeline_id)
              : null;
            return (
              <div
                key={a.id}
                className="rounded-card border-[0.5px] px-4 py-3 text-sm flex items-start justify-between gap-3"
                style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
              >
                <span>
                  {label ? <span className="font-medium">{displayName(label)}: </span> : null}
                  {a.message}
                </span>
                <button
                  onClick={() => setAlerts(prev => prev.filter(x => x.id !== a.id))}
                  className="shrink-0 text-xs font-medium opacity-70 hover:opacity-100"
                  style={{ color: c.text }}
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Toolbar: search */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div />

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

      {/* Pipeline table — one card per export file (a table + its columns) */}
      {!loading && !error && tableGroups.length > 0 && (
        <div className="flex flex-col" style={{ gap: 20 }}>

          {/* Column header */}
          <div
            className="grid text-[10px] font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '20px minmax(140px,2fr) 100px 75px 1fr',
              padding: '0 16px',
              gap: 14,
              color: 'var(--text-muted)',
            }}
          >
            <span />
            <span>Pipeline</span>
            <span>Status</span>
            <span>Mode</span>
            <span className="text-right">Actions</span>
          </div>

          <div style={{ border: '0.5px solid var(--border)', borderRadius: 7, overflow: 'hidden', backgroundColor: 'var(--surface)' }}>
            {tableGroups.map(g => {
              const covered = new Set(g.columns.map(c => c.column_name.toUpperCase()));
              const addableColumns = (tableFields.get(g.table_fqn) ?? [])
                .filter(f => f.isText && !covered.has(f.name.toUpperCase()))
                .map(f => f.name);
              return (
              <GroupRow
                key={g.key}
                group={g}
                variant="table"
                isExpanded={expandedKey === g.key}
                expandedTab={expandedKey === g.key ? expandedTab : null}
                onToggle={() => handleToggle(g)}
                onUpdateStandardizations={handleUpdateStandardizations}
                onAutoStandardize={handleAutoStandardize}
                onManualStandardize={handleManualStandardize}
                onReviewInitial={handleReviewInitial}
                onPause={handlePause}
                onResume={handleResume}
                onDelete={handleDelete}
                onAddColumn={setAddColumnGroup}
                addableColumns={addableColumns}
                onUpdateMember={handleUpdateMember}
                onDeleteMember={handleDeleteMember}
                busy={busyKey === g.key}
                running={g.columns.some(c => standardizingPipelines.has(c.pipeline_id)) || autoStdBusyKey === g.key}
                scanning={g.columns.some(c => scanningPipelines.has(c.pipeline_id))}
                cycleResetMs={g.columns.reduce((m, c) => Math.max(m, cycleResetAt.get(c.pipeline_id) ?? 0), 0)}
              />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
