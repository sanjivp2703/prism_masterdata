'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import PipelineDetail from './PipelineDetail';
import {
  emptyColumnSpecDraft, columnSpecDraftValid, columnSpecDraftToApiSpec,
  type ColumnSpecDraft,
} from '@/app/components/ColumnSpecEditor';
import ColumnSpecField from '@/app/components/ColumnSpecField';
import ExportLookupModal from '@/app/components/ExportLookupModal';
import { showToast } from '@/app/components/Toast';
import type { ColumnSpec } from '@/app/components/spec-types';
import { parseStoredSchedule, scheduleLabel, type UpdateSchedule } from '@/app/api/_lib/update-schedule';
import { sanitizeConventionRules, describeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';
import { useWarehouseLabel } from '@/app/components/use-warehouse-label';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PipelineStatus = 'active' | 'paused' | 'pending_baseline';

export interface Pipeline {
  pipeline_id:         number;
  name:                string | null;
  table_fqn:           string;
  column_name:         string;
  export_table_fqn:    string | null;
  export_kind:         'table' | 'view' | 'column'; // meaningless when export_table_fqn is null; 'column' ⇒ export_table_fqn = table_fqn
  domain_id:           number | null;
  domain_name:         string | null;
  status:               PipelineStatus;
  status_message:       string | null;
  // Machine-readable code alongside status_message — set only when there's a
  // real fix action attached (currently 'table_mode_access'). Drives the
  // "Grant automatically" disclosure instead of a plain text banner.
  status_reason:        string | null;
  update_schedule:      UpdateSchedule;
  export_unmapped_rows: boolean;
  queue_size:           number;
  total_new_values:    number;
  total_mapped:        number;
  total_source_values: number;
  last_polled_at:      string | null;
  last_queue_empty_at: string | null;
  fully_synced_at:     string | null;
  created_by:          number | null;
  created_at:          string | null;
  updated_at:          string | null;
  // File-based pipeline fields
  // Change-detection mode (SQL Server warehouses): 'stream' (Snowflake),
  // 'ct' (Change Tracking) or 'diff' (scheduled scan); null for file pipelines.
  detection_mode:      string | null;
  detection_reason:    string | null;
}

/**
 * A card in the pipelines list: all column-pipelines that share one export file
 * (i.e. one source table standardized into one destination). The backend still
 * stores one PIPELINES row per column; this is a presentation grouping.
 */
export interface PipelineGroup {
  key:                 string;        // `exp:<export_table_fqn>`, or `tbl:<table_fqn>` when there is no export object
  export_table_fqn:    string | null;
  export_kind:         'table' | 'view' | 'column'; // from the first member; meaningless when export_table_fqn is null
  table_fqn:           string;        // from the first member
  name:                string | null; // card name (first member with a name)
  columns:             Pipeline[];    // member pipelines, ordered by source ordinal
  status:               PipelineStatus; // derived: any pending_baseline → pending_baseline; all active → active; else paused
  update_schedule:      UpdateSchedule; // shared by all columns of a table (from the first)
  export_unmapped_rows: boolean;        // from first column; false = mapped rows only in export
  total_source_values: number;        // summed across columns
  total_mapped:        number;        // summed across columns
  queue_size:          number;        // summed across columns
  total_new_values:    number;        // summed across columns
  created_at:          string | null; // earliest
  last_polled_at:      string | null; // latest
  last_queue_empty_at: string | null; // latest
  /** EARLIEST across columns (all must be synced for the table to be fully up
   *  to date) — last time the standardized table was verified complete. */
  fully_synced_at:     string | null;
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

/** The card key a pipeline belongs to: its export object, else its source table. */
function groupKeyFor(p: Pipeline): string {
  if (p.export_table_fqn && p.export_table_fqn.trim()) return `exp:${p.export_table_fqn}`;
  // Lookup-only pipelines have no export_table_fqn; group by the source table
  // so a multi-column lookup-only pipeline is ONE card like every other kind.
  // (Was a per-pipeline_id key until 2026-10-03 — a two-column Lookup-table
  // pipeline rendered as two cards on the client-test install, finding #2.)
  return `tbl:${p.table_fqn}`;
}

/**
 * Collapse pipelines into cards by export file. All columns sharing an
 * export_table_fqn become one card (a table + its standardized columns); spec
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

    // Derived status: any setting-up → setting up; all live → live; else paused.
    const status: PipelineStatus =
      columns.some(c => c.status === 'pending_baseline') ? 'pending_baseline'
        : columns.every(c => c.status === 'active') ? 'active'
          : 'paused';

    // All columns of a table share one update schedule (settings/creation apply
    // it to every column); tolerate raw rows by re-parsing defensively.
    const update_schedule = parseStoredSchedule(columns[0].update_schedule);

    // All columns of a table share the same export_unmapped_rows value; use the first.
    const export_unmapped_rows = columns[0].export_unmapped_rows !== false;

    groups.push({
      key,
      export_table_fqn:    members[0].export_table_fqn,
      export_kind:         members[0].export_kind,
      table_fqn:           members[0].table_fqn,
      name:                columns.find(c => c.name)?.name ?? null,
      columns,
      status,
      update_schedule,
      export_unmapped_rows,
      total_source_values: columns.reduce((s, c) => s + (c.total_source_values || 0), 0),
      total_mapped:        columns.reduce((s, c) => s + (c.total_mapped || 0), 0),
      queue_size:          columns.reduce((s, c) => s + (c.queue_size || 0), 0),
      total_new_values:    columns.reduce((s, c) => s + (c.total_new_values || 0), 0),
      created_at:          columns.reduce<string | null>((acc, c) => minIso(acc, c.created_at), null),
      last_polled_at:      columns.reduce<string | null>((acc, c) => maxIso(acc, c.last_polled_at), null),
      last_queue_empty_at: columns.reduce<string | null>((acc, c) => maxIso(acc, c.last_queue_empty_at), null),
      // Min, not max: the card is only as fresh as its least-synced column.
      fully_synced_at:     columns.every(c => c.fully_synced_at)
        ? columns.reduce<string | null>((acc, c) => minIso(acc, c.fully_synced_at), null)
        : null,
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

/** A column spec's details for the hover tooltip — description, standardization
 *  rules, and naming convention, as heading + lines sections. */
function columnSpecSections(spec: ColumnSpec): { heading: string; lines: string[] }[] {
  const sections: { heading: string; lines: string[] }[] = [];
  if (spec.description?.trim()) {
    sections.push({ heading: 'Description', lines: [spec.description.trim()] });
  }
  try {
    const raw = spec.standardization_rules;
    const rules = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(rules) && rules.length > 0) {
      sections.push({ heading: 'Standardization rules', lines: rules.map(r => String(r)) });
    }
  } catch { /* unreadable rules JSON — omit the section */ }
  const convLines: string[] = [];
  try {
    const raw = spec.convention_rules;
    const cr = sanitizeConventionRules(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (hasAnyRule(cr)) convLines.push(...describeConventionRules(cr));
  } catch { /* no structured convention */ }
  if (spec.convention_type === 'regex' && spec.convention_value) {
    convLines.push(`Names must match the pattern: ${spec.convention_value}`);
  } else if (spec.convention_type === 'natural' && spec.convention_value) {
    convLines.push(spec.convention_value);
  } else if (spec.convention_type === 'examples' && spec.convention_value) {
    convLines.push(`Names follow the style of: ${spec.convention_value}`);
  }
  if (convLines.length > 0) sections.push({ heading: 'Naming convention', lines: convLines });
  return sections;
}

/** ⓘ icon revealing a column's spec (description + standardization rules +
 *  naming convention) on hover OR click. PORTALED (position: fixed) — card rows
 *  and panels clip absolute children. Used next to each column in the Activity
 *  tab's per-column breakdown (exported for PipelineDetail). */
export function SpecInfoIcon({ spec }: { spec: ColumnSpec | null }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const show = () => {
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    // Exact width + clamp to the viewport so the fixed panel never overflows.
    setTipPos({ left: Math.min(r.left - 8, window.innerWidth - 296), top: r.bottom + 6 });
  };

  // A clicked-open (pinned) panel closes on any outside click.
  useEffect(() => {
    if (!pinned) return;
    const close = () => { setPinned(false); setTipPos(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pinned]);

  if (!spec) return null;
  const sections = columnSpecSections(spec);

  return (
    <span
      ref={iconRef}
      onMouseEnter={show}
      onMouseLeave={() => { if (!pinned) setTipPos(null); }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        if (pinned) { setPinned(false); setTipPos(null); }
        else { setPinned(true); show(); }
      }}
      style={{ display: 'inline-flex', cursor: 'help', color: 'var(--accent)', flexShrink: 0 }}
      aria-label={`Description, standardization rules, and naming convention for the ${spec.column_name} column`}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="5.4" stroke="currentColor" strokeWidth="1" />
        <path d="M6 5.4v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="6" cy="3.6" r="0.65" fill="currentColor" />
      </svg>
      {tipPos && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed', left: tipPos.left, top: tipPos.top, zIndex: 9999,
            width: 288, maxHeight: 320, overflowY: 'auto', pointerEvents: 'none',
            backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)',
            borderRadius: 'var(--radius-button)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '10px 12px',
          }}
        >
          <p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{spec.column_name}</p>
          {sections.length === 0 ? (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              No description, standardization rules, or naming convention set for this column.
            </p>
          ) : sections.map(s => (
            <div key={s.heading} className="mt-1.5">
              <p className="text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-muted)' }}>{s.heading}</p>
              {s.lines.map((line, i) => (
                <p key={i} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {s.lines.length > 1 ? '• ' : ''}{line}
                </p>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}

// ── Fixable pause: table-mode export permissions (mssql only) ────────────────

// Replaces the plain status_message banner for this specific pause reason
// with an explanation + a one-click "Grant automatically" action, instead of
// just text the user has to act on manually.
function TableModeAccessBanner({
  pipeline, multiColumn, onFixAccess,
}: {
  pipeline:    Pipeline;
  multiColumn: boolean;
  onFixAccess: (pipelineId: number) => Promise<{ fixed: boolean; error?: string; manual_sql?: string }>;
}) {
  const [attempting, setAttempting] = useState(false);
  const [manualSql,  setManualSql]  = useState<string | null>(null);
  const [copied,     setCopied]     = useState(false);

  async function tryFix() {
    setAttempting(true);
    setManualSql(null);
    try {
      const result = await onFixAccess(pipeline.pipeline_id);
      if (!result.fixed) {
        setManualSql(result.manual_sql ?? null);
        showToast(result.error ?? "Couldn't grant access automatically.", 'error');
      }
    } finally {
      setAttempting(false);
    }
  }

  function copySql() {
    if (!manualSql) return;
    navigator.clipboard?.writeText(manualSql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="px-4 py-3 text-[11px]" style={{ backgroundColor: '#FFFBEB', borderTop: '0.5px solid #FDE9C8', color: '#92400E' }}>
      {multiColumn && <span className="font-medium">{pipeline.column_name}: </span>}
      <p className="mb-1.5" style={{ lineHeight: 1.55 }}>
        Prism paused this pipeline — it needs <span className="font-mono">CREATE TABLE</span> and{' '}
        <span className="font-mono">ALTER</span> permissions on the destination schema to rebuild the standardized
        export table. These let Prism create and replace its own export table there. They do not touch any of your
        other existing tables — but they are schema-wide grants, so they would technically also let Prism (or anyone
        else holding them) create or modify other new tables in that same schema.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={tryFix}
          disabled={attempting}
          className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors disabled:opacity-50"
          style={{ borderColor: '#F59E0B', color: '#92400E', backgroundColor: 'transparent' }}
        >
          {attempting ? 'Granting…' : 'Grant automatically'}
        </button>
        {manualSql && (
          <button
            type="button"
            onClick={copySql}
            className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors"
            style={{ borderColor: '#F59E0B', color: '#92400E', backgroundColor: 'transparent' }}
          >
            {copied ? 'Copied!' : 'Copy fix SQL'}
          </button>
        )}
      </div>
      {manualSql && (
        <pre
          className="mt-2 text-[10px] p-2 rounded-button overflow-x-auto"
          style={{ backgroundColor: '#FEF3C7', color: '#78350F', whiteSpace: 'pre-wrap' }}
        >
          {manualSql}
        </pre>
      )}
    </div>
  );
}

// ── Pipeline row ──────────────────────────────────────────────────────────────

interface GroupRowProps {
  group:                    PipelineGroup;
  variant:                  'table' | 'spec';
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
  onDeleteMember:           (p: Pipeline) => void | Promise<void>;
  onFixAccess:              (pipelineId: number) => Promise<{ fixed: boolean; error?: string; manual_sql?: string }>;
  busy:                     boolean;
  /** True while THIS card's delete request is in flight (subset of busy). */
  deleting:                 boolean;
  running:                  boolean;
  /** Full column-spec records (from /api/column-specs, keyed by spec_id) for the spec tooltip. */
  specsById:                Map<number, ColumnSpec>;
}

function GroupRow({
  group: g, variant, isExpanded, expandedTab, onToggle,
  onUpdateStandardizations, onAutoStandardize, onManualStandardize, onReviewInitial,
  onPause, onResume, onDelete,
  onAddColumn, addableColumns,
  onUpdateMember, onDeleteMember, onFixAccess, busy, deleting, running, specsById,
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

  const title   = variant === 'spec' ? (g.columns[0].name ?? g.columns[0].column_name) : groupName(g);
  const subline = variant === 'spec' ? g.table_fqn : columnsLabel;

  // WHERE THE STANDARDIZED DATA ACTUALLY LANDS.
  //
  // The card's sub-line names the SOURCE, and until now the destination
  // appeared nowhere on a warehouse card at all — so the one thing a user most
  // needs ("where do I read the clean data?") was the one thing they had to go
  // hunting for.
  //
  // Every output kind gets an answer here, including the two that don't create
  // an object, because "Prism didn't make you a table, and that's the setting
  // you chose" is a legitimate answer and better than silence.
  const destination = (() => {
    if (!g.export_table_fqn) {
      return { label: 'Lookup table only — no output object', href: null, mono: false };
    }
    if (g.export_kind === 'column') {
      // Destination is pinned to the source; the real artifact is the companion
      // column, which is what the user has to go and SELECT.
      const cols = g.columns.map(c => `${c.column_name}_STANDARDIZED`).join(', ');
      return { label: `${g.export_table_fqn} · ${cols}`, href: null, mono: true };
    }
    return { label: g.export_table_fqn, href: null, mono: true };
  })();
  const destinationKindLabel =
    g.export_kind === 'column' ? 'Standardized column'
      : g.export_kind === 'view'   ? 'Output view'
      : g.export_table_fqn         ? 'Output table'
      : 'Output';

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
          gridTemplateColumns: '20px minmax(140px,2fr) 100px 170px 1fr',
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
          {/* Where the standardized data lands — the answer users came for. */}
          {variant !== 'spec' && (
            <p className="text-[11px] truncate mt-0.5 flex items-center gap-1" style={{ color: 'var(--text-hint)' }}
               title={`${destinationKindLabel}: ${destination.label}`}>
              <span style={{ flexShrink: 0 }}>{destinationKindLabel}:</span>
              {destination.href ? (
                <a
                  href={destination.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="truncate hover:underline"
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  {destination.label} ↗
                </a>
              ) : (
                <span className={`truncate ${destination.mono ? 'font-mono' : ''}`}>{destination.label}</span>
              )}
            </p>
          )}
        </div>

        {/* Status */}
        <div>
          <StatusPill status={g.status} />
        </div>

        {/* Update window + export-unmapped indicator */}
        <div className="flex flex-col items-start gap-1">
          <span
            className="text-[9px] font-medium px-1.5 py-0.5 rounded self-start whitespace-nowrap"
            title="Update window — when Prism auto-updates the standardized table"
            style={{
              backgroundColor: g.update_schedule.type !== 'manual' ? '#F5F3FF' : 'var(--page-bg)',
              color:           g.update_schedule.type !== 'manual' ? '#7C3AED' : 'var(--text-muted)',
              border:          `0.5px solid ${g.update_schedule.type !== 'manual' ? '#DDD6FE' : 'var(--border)'}`,
            }}
          >
            {scheduleLabel(g.update_schedule)}
          </span>
          {running ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium whitespace-nowrap" style={{ color: '#B45309' }}>
              <PulseDot color="#D97706" />
              Standardizing…
            </span>
          ) : g.fully_synced_at ? (
            <span
              className="text-[10px] leading-snug"
              title={`Standardized table last updated ${new Date(g.fully_synced_at).toLocaleString()} — the source was checked and every value was standardized and in the export`}
              style={{ color: 'var(--text-hint)' }}
            >
              Standardized table last updated {relativeTime(g.fully_synced_at)}
            </span>
          ) : null}
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
                {(running || busy) && <Spinner className="w-3 h-3" />}
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
                    borderRadius: 'var(--radius-card)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',  // radius was a hardcoded 6px (UI-01)
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

          {g.status === 'active' && g.update_schedule.type !== 'manual' && (
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
              tableFqn={g.table_fqn}
              onClose={() => setShowExportLookup(false)}
            />
          )}

          <button
            onClick={() => onDelete(g)}
            disabled={busy}
            className="w-7 h-7 flex items-center justify-center rounded-button border-[0.5px] transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
            onMouseEnter={e => { if (busy) return; (e.currentTarget as HTMLButtonElement).style.borderColor = '#FCA5A5'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
            title="Delete pipeline"
          >
            {deleting ? (
              <Spinner className="w-3 h-3" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M2 3.5h9M5 3.5V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1M5.5 6v3.5M7.5 6v3.5M3 3.5l.5 7a.5.5 0 00.5.5h5a.5.5 0 00.5-.5l.5-7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Status messages (persistent reasons while paused/blocked) ─────── */}
      {messages.map(c => (
        c.status_reason === 'table_mode_access' ? (
          <TableModeAccessBanner
            key={`msg-${c.pipeline_id}`}
            pipeline={c}
            multiColumn={g.columns.length > 1}
            onFixAccess={onFixAccess}
          />
        ) : (
          <div
            key={`msg-${c.pipeline_id}`}
            className="px-4 py-2 text-[11px]"
            style={{ backgroundColor: '#FFFBEB', borderTop: '0.5px solid #FDE9C8', color: '#BA7517' }}
          >
            {g.columns.length > 1 && <span className="font-medium">{c.column_name}: </span>}
            {c.status_message}
          </div>
        )
      ))}

      {/* ── Expanded detail ──────────────────────────────────────────────── */}
      {isExpanded && (
        <PipelineDetail
          group={g}
          initialTab={(expandedTab as 'activity' | 'mappings' | 'queue' | 'settings' | null) ?? 'activity'}
          isStandardizing={running}
          specsById={specsById}
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
// authoring a spec (description + optional rules/convention) for each. Creates
// pending_baseline pipelines that share the table's export file, then the parent
// opens the review wizard for them.
export type AddColumnSelection = { column_name: string; spec: ReturnType<typeof columnSpecDraftToApiSpec> };

function AddColumnModal({
  group, columns, ctStatus, busy, onCancel, onSubmit,
}: {
  group:    PipelineGroup;
  columns:  string[];
  ctStatus?: 'enabled' | 'available' | 'no_pk';
  busy:     boolean;
  onCancel: () => void;
  onSubmit: (selections: AddColumnSelection[], ctConsent: boolean) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [specByCol, setSpecByCol] = useState<Record<string, ColumnSpecDraft>>({});
  const [ctConsent, setCtConsent] = useState(false);

  function toggle(col: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else { next.add(col); setSpecByCol(p => (p[col] ? p : { ...p, [col]: emptyColumnSpecDraft() })); }
      return next;
    });
  }

  const selections: AddColumnSelection[] = [...checked]
    .map(col => {
      const d = specByCol[col];
      return d && columnSpecDraftValid(d) ? { column_name: col, spec: columnSpecDraftToApiSpec(d) } : null;
    })
    .filter((s): s is AddColumnSelection => s !== null);
  // Structural gate only; incomplete specs are directed, not silently disabled.
  const canSubmit = !busy && checked.size > 0;
  const specsIncomplete = selections.length !== checked.size;

  function attemptSubmit() {
    if (specsIncomplete) return; // the directed hint below already explains why
    onSubmit(selections, ctStatus === 'available' && ctConsent);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} onClick={busy ? undefined : onCancel}>
      <div
        className="rounded-card border-[0.5px] w-full max-w-lg mx-4"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Standardize another column</h3>
        <p className="text-xs mb-4 font-mono truncate" style={{ color: 'var(--text-muted)' }} title={group.table_fqn}>{group.table_fqn}</p>

        <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>Pick the column(s) to standardize and describe each.</p>

        <div className="flex flex-col gap-2 mb-4 overflow-y-auto" style={{ maxHeight: '52vh' }}>
          {columns.map((col) => {
            const on = checked.has(col);
            return (
              <div
                key={col}
                className="rounded-button border-[0.5px] flex items-center gap-3 px-3 py-2"
                style={{ borderColor: on ? 'var(--accent-border)' : 'var(--border)', backgroundColor: on ? 'var(--accent-tint)' : 'var(--surface)' }}
              >
                <button
                  type="button"
                  onClick={() => toggle(col)}
                  disabled={busy}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                  style={{ background: 'none', border: 'none', padding: 0 }}
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
                  <ColumnSpecField
                    variant="inline"
                    value={specByCol[col] ?? emptyColumnSpecDraft()}
                    onChange={d => setSpecByCol(prev => ({ ...prev, [col]: d }))}
                    disabled={busy}
                    columnName={col}
                  />
                )}
              </div>
            );
          })}
        </div>

        {canSubmit && specsIncomplete && (
          <div className="flex items-center gap-2 rounded-button border-[0.5px] px-3 py-2 mb-3 text-xs" style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
            <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, backgroundColor: '#F59E0B' }} />
            Add standardization specs to each selected column before creating.
          </div>
        )}

        {/* Column-mode pipelines edit the source table — restate the consent
            for each newly added companion column (sent as column_write_consent). */}
        {group.export_kind === 'column' && checked.size > 0 && (
          <div className="rounded-button border-[0.5px] px-3 py-2 mb-3 text-xs leading-relaxed" style={{ backgroundColor: '#FFF7ED', borderColor: '#FED7AA', color: '#7C2D12' }}>
            This pipeline uses the Column output: creating these standardizations adds a new{' '}
            <span className="font-mono">&lt;column&gt;_STANDARDIZED</span> column to{' '}
            <span className="font-mono">{tableShort(group.table_fqn)}</span> for each selected column and keeps it updated.
            Prism will not modify any other column. In the unlikely event of an error, Prism is not
            liable for consequences of modified or erased source data.
          </div>
        )}

        {/* SQL Server only — offered once per table, same as the connect form. */}
        {ctStatus === 'available' && checked.size > 0 && (
          <div className="rounded-button border-[0.5px] px-3 py-2 mb-3 text-xs leading-relaxed" style={{ backgroundColor: '#EFF6FF', borderColor: '#BFDBFE', color: '#1E3A8A' }}>
            <p className="font-semibold mb-1" style={{ color: '#1E40AF' }}>Enable Change Tracking on this table?</p>
            <p className="mb-1.5">
              Lets Prism spot new, changed, or deleted values within about a minute instead of on a
              scheduled scan. Runs <span className="font-mono">ALTER DATABASE ... SET CHANGE_TRACKING = ON</span>{' '}
              and <span className="font-mono">ALTER TABLE ... ENABLE CHANGE_TRACKING</span> against your SQL
              Server (using your saved personal credentials if the service login can&apos;t make schema changes
              itself). Optional — Prism falls back to scheduled scans automatically.
            </p>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ctConsent}
                onChange={e => setCtConsent(e.target.checked)}
                disabled={busy}
                className="mt-0.5"
                style={{ accentColor: '#1D4ED8' }}
              />
              <span className="font-medium" style={{ color: '#1E40AF' }}>
                Yes, have Prism try to enable Change Tracking on this table automatically.
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button" onClick={onCancel} disabled={busy}
            className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={attemptSubmit} disabled={!canSubmit || specsIncomplete}
            className="px-4 py-2 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={e => { if (canSubmit && !specsIncomplete) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
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
  const warehouseLabel = useWarehouseLabel();
  const router = useRouter();
  const [pipelines,     setPipelines]     = useState<Pipeline[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [busyKey,          setBusyKey]          = useState<string | null>(null);  // group key running a pause/delete/review action
  const [deletingKey,      setDeletingKey]      = useState<string | null>(null);  // group key with a delete in flight (drives the trash spinner)
  const [autoStdBusyKey,  setAutoStdBusyKey]   = useState<string | null>(null); // group key running an auto-standardize fetch
  const [expandedKey,    setExpandedKey]   = useState<string | null>(null);
  const [expandedTab,   setExpandedTab]   = useState<string | null>(null);
  const [search,        setSearch]        = useState('');
  const [autoExpanded,  setAutoExpanded]  = useState(false);
  const [standardizingPipelines, setStandardizingPipelines] = useState<Set<number>>(new Set());
  const [alerts,        setAlerts]        = useState<Alert[]>([]);
  // Re-render every 30 s so relative labels ("Updated 5m ago") stay fresh even
  // when no SSE event lands (e.g. paused pipelines) — no page reload needed.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Full column-spec records for each column's spec tooltip (keyed by spec_id,
  // which lives in the column/pipeline's historical `domain_id` slot).
  const [specsById, setSpecsById] = useState<Map<number, ColumnSpec>>(new Map());
  useEffect(() => {
    fetch('/api/column-specs')
      .then(r => r.json())
      .then(b => {
        const m = new Map<number, ColumnSpec>();
        for (const s of (b.specs ?? []) as ColumnSpec[]) m.set(Number(s.spec_id), s);
        setSpecsById(m);
      })
      .catch(() => {});
  }, []);

  // Column ordinal positions per table_fqn — used to order columns within a card.
  const [columnOrders, setColumnOrders] = useState<Map<string, Record<string, number>>>(new Map());
  // Per-table eligible (text) column names, used to offer "Standardize another column".
  const [tableFields,  setTableFields]  = useState<Map<string, { name: string; isText: boolean }[]>>(new Map());
  // SQL Server only — per-table Change Tracking status ('ct_status' is absent
  // from the /api/columns response on Snowflake). Drives AddColumnModal's
  // disclosure for adding a column to a CT-eligible-but-not-yet-enabled table.
  const [tableCtStatus, setTableCtStatus] = useState<Map<string, 'enabled' | 'available' | 'no_pk'>>(new Map());
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
          table:     t,
          columns:   body.columns as Record<string, number> ?? {},
          fields:    (body.fields as { name: string; isText: boolean }[]) ?? [],
          ct_status: body.ct_status as 'enabled' | 'available' | 'no_pk' | undefined,
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
      setTableCtStatus(prev => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.ct_status) next.set(r.value.table, r.value.ct_status);
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
        } else if (event.type === 'standardizing_started' && event.pipeline_id != null) {
          setStandardizingPipelines(prev => new Set([...prev, event.pipeline_id!]));
        } else if (event.type === 'standardizing_finished' && event.pipeline_id != null) {
          setStandardizingPipelines(prev => {
            const next = new Set(prev);
            next.delete(event.pipeline_id!);
            return next;
          });
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
  }, [fetchPipelines]);

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
        if (res.ok) return { m, ok: true as const, error: null };
        // Surface the server's reason — a refused resume (e.g. the native
        // access preflight's 409) carries the exact fix; the old generic
        // "please try again" hid it and made the flip look like a mystery.
        const body = await res.json().catch(() => ({}));
        return { m, ok: false as const, error: typeof body?.error === 'string' ? body.error : null };
      } catch {
        return { m, ok: false as const, error: null };
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
      const reason = failed.find(f => f.error)?.error;
      showToast(reason ?? `Couldn't ${verb} ${what}. Please try again.`, 'error');
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

  async function handleFixAccess(pipelineId: number): Promise<{ fixed: boolean; error?: string; manual_sql?: string }> {
    try {
      const res  = await fetch(`/api/pipelines/${pipelineId}/fix-access`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { fixed: false, error: body?.error ?? `HTTP ${res.status}` };
      if (body.fixed) {
        showToast('Access granted — export rebuilt.', 'info');
        await fetchPipelines();
      }
      return { fixed: Boolean(body.fixed), error: body.error, manual_sql: body.manual_sql };
    } catch {
      return { fixed: false, error: "Couldn't reach the server — check your connection." };
    }
  }

  async function handleDelete(g: PipelineGroup) {
    const label = `${groupName(g)}${g.columns.length > 1 ? ` (${g.columns.length} columns)` : ''}`;
    if (!confirm(`Delete the pipeline for ${label}? This cannot be undone.`)) return;
    setBusyKey(g.key);
    setDeletingKey(g.key);
    try {
      // Dedup: virtual multi-column entries share a pipeline_id; only delete each once.
      const seen = new Set<number>();
      const results = await Promise.all(
        g.columns
          .filter(m => { if (seen.has(m.pipeline_id)) return false; seen.add(m.pipeline_id); return true; })
          .map(async m => {
            try {
              const res = await fetch(`/api/pipelines/${m.pipeline_id}`, { method: 'DELETE' });
              if (res.ok) return { id: m.pipeline_id, ok: true as const, error: null };
              const body = await res.json().catch(() => ({}));
              return { id: m.pipeline_id, ok: false as const, error: typeof body?.error === 'string' ? body.error : null };
            } catch {
              return { id: m.pipeline_id, ok: false as const, error: null };
            }
          }),
      );
      // Only remove what the server actually deleted — a swallowed failure
      // here made the card vanish and then reappear on the next refetch.
      const deletedIds = new Set(results.filter(r => r.ok).map(r => r.id));
      setPipelines(prev => prev.filter(x => !deletedIds.has(x.pipeline_id)));
      const firstError = results.find(r => !r.ok);
      if (firstError) {
        showToast(firstError.error ?? `Couldn't delete ${label}. Please try again.`, 'error');
      } else if (expandedKey === g.key) {
        setExpandedKey(null);
      }
    } finally { setBusyKey(null); setDeletingKey(null); }
  }

  // Delete a single column from a card (per-column delete in Settings).
  async function handleDeleteMember(p: Pipeline) {
    try {
      const res = await fetch(`/api/pipelines/${p.pipeline_id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(typeof body?.error === 'string' ? body.error : `Couldn't delete ${p.column_name}. Please try again.`, 'error');
        return;
      }
    } catch {
      showToast(`Couldn't delete ${p.column_name}. Please try again.`, 'error');
      return;
    }
    setPipelines(prev => prev.filter(x => x.pipeline_id !== p.pipeline_id));
  }

  function handleUpdateMember(p: Pipeline, patch: Partial<Pipeline>) {
    setPipelines(prev => prev.map(x => x.pipeline_id === p.pipeline_id ? { ...x, ...patch } : x));
  }

  // Open a review wizard over the given columns. kind='create' builds runs from
  // the full source (create-initial-run); kind='standardize' builds them from the
  // queue (standardize-run, the manual trigger). Walks the column wizard so a
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
      // Say so: this used to be a silent no-op, and with the card showing
      // "Unstandardized" values the owner read it as a broken button (2026-09-14).
      if (kind === 'standardize') {
        showToast(
          `Nothing to standardize — every value in ${columns.map(c => c.column_name).join(', ')} is already standardized.`,
          'info',
        );
      }
      await fetchPipelines();
      setBusyKey(null);
    } catch {
      showToast('Couldn’t start the review — check your connection and try again.', 'error');
      setBusyKey(null);
    }
  }

  // Update Standardizations — runs the standardization pass directly now that the
  // per-domain mappings editor is gone. (Specs are per-column; there is no shared
  // domain library page to open.)
  function handleUpdateStandardizations(g: PipelineGroup) {
    void handleAutoStandardize(g);
  }

  // Auto Standardize — fire process-queue for every unique pipeline in the group.
  // Virtual multi-column entries share a pipeline_id; dedup so we call once per pipeline.
  // Also expand the card so the progress ring/activity is visible while it runs.
  async function handleAutoStandardize(g: PipelineGroup) {
    setExpandedKey(g.key);
    setExpandedTab('activity');
    setAutoStdBusyKey(g.key);
    // The route used to answer an empty queue with a silent 200, so with
    // "Unstandardized: 1" showing on the card this button visibly did nothing
    // (2026-09-14). Now it reconciles the source first and we always say what
    // happened — how many values were standardized, or that nothing needed it.
    let processed = 0;
    let anyOk = false;
    try {
      const seen = new Set<number>();
      for (const col of g.columns) {
        if (seen.has(col.pipeline_id)) continue;
        seen.add(col.pipeline_id);
        try {
          const res = await fetch(`/api/pipelines/${col.pipeline_id}/process-queue`, { method: 'POST' });
          const body = (await res.json().catch(() => ({}))) as { error?: string; literals_processed?: number };
          if (!res.ok) {
            showToast(
              `Auto-standardize failed for ${col.column_name}${body?.error ? `: ${body.error}` : '.'}`,
              'error',
            );
            continue;
          }
          anyOk = true;
          processed += Number(body?.literals_processed ?? 0) || 0;
        } catch {
          showToast(`Auto-standardize failed for ${col.column_name} — check your connection.`, 'error');
        }
      }
      if (anyOk) {
        const cols = g.columns.map(c => c.column_name).join(', ');
        showToast(
          processed > 0
            ? `Standardized ${processed.toLocaleString()} value${processed === 1 ? '' : 's'} in ${cols}.`
            : `Nothing to standardize — every value in ${cols} is already standardized.`,
          'info',
        );
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
  // export file + update schedule), then open the review wizard for them.
  async function handleAddColumns(g: PipelineGroup, selections: AddColumnSelection[], ctConsent: boolean) {
    setAddColumnGroup(null);
    if (selections.length === 0) return;
    setBusyKey(g.key);
    const created: Pipeline[] = [];
    for (const sel of selections) {
      try {
        const res  = await fetch('/api/pipelines', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            table_fqn:            g.table_fqn,
            column_name:          sel.column_name,
            spec:                 sel.spec,
            export_table_fqn:     g.export_table_fqn,
            // Without this, a new sibling silently reverted to 'table' — which
            // for view groups broke the shared view, and for column groups
            // would trip the source==destination rebuild guard.
            export_kind:          g.export_kind,
            // Consent restated in AddColumnModal's notice for column groups —
            // the server refuses a new column-mode pipeline without it.
            ...(g.export_kind === 'column' ? { column_write_consent: true } : {}),
            ...(ctConsent ? { change_tracking_consent: true } : {}),
            update_schedule:      g.update_schedule,
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

  // Filter by search (matches on table, any column name, export)
  const filtered = ready.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      displayName(p).toLowerCase().includes(q) ||
      p.table_fqn.toLowerCase().includes(q) ||
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
            ctStatus={tableCtStatus.get(addColumnGroup.table_fqn)}
            busy={busyKey === addColumnGroup.key}
            onCancel={() => setAddColumnGroup(null)}
            onSubmit={(sel, ctConsent) => handleAddColumns(addColumnGroup, sel, ctConsent)}
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
              placeholder="Search by name, table, column spec…"
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
            Use the Connect tab to set up your first {warehouseLabel} pipeline.
          </p>
        </div>
      )}

      {!loading && !error && pipelines.length > 0 && tableGroups.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ opacity: 0.2 }}>
            <rect x="4" y="12" width="40" height="26" rx="5" stroke="currentColor" strokeWidth="2.5" />
            <path d="M16 24h16M16 30h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="38" cy="12" r="6" fill="currentColor" />
          </svg>
          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Pipeline setup not complete</p>
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 280 }}>
            Your pipeline was created but the initial review wasn&apos;t finished. Go to the Connect tab to continue or cancel it.
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
              gridTemplateColumns: '20px minmax(140px,2fr) 100px 170px 1fr',
              padding: '0 16px',
              gap: 14,
              color: 'var(--text-muted)',
            }}
          >
            <span />
            <span>Pipeline</span>
            <span>Status</span>
            <span>Updates</span>
            <span className="text-right">Actions</span>
          </div>

          <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-card)', overflow: 'hidden', backgroundColor: 'var(--surface)' }}>
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
                onFixAccess={handleFixAccess}
                busy={busyKey === g.key}
                deleting={deletingKey === g.key}
                running={g.columns.some(c => standardizingPipelines.has(c.pipeline_id)) || autoStdBusyKey === g.key}
                specsById={specsById}
              />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
