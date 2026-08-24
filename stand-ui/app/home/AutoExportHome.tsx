'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { isNativeEdition } from '@/app/api/_lib/edition';
import NativeTablePicker from '@/app/components/NativeTablePicker';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  emptyColumnSpecDraft, columnSpecDraftValid, columnSpecDraftToApiSpec,
  type ColumnSpecDraft,
} from '@/app/components/ColumnSpecEditor';
import ColumnSpecField from '@/app/components/ColumnSpecField';
import PipelinesView, { type Pipeline } from './PipelinesView';
import OneTimeArchiveView from './OneTimeArchiveView';
import OneTimeStandardizationCard from './OneTimeStandardizationCard';
import UpdateScheduleEditor from '@/app/components/UpdateScheduleEditor';
import { buildMssqlDataAccessSql } from '@/app/components/mssql-access-sql';
import { DEFAULT_UPDATE_SCHEDULE, type UpdateSchedule } from '@/app/api/_lib/update-schedule';

// ── Layout ──────────────────────────────────────────────────────────────────────
const SIDEBAR_WIDTH = 228;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColumnEntry {
  id:         string;
  columnName: string;
  spec:       ColumnSpecDraft;
}

let _entryCounter = 0;
function mkEntry(overrides: Partial<ColumnEntry> = {}): ColumnEntry {
  return {
    id:         `e${++_entryCounter}`,
    columnName: '',
    spec:       emptyColumnSpecDraft(),
    ...overrides,
  };
}

function suggestExport(tableFqn: string, warehouseKind?: string): string {
  const t = tableFqn.trim();
  if (!t) return '';
  // SQL Server: default the output into the PRISM_OUT export schema — the
  // schema the setup wizard's Part C creates and grants (building in the
  // source schema would need CREATE TABLE + ALTER on that schema, which
  // onboarding deliberately does not give Prism).
  if (warehouseKind === 'mssql') {
    const parts = t.split('.');
    if (parts.length === 3) return `${parts[0]}.PRISM_OUT.${parts[2]}_STANDARDIZED`;
  }
  return `${t}_STANDARDIZED`;
}

function tableShortName(fqn: string): string {
  if (fqn.startsWith('SHEETS:')) {
    const parts = fqn.split(':');
    return parts[2] || 'Google Sheet';
  }
  const parts = fqn.split('.');
  return parts[parts.length - 1] || fqn;
}

// Demo-data mode: prefills the connect form with the seeded TEST_DB demo table.
// Off by default so real customers see a clean empty form.
const DEMO_DATA = process.env.NEXT_PUBLIC_PRISM_DEMO_DATA === 'true';

// ── Prism mark ────────────────────────────────────────────────────────────────
// ── Sidebar / step icons ────────────────────────────────────────────────────────
function IconConnect() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 9h8M7 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="17" cy="5" r="2.5" fill="currentColor" />
    </svg>
  );
}

function IconClassify() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M4 11h4l2-4 3 8 2-4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAutoExport() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M11 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 9.5L11 13l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v3.5A1.5 1.5 0 005.5 19h11a1.5 1.5 0 001.5-1.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGuide() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M4 4.5A1.5 1.5 0 015.5 3H10v15H5.5A1.5 1.5 0 004 19V4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 4.5A1.5 1.5 0 0016.5 3H12v15h4.5a1.5 1.5 0 011.5 1V4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Column picker ─────────────────────────────────────────────────────────────
// Lists the source table's columns and lets the user check the ones to
// standardize; each checked column gets an inline domain picker.

interface TableColumn { name: string; type: string; isText: boolean }

function ColumnPicker({
  columns, loading, error, hasTable,
  entries, existingColNames, busy,
  onToggle, onSetSpec,
}: {
  columns:          TableColumn[];
  loading:          boolean;
  error:            string | null;
  hasTable:         boolean;
  entries:          ColumnEntry[];
  existingColNames: Set<string>;
  busy:             boolean;
  onToggle:         (name: string) => void;
  onSetSpec:        (name: string, spec: ColumnSpecDraft) => void;
}) {
  const [filter, setFilter] = useState('');
  const specOf = (name: string) =>
    entries.find(e => e.columnName.toUpperCase() === name.toUpperCase())?.spec ?? emptyColumnSpecDraft();
  const isSelected = (name: string) =>
    entries.some(e => e.columnName.toUpperCase() === name.toUpperCase());

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 rounded-[10px] border-[0.5px]" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
        <Spinner /><span className="text-xs" style={{ color: 'var(--text-muted)' }}>Reading columns…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-[10px] border-[0.5px] px-3.5 py-3 text-xs leading-relaxed" style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
        {error}
      </div>
    );
  }
  if (!hasTable || columns.length === 0) {
    return (
      <div className="rounded-[10px] border-[0.5px] px-3.5 py-5 text-center text-xs" style={{ borderColor: 'var(--border)', borderStyle: 'dashed', color: 'var(--text-hint)' }}>
        {hasTable ? 'No columns found for this table.' : 'Enter a source table above to choose its columns.'}
      </div>
    );
  }

  const showFilter = columns.length > 8;
  const visible = filter
    ? columns.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    : columns;

  return (
    <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ borderColor: 'var(--border)' }}>
      {showFilter && (
        <div className="px-2.5 py-2" style={{ borderBottom: '0.5px solid var(--border)', backgroundColor: 'var(--page-bg)' }}>
          <div className="relative">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>
              <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              type="text" value={filter} onChange={e => setFilter(e.target.value)}
              placeholder="Filter columns…"
              className="w-full text-xs rounded-button border-[0.5px] outline-none pl-7 pr-3 py-1.5"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      )}
      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        {visible.map((col, i) => {
          const selected = isSelected(col.name);
          const already  = existingColNames.has(col.name.toUpperCase());
          const blocked  = already || !col.isText;
          const disabled = blocked || busy;
          return (
            <div key={col.name} style={{ borderTop: i > 0 ? '0.5px solid var(--border)' : undefined }}>
              <div
                className="w-full flex items-center gap-3 px-3 py-2.5 transition-colors"
                style={{ backgroundColor: selected ? 'var(--accent-tint)' : 'transparent', opacity: blocked ? 0.55 : 1 }}
                onMouseEnter={e => { if (!disabled && !selected) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(col.name)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                  style={{ background: 'none', border: 'none', padding: 0 }}
                >
                  <span
                    className="flex items-center justify-center flex-shrink-0"
                    style={{ width: 18, height: 18, borderRadius: 5, border: `0.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, backgroundColor: selected ? 'var(--accent)' : 'var(--surface)' }}
                  >
                    {selected && (
                      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="font-mono text-sm truncate" style={{ color: 'var(--text-primary)' }}>{col.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-pill uppercase tracking-wide flex-shrink-0" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
                    {col.type.toLowerCase()}
                  </span>
                </button>
                {already && (
                  <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-pill flex-shrink-0 whitespace-nowrap" style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}>
                    Already standardized
                  </span>
                )}
                {!already && !col.isText && (
                  <span className="ml-auto text-[10px] flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--text-hint)' }}>
                    non-text
                  </span>
                )}
                {selected && (
                  <ColumnSpecField
                    variant="inline"
                    value={specOf(col.name)}
                    onChange={s => onSetSpec(col.name, s)}
                    disabled={busy}
                    columnName={col.name}
                  />
                )}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--text-hint)' }}>No columns match "{filter}".</p>
        )}
      </div>
    </div>
  );
}

// ── Export table disclosure ───────────────────────────────────────────────────
// warehouseLabel is a PROP, not hardcoded: this panel is the privilege
// disclosure an admin reads before activating a pipeline, and it said
// "Snowflake changes" / "Required Snowflake privileges" verbatim on a SQL
// Server install — naming a warehouse the customer does not have, in the one
// place they are being asked to grant access (SEC-07). The surrounding
// component already computed the right label and used it nearby.
function ExportTableDisclosure({ exportTableFqn, exportKind = 'table', warehouseLabel = 'Snowflake' }: { exportTableFqn: string; exportKind?: 'table' | 'view' | 'column'; warehouseLabel?: string }) {
  const [open, setOpen] = useState(false);
  const isView   = exportKind === 'view';
  const isColumn = exportKind === 'column';
  const exportTable = exportTableFqn.trim() || (isView ? 'DB.SCHEMA.TABLE_STANDARDIZED_VIEW' : 'DB.SCHEMA.TABLE_STANDARDIZED');

  return (
    <div
      className="rounded-[10px] border-[0.5px] mb-4 overflow-hidden"
      style={{ borderColor: '#CBD5E1', backgroundColor: '#F8FAFC' }}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-2.5 px-3.5 py-3 text-left"
        style={{ backgroundColor: 'transparent' }}
      >
        <span
          className="flex items-center justify-center rounded-full flex-shrink-0 mt-0.5"
          style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB' }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <circle cx="5" cy="5" r="4.5" stroke="currentColor" strokeWidth="1"/>
            <path d="M5 4.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="5" cy="3" r="0.6" fill="currentColor"/>
          </svg>
        </span>
        <span className="flex-1 text-xs" style={{ color: '#475569' }}>
          <span className="font-semibold" style={{ color: '#1E40AF' }}>{warehouseLabel} changes: </span>
          {isColumn ? (<>
            Prism will add and maintain a standardized column next to each connected column on{' '}
            <span className="font-mono" style={{ wordBreak: 'break-all' }}>{exportTable}</span>.
          </>) : (<>
            Prism will create{isView ? '' : ' and maintain'}{' '}
            <span className="font-mono" style={{ wordBreak: 'break-all' }}>{exportTable}</span>{' '}
            as a standardized {isView ? 'view' : 'copy'} of your source table.
          </>)}
        </span>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ flexShrink: 0, marginTop: 2, color: '#94A3B8', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          <path d="M2.5 4.5l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 flex flex-col gap-2.5" style={{ borderTop: '0.5px solid #E2E8F0' }}>
          <p className="text-[11px] mt-3" style={{ color: '#64748B' }}>
            {isColumn
              ? 'After each standardization pass, Prism refreshes the standardized column(s) on your source table:'
              : isView
              ? 'The view is created once and always reflects the current data live — nothing to rebuild:'
              : 'After each standardization pass, Prism rebuilds the export table with all confirmed mappings:'}
          </p>
          <ol className="flex flex-col gap-2 mt-0.5">
            <li className="flex gap-2.5 items-start">
              <span className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}>1</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>
                  {isColumn ? 'Standardized column added' : isView ? 'Export view created' : 'Export table created / replaced'}
                </p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  {isColumn ? (<>
                    Each connected column gets a companion column named after it (e.g. CARRIER → CARRIER_STANDARDIZED) on{' '}
                    <span className="font-mono">{exportTable}</span>. It holds the canonical standardized name, and stays empty for rows whose value has no confirmed standardization yet.
                  </>) : (<>
                    <span className="font-mono">{exportTable}</span> — same schema as the source table but with the watched column replaced by the canonical standardized name.
                    Only rows with a confirmed mapping are included.
                  </>)}
                </p>
              </div>
            </li>
            <li className="flex gap-2.5 items-start">
              <span className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}>2</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>
                  {isColumn ? 'Kept in sync on every pass' : isView ? 'Always live — no storage, no rebuilds' : 'Rebuilt on every pass'}
                </p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  {isColumn
                    ? 'Every time new values are standardized, only the rows whose standardized value changed are updated — your source data columns are never modified. This requires Prism to have update access on the source table.'
                    : isView
                    ? 'Every query against the view re-reads the current source and lookup data directly — there is nothing for Prism to keep in sync, but each read does the join work, so it costs more the more it is queried.'
                    : 'Every time new values are standardized the table is fully refreshed — always a complete, consistent snapshot.'}
                </p>
              </div>
            </li>
          </ol>
          <div className="rounded-[8px] px-3 py-2 mt-1" style={{ backgroundColor: '#FFF7ED', border: '0.5px solid #FED7AA' }}>
            <p className="text-[11px]" style={{ color: '#92400E' }}>
              <strong>Required {warehouseLabel} privileges</strong> for the service role:{' '}
              <span className="font-mono">SELECT</span> on the source table,{' '}
              <span className="font-mono">USAGE</span> on the source database and schema,
              and <span className="font-mono">{isView ? 'CREATE VIEW' : 'CREATE TABLE'}</span> on the export schema.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Input style helper ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  borderColor:     'var(--border)',
  backgroundColor: 'var(--surface)',
  color:           'var(--text-primary)',
  fontFamily:      'monospace',
};

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AutoExportHome() {
  const router = useRouter();
  const searchParams = useSearchParams();

  type Tab = 'connect' | 'pipelines' | 'history' | 'how-it-works';
  const [activeTab, setActiveTab] = useState<Tab>('connect');

  // Native first-visit nudge — shown once, dismissed into localStorage.
  const [showNativeIntro, setShowNativeIntro] = useState(false);
  useEffect(() => {
    try {
      if (isNativeEdition() && !localStorage.getItem('prism_native_intro_dismissed')) setShowNativeIntro(true);
    } catch { /* storage unavailable — skip the nudge */ }
  }, []);

  // Switch to the tab specified in the URL (e.g. ?tab=connect from the logo link).
  useEffect(() => {
    const raw = searchParams.get('tab');
    // The old domain-library tab was 'standardizations' — map any stale link to
    // the one-time history tab that replaced it.
    const tab = (raw === 'standardizations' ? 'history' : raw) as Tab | null;
    if (tab && ['connect', 'pipelines', 'history', 'how-it-works'].includes(tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [isAdmin,   setIsAdmin]   = useState<boolean | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => r.json())
      .then(d => { setIsAdmin(d.role === 'admin'); setAccountId(d.accountId ?? null); })
      .catch(() => setIsAdmin(false));
  }, []);

  // ── Warehouse platform — drives copy that must name the right platform
  // ("Snowflake" vs "SQL Server") instead of assuming Snowflake. Defaults to
  // 'snowflake' (this app's historical default) until the fetch resolves.
  const [warehouseKind, setWarehouseKind] = useState<'snowflake' | 'mssql' | 'postgres' | 'mysql'>('snowflake');
  useEffect(() => {
    fetch('/api/accounts/warehouse-kind')
      .then(r => r.json())
      .then(d => { if (d?.kind === 'mssql' || d?.kind === 'snowflake' || d?.kind === 'postgres' || d?.kind === 'mysql') setWarehouseKind(d.kind); })
      .catch(() => {});
  }, []);
  const warehouseLabel = warehouseKind === 'mssql' ? 'SQL Server' : warehouseKind === 'postgres' ? 'PostgreSQL' : warehouseKind === 'mysql' ? 'MySQL' : 'Snowflake';

  // Copy for the Connect tab's "Output types" explainer grid.
  //
  // Kept in step with the ACTUAL picker below, which already drops View on
  // mssql (a view can't reference the per-rebuild staging tables mssql exports
  // use). The explainer did not: an mssql install advertised "one of four
  // outputs" including a "Snowflake view", then offered three — describing a
  // product they don't run and a feature they can't pick (SEC-07 follow-up).
  const outputExplainers = ([
    {
      badge: 'Table',
      cost:  '',
      desc:  'Prism rebuilds a full copy of the source table, with standardized values in place of the raw ones.',
    },
    {
      badge: 'Column',
      cost:  '',
      desc:  'Prism adds a standardized column next to each connected column on your source table — filled in as values are standardized, empty until then.',
    },
    {
      badge: 'View',
      cost:  '',
      desc:  `Prism creates a ${warehouseLabel} view and every query against it automatically shows the applied standardized values.`,
    },
    {
      badge: 'Lookup table',
      cost:  '',
      desc:  "Prism won't create any additional tables. Along with the other output types, it will maintain a lookup table denoting all standardizations.",
    },
  ]).filter(o => o.badge !== 'View' || warehouseKind !== 'mssql');

  // ── Pipeline alert badge ──────────────────────────────────────────────────
  // Snapshot of paused pipelines at page load. Admins see every paused pipeline;
  // standard users only see ones they created. The badge clears once the user
  // opens the Pipelines tab and stays cleared for this page session (it returns
  // on the next fresh load if pipelines are still paused).
  const [pausedPipelines, setPausedPipelines] = useState<Pipeline[]>([]);
  const [pendingBaselinePipelines, setPendingBaselinePipelines] = useState<Pipeline[]>([]);
  const [alertBadgeSeen,  setAlertBadgeSeen]  = useState(false);
  useEffect(() => {
    fetch('/api/pipelines')
      .then(r => r.json())
      .then(b => {
        const all = b.pipelines ?? [];
        setPausedPipelines(all.filter((p: Pipeline) => p.status === 'paused'));
        setPendingBaselinePipelines(all.filter((p: Pipeline) => p.status === 'pending_baseline'));
      })
      .catch(() => {});
  }, []);

  const pausedAlertCount = useMemo(() => {
    if (isAdmin === null) return 0; // identity not resolved yet — don't flash a badge
    return pausedPipelines.filter(p => isAdmin || p.created_by === accountId).length;
  }, [pausedPipelines, isAdmin, accountId]);

  // ── Pipeline DB state ─────────────────────────────────────────────────────
  const [activePipelineId, setActivePipelineId] = useState<number | null>(null);
  const [pendingActivation, setPendingActivation] = useState<Pipeline | null>(null);
  // All sibling pipelines sharing the pending activation's table+export (one per
  // standardized column), so the activation card lists every column, not just one.
  const [pendingSiblings, setPendingSiblings] = useState<Pipeline[]>([]);
  // Progress while "Begin Pipeline Standardization" commits the deferred lookup
  // writes (one step per column) and then activates the pipeline.
  const [beginProgress, setBeginProgress] = useState<{ current: number; total: number; phase: 'writing' | 'starting'; pct: number; etaSec: number | null } | null>(null);
  const [cancellingPipeline, setCancellingPipeline] = useState(false);
  // `continue:<table_fqn>` or `delete:<table_fqn>` while an incomplete-card action is in flight.
  const [incompleteBusyKey, setIncompleteBusyKey] = useState<string | null>(null);
  const beginTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [beginError,    setBeginError]    = useState<string | null>(null);

  // ── Pipeline source type ──────────────────────────────────────────────────
  // Retained as a constant rather than deleted outright: several guards below
  // still read it (notably the export-kind 'view' rule), and hard-coding the
  // only remaining value keeps those reading naturally instead of inverting
  // every condition.
  const pipelineSourceType = 'snowflake' as const;

  // ── Connection form ───────────────────────────────────────────────────────
  // Demo mode prefills the seeded demo table; otherwise start clean.
  const DEFAULT_TABLE = DEMO_DATA ? 'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS' : '';

  const [tableFqn,      setTableFqnRaw]  = useState(DEFAULT_TABLE);
  const [exportTableFqn,    setExportTableFqnRaw]    = useState(DEFAULT_TABLE ? suggestExport(DEFAULT_TABLE) : '');
  const [exportTableEdited, setExportTableEdited]    = useState(false);
  const [columnEntries, setColumnEntries] = useState<ColumnEntry[]>(
    DEMO_DATA
      ? [mkEntry({ columnName: 'RAW_CARRIER_VALUE' }), mkEntry({ columnName: 'RAW_COMPANY_VALUE' })]
      : [mkEntry({})],
  );

  const [loadingStep,    setLoadingStep]    = useState<'idle' | 'validating' | 'processing'>('idle');
  const [setupProgress,  setSetupProgress]  = useState<{ current: number; total: number } | null>(null);
  const [formError,      setFormError]      = useState<string | null>(null);
  // Update time window for the whole table (all columns share it). Defaults to
  // business hours (Mon–Fri, 9 AM–5 PM); the browser timezone is stamped after
  // mount (not in the initializer) to avoid an SSR hydration mismatch.
  const [updateSchedule,    setUpdateSchedule]    = useState<UpdateSchedule>(DEFAULT_UPDATE_SCHEDULE);
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setUpdateSchedule(s => (s.type === 'window' && !s.timezone) ? { ...s, timezone: tz } : s);
    } catch { /* no timezone available — server time applies */ }
  }, []);
  // export_unmapped_rows: when true, source rows whose values have no confirmed
  // standardization yet appear in the export with their raw value; when false
  // (default), only rows with a confirmed mapping appear. Applies to every
  // update schedule — even 24/7 pipelines hold unmapped values between ticks,
  // during large-backlog installment drains, or while paused.
  const [exportUnmappedRows, setExportUnmappedRows] = useState(false);
  // copyMode: whether Prism maintains a rebuilt table copy, a standardized
  // companion column on the source table itself, a live view, or only the
  // raw-value -> standardized-value lookup with no export object at all.
  const [copyMode, setCopyMode] = useState<'table' | 'column' | 'view' | 'lookup_only'>('table');
  // View exports are refused at the mssql write layer (a view can't reference
  // the per-rebuild staging tables mssql exports use — warehouse/mssql/export.ts).
  // warehouseKind resolves asynchronously after 'view' may already be selected
  // (it defaults to 'snowflake' until the fetch above completes), so force the
  // mode back off view the moment mssql is confirmed, not just at selection time.
  useEffect(() => {
    if (warehouseKind === 'mssql' && copyMode === 'view') setCopyMode('table');
  }, [warehouseKind, copyMode]);
  // Only the table and view modes need a separate destination object; column
  // mode writes onto the source table and lookup-only creates nothing.
  const needsExportObject = copyMode === 'table' || copyMode === 'view';
  // Column mode edits the source table — explicit per-table consent, required
  // by the server (column_write_consent). Reset whenever the mode changes.
  const [columnConsent, setColumnConsent] = useState(false);
  useEffect(() => { setColumnConsent(false); }, [copyMode, tableFqn]);

  // Preflight — checked once at submit time (never as-you-type): whatever
  // warehouse permissions are missing for the table/export about to be
  // created (SQL Server only; see /api/pipelines/preflight). Non-empty items
  // pop an approve/cancel modal instead of silently fixing or silently
  // failing later. preflightExport carries the export target the popup
  // should proceed with once approved.
  interface PreflightItem { key: string; label: string; detail: string; }
  const [preflightItems, setPreflightItems] = useState<PreflightItem[] | null>(null);
  // Prism can only apply the preflight grants with a privileged identity —
  // SQL Server forbids a login granting permissions to itself. When the
  // creator has no saved credentials the popup collects them inline, rather
  // than bouncing to Setup and losing this half-filled form (owner request).
  const [preflightNeedsCreds, setPreflightNeedsCreds] = useState(false);
  const [credUser, setCredUser]         = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credError, setCredError]       = useState<string | null>(null);
  const [showFixSql, setShowFixSql]     = useState(false);
  const [preflightExport, setPreflightExport] = useState('');
  const [preflightChecking, setPreflightChecking] = useState(false);
  const [preflightSubmitting, setPreflightSubmitting] = useState(false);

  const loading = loadingStep !== 'idle' || preflightChecking;

  // Snapshot of existing pipelines — used to detect duplicate table+column pairs
  // and to default/steer the export file for a table that already has a pipeline.
  const [existingPipelines, setExistingPipelines] = useState<Pipeline[]>([]);
  useEffect(() => {
    fetch('/api/pipelines')
      .then(r => r.json())
      .then(b => setExistingPipelines(b.pipelines ?? []))
      .catch(() => {});
  }, []);

  // The export file already configured for a table (if any pipeline exists on it).
  // Column-mode pipelines are skipped — their export_table_fqn is the source
  // table itself, which must never be offered as a table/view destination.
  function existingExportForTable(table: string): string | null {
    const t = table.trim();
    const m = existingPipelines.find(p => p.table_fqn === t && p.export_table_fqn && p.export_kind !== 'column');
    return m?.export_table_fqn ?? null;
  }

  // Pending export-file conflict — the entered export differs from the one this
  // table already exports to. The user chooses to reuse it or create a separate one.
  const [exportConflict, setExportConflict] = useState<{ existingExport: string } | null>(null);

  // When source table changes, default the export table: reuse the table's
  // existing export file if it already has a pipeline, else the suggested name.
  function setTableFqn(val: string) {
    setTableFqnRaw(val);
    if (!exportTableEdited) {
      setExportTableFqnRaw(existingExportForTable(val) ?? suggestExport(val, warehouseKind));
    }
  }

  // Once the existing-pipelines snapshot loads, re-default the export file for the
  // current table if the user hasn't edited it and the table already has a pipeline.
  useEffect(() => {
    if (exportTableEdited) return;
    const existing = existingExportForTable(tableFqn);
    if (existing) setExportTableFqnRaw(existing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingPipelines]);

  function setExportTableFqn(val: string) {
    setExportTableFqnRaw(val);
    setExportTableEdited(true);
  }

  // ── Column picker — fetch the source table's columns ──────────────────────
  const [tableColumns,   setTableColumns]   = useState<TableColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError,   setColumnsError]   = useState<string | null>(null);
  const [manualColumns,  setManualColumns]  = useState(false);
  // SQL Server only — 'ct_status' is present in the /api/columns response only
  // when the workspace is on the mssql adapter (absent for Snowflake). Drives
  // the "no primary key" info note below; actual consent now happens in the
  // submit-time preflight popup, not here.
  const [ctStatus, setCtStatus] = useState<'enabled' | 'available' | 'no_pk' | null>(null);
  // mssql only — true when the columns probe answered "the service login
  // can't see this table": the inline access-SQL panel renders the exact
  // grant statements for the typed table (owner request 2026-08-17 — an
  // access error must hand over the fix, not just point at the wizard).
  const [needsGrantSql, setNeedsGrantSql] = useState(false);
  const [grantSqlCopied, setGrantSqlCopied] = useState(false);

  useEffect(() => {
    const t = tableFqn.trim();
    // Postgres accepts the 2-part schema.table form too — a connection is
    // bound to one database, so the database part is implied. MySQL is
    // EXACTLY 2-part (database.table — no schema level).
    const partCount = t.split('.').filter(Boolean).length;
    const validFqn = warehouseKind === 'mysql'
      ? partCount === 2
      : partCount === 3 || (warehouseKind === 'postgres' && partCount === 2);
    if (!validFqn) {
      setTableColumns([]); setColumnsError(null); setColumnsLoading(false); setCtStatus(null); setNeedsGrantSql(false);
      return;
    }
    let cancelled = false;
    setColumnsLoading(true); setColumnsError(null); setNeedsGrantSql(false); setGrantSqlCopied(false);
    const timer = setTimeout(async () => {
      try {
        // `for=pipeline` so an access failure gets the remedy that applies HERE
        // (an admin grant to the service connection), not the one-time flow's
        // "connect your own credentials" — which cannot help a pipeline (PIPE-01).
        const res  = await fetch(`/api/columns?table_fqn=${encodeURIComponent(t)}&for=pipeline`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setColumnsError(body?.error ?? 'Could not read this table — check the name and that the service role has access.');
          setNeedsGrantSql(false);
          setTableColumns([]);
          setCtStatus(null);
        } else if ((body?.fields?.length ?? 0) === 0 && body?.error) {
          // A 200 that still carries an error. /api/columns answers 200 with
          // `fields: []` + an explanatory `error` when the service role cannot
          // see the table (INFORMATION_SCHEMA returns zero rows for an ungranted
          // table rather than failing), so checking only `!res.ok` threw that
          // explanation away and the picker fell through to a bare "No columns
          // found for this table" — which reads as "wrong name" when the real
          // cause is missing access. The sibling one-time card already handled
          // this correctly; the connect form did not (PIPE-01).
          //
          // On mssql this also lights up the inline access-SQL panel below the
          // picker — the exact grant statements for the typed table, so nobody
          // has to walk back to the wizard to find them.
          setColumnsError(body.error);
          setNeedsGrantSql(warehouseKind === 'mssql');
          setTableColumns([]);
          setCtStatus(null);
        } else {
          const fields = (body.fields ?? []) as TableColumn[];
          setTableColumns(fields);
          setCtStatus(body?.ct_status ?? null);
          // Keep only entries that are REAL, TEXT-eligible columns of THIS
          // table, once each. Entries survive table changes and fetch errors
          // (only this success branch can validate them), so a stale,
          // duplicate, empty, or non-text leftover — reachable via manual
          // mode or an errored previous table — could linger invisibly:
          // the count read "2 selected" with one visible checkbox and the
          // create button silently disabled (live-found 2026-08-18, A3).
          const textNames = new Set(fields.filter(f => f.isText).map(f => f.name.toUpperCase()));
          setColumnEntries(prev => {
            const seen = new Set<string>();
            const kept = prev.filter(e => {
              const n = e.columnName.trim().toUpperCase();
              if (!n || !textNames.has(n) || seen.has(n)) return false;
              seen.add(n);
              return true;
            });
            return kept.length === prev.length ? prev : kept;
          });
        }
      } catch {
        if (!cancelled) { setColumnsError('Could not read this table — check the name and access.'); setTableColumns([]); setCtStatus(null); }
      } finally {
        if (!cancelled) setColumnsLoading(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tableFqn, warehouseKind]);

  // Columns of the current table that already have a live pipeline (uppercased).
  // pending_baseline pipelines are incomplete setups and should not block.
  const existingColNames = useMemo(() => {
    const t = tableFqn.trim();
    // Case-INSENSITIVE table match: both warehouses resolve identifiers
    // case-insensitively, so `db.s.T` and `DB.S.T` are the same physical table.
    // Comparing them exactly let the same column be connected twice under a
    // different casing, silently bypassing the already-connected guard
    // (PIPE-01). The server-side dedup now uses COLLATE NOCASE for the same
    // reason.
    const tKey = t.toUpperCase();
    return new Set(existingPipelines.filter(p => (p.table_fqn ?? '').toUpperCase() === tKey && p.status !== 'pending_baseline').map(p => p.column_name.toUpperCase()));
  }, [existingPipelines, tableFqn]);

  // Toggle a column's selection (add/remove a column entry by name).
  function toggleColumnSelection(name: string) {
    setColumnEntries(prev => {
      const existing = prev.find(e => e.columnName.toUpperCase() === name.toUpperCase());
      if (existing) return prev.filter(e => e !== existing);
      return [...prev, mkEntry({ columnName: name })];
    });
  }

  function setColumnSpecByName(name: string, spec: ColumnSpecDraft) {
    setColumnEntries(prev => prev.map(e =>
      e.columnName.toUpperCase() === name.toUpperCase() ? { ...e, spec } : e));
  }

  function updateEntryColumn(id: string, columnName: string) {
    setColumnEntries(prev => prev.map(e =>
      e.id !== id ? e : { ...e, columnName }
    ));
  }

  function updateEntrySpec(id: string, spec: ColumnSpecDraft) {
    setColumnEntries(prev => prev.map(e =>
      e.id !== id ? e : { ...e, spec }
    ));
  }

  function addEntry() {
    setColumnEntries(prev => [...prev, mkEntry()]);
  }

  function removeEntry(id: string) {
    setColumnEntries(prev => prev.length > 1 ? prev.filter(e => e.id !== id) : prev);
  }

  // ── Restore from localStorage on mount ───────────────────────────────────
  useEffect(() => {
    const activePidStr = sessionStorage.getItem('prism_ae_active_pid');
    sessionStorage.removeItem('prism_ae_jump_pipelines'); // legacy key — clear if present

    if (activePidStr) {
      const pid = Number(activePidStr);
      if (Number.isFinite(pid) && pid > 0) {
        setActivePipelineId(pid);
      }
    }

    const pendingId = localStorage.getItem('prism_ae_pending_pipeline_id');
    if (pendingId) {
      localStorage.removeItem('prism_ae_pending_pipeline_id');
      const pid = Number(pendingId);
      if (!Number.isFinite(pid) || pid <= 0) return;

      function applyActivation(pl: Pipeline, siblings: Pipeline[]) {
        setTableFqnRaw(pl.table_fqn);
        setExportTableFqnRaw(pl.export_table_fqn ?? '');
        setExportTableEdited(!!pl.export_table_fqn);
        // Specs aren't re-edited on the activation card; start each column with a
        // blank spec draft (the real spec already lives in column_specs).
        setColumnEntries((siblings.length > 0 ? siblings : [pl]).map(p => mkEntry({
          columnName: p.column_name,
        })));
        setPendingSiblings(siblings);
        setPendingActivation(pl);
      }

      // Fast path: run page pre-fetched the data — show the card immediately.
      const cached = sessionStorage.getItem('prism_ae_activation_data');
      if (cached) {
        sessionStorage.removeItem('prism_ae_activation_data');
        try {
          const { pl, siblings } = JSON.parse(cached) as { pl: Pipeline; siblings: Pipeline[] };
          if (pl?.pipeline_id === pid) { applyActivation(pl, siblings); return; }
        } catch { /* fall through */ }
      }

      // Slow path fallback: fetch pipelines from API.
      fetch('/api/pipelines')
        .then(r => r.json())
        .then(body => {
          const allPls = (body.pipelines ?? []) as Pipeline[];
          const pl: Pipeline | undefined = allPls.find((p) => p.pipeline_id === pid);
          if (!pl) return;
          const siblings = allPls
            .filter(p => p.table_fqn === pl.table_fqn &&
              (pl.export_table_fqn ? p.export_table_fqn === pl.export_table_fqn : p.pipeline_id === pl.pipeline_id))
            .sort((a, b) => a.pipeline_id - b.pipeline_id);
          applyActivation(pl, siblings);
        })
        .catch(() => {});
      return;
    }

    const raw = localStorage.getItem('prism_ae_pending_connect');
    if (!raw) return;
    localStorage.removeItem('prism_ae_pending_connect');
    try {
      const { table_fqn, column_name } = JSON.parse(raw);
      if (!table_fqn || !column_name) return;
      setTableFqnRaw(table_fqn);
      setExportTableFqnRaw(suggestExport(table_fqn, warehouseKind));
      setExportTableEdited(false);
      setColumnEntries([mkEntry({ columnName: column_name })]);
    } catch { /* malformed — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect handler ───────────────────────────────────────────────────────
  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const table  = tableFqn.trim();
    const exportTable = exportTableFqn.trim();
    if (!table || loading) return;

    if (needsExportObject && !exportTable) {
      setFormError(copyMode === 'view' ? 'Export view is required.' : 'Export table is required.');
      return;
    }
    if (copyMode === 'column' && !columnConsent) {
      setFormError('The Column output edits the source table — please check the consent box in the warning above to continue.');
      return;
    }
    if (columnEntries.length === 0) {
      setFormError('Select at least one column to standardize.');
      return;
    }
    for (let i = 0; i < columnEntries.length; i++) {
      const entry = columnEntries[i];
      if (!entry.columnName.trim()) {
        setFormError(`Column ${i + 1}: column name is required.`);
        return;
      }
      // A description is mandatory for every column's spec.
      if (!columnSpecDraftValid(entry.spec)) {
        const label = entry.columnName.trim() || `Column ${i + 1}`;
        setFormError(`Add a description for ${label} (and check its naming convention).`);
        return;
      }
    }

    // Block table+column pairs that already have a live pipeline.
    // pending_baseline pipelines are incomplete setups and should not block.
    const shortTable = table.split('.').pop() ?? table;
    const dupes = columnEntries.filter(en =>
      existingPipelines.some(p =>
        // Case-insensitive on BOTH parts — see existingColNames above (PIPE-01).
        (p.table_fqn ?? '').toUpperCase() === table.toUpperCase()
        && p.status !== 'pending_baseline'
        && p.column_name.toLowerCase() === en.columnName.trim().toLowerCase()));
    if (dupes.length > 0) {
      const list = dupes.map(d => `${shortTable}.${d.columnName.trim()}`).join(', ');
      setFormError(`${list} already has a pipeline created.`);
      return;
    }

    setFormError(null);

    // Export-file conflict: this table already exports to a different file. Ask
    // whether to reuse that export table or deliberately create a separate one.
    // Only applies in table/view mode — column and lookup-only pipelines have
    // no separate export object.
    if (needsExportObject) {
      const existingExport = existingExportForTable(table);
      if (existingExport && existingExport !== exportTable) {
        setExportConflict({ existingExport });
        return;
      }
    }

    void runPreflightThenCreate(exportTable);
  }

  // Checked once at the moment of submission — if anything's missing, opens
  // the approve/cancel popup and STOPS here; proceedCreate only runs once the
  // user explicitly approves (or immediately, unimpeded, when nothing's
  // missing — the common case on Snowflake and on a fully-provisioned mssql
  // install). A failed check (e.g. a network hiccup) never blocks creation —
  // it just falls through, same as any other best-effort probe in this app.
  async function runPreflightThenCreate(finalExport: string) {
    const table  = tableFqn.trim();
    const exportTable = needsExportObject ? finalExport.trim() : '';
    const exportKindParam = copyMode === 'view' ? 'view' : copyMode === 'column' ? 'column' : 'table';
    setPreflightChecking(true);
    try {
      const params = new URLSearchParams({
        table_fqn:   table,
        column_name: columnEntries[0]?.columnName.trim() ?? '',
        export_kind: exportKindParam,
      });
      if (exportTable) params.set('export_table_fqn', exportTable);
      const res  = await fetch(`/api/pipelines/preflight?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      const items: PreflightItem[] = Array.isArray(body?.items) ? body.items : [];
      if (items.length > 0) {
        setPreflightItems(items);
        setPreflightNeedsCreds(body?.needs_credentials === true);
        setPreflightExport(finalExport);
        return;
      }
    } catch { /* check failed — don't block creation on it */ }
    finally {
      setPreflightChecking(false);
    }
    void proceedCreate(finalExport, {});
  }

  async function proceedCreate(finalExport: string, consents: { ct?: boolean; tableMode?: boolean }) {
    const table  = tableFqn.trim();
    // Only table/view modes carry a destination — column mode's destination is
    // the source table itself (the server stamps export_table_fqn = table_fqn).
    const exportTable = needsExportObject ? finalExport.trim() : '';
    if (!table || loading) return;
    setExportConflict(null);
    setPreflightItems(null);
    setFormError(null);

    // Declared outside the try so the catch can roll back partially-created
    // pipelines (a failure at column 2 of 3 must not leave orphaned
    // pending_baseline rows that collide with the user's retry).
    const results: Pipeline[] = [];
    try {
      setLoadingStep('validating');
      const sourceRes  = await fetch(`/api/auto-export/source?table_fqn=${encodeURIComponent(table)}&column_name=${encodeURIComponent(columnEntries[0].columnName.trim())}`);
      const sourceBody = await sourceRes.json().catch(() => ({}));
      if (!sourceRes.ok) throw new Error(sourceBody?.error ?? 'Failed to reach table');

      setLoadingStep('processing');

      // Create each pipeline as 'pending_baseline' — NO auto-standardize. The user
      // reviews the initial grouping on the run page and accepts it before the
      // pipeline goes live.
      for (let i = 0; i < columnEntries.length; i++) {
        const entry = columnEntries[i];
        setSetupProgress({ current: i + 1, total: columnEntries.length });

        const createRes = await fetch('/api/pipelines', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            table_fqn:            table,
            column_name:          entry.columnName.trim(),
            spec:                 columnSpecDraftToApiSpec(entry.spec),
            export_table_fqn:     exportTable || null,
            export_kind:          copyMode === 'view' ? 'view' : copyMode === 'column' ? 'column' : 'table',
            ...(copyMode === 'column' ? { column_write_consent: true } : {}),
            ...(consents.ct ? { change_tracking_consent: true } : {}),
            ...(consents.tableMode ? { table_mode_consent: true } : {}),
            update_schedule:      updateSchedule,
            export_unmapped_rows: exportUnmappedRows,
            status:               'pending_baseline',
          }),
        });
        const createBody = await createRes.json().catch(() => ({}));
        if (!createRes.ok) throw new Error(createBody?.error ?? `Failed to create pipeline for ${entry.columnName}`);
        results.push(createBody.pipeline as Pipeline);
      }

      // Build the initial review run for the first pipeline and open it. When the
      // user created more than one column, seed a "column wizard" in sessionStorage
      // so the run page can walk through each column's standardization in turn
      // (stepper + back/continue) instead of leaving the rest as pending_baseline.
      // Build the initial review run for the FIRST column that actually has data.
      // create-initial-run returns { run_id: null } and advances the pipeline to
      // 'paused' for a fully-null/empty column, so skip those and try the next one.
      let firstRunId: number | null = null;
      let firstIdx   = -1;
      for (let i = 0; i < results.length; i++) {
        const runRes  = await fetch(`/api/pipelines/${results[i].pipeline_id}/create-initial-run`, { method: 'POST' });
        const runBody = await runRes.json().catch(() => ({}));
        if (!runRes.ok) throw new Error(runBody?.error ?? 'Failed to create the initial standardization run');
        if (runBody?.run_id) { firstRunId = Number(runBody.run_id); firstIdx = i; break; }
        // else: column empty / all-null — already advanced to paused; try the next.
      }

      if (firstRunId != null && firstIdx >= 0) {
        // Walk the remaining columns starting from the first with data. The run
        // page's wizard skips any later all-null columns automatically.
        const remaining = results.slice(firstIdx);
        if (remaining.length > 1) {
          const wizard = {
            kind: 'create',
            pids: remaining.map(r => r.pipeline_id),
            cols: remaining.map(r => r.column_name),
            runs: remaining.map((_, idx) => (idx === 0 ? firstRunId : null)),
          };
          sessionStorage.setItem('prism_ae_col_wizard', JSON.stringify(wizard));
        } else {
          sessionStorage.removeItem('prism_ae_col_wizard');
        }
        router.push(`/run/${firstRunId}`);
        return;
      }

      // Every column was empty / all-null — there is nothing to review. Skip the
      // mapping phase entirely and show the activation card so the user can begin
      // the pipeline directly. Re-fetch so the card has full pipeline rows.
      sessionStorage.removeItem('prism_ae_col_wizard');
      try {
        const plRes  = await fetch('/api/pipelines');
        const plBody = await plRes.json().catch(() => ({}));
        const all    = (plBody.pipelines ?? []) as Pipeline[];
        const createdIds = new Set(results.map(r => r.pipeline_id));
        const sibs = all
          .filter(p => p.table_fqn === table &&
            (exportTable ? p.export_table_fqn === exportTable : createdIds.has(p.pipeline_id)))
          .sort((a, b) => a.pipeline_id - b.pipeline_id);
        const list = sibs.length > 0 ? sibs : results;
        setPendingSiblings(list);
        setPendingActivation(list.find(p => p.pipeline_id === results[0].pipeline_id) ?? list[0]);
      } catch {
        setPendingSiblings(results);
        setPendingActivation(results[0]);
      }
    } catch (err) {
      // Roll back pipelines created before the failure so a retry starts clean.
      if (results.length > 0) {
        await Promise.all(results.map(r =>
          fetch(`/api/pipelines/${r.pipeline_id}`, { method: 'DELETE' }).catch(() => {})));
      }
      // Refresh the pipelines snapshot so the dupe check on retry sees reality.
      try {
        const plRes  = await fetch('/api/pipelines');
        const plBody = await plRes.json().catch(() => ({}));
        setExistingPipelines((plBody.pipelines ?? []) as Pipeline[]);
      } catch { /* snapshot refresh is best-effort */ }
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoadingStep('idle');
      setSetupProgress(null);
    }
  }

  // ── Pending activation card handlers ─────────────────────────────────────
  async function handleBeginStandardization() {
    if (!pendingActivation || beginProgress) return;
    const pl = pendingActivation;
    // Claim the button BEFORE the first await — the sibling fetch below takes
    // long enough that a double-click could start two commit passes.
    setBeginProgress({ current: 0, total: 1, phase: 'writing', pct: 0, etaSec: null });

    // All columns of this table (sharing the export file) commit + activate together.
    let members: Pipeline[] = pendingSiblings.length > 0 ? pendingSiblings : [pl];
    try {
      const res  = await fetch('/api/pipelines');
      const body = await res.json().catch(() => ({}));
      const all  = (body.pipelines ?? []) as Pipeline[];
      const sibs = all.filter(p =>
        p.table_fqn === pl.table_fqn &&
        (pl.export_table_fqn ? p.export_table_fqn === pl.export_table_fqn : true));
      if (sibs.length > 0) members = sibs.sort((a, b) => a.pipeline_id - b.pipeline_id);
    } catch { /* fall back to pendingSiblings */ }

    const total = members.length;
    setBeginError(null);

    // Per-column commit durations let us refine the time estimate as we go.
    // Seed with a rough first guess; once a column finishes we use the running
    // average for the remaining columns and the in-flight one.
    const durations: number[] = [];
    const SEED_MS = 9000;
    const expectedPerCol = () =>
      durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : SEED_MS;
    const stopTick = () => { if (beginTickRef.current) { clearInterval(beginTickRef.current); beginTickRef.current = null; } };

    try {
      // Phase 1 — write each column's standardizations to the lookup. We commit
      // one column at a time and animate a smooth progress fraction + ETA within
      // each (the server write is atomic, so this is an estimate that snaps to
      // the real boundary when the request resolves).
      for (let i = 0; i < members.length; i++) {
        const colStart = Date.now();
        const tick = () => {
          const elapsed   = Date.now() - colStart;
          const exp       = expectedPerCol();
          const frac      = Math.min(elapsed / exp, 0.97);        // cap until it actually resolves
          const pct       = Math.min(((i + frac) / total) * 100, 99);
          const remaining = Math.max(exp - elapsed, 0) + (total - i - 1) * exp;
          setBeginProgress({ current: i, total, phase: 'writing', pct, etaSec: Math.max(1, Math.ceil(remaining / 1000)) });
        };
        tick();
        stopTick();
        beginTickRef.current = setInterval(tick, 250);

        const res = await fetch(`/api/pipelines/${members[i].pipeline_id}/commit-standardizations`, { method: 'POST' });
        stopTick();
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b?.error ?? `Failed to write standardizations for ${members[i].column_name}`);
        }
        durations.push(Date.now() - colStart);
      }
      // Phase 2 — activate all columns together (builds the export, starts polling).
      setBeginProgress({ current: total, total, phase: 'starting', pct: 99, etaSec: null });
      await Promise.all(members.map(m =>
        fetch(`/api/pipelines/${m.pipeline_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        }).catch(() => {})));

      sessionStorage.setItem('prism_ae_active_pid', String(pl.pipeline_id));
      setActivePipelineId(pl.pipeline_id || null);
      setPendingActivation(null);
      setPendingSiblings([]);
      setBeginProgress(null);
      setActiveTab('pipelines');
    } catch (e) {
      setBeginError(e instanceof Error ? e.message : 'Failed to start the pipeline.');
      setBeginProgress(null);
    } finally {
      stopTick();
    }
  }

  async function handleCancelPipeline() {
    if (!pendingActivation || cancellingPipeline) return;
    const pl = pendingActivation;
    setCancellingPipeline(true);
    try {
      // Cancel every column of this table together (mirrors begin/activation).
      const members = pendingSiblings.length > 0 ? pendingSiblings : [pl];
      await Promise.all(members.map(m =>
        m.pipeline_id ? fetch(`/api/pipelines/${m.pipeline_id}`, { method: 'DELETE' }).catch(() => {}) : Promise.resolve()));
      for (const m of members) {
        fetch(`/api/auto-export/source?table_fqn=${encodeURIComponent(m.table_fqn)}&column_name=${encodeURIComponent(m.column_name)}`, { method: 'DELETE' }).catch(() => {});
      }
      setPendingActivation(null);
      setPendingSiblings([]);
      setActivePipelineId(null);
      setFormError(null);
      setLoadingStep('idle');
    } finally {
      setCancellingPipeline(false);
    }
  }

  async function handleActivatePipeline(p: Pipeline) {
    try {
      const res = await fetch(`/api/pipelines/${p.pipeline_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error ?? 'Failed to start the pipeline.');
      }
      sessionStorage.setItem('prism_ae_active_pid', String(p.pipeline_id));
      setActivePipelineId(p.pipeline_id);
    } catch (e) {
      setBeginError(e instanceof Error ? e.message : 'Failed to start the pipeline.');
    }
  }

  // Structural gate only — a missing/incomplete standardization spec does NOT
  // disable the button silently. The click is allowed through to handleConnect,
  // which blocks and points the user at the exact column that needs a spec
  // (so "submit does nothing" never happens without an explanation).
  const canSubmit = !loading && !!tableFqn.trim() &&
    (!needsExportObject || !!exportTableFqn.trim()) &&
    columnEntries.length > 0 &&
    columnEntries.every(e => e.columnName.trim());
  const specsIncomplete = columnEntries.some(e => !columnSpecDraftValid(e.spec));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>

      <div className="min-h-screen" style={{ backgroundColor: 'var(--page-bg)' }}>

        {/* ── Left sidebar nav ─────────────────────────────────────────────── */}
        <aside
          style={{
            position: 'fixed', top: 0, left: 0, bottom: 0, width: SIDEBAR_WIDTH, zIndex: 40,
            backgroundColor: 'var(--surface)', borderRight: '0.5px solid var(--border)',
            paddingTop: 76, display: 'flex', flexDirection: 'column',
          }}
        >
          <nav style={{ padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {([
              { id: 'connect',      label: 'Connect',          Icon: IconConnect },
              { id: 'pipelines',    label: 'Pipelines',        Icon: IconClassify },
              { id: 'history',      label: 'One-time history', Icon: IconAutoExport },
              { id: 'how-it-works', label: 'How it works',     Icon: IconGuide },
            ] as const).map(({ id, label, Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => { if (id === 'pipelines') setAlertBadgeSeen(true); setActiveTab(id); }}
                  className="transition-colors"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '9px 11px', fontSize: 13.5, fontWeight: 500, textAlign: 'left',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    backgroundColor: active ? 'var(--accent-tint)' : 'transparent',
                    border: 'none', borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 'var(--radius-button)', cursor: 'pointer',
                  }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                >
                  <span className="inline-flex flex-shrink-0 [&>svg]:w-[17px] [&>svg]:h-[17px]"><Icon /></span>
                  <span style={{ flex: 1 }}>{label}</span>
                  {id === 'pipelines' && !alertBadgeSeen && !active && pausedAlertCount > 0 && (
                    <span className="inline-flex items-center justify-center rounded-full text-[10px] font-semibold"
                      style={{ minWidth: 16, height: 16, padding: '0 4px', backgroundColor: 'var(--confidence-low)', color: 'white' }}>
                      {pausedAlertCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Native edition: Snowflake owns membership — no email invitations. */}
          {isAdmin === true && !isNativeEdition() && (
            <div style={{ marginTop: 'auto', padding: 12, borderTop: '0.5px solid var(--border)' }}>
              <Link
                href="/invite"
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, borderRadius: 'var(--radius-button)', padding: '8px 12px', border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent)', textDecoration: 'none' }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="5.5" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1 12c0-2.5 2-4 4.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  <path d="M10.5 8v4M8.5 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                Invite teammate
              </Link>
            </div>
          )}
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main style={{ marginLeft: SIDEBAR_WIDTH, paddingTop: 76, minHeight: '100vh' }}>

        {/* ════════════════════════════════════════════════════════════════
            CONNECT TAB
        ════════════════════════════════════════════════════════════════ */}
        {/* Native first-visit welcome (owner request 2026-08-16): a modal over
            the dimmed page — the user explicitly chooses the grant guide or
            Continue. Portaled per the floating-UI rule. */}
        {showNativeIntro && typeof document !== 'undefined' && createPortal(
          <div className="fixed inset-0 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(26, 26, 46, 0.45)', zIndex: 70 }}>
            <div className="rounded-card border-[0.5px]"
              style={{
                maxWidth: 460, width: '90%', backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)', padding: 32,
                boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
              }}>
              <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                Welcome to Prism
              </h2>
              <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Prism only sees the tables your team grants it — nothing is shared
                automatically. If this workspace is new, start by giving Prism
                access to the data you want standardized.
              </p>
              <div className="flex items-center justify-end gap-3">
                <button type="button"
                  onClick={() => { try { localStorage.setItem('prism_native_intro_dismissed', '1'); } catch { /* storage unavailable */ } setShowNativeIntro(false); }}
                  className="rounded-button border-[0.5px] px-4 py-2.5 text-sm font-medium"
                  style={{ backgroundColor: 'transparent', borderColor: 'var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >Continue</button>
                <Link href="/setup"
                  onClick={() => { try { localStorage.setItem('prism_native_intro_dismissed', '1'); } catch { /* storage unavailable */ } }}
                  className="rounded-button px-4 py-2.5 text-sm font-medium"
                  style={{ backgroundColor: 'var(--accent)', color: '#FFFFFF' }}
                >Give Prism access to your data</Link>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {activeTab === 'connect' && (
          <div style={{ padding: '32px 40px', backgroundColor: 'var(--page-bg)' }}>
            <div className="mx-auto" style={{ maxWidth: 1100 }}>

              {/* Step summary — minimal graphics + brief copy */}
              {!pendingActivation && (
                <div className="flex items-stretch gap-3 mb-6">
                  {([
                    {
                      title: 'Connect source',
                      desc:  `Point Prism at a ${warehouseLabel} table and column, define each column's standardization spec, and set the export table.`,
                      graphic: (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <rect x="2.5" y="3" width="15" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                          <path d="M2.5 7.5h15M8 7.5V17" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                      ),
                    },
                    {
                      title: 'Review groups',
                      desc:  'Prism groups the raw values of the table and recommends a single standardized name for each group. Check the groupings/standardized names and accept.',
                      graphic: (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <path d="M4 6h6.5M4 10h6.5M4 14h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          <path d="M13 12.5l1.6 1.6L17.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ),
                    },
                    {
                      title: 'Go live',
                      desc:  'Activate the pipeline – all values are standardized and exported to Export Table periodically',
                      graphic: (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <circle cx="10" cy="10" r="2.1" fill="currentColor" />
                          <path d="M6 6a5.5 5.5 0 000 8M14 6a5.5 5.5 0 010 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      ),
                    },
                  ] as const).map((s, i, arr) => (
                    <div key={s.title} style={{ display: 'contents' }}>
                      <div className="flex-1 rounded-card border-[0.5px]"
                        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '14px 16px' }}>
                        <div className="flex items-center gap-2.5 mb-2">
                          <span className="inline-flex items-center justify-center flex-shrink-0"
                            style={{ width: 30, height: 30, borderRadius: 'var(--radius-button)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>
                            {s.graphic}
                          </span>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
                              Step {i + 1}
                            </span>
                            <span className="text-sm font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
                              {s.title}
                            </span>
                          </div>
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{s.desc}</p>
                      </div>
                      {i < arr.length - 1 && (
                        <div className="flex items-center flex-shrink-0" style={{ color: 'var(--text-hint)' }}>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                            <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Connect source table — spans the working area */}
              <div className="rounded-card border-[0.5px]"
                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'calc(var(--card-padding) * 1.5)' }}>

                {/* ── State 1: connection form ──────────────────────────── */}
                {!pendingActivation && (
                  <>
                    <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Connect source</h2>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                      Prism will build the initial mapping, then standardize new values
                    </p>

                    {/* A pipeline's source is ALWAYS the workspace's warehouse.
                        Files and Google Sheets moved to the one-time flow: a
                        pipeline exists to keep a LIVE source standardized on a
                        schedule, and a spreadsheet had to be polled every 60
                        seconds to pretend it was one. A file is a one-shot list,
                        which is exactly what one-time standardization is for. */}
                    <><form onSubmit={handleConnect}>
                      {/* Source table — shared across all column entries */}
                      <div className="mb-4">
                        <label htmlFor="ae-table-fqn" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Source table
                        </label>
                        {isNativeEdition() ? (
                          <NativeTablePicker inputId="ae-table-fqn" value={tableFqn} onChange={setTableFqn} />
                        ) : (
                        <input
                          id="ae-table-fqn" type="text" value={tableFqn}
                          onChange={e => setTableFqn(e.target.value)}
                          placeholder={warehouseKind === 'postgres' ? 'schema.table_name' : warehouseKind === 'mysql' ? 'database.table_name' : 'DATABASE.SCHEMA.TABLE_NAME'}
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={inputStyle}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        )}
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>Full path to the source table whose column values you want to standardize</p>
                      </div>

                      {/* Output mode — table copy vs. standardized column on the source vs.
                          live view vs. lookup table only. */}
                      <div className="mb-5">
                        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Output
                        </label>
                        <div
                          className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
                        >
                          {(() => {
                            // View is refused on mssql (a view can't reference the
                            // per-rebuild staging tables mssql exports use) and only
                            // makes sense for a live warehouse table, not a file source
                            // — rather than show it disabled, drop it from the list.
                            const viewAllowed = pipelineSourceType === 'snowflake' && warehouseKind !== 'mssql';
                            const outputOptions = ([
                              { id: 'table',       label: 'Table' },
                              { id: 'column',      label: 'Column' },
                              { id: 'view',        label: 'View' },
                              { id: 'lookup_only', label: 'Lookup table' },
                            ] as const).filter(o => o.id !== 'view' || viewAllowed);
                            return outputOptions.map(({ id, label }, i) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setCopyMode(id)}
                              disabled={loading}
                              className="flex-1 py-2 text-xs font-medium transition-colors disabled:opacity-50"
                              style={{
                                backgroundColor: copyMode === id ? 'var(--accent)' : 'transparent',
                                color:           copyMode === id ? 'white' : 'var(--text-muted)',
                                borderRight:     i < outputOptions.length - 1 ? '0.5px solid var(--border)' : undefined,
                              }}
                            >
                              {label}
                            </button>
                            ));
                          })()}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                          {copyMode === 'table' && 'Table — Prism creates and rebuilds a full copy of the source table after each pass, with the standardized column(s) in place of the raw values. Most expensive: storage plus rebuild compute on every pass, but reads are fast.'}
                          {copyMode === 'column' && 'Column — Prism adds a new column next to each standardized column on your source table (e.g. CARRIER_STANDARDIZED) holding the standardized value, empty until the raw value is standardized. No separate table or view is created. Requires giving Prism update access on the source table.'}
                          {copyMode === 'view' && "View — Prism creates a view once; it always reflects the current data live, with no storage and no rebuild compute. Cheaper than a table, but each read re-runs the join, so it costs more the more it’s queried."}
                          {copyMode === 'lookup_only' && 'Lookup table — Prism maintains just the raw-value-to-standardized-value mappings. No copy, view, or column is created; you join the lookup table to your source table yourself. Least expensive: no derived object at all.'}
                        </p>

                        {/* Column mode edits the customer's own table — unmissable disclaimer. */}
                        {copyMode === 'column' && (
                          <div className="mt-2.5 rounded-card border-[0.5px] p-3.5" style={{ backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }}>
                            <div className="flex items-start gap-2.5">
                              <span className="flex items-center justify-center rounded-full flex-shrink-0 mt-0.5"
                                style={{ width: 16, height: 16, backgroundColor: '#FFEDD5', color: '#C2410C' }}>
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                  <path d="M5 1L9.3 8.5H0.7L5 1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                                  <path d="M5 4v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                                  <circle cx="5" cy="7.3" r="0.5" fill="currentColor"/>
                                </svg>
                              </span>
                              <div className="text-xs leading-relaxed" style={{ color: '#7C2D12' }}>
                                <p className="font-semibold mb-1" style={{ color: '#9A3412' }}>This mode edits your source table</p>
                                <p className="mb-1.5">
                                  Prism will run ALTER TABLE on your source table to add one new column per connected
                                  column (e.g. CARRIER → CARRIER_STANDARDIZED), and will then run UPDATE statements
                                  against the table to keep those added columns filled in.
                                </p>
                                <p className="mb-1.5">
                                  Prism is designed to never touch your existing columns: its write statements can
                                  only target the companion columns it created, and it refuses to start if a column
                                  with the companion name already exists. However, in the unlikely event that Prism
                                  makes an error, Prism is not liable for the consequences of modified or erased
                                  source data.
                                </p>
                                <p>
                                  We recommend not using this mode on highly important or unrecoverable data — choose
                                  the Table or View output there instead, or keep a backup of the table.
                                </p>
                                <label className="flex items-start gap-2 mt-2.5 cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={columnConsent}
                                    onChange={e => setColumnConsent(e.target.checked)}
                                    disabled={loading}
                                    className="mt-0.5"
                                    style={{ accentColor: '#C2410C' }}
                                  />
                                  <span className="text-xs font-medium" style={{ color: '#9A3412' }}>
                                    I understand — allow Prism to add and maintain standardized columns on this table,
                                    giving Prism update access to this table only. Prism grants that itself using your own
                                    saved SQL Server credentials; if it can&apos;t, it shows you the exact SQL for an admin
                                    to run instead.
                                  </span>
                                </label>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Export table/view — single shared destination for all columns (table or view mode only) */}
                      {needsExportObject && (
                      <div className="mb-5">
                        <label htmlFor="ae-export-fqn" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          {copyMode === 'view' ? 'Export view' : 'Export table'}
                        </label>
                        <input
                          id="ae-export-fqn" type="text" value={exportTableFqn}
                          onChange={e => setExportTableFqn(e.target.value)}
                          placeholder={warehouseKind === 'postgres' || warehouseKind === 'mysql'
                            ? (copyMode === 'view' ? 'prism_exports.table_standardized_view' : 'prism_exports.table_standardized')
                            : (copyMode === 'view' ? 'DATABASE.SCHEMA.TABLE_STANDARDIZED_VIEW' : 'DATABASE.SCHEMA.TABLE_STANDARDIZED')}
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={inputStyle}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>
                          {copyMode === 'view'
                            ? 'This view will always reflect the source table live, with the specified columns replaced by their standardized values.'
                            : 'This table will be maintained as a copy of the source table with the specified columns replaced with their standardized values'}
                        </p>
                      </div>
                      )}

                      {/* Update time window — applies to the whole table */}
                      <div className="mb-5">
                        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Update window
                        </label>
                        <UpdateScheduleEditor
                          value={updateSchedule}
                          onChange={setUpdateSchedule}
                          disabled={loading}
                        />
                      </div>

                      {/* Export unmapped rows — every schedule (24/7 pipelines also hold
                          unmapped values between ticks / during backlogs / while paused) */}
                      <div className="mb-5">
                        <div className="flex items-center justify-between">
                          <div>
                            <label className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                              Export unstandardized values
                            </label>
                            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                              {exportUnmappedRows
                                ? 'Unstandardized values appear in the export table with their raw value until standardized.'
                                : 'Only values with a confirmed standardization appear in the export table. Values already standardized from a prior run are included automatically.'}
                            </p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={exportUnmappedRows}
                            onClick={() => setExportUnmappedRows(v => !v)}
                            disabled={loading}
                            className="ml-4 flex-shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50"
                            style={{ backgroundColor: exportUnmappedRows ? 'var(--accent)' : '#D1D5DB' }}
                          >
                            <span
                              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
                              style={{ transform: exportUnmappedRows ? 'translateX(18px)' : 'translateX(3px)' }}
                            />
                          </button>
                        </div>
                      </div>

                      {/* Columns to standardize */}
                      <div className="mb-5">
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            Columns to standardize
                          </label>
                          {columnEntries.length > 0 && (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {columnEntries.length} selected
                            </span>
                          )}
                        </div>

                        {!manualColumns ? (
                          <>
                            <ColumnPicker
                              columns={tableColumns}
                              loading={columnsLoading}
                              error={columnsError}
                              hasTable={tableFqn.trim().split('.').filter(Boolean).length === 3}
                              entries={columnEntries}
                              existingColNames={existingColNames}
                              busy={loading}
                              onToggle={toggleColumnSelection}
                              onSetSpec={setColumnSpecByName}
                            />
                            {needsGrantSql && columnsError && (() => {
                              const grantSql = buildMssqlDataAccessSql(tableFqn.trim());
                              if (!grantSql) return null;
                              return (
                                <div
                                  className="mt-2 rounded-card border-[0.5px] p-3"
                                  style={{ borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}
                                >
                                  <div className="flex items-center justify-between gap-2 mb-2">
                                    <p className="text-xs font-medium" style={{ color: 'var(--accent-strong)', margin: 0 }}>
                                      Ask a SQL Server admin to run this — it grants Prism read access (and
                                      fast change detection) for this table, nothing more:
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        navigator.clipboard?.writeText(grantSql).then(() => {
                                          setGrantSqlCopied(true);
                                          setTimeout(() => setGrantSqlCopied(false), 2000);
                                        }).catch(() => {});
                                      }}
                                      className="text-xs font-medium rounded-button px-2.5 flex-shrink-0"
                                      style={{ height: 26, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--surface)', color: 'var(--accent-strong)', cursor: 'pointer' }}
                                    >
                                      {grantSqlCopied ? 'Copied' : 'Copy SQL'}
                                    </button>
                                  </div>
                                  <pre
                                    className="text-[11px] rounded-button p-2.5 m-0"
                                    style={{ backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)', maxHeight: 180, overflow: 'auto', whiteSpace: 'pre' }}
                                  >{grantSql}</pre>
                                  <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--text-muted)' }}>
                                    The same SQL (for any table) lives in{' '}
                                    <a href="/setup" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>setup</a>, step 2, Part C.
                                    Once it has been run, re-enter or re-type the table name above.
                                  </p>
                                </div>
                              );
                            })()}
                            <button
                              type="button"
                              onClick={() => { setManualColumns(true); if (columnEntries.length === 0) setColumnEntries([mkEntry()]); }}
                              className="mt-2 text-xs font-medium transition-colors"
                              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                            >
                              {"Can't see your columns? Enter them manually"}
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="flex flex-col gap-3">
                              {columnEntries.map((entry, idx) => (
                                <div
                                  key={entry.id}
                                  className="rounded-[10px] border-[0.5px]"
                                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)', padding: '12px 14px' }}
                                >
                                  <div className="flex items-center justify-between gap-2 mb-2.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                                      Column {idx + 1}
                                    </span>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <ColumnSpecField
                                        variant="inline"
                                        value={entry.spec}
                                        onChange={s => updateEntrySpec(entry.id, s)}
                                        disabled={loading}
                                        columnName={entry.columnName.trim() || undefined}
                                      />
                                      {columnEntries.length > 1 && (
                                        <button
                                          type="button"
                                          onClick={() => removeEntry(entry.id)}
                                          disabled={loading}
                                          className="w-5 h-5 flex items-center justify-center rounded transition-colors disabled:opacity-40"
                                          style={{ color: 'var(--text-muted)', backgroundColor: 'transparent', border: 'none' }}
                                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                                          title="Remove this column"
                                        >
                                          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                                            <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                          </svg>
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Column name</label>
                                    <input
                                      type="text"
                                      value={entry.columnName}
                                      onChange={e => updateEntryColumn(entry.id, e.target.value)}
                                      placeholder="COLUMN_NAME"
                                      autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                                      disabled={loading}
                                      className="w-full px-3 py-2 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                                      style={inputStyle}
                                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                                      onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>

                            <button
                              type="button"
                              onClick={addEntry}
                              disabled={loading}
                              className="w-full py-2 rounded-button border-[0.5px] text-xs font-medium transition-colors mt-3 disabled:opacity-40 flex items-center justify-center gap-1.5"
                              style={{ borderColor: 'var(--border)', borderStyle: 'dashed', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                              onMouseEnter={e => { if (!loading) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; } }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                              </svg>
                              Add column
                            </button>
                            <button
                              type="button"
                              onClick={() => setManualColumns(false)}
                              className="mt-2 text-xs font-medium transition-colors"
                              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                            >
                              Pick from the table's columns instead
                            </button>
                          </>
                        )}
                      </div>

                      {/* SQL Server only — no inline consent here anymore: if Change
                          Tracking (or any other permission) is missing, the preflight
                          check run at submit time shows an unmissable approve/cancel
                          popup instead, right when it actually matters. */}
                      {ctStatus === 'no_pk' && (
                        <p className="mb-5 text-xs leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                          This table has no primary key, so Change Tracking isn&apos;t available — Prism will use
                          scheduled scans to detect new, changed, or deleted values instead.
                        </p>
                      )}

                      {formError && (
                        <div className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                          {formError}
                        </div>
                      )}

                      {canSubmit && specsIncomplete && !formError && (
                        <div className="flex items-center gap-2 rounded-button border-[0.5px] px-3.5 py-2.5 mb-4 text-xs" style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}>
                          <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, backgroundColor: '#F59E0B' }} />
                          Add standardization specs to each column before continuing.
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={!canSubmit}
                        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)' }}
                        onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                      >
                        {preflightChecking && (
                          <span className="inline-flex items-center justify-center gap-2"><Spinner />Checking access…</span>
                        )}
                        {!preflightChecking && loadingStep === 'validating' && (
                          <span className="inline-flex items-center justify-center gap-2"><Spinner />Checking table…</span>
                        )}
                        {loadingStep === 'processing' && (
                          <span className="inline-flex items-center justify-center gap-2">
                            <Spinner />
                            {setupProgress && setupProgress.total > 1
                              ? `Setting up ${setupProgress.current} of ${setupProgress.total}…`
                              : 'Building initial groups…'}
                          </span>
                        )}
                        {!preflightChecking && loadingStep === 'idle' && 'Create initial standardizations'}
                      </button>
                    </form>

                    {/* ── Export-file conflict modal ──────────────────────── */}
                    {exportConflict && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center"
                        style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
                        onClick={() => setExportConflict(null)}
                      >
                        <div
                          className="rounded-card border-[0.5px] w-full max-w-md mx-4"
                          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
                          onClick={e => e.stopPropagation()}
                        >
                          <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                            Two export files for one table
                          </h3>
                          <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
                            {tableFqn.trim().split('.').pop()} already exports its standardized columns to:
                          </p>
                          <p className="text-xs font-mono mb-3 px-3 py-2 rounded-button" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-primary)', border: '0.5px solid var(--border)' }}>
                            {exportConflict.existingExport}
                          </p>
                          <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                            You entered a different export file. Use the existing one so all columns stay in a
                            single pipeline, or create a separate export file (stored as its own pipeline).
                          </p>
                          <div className="flex flex-col gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const exp = exportConflict.existingExport;
                                setExportTableFqnRaw(exp);
                                setExportTableEdited(true);
                                setExportConflict(null);
                                void runPreflightThenCreate(exp);
                              }}
                              className="w-full py-2.5 rounded-button text-white text-sm font-medium transition-colors"
                              style={{ backgroundColor: 'var(--accent)' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                            >
                              Use existing export table
                            </button>
                            <button
                              type="button"
                              onClick={() => { setExportConflict(null); void runPreflightThenCreate(exportTableFqn.trim()); }}
                              className="w-full py-2.5 rounded-button text-sm font-medium transition-colors border-[0.5px]"
                              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                            >
                              Create a separate export file
                            </button>
                            <button
                              type="button"
                              onClick={() => setExportConflict(null)}
                              className="w-full py-2 text-xs font-medium transition-colors"
                              style={{ color: 'var(--text-muted)', backgroundColor: 'transparent', border: 'none' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Preflight approve/cancel popup — SQL Server only; shown once,
                           at the moment of submission, only when something's actually
                           missing. Approving is the ONLY way any of these grants are
                           ever attempted. ──────────────────────────────────────── */}
                    {preflightItems && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center"
                        style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
                        onClick={() => { if (!preflightSubmitting) setPreflightItems(null); }}
                      >
                        <div
                          className="rounded-card border-[0.5px] w-full max-w-md mx-4"
                          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
                          onClick={e => e.stopPropagation()}
                        >
                          <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                            Prism needs a few permissions first
                          </h3>
                          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                            Before creating this pipeline, Prism will enable the following on your SQL Server,
                            using your saved personal credentials:
                          </p>
                          <div className="flex flex-col gap-3 mb-5">
                            {preflightItems.map(item => (
                              <div key={item.key} className="rounded-button border-[0.5px] p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
                                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{item.label}</p>
                                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{item.detail}</p>
                              </div>
                            ))}
                          </div>
                          {preflightNeedsCreds ? (
                            <div className="rounded-button border-[0.5px] p-3 mb-4" style={{ borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}>
                              <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--accent-strong)' }}>
                                Prism signs in as its own restricted login, and SQL Server does not let a login grant
                                permissions to itself — so it needs your database login once to apply the above. It is
                                stored encrypted, used only on your behalf, and reused for future pipelines.
                              </p>
                              <div className="flex flex-col gap-2">
                                <input
                                  type="text" value={credUser} onChange={e => setCredUser(e.target.value)}
                                  placeholder="Your SQL Server login" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                                  className="w-full px-3 py-2 rounded-button border-[0.5px] text-sm outline-none font-mono"
                                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                                />
                                <input
                                  type="password" value={credPassword} onChange={e => setCredPassword(e.target.value)}
                                  placeholder="Password"
                                  className="w-full px-3 py-2 rounded-button border-[0.5px] text-sm outline-none"
                                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                                />
                              </div>
                              {credError && (
                                <p className="text-[11px] mt-2" style={{ color: 'var(--confidence-low)' }}>{credError}</p>
                              )}
                              <button
                                type="button"
                                onClick={() => setShowFixSql(v => !v)}
                                className="text-[11px] mt-2 underline"
                                style={{ color: 'var(--accent-strong)', background: 'none', cursor: 'pointer' }}
                              >
                                {showFixSql ? 'Hide' : 'Or have a database admin run the SQL instead'}
                              </button>
                              {showFixSql && (
                                <p className="text-[11px] mt-2 font-mono select-all leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                                  Ask your SQL Server admin to grant Prism&apos;s login the access described above on
                                  this one table, then create the pipeline again — the exact statements are shown on
                                  the pipeline card if you continue without credentials.
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs mb-4" style={{ color: 'var(--text-hint)' }}>
                              Prism applies these with your saved personal credentials. If a grant can&apos;t be
                              applied, nothing happens silently — you get the exact SQL for an admin to run.
                            </p>
                          )}
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setPreflightItems(null)}
                              disabled={preflightSubmitting}
                              className="text-[13px] font-medium px-3 py-2 rounded-button border-[0.5px] transition-colors disabled:opacity-50"
                              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                setPreflightSubmitting(true);
                                setCredError(null);
                                try {
                                  // Save the typed credentials first — the server
                                  // live-tests them, so a bad login is reported
                                  // here instead of failing mid-creation.
                                  if (preflightNeedsCreds) {
                                    const r = await fetch('/api/accounts/mssql-config', {
                                      method:  'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body:    JSON.stringify({ user: credUser.trim(), password: credPassword }),
                                    });
                                    const b = await r.json().catch(() => ({}));
                                    if (!r.ok) {
                                      setCredError(b?.error ?? 'Those credentials could not be saved.');
                                      return;
                                    }
                                    setPreflightNeedsCreds(false);
                                    setCredPassword('');
                                  }
                                  await proceedCreate(preflightExport, {
                                    ct:        preflightItems.some(i => i.key === 'change_tracking'),
                                    tableMode: preflightItems.some(i => i.key === 'table_mode_access'),
                                  });
                                } finally {
                                  setPreflightSubmitting(false);
                                }
                              }}
                              disabled={preflightSubmitting || (preflightNeedsCreds && (!credUser.trim() || !credPassword))}
                              className="text-[13px] font-medium px-4 py-2 rounded-button text-white transition-colors disabled:opacity-50 inline-flex items-center gap-2"
                              style={{ backgroundColor: 'var(--accent)' }}
                              onMouseEnter={e => { if (!preflightSubmitting) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                            >
                              {preflightSubmitting && <Spinner className="w-3 h-3" />}
                              {preflightNeedsCreds ? 'Save credentials and continue' : 'I approve, continue'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    </>
                  </>
                )}

                {/* ── State 2: activation card ──────────────────────────── */}
                {pendingActivation && (
                  <>
                    <div className="flex items-center gap-2 mb-5">
                      <div className="flex items-center justify-center rounded-full flex-shrink-0"
                        style={{ width: 28, height: 28, backgroundColor: '#DCFCE7' }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M2.5 7l3 3 6-6" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Initial mapping complete</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Your pipeline is ready to go live</p>
                      </div>
                    </div>

                    {(() => {
                      const cols = pendingSiblings.length > 0 ? pendingSiblings : [pendingActivation];
                      return (
                    <div className="rounded-[10px] border-[0.5px] px-4 py-3 mb-6 flex flex-col gap-2"
                      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Table</span>
                        <span className="text-xs font-mono text-right" style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                          {pendingActivation.table_fqn}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {cols.length > 1 ? `Columns (${cols.length})` : 'Column'}
                        </span>
                        {cols.map((c) => (
                          <div key={`${c.pipeline_id}_${c.column_name}`} className="flex items-center justify-between gap-3 pl-2">
                            <span className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }} title={c.column_name}>
                              {c.column_name}
                            </span>
                          </div>
                        ))}
                      </div>
                      {pendingActivation.export_table_fqn && (
                        <div className="flex items-start justify-between gap-4">
                          <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>Export table</span>
                          <span className="text-xs font-mono text-right" style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                            {pendingActivation.export_table_fqn}
                          </span>
                        </div>
                      )}
                    </div>
                      );
                    })()}

                    {pendingActivation.export_table_fqn && (
                      <ExportTableDisclosure exportTableFqn={pendingActivation.export_table_fqn} exportKind={pendingActivation.export_kind} warehouseLabel={warehouseLabel} />
                    )}

                    {beginError && !beginProgress && (
                      <div className="rounded-button border-[0.5px] px-3 py-2 mb-3 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                        {beginError}
                      </div>
                    )}

                    {beginProgress ? (
                      <div className="mb-5">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {beginProgress.phase === 'starting'
                              ? 'Almost done — opening pipeline…'
                              : beginProgress.total > 1
                                ? `Writing standardizations — column ${Math.min(beginProgress.current + 1, beginProgress.total)} of ${beginProgress.total}`
                                : 'Writing standardizations…'}
                          </span>
                          <span className="flex items-center gap-2 tabular-nums">
                            <span className="text-xs font-semibold" style={{ color: '#16a34a' }}>
                              {Math.round(beginProgress.pct)}%
                            </span>
                            <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: '#16a34a' }}>
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                          </span>
                        </div>
                        <div className="w-full rounded-full overflow-hidden" style={{ height: 8, backgroundColor: 'var(--border-subtle)' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.min(beginProgress.pct, 100)}%`,
                            backgroundColor: '#16a34a',
                            transition: 'width 0.35s ease',
                          }} />
                        </div>
                        <p className="text-[11px] text-center mt-2 mb-1" style={{ color: 'var(--text-muted)' }}>
                          {beginProgress.phase === 'starting'
                            ? 'Finishing up — the pipeline opens once everything is written.'
                            : beginProgress.etaSec != null
                              ? `Saving standardized values — about ${beginProgress.etaSec}s remaining`
                              : 'Saving standardized values…'}
                        </p>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={handleBeginStandardization}
                          disabled={cancellingPipeline}
                          className="w-full py-2.5 rounded-button text-sm font-medium transition-colors flex items-center justify-center gap-2 border disabled:opacity-60"
                          style={{ backgroundColor: '#F0FDF4', borderColor: '#86EFAC', color: '#16a34a' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#DCFCE7'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#F0FDF4'; }}
                        >
                          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                            <path d="M2 1.5l9 4.5-9 4.5V1.5z" fill="#16a34a" stroke="#16a34a" strokeWidth="1" strokeLinejoin="round" />
                          </svg>
                          Begin Pipeline Standardization
                        </button>

                        <p className="text-[11px] text-center mt-2 mb-5" style={{ color: 'var(--text-muted)' }}>
                          Standardized values are written when you begin, then Prism polls every 30 seconds for new values
                        </p>

                        <button
                          onClick={handleCancelPipeline}
                          disabled={cancellingPipeline}
                          className="w-full py-2 rounded-button border-[0.5px] text-xs font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
                          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                          onMouseEnter={e => { if (cancellingPipeline) return; (e.currentTarget as HTMLButtonElement).style.borderColor = '#FECACA'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                        >
                          {cancellingPipeline && <Spinner className="w-3 h-3" />}
                          {cancellingPipeline ? 'Cancelling…' : 'Cancel pipeline'}
                        </button>
                      </>
                    )}
                  </>
                )}

              </div>

              {/* Incomplete pipeline cards — only for the current user's pending_baseline pipelines */}
              {!pendingActivation && accountId != null && (() => {
                const mine = pendingBaselinePipelines.filter(p => p.created_by === accountId);
                // Group by table_fqn so multi-column setups show as one card
                const grouped = new Map<string, Pipeline[]>();
                for (const p of mine) {
                  const key = p.table_fqn;
                  if (!grouped.has(key)) grouped.set(key, []);
                  grouped.get(key)!.push(p);
                }
                if (grouped.size === 0) return null;
                return (
                  <div className="flex flex-col gap-3 mt-4">
                    {[...grouped.entries()].map(([tableFqn, cols]) => (
                      <div
                        key={tableFqn}
                        className="rounded-card border-[0.5px] flex items-center justify-between"
                        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)', padding: '14px 18px' }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-pill text-[10px] font-medium"
                              style={{ backgroundColor: '#FFFBEB', color: '#BA7517', border: '0.5px solid #FDE9C8' }}>
                              Incomplete
                            </span>
                            <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {tableShortName(tableFqn)}
                            </span>
                          </div>
                          <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {cols.length === 1
                              ? `${cols[0].column_name} · Initial review not completed`
                              : `${cols.length} columns · Initial review not completed`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {(() => {
                            const continuing = incompleteBusyKey === `continue:${tableFqn}`;
                            const deleting   = incompleteBusyKey === `delete:${tableFqn}`;
                            const anyBusy    = incompleteBusyKey != null;
                            return (
                              <>
                                <button
                                  type="button"
                                  disabled={anyBusy}
                                  onClick={async () => {
                                    setIncompleteBusyKey(`continue:${tableFqn}`);
                                    try {
                                      // Rebuilds/resumes the review run (may include an LLM grouping pass).
                                      const res = await fetch(`/api/pipelines/${cols[0].pipeline_id}/create-initial-run`, { method: 'POST' });
                                      const body = await res.json();
                                      // Multi-column Sheets pipelines come back with a run PER column —
                                      // re-establish the same wizard the creation flow sets up, otherwise
                                      // resuming an abandoned setup would walk only the first column and
                                      // silently drop the rest (PIPE-16b).
                                      const runIds: (number | null)[] = body.run_ids ?? [];
                                      if (runIds.filter(r => r != null).length > 1) {
                                        const wizard = {
                                          kind: 'create',
                                          pids: runIds.map(() => cols[0].pipeline_id),
                                          cols: body.column_names ?? [],
                                          runs: runIds,
                                        };
                                        try { sessionStorage.setItem('prism_ae_col_wizard', JSON.stringify(wizard)); } catch { /* ignore */ }
                                      }
                                      if (body.run_id) { router.push(`/run/${body.run_id}`); return; }
                                      setIncompleteBusyKey(null);
                                    } catch { setIncompleteBusyKey(null); }
                                  }}
                                  className="text-xs font-medium px-3 py-1.5 rounded-button border-[0.5px] transition-colors inline-flex items-center gap-1.5 disabled:opacity-60"
                                  style={{ color: 'var(--accent)', borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}
                                >
                                  {continuing && <Spinner className="w-3 h-3" />}
                                  {continuing ? 'Preparing review…' : 'Continue'}
                                </button>
                                <button
                                  type="button"
                                  disabled={anyBusy}
                                  onClick={async () => {
                                    if (!confirm('Delete this incomplete pipeline?')) return;
                                    setIncompleteBusyKey(`delete:${tableFqn}`);
                                    try {
                                      const res = await fetch(`/api/pipelines/${cols[0].pipeline_id}`, { method: 'DELETE' });
                                      if (res.ok) {
                                        setPendingBaselinePipelines(prev => prev.filter(p => p.table_fqn !== tableFqn));
                                      }
                                    } catch { /* ignore */ } finally { setIncompleteBusyKey(null); }
                                  }}
                                  className="inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-60"
                                  style={{ width: 26, height: 26, color: 'var(--text-muted)', backgroundColor: 'transparent', border: '0.5px solid var(--border)' }}
                                  aria-label="Delete incomplete pipeline"
                                >
                                  {deleting ? (
                                    <Spinner className="w-3 h-3" />
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                    </svg>
                                  )}
                                </button>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {!pendingActivation && <OneTimeStandardizationCard />}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            PIPELINES TAB
        ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'pipelines' && (
          <div className="w-full max-w-7xl mx-auto"
            style={{ padding: 'calc(var(--page-padding-y) * 0.8) 32px var(--page-padding-y)' }}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Pipelines</h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>All configured standardizations of source tables</p>
              </div>
              <button
                onClick={() => setActiveTab('connect')}
                className="inline-flex items-center gap-2 text-sm font-medium rounded-button px-4 py-2 transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'white' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                New pipeline
              </button>
            </div>

            <PipelinesView
              onActivate={handleActivatePipeline}
              activePipelineId={activePipelineId}
              defaultExpandedId={activePipelineId}
              defaultExpandedTab="activity"
            />
          </div>
        )}

        {activeTab === 'history' && <OneTimeArchiveView />}

        {/* ════════════════════════════════════════════════════════════════
            HOW IT WORKS TAB
        ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'how-it-works' && (
          <div style={{ padding: '28px 40px' }}>
            <div className="mx-auto" style={{ maxWidth: 1000 }}>

              {/* Hero — split layout */}
              <div className="flex items-center gap-12 mb-8" style={{ minHeight: '55vh' }}>
                {/* Left: text + checklist */}
                <div style={{ flex: '0 0 45%' }}>
                  <p className="text-[10px] font-semibold uppercase mb-3" style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}>
                    How it works
                  </p>
                  <h1 className="text-[28px] font-semibold mb-4" style={{ color: 'var(--text-primary)', lineHeight: 1.25 }}>
                    From messy values to one standard
                  </h1>
                  <p className="text-[14px] leading-relaxed mb-5" style={{ color: 'var(--text-secondary)' }}>
                    Prism recognizes when different values in your database mean the same thing, standardizes them, and keeps them clean — automatically.
                  </p>
                  <div className="flex flex-col gap-3 mb-6">
                    {[
                      'Recognizes when different values mean the same thing',
                      'Standardizes and applies Naming Conventions across your database',
                      'Automatically updates as new data is provided',
                    ].map((item, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                          <path d="M4.5 9.5l3 3 6-6" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="text-[14px] leading-snug" style={{ color: 'var(--text-secondary)' }}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right: before → after diagram */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center justify-center gap-6">
                    {/* Before column */}
                    <div className="rounded-card border-[0.5px] overflow-hidden" style={{ width: 216, backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
                      <div className="px-4 py-2.5" style={{ borderBottom: '0.5px solid var(--border)', backgroundColor: 'var(--page-bg)' }}>
                        <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--text-muted)' }}>COMPANY_NAME</span>
                      </div>
                      {[
                        { value: 'JP Morgan Chase', dot: '#DC2626' },
                        { value: 'JPMorgan', dot: '#DC2626' },
                        { value: 'JPM', dot: '#DC2626' },
                      ].map(({ value, dot }, i) => (
                        <div key={i} className="flex items-center gap-2.5 px-4 py-2.5"
                          style={{ borderBottom: i < 2 ? '0.5px solid var(--border-subtle)' : undefined }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dot, flexShrink: 0 }} />
                          <span className="text-[13px] font-mono" style={{ color: 'var(--text-secondary)' }}>{value}</span>
                        </div>
                      ))}
                    </div>

                    {/* Arrow + Prism mark */}
                    <div className="flex flex-col items-center gap-2 flex-shrink-0">
                      <svg width="56" height="10" viewBox="0 0 56 10" fill="none" style={{ color: 'var(--accent)' }}>
                        <path d="M1 5h50M46 1l9 4-9 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill"
                        style={{ backgroundColor: 'var(--accent-tint)', border: '0.5px solid var(--accent-border)' }}>
                        <svg width="18" height="14" viewBox="0 0 28 22" fill="none" aria-hidden="true">
                          <polygon points="0,0 0,22 14,11" fill="#1A1A2E" />
                          <polygon points="28,0 28,22 14,11" fill="#378ADD" />
                          <circle cx="14" cy="11" r="1.4" fill="white" />
                        </svg>
                        <span className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>Prism</span>
                      </div>
                    </div>

                    {/* After column */}
                    <div className="rounded-card border-[0.5px] overflow-hidden" style={{ width: 216, backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)' }}>
                      <div className="px-4 py-2.5" style={{ borderBottom: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}>
                        <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--accent)' }}>COMPANY_NAME</span>
                      </div>
                      {['JP Morgan', 'JP Morgan', 'JP Morgan'].map((v, i) => (
                        <div key={i} className="flex items-center gap-2.5 px-4 py-2.5"
                          style={{ borderBottom: i < 2 ? '0.5px solid var(--border-subtle)' : undefined }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#16a34a', flexShrink: 0 }} />
                          <span className="text-[13px] font-mono font-semibold" style={{ color: 'var(--accent-strong)' }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Tutorial — starting a pipeline */}
              <div className="py-8 mb-8" style={{ borderTop: '1px solid var(--border)' }}>
                <p className="text-[10px] font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}>
                  Tutorial
                </p>
                <h2 className="text-[20px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                  Starting a pipeline
                </h2>
                <p className="text-[14px] leading-relaxed mb-6" style={{ color: 'var(--text-secondary)', maxWidth: 560 }}>
                  Follow along with these walkthroughs to set up your first pipeline from start to finish.
                </p>
                {(() => {
                  const activeVideoRef = { current: null as HTMLVideoElement | null };
                  const tutorialVideo = (src: string) => (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <video
                        ref={(el) => {
                          if (!el) return;
                          const obs = new IntersectionObserver(
                            ([entry]) => {
                              if (entry.isIntersecting) {
                                if (activeVideoRef.current && activeVideoRef.current !== el) {
                                  activeVideoRef.current.pause();
                                  activeVideoRef.current.currentTime = 0;
                                }
                                activeVideoRef.current = el;
                                el.currentTime = 0;
                                el.play().catch(() => {});
                              } else {
                                if (activeVideoRef.current === el) activeVideoRef.current = null;
                                el.pause();
                              }
                            },
                            { threshold: 0.5 },
                          );
                          obs.observe(el);
                        }}
                        src={src}
                        muted
                        playsInline
                        preload="metadata"
                        style={{ width: '100%', display: 'block', borderRadius: 'var(--radius-card)' }}
                      />
                    </div>
                  );
                  return (<>
                    {/* Tutorial 01 */}
                    <div className="flex items-center gap-12" style={{ borderTop: '1px solid var(--border)', paddingTop: 56, paddingBottom: 40 }}>
                      <div className="flex flex-col justify-center" style={{ flex: '0 0 30%' }}>
                        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>01 —</p>
                        <h2 className="text-[22px] font-semibold mb-3" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                          Connect Prism to your source table for standardization
                        </h2>
                        <div className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          <p className="mb-2">1. Specify which table you want standardized</p>
                          <p className="mb-2">2. Select how you want to access the standardized data (i.e. table, column, view, lookup table)</p>
                          <p>3. Select if you want standardizations updated automatically or upon your approval</p>
                        </div>
                      </div>
                      {tutorialVideo('/tutorial-1.mov')}
                    </div>

                    {/* Output types — below Tutorial 01 */}
                    <h2 className="text-[15px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)' }}>
                      Output types
                    </h2>
                    <p className="text-[13.5px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)', maxWidth: 720 }}>
                      Each pipeline maintains one of {outputExplainers.length === 4 ? 'four' : 'three'} outputs, chosen at setup based on how the standardized data will be used.
                    </p>
                    <div className="grid gap-3 mb-10" style={{ gridTemplateColumns: `repeat(${outputExplainers.length}, 1fr)` }}>
                      {outputExplainers.map((o, i) => (
                        <div key={i} className="rounded-card border-[0.5px]"
                          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                              style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}>{o.badge}</span>
                          </div>
                          <p className="text-[13px] leading-relaxed mt-1.5" style={{ color: 'var(--text-secondary)' }}>{o.desc}</p>
                        </div>
                      ))}
                    </div>

                    {/* Update windows — below output types */}
                    <h2 className="text-[15px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)' }}>
                      Update windows
                    </h2>
                    <p className="text-[13.5px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)', maxWidth: 720 }}>
                      Each pipeline has an update window that controls when Prism standardizes new values automatically. New values are always detected and queued as they arrive; updates run at every 10-minute mark on the clock (1:00, 1:10, 1:20, …) — the window only decides which of those marks are allowed to run.
                    </p>
                    <div className="grid gap-3 mb-10" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                      <div className="rounded-card border-[0.5px]"
                        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)', padding: 'var(--card-padding)' }}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                            style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>Time window</span>
                          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>default: Mon–Fri, 9 AM–5 PM</span>
                        </div>
                        <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          Prism auto-updates every 10 minutes, but only during the days and hours you pick. Values that arrive outside the window queue up and go out at the first mark after it opens — nothing is lost in between.
                        </p>
                      </div>
                      <div className="rounded-card border-[0.5px]"
                        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                            style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}>24/7</span>
                        </div>
                        <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          New values are standardized and exported around the clock, at every 10-minute mark. Values already standardized before are re-applied from the lookup table without using any AI.
                        </p>
                      </div>
                      <div className="rounded-card border-[0.5px]"
                        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                            style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}>Manual only</span>
                        </div>
                        <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          Prism never updates on its own. New values queue up until you trigger standardization — Prism then generates the standardizations for you to approve or modify before they reach the export.
                        </p>
                      </div>
                    </div>

                    {/* Tutorial 02 */}
                    <div className="flex items-center gap-12" style={{ borderTop: '1px solid var(--border)', paddingTop: 72, paddingBottom: 40 }}>
                      {tutorialVideo('/tutorial-2.mov')}
                      <div className="flex flex-col justify-center" style={{ flex: '0 0 30%' }}>
                        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>02 —</p>
                        <h2 className="text-[22px] font-semibold mb-3" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                          Select the columns to standardize and describe them
                        </h2>
                        <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          Each column gets its own spec — what its values represent, plus optional naming conventions and grouping rules. More info below:
                        </p>
                      </div>
                    </div>

                    {/* Column specs — below Tutorial 02 */}
                    <h2 className="text-[15px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                      Column specs
                    </h2>
                    <p className="text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
                      Tells Prism what a column&rsquo;s values represent and how to standardize them
                    </p>
                    <p className="text-[13.5px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)', maxWidth: 720 }}>
                      Every standardized column carries its own spec, set at setup. Prism applies it whenever it standardizes that column&rsquo;s values. A spec has:
                    </p>
                    <ul className="mb-4 flex flex-col gap-1.5 list-disc" style={{ paddingLeft: 24 }}>
                      <li className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Description of the data (required — e.g. &ldquo;legal company names&rdquo;)</li>
                      <li className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Naming convention (optional — e.g. lowercase)</li>
                      <li className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Grouping rules (optional — e.g. group subsidiary companies together)</li>
                    </ul>
                    <p className="text-[13.5px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                      Refer to the example below:
                    </p>

                    {/* Example column-spec diagram */}
                    <div className="rounded-[10px] border-[0.5px] px-8 py-6 mb-10"
                      style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)', border: '2px solid var(--accent-border)' }}>

                      {/* Column-spec header */}
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>Column spec</p>
                      </div>
                      <p className="text-[17px] font-semibold mb-3 font-mono" style={{ color: 'var(--text-primary)' }}>CLIENT_COMPANY</p>
                      <div className="flex flex-wrap gap-2 mb-5">
                        <span className="inline-block text-[11px] font-medium rounded-pill px-2.5 py-1"
                          style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)', border: '0.5px solid var(--accent-border)' }}>
                          Description: legal company names
                        </span>
                        <span className="inline-block text-[11px] font-medium rounded-pill px-2.5 py-1"
                          style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)', border: '0.5px solid var(--accent-border)' }}>
                          Naming convention: alphanumeric + underscores, lowercase
                        </span>
                        <span className="inline-block text-[11px] font-medium rounded-pill px-2.5 py-1"
                          style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)', border: '0.5px solid var(--accent-border)' }}>
                          Grouping rules: group subsidiaries under the parent
                        </span>
                      </div>

                      <div className="flex items-center gap-5" style={{ borderTop: '0.5px solid var(--border)', paddingTop: 20 }}>
                        {/* Two pipelines stacked under one heading */}
                        <div style={{ flex: '0 0 auto', minWidth: 200 }}>
                          <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Pipelines</p>
                          <div className="flex flex-col gap-4">
                            {[
                              { column: 'CLIENT_COMPANY',  value: 'JP Morgan Chase' },
                              { column: 'PARTNER_COMPANY', value: 'JPM' },
                            ].map((s, i) => (
                              <div key={i} className="rounded-button overflow-hidden" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)' }}>
                                <div className="px-3.5 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                                  <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--text-muted)' }}>{s.column}</span>
                                </div>
                                <div className="px-3.5 py-1 text-center" style={{ borderBottom: '1px solid var(--border)' }}>
                                  <span className="text-[14px] font-semibold tracking-widest" style={{ color: 'var(--text-muted)' }}>···</span>
                                </div>
                                <div className="px-3.5 py-2" style={{ borderLeft: '2px solid var(--accent)', backgroundColor: 'var(--accent-tint)' }}>
                                  <span className="text-[12px] font-mono font-semibold" style={{ color: 'var(--accent-strong)' }}>{s.value}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Arrow: pipelines → lookup table */}
                        <svg width="36" height="20" viewBox="0 0 36 20" fill="none" style={{ color: 'var(--accent)', flexShrink: 0 }} aria-hidden="true">
                          <path d="M2 10H28" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          <path d="M24 5l8 5-8 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>

                        {/* Shared lookup table */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>Lookup table</p>
                          <div className="rounded-button overflow-hidden" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)' }}>
                            <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
                              <div className="px-3.5 py-1.5" style={{ flex: 1, borderRight: '1px solid var(--border)' }}>
                                <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--text-muted)' }}>RAW VALUE</span>
                              </div>
                              <div className="px-3.5 py-1.5" style={{ flex: 1 }}>
                                <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--text-muted)' }}>STANDARDIZED</span>
                              </div>
                            </div>
                            {[
                              { raw: 'JP Morgan Chase', std: 'jp_morgan' },
                              { raw: 'JPM',             std: 'jp_morgan' },
                            ].map((m, i) => (
                              <div key={i} className="flex" style={{ borderBottom: i === 0 ? '1px solid var(--border)' : undefined }}>
                                <div className="px-3.5 py-2" style={{ flex: 1, borderRight: '1px solid var(--border)' }}>
                                  <span className="text-[12px] font-mono" style={{ color: 'var(--text-secondary)' }}>{m.raw}</span>
                                </div>
                                <div className="px-3.5 py-2" style={{ flex: 1 }}>
                                  <span className="text-[12px] font-mono font-semibold" style={{ color: 'var(--accent-strong)' }}>{m.std}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Arrow: lookup table → standardized output */}
                        <svg width="36" height="20" viewBox="0 0 36 20" fill="none" style={{ color: 'var(--accent)', flexShrink: 0 }} aria-hidden="true">
                          <path d="M2 10H28" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          <path d="M24 5l8 5-8 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>

                        {/* Single standardized output */}
                        <div style={{ flexShrink: 0 }}>
                          <div className="rounded-button border-[0.5px] px-5 py-4 text-center"
                            style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)' }}>
                            <p className="text-[10px] font-medium mb-1" style={{ color: 'var(--accent)' }}>Both resolve to:</p>
                            <span className="text-[17px] font-semibold" style={{ color: 'var(--accent-strong)' }}>jp_morgan</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Tutorial 03 */}
                    <div className="flex items-center gap-12" style={{ borderTop: '1px solid var(--border)', paddingTop: 72, paddingBottom: 48 }}>
                      <div className="flex flex-col justify-center" style={{ flex: '0 0 30%' }}>
                        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>03 —</p>
                        <h2 className="text-[22px] font-semibold mb-3" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                          Set initial standardizations
                        </h2>
                        <ol className="text-[14px] leading-relaxed flex flex-col gap-2 list-decimal" style={{ color: 'var(--text-secondary)', paddingLeft: 20 }}>
                          <li>Prism will show the initial set of standardizations for the values in the table</li>
                          <li>Modify and approve the standardizations</li>
                          <li>Accept and Prism will continuously standardize your table</li>
                        </ol>
                      </div>
                      {tutorialVideo('/tutorial-3.mov')}
                    </div>

                    {/* Tutorial 04 */}
                    <div className="flex items-center gap-12" style={{ borderTop: '1px solid var(--border)', paddingTop: 72, paddingBottom: 48 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <img
                          src="/tutorial-4.png"
                          alt="Pipeline dashboard showing live status, source values, standardized count, and column details"
                          style={{ width: '100%', display: 'block', borderRadius: 'var(--radius-card)' }}
                        />
                      </div>
                      <div className="flex flex-col justify-center" style={{ flex: '0 0 30%' }}>
                        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>04 —</p>
                        <h2 className="text-[22px] font-semibold mb-3" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                          Monitor your pipeline
                        </h2>
                        <p className="text-[14px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)' }}>
                          Your pipeline is now live — Prism checks your source for new values every minute and updates your dashboard automatically as they&rsquo;re detected and standardized.
                        </p>
                        <ol className="text-[14px] leading-relaxed flex flex-col gap-2 list-decimal" style={{ color: 'var(--text-secondary)', paddingLeft: 20 }}>
                          <li>Track counts for updating source values, standardized items, and items awaiting standardization</li>
                          <li>Export the lookup table containing all standardizations for the table</li>
                          <li>View the mappings or unstandardized items in the queue as needed</li>
                        </ol>
                      </div>
                    </div>
                  </>);
                })()}
              </div>

              {/* CTA */}
              <button
                onClick={() => setActiveTab('connect')}
                className="inline-flex items-center gap-2 text-sm font-medium rounded-button px-5 py-2.5 transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'white' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
              >
                Connect your first table
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

            </div>
          </div>
        )}

        </main>
      </div>
    </>
  );
}
