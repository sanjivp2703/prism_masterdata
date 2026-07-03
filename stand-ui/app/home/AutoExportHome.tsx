'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Domain } from '@/app/components/domain-types';
import CompactDomainPicker from '@/app/components/CompactDomainPicker';
import PipelinesView, { type Pipeline } from './PipelinesView';
import StandardizationsView from './StandardizationsView';
import OneTimeStandardizationCard from './OneTimeStandardizationCard';
import FilePipelineConnectForm, { type FileSourceType } from './FilePipelineConnectForm';

// ── Layout ──────────────────────────────────────────────────────────────────────
const SIDEBAR_WIDTH = 228;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColumnEntry {
  id:                string;
  columnName:        string;
  selectedDomain:    Domain | null;
}

let _entryCounter = 0;
function mkEntry(overrides: Partial<ColumnEntry> = {}): ColumnEntry {
  return {
    id:             `e${++_entryCounter}`,
    columnName:     '',
    selectedDomain: null,
    ...overrides,
  };
}

function suggestExport(tableFqn: string): string {
  const t = tableFqn.trim();
  if (!t) return '';
  return `${t}_STANDARDIZED`;
}

// Demo-data mode: prefills the connect form with the seeded TEST_DB demo table.
// Off by default so real customers see a clean empty form.
const DEMO_DATA = process.env.NEXT_PUBLIC_PRISM_DEMO_DATA === 'true';

// Default domain (by name) for known demo columns (demo mode only). The matching
// Domain object is resolved once /api/domains has loaded (domain IDs are autoincrement).
const DEFAULT_COLUMN_DOMAINS: Record<string, string> = {
  RAW_CARRIER_VALUE: 'Mobile Carrier',
  RAW_COMPANY_VALUE: 'Company Name',
};
function defaultDomainForColumn(columnName: string, domainsList: Domain[]): Domain | null {
  if (!DEMO_DATA) return null;
  const target = DEFAULT_COLUMN_DOMAINS[columnName.trim().toUpperCase()];
  if (!target) return null;
  return domainsList.find(d => d.name === target) ?? null;
}

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

// ── Domain info modal ─────────────────────────────────────────────────────────
function DomainInfoTooltip() {
  const [open, setOpen] = useState(false);

  const modal = open && typeof document !== 'undefined' ? createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
      onClick={() => setOpen(false)}
    >
      <div
        className="rounded-card border-[0.5px] w-full mx-4 overflow-y-auto"
        style={{
          backgroundColor: 'var(--surface)', borderColor: 'var(--border)',
          padding: '20px 22px', maxHeight: '88vh', maxWidth: 400,
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>What is a domain?</p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: '50%', border: '0.5px solid var(--border)',
              backgroundColor: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <p className="text-[12px] leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
          A domain groups columns that standardize the same kind of value.
        </p>

        <ul className="flex flex-col gap-2.5 mb-4" style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
          {[
            'Naming conventions are configured per domain and applied to values in every column linked to that domain.',
            'Columns in the same domain share one lookup table — a confirmed mapping in one pipeline is reused by all others.',
          ].map((point, i) => (
            <li key={i} className="flex items-start gap-2">
              <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <span className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{point}</span>
            </li>
          ))}
        </ul>

        {/* Examples of Domains */}
        <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 12 }}>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--text-hint)' }}>Examples of Domains</p>
          <div className="flex flex-col gap-2">
            {([
              {
                domain: 'Company Name',
                columns: [
                  { col: 'VENDOR_NAME',      table: 'sales.ORDERS' },
                  { col: 'SUPPLIER_COMPANY', table: 'procurement.CONTRACTS' },
                ],
              },
              {
                domain: 'Drug Name',
                columns: [
                  { col: 'MEDICATION', table: 'patient.PRESCRIPTIONS' },
                  { col: 'DRUG',       table: 'safety.ADVERSE_EVENTS' },
                ],
              },
            ] as const).map(ex => (
              <div
                key={ex.domain}
                className="rounded-button border-[0.5px] px-3 py-2.5"
                style={{ borderColor: 'var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>{ex.domain}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-hint)' }}>domain</span>
                </div>
                <div className="flex flex-col gap-1">
                  {ex.columns.map(c => (
                    <div key={c.col} className="flex items-center gap-1.5">
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                        <path d="M3 1L6 4L3 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}/>
                      </svg>
                      <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--text-primary)' }}>{c.col}</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>in {c.table}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOpen(false)}
          className="w-full mt-4 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors"
          style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        aria-label="What is a domain?"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: '50%',
          backgroundColor: 'var(--accent)', border: 'none',
          color: '#fff', cursor: 'pointer', flexShrink: 0,
          padding: 0,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M5 4.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="5" cy="3" r="0.75" fill="currentColor"/>
        </svg>
      </button>
      {modal}
    </span>
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
  entries, existingColNames,
  domains, domainsLoading, busy,
  onToggle, onSetDomain, onDomainCreated,
}: {
  columns:          TableColumn[];
  loading:          boolean;
  error:            string | null;
  hasTable:         boolean;
  entries:          ColumnEntry[];
  existingColNames: Set<string>;
  domains:          Domain[];
  domainsLoading:   boolean;
  busy:             boolean;
  onToggle:         (name: string) => void;
  onSetDomain:      (name: string, d: Domain | null) => void;
  onDomainCreated:  (d: Domain) => void;
}) {
  const [filter, setFilter] = useState('');
  const selectedDomainOf = (name: string) =>
    entries.find(e => e.columnName.toUpperCase() === name.toUpperCase())?.selectedDomain ?? null;
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
              <button
                type="button"
                disabled={disabled}
                onClick={() => onToggle(col.name)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed"
                style={{ backgroundColor: selected ? 'var(--accent-tint)' : 'transparent', opacity: blocked ? 0.55 : 1 }}
                onMouseEnter={e => { if (!disabled && !selected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
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
                <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide flex-shrink-0" style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
                  {col.type.toLowerCase()}
                </span>
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
              </button>
              {selected && (
                <div className="px-3 pb-2.5 pt-0.5 flex flex-col gap-1.5" style={{ backgroundColor: 'var(--accent-tint)' }}>
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>Domain</span>
                      <DomainInfoTooltip />
                    </span>
                    <div className="flex-1 min-w-0">
                      <CompactDomainPicker
                        domains={domains}
                        isLoading={domainsLoading}
                        value={selectedDomainOf(col.name)}
                        onChange={d => onSetDomain(col.name, d)}
                        onDomainCreated={onDomainCreated}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <p className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                    Domains establishes what the data in the column represents – e.g. Mobile Carriers, Drug Names, Company Names
                  </p>
                </div>
              )}
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
function ExportTableDisclosure({ exportTableFqn }: { exportTableFqn: string }) {
  const [open, setOpen] = useState(false);
  const exportTable = exportTableFqn.trim() || 'DB.SCHEMA.TABLE_STANDARDIZED';

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
          <span className="font-semibold" style={{ color: '#1E40AF' }}>Snowflake changes: </span>
          Prism will create and maintain{' '}
          <span className="font-mono" style={{ wordBreak: 'break-all' }}>{exportTable}</span>{' '}
          as a standardized copy of your source table.
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
            After each standardization pass, Prism rebuilds the export table with all confirmed mappings:
          </p>
          <ol className="flex flex-col gap-2 mt-0.5">
            <li className="flex gap-2.5 items-start">
              <span className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}>1</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>Export table created / replaced</p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  <span className="font-mono">{exportTable}</span> — same schema as the source table but with the watched column replaced by the canonical standardized name.
                  Only rows with a confirmed mapping are included.
                </p>
              </div>
            </li>
            <li className="flex gap-2.5 items-start">
              <span className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}>2</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>Rebuilt on every pass</p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  Every time new values are standardized the table is fully refreshed — always a complete, consistent snapshot.
                </p>
              </div>
            </li>
          </ol>
          <div className="rounded-[8px] px-3 py-2 mt-1" style={{ backgroundColor: '#FFF7ED', border: '0.5px solid #FED7AA' }}>
            <p className="text-[11px]" style={{ color: '#92400E' }}>
              <strong>Required Snowflake privileges</strong> for the service role:{' '}
              <span className="font-mono">SELECT</span> on the source table,{' '}
              <span className="font-mono">USAGE</span> on the source database and schema,
              and <span className="font-mono">CREATE TABLE</span> on the export schema.
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

  type Tab = 'connect' | 'pipelines' | 'standardizations' | 'how-it-works';
  const [activeTab, setActiveTab] = useState<Tab>('connect');

  // Switch to the tab specified in the URL (e.g. ?tab=connect from the logo link).
  const [openDomainId, setOpenDomainId] = useState<number | null>(null);
  useEffect(() => {
    const tab = searchParams.get('tab') as Tab | null;
    if (tab && ['connect', 'pipelines', 'standardizations', 'how-it-works'].includes(tab)) {
      setActiveTab(tab);
    }
    const od = searchParams.get('open_domain_id');
    setOpenDomainId(od ? Number(od) : null);
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

  // ── Pipeline alert badge ──────────────────────────────────────────────────
  // Snapshot of paused pipelines at page load. Admins see every paused pipeline;
  // standard users only see ones they created. The badge clears once the user
  // opens the Pipelines tab and stays cleared for this page session (it returns
  // on the next fresh load if pipelines are still paused).
  const [pausedPipelines, setPausedPipelines] = useState<Pipeline[]>([]);
  const [alertBadgeSeen,  setAlertBadgeSeen]  = useState(false);
  useEffect(() => {
    fetch('/api/pipelines')
      .then(r => r.json())
      .then(b => setPausedPipelines((b.pipelines ?? []).filter((p: Pipeline) => p.status === 'paused')))
      .catch(() => {});
  }, []);

  const pausedAlertCount = useMemo(() => {
    if (isAdmin === null) return 0; // identity not resolved yet — don't flash a badge
    return pausedPipelines.filter(p => isAdmin || p.created_by === accountId).length;
  }, [pausedPipelines, isAdmin, accountId]);

  // ── Domains (fetched once, shared across all entries) ─────────────────────
  const [domains,        setDomains]        = useState<Domain[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  useEffect(() => {
    fetch('/api/domains')
      .then(r => r.json())
      .then(b => {
        const list = (b.domains ?? []) as Domain[];
        setDomains(list);
        // Pre-fill the default domain for any selected column that has a known
        // mapping but no domain yet (e.g. the demo RAW_CARRIER_VALUE / RAW_COMPANY_VALUE).
        setColumnEntries(prev => prev.map(e =>
          e.selectedDomain ? e : { ...e, selectedDomain: defaultDomainForColumn(e.columnName, list) }));
      })
      .catch(() => {})
      .finally(() => setDomainsLoading(false));
  }, []);

  function handleDomainCreated(d: Domain) {
    setDomains(prev => [d, ...prev]);
  }

  // ── Pipeline DB state ─────────────────────────────────────────────────────
  const [activePipelineId, setActivePipelineId] = useState<number | null>(null);
  const [pendingActivation, setPendingActivation] = useState<Pipeline | null>(null);
  // All sibling pipelines sharing the pending activation's table+export (one per
  // standardized column), so the activation card lists every column, not just one.
  const [pendingSiblings, setPendingSiblings] = useState<Pipeline[]>([]);
  // Progress while "Begin Pipeline Standardization" commits the deferred lookup
  // writes (one step per column) and then activates the pipeline.
  const [beginProgress, setBeginProgress] = useState<{ current: number; total: number; phase: 'writing' | 'starting'; pct: number; etaSec: number | null } | null>(null);
  const beginTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [beginError,    setBeginError]    = useState<string | null>(null);

  // ── Pipeline source type ──────────────────────────────────────────────────
  const [pipelineSourceType, setPipelineSourceType] = useState<'snowflake' | FileSourceType>('snowflake');

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
  // Update mode for the whole table (all columns share it).
  const [updateMode,        setUpdateMode]        = useState<'auto' | 'manual'>('auto');
  // export_unmapped_rows: manual-only toggle. When false, unmapped rows are excluded
  // from the export table (only rows with a confirmed mapping appear).
  const [exportUnmappedRows, setExportUnmappedRows] = useState(false);
  const loading = loadingStep !== 'idle';

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
  function existingExportForTable(table: string): string | null {
    const t = table.trim();
    const m = existingPipelines.find(p => p.table_fqn === t && p.export_table_fqn);
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
      setExportTableFqnRaw(existingExportForTable(val) ?? suggestExport(val));
    }
  }

  // Once the existing-pipelines snapshot loads, re-default the export file for the
  // current table if the user hasn't edited it (covers the initial default table).
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

  useEffect(() => {
    const t = tableFqn.trim();
    if (t.split('.').filter(Boolean).length !== 3) {
      setTableColumns([]); setColumnsError(null); setColumnsLoading(false);
      return;
    }
    let cancelled = false;
    setColumnsLoading(true); setColumnsError(null);
    const timer = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/columns?table_fqn=${encodeURIComponent(t)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setColumnsError(body?.error ?? 'Could not read this table — check the name and that the service role has access.');
          setTableColumns([]);
        } else {
          const fields = (body.fields ?? []) as TableColumn[];
          setTableColumns(fields);
          // Drop any selected columns that aren't in this table (e.g. after a table change).
          const names = new Set(fields.map(f => f.name.toUpperCase()));
          setColumnEntries(prev => {
            const kept = prev.filter(e => names.has(e.columnName.toUpperCase()));
            return kept.length === prev.length ? prev : kept;
          });
        }
      } catch {
        if (!cancelled) { setColumnsError('Could not read this table — check the name and access.'); setTableColumns([]); }
      } finally {
        if (!cancelled) setColumnsLoading(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tableFqn]);

  // Columns of the current table that already have a pipeline (uppercased).
  const existingColNames = useMemo(() => {
    const t = tableFqn.trim();
    return new Set(existingPipelines.filter(p => p.table_fqn === t).map(p => p.column_name.toUpperCase()));
  }, [existingPipelines, tableFqn]);

  // Toggle a column's selection (add/remove a column entry by name).
  function toggleColumnSelection(name: string) {
    setColumnEntries(prev => {
      const existing = prev.find(e => e.columnName.toUpperCase() === name.toUpperCase());
      if (existing) return prev.filter(e => e !== existing);
      // Pre-select a default domain for known demo columns (Mobile Carrier / Company Name).
      return [...prev, mkEntry({ columnName: name, selectedDomain: defaultDomainForColumn(name, domains) })];
    });
  }

  function setColumnDomainByName(name: string, domain: Domain | null) {
    setColumnEntries(prev => prev.map(e =>
      e.columnName.toUpperCase() === name.toUpperCase() ? { ...e, selectedDomain: domain } : e));
  }

  function updateEntryColumn(id: string, columnName: string) {
    setColumnEntries(prev => prev.map(e =>
      e.id !== id ? e : { ...e, columnName }
    ));
  }

  function updateEntryDomain(id: string, domain: Domain | null) {
    setColumnEntries(prev => prev.map(e =>
      e.id !== id ? e : { ...e, selectedDomain: domain }
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
        setColumnEntries((siblings.length > 0 ? siblings : [pl]).map(p => mkEntry({
          columnName:     p.column_name,
          selectedDomain: p.domain_id ? { domain_id: p.domain_id, name: p.domain_name ?? '', description: null, standardization_rules: null, convention_type: null, convention_value: null, convention_rules: null, usage_count: 0, last_used_at: null, created_at: null } : null,
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
      const { table_fqn, column_name, domain_id, domain_name } = JSON.parse(raw);
      if (!table_fqn || !column_name) return;
      setTableFqnRaw(table_fqn);
      setExportTableFqnRaw(suggestExport(table_fqn));
      setExportTableEdited(false);
      setColumnEntries([mkEntry({
        columnName:     column_name,
        selectedDomain: domain_id ? { domain_id, name: domain_name ?? '', description: null, standardization_rules: null, convention_type: null, convention_value: null, convention_rules: null, usage_count: 0, last_used_at: null, created_at: null } : null,
      })]);
    } catch { /* malformed — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect handler ───────────────────────────────────────────────────────
  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const table  = tableFqn.trim();
    const exportTable = exportTableFqn.trim();
    if (!table || loading) return;

    if (!exportTable) {
      setFormError('Export table is required.');
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
      // Domain is mandatory for every column.
      if (!entry.selectedDomain) {
        const label = entry.columnName.trim() || `Column ${i + 1}`;
        setFormError(`Choose a domain for ${label}.`);
        return;
      }
    }

    // Block table+column pairs that already have a pipeline.
    const shortTable = table.split('.').pop() ?? table;
    const dupes = columnEntries.filter(en =>
      existingPipelines.some(p =>
        p.table_fqn === table && p.column_name.toLowerCase() === en.columnName.trim().toLowerCase()));
    if (dupes.length > 0) {
      const list = dupes.map(d => `${shortTable}.${d.columnName.trim()}`).join(', ');
      setFormError(`${list} already has a pipeline created.`);
      return;
    }

    setFormError(null);

    // Export-file conflict: this table already exports to a different file. Ask
    // whether to reuse that export table or deliberately create a separate one.
    const existingExport = existingExportForTable(table);
    if (existingExport && existingExport !== exportTable) {
      setExportConflict({ existingExport });
      return;
    }

    void proceedCreate(exportTable);
  }

  async function proceedCreate(finalExport: string) {
    const table  = tableFqn.trim();
    const exportTable = finalExport.trim();
    if (!table || loading) return;
    setExportConflict(null);
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
            domain_id:            entry.selectedDomain?.domain_id ?? null,
            export_table_fqn:     exportTable,
            mode:                 updateMode,
            export_unmapped_rows: updateMode === 'manual' ? exportUnmappedRows : true,
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
    if (!pendingActivation) return;
    const pl = pendingActivation;
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

  const canSubmit = !loading && !!tableFqn.trim() && !!exportTableFqn.trim() &&
    columnEntries.length > 0 &&
    columnEntries.every(e => e.columnName.trim() && e.selectedDomain);

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
              { id: 'connect',          label: 'Connect',          Icon: IconConnect },
              { id: 'pipelines',        label: 'Pipelines',        Icon: IconClassify },
              { id: 'standardizations', label: 'Standardizations', Icon: IconAutoExport },
              { id: 'how-it-works',     label: 'How it works',     Icon: IconGuide },
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

          {isAdmin === true && (
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
        {activeTab === 'connect' && (
          <div style={{ padding: '32px 40px' }}>
            <div className="mx-auto" style={{ maxWidth: 1100 }}>

              {/* Step summary — minimal graphics + brief copy */}
              {!pendingActivation && (
                <div className="flex items-stretch gap-3 mb-6">
                  {([
                    {
                      title: 'Connect source',
                      desc:  'Point Prism at a Snowflake table and column, choose a domain, and set the export table.',
                      graphic: (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <rect x="2.5" y="3" width="15" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                          <path d="M2.5 7.5h15M8 7.5V17" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                      ),
                    },
                    {
                      title: 'Review groups',
                      desc:  'Prism groups the raw values of the table and recommends a single standardized name for each group – check the groupings/standardized names and accept.',
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

                    {/* Source type selector */}
                    <div className="mb-5">
                      <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Source type</label>
                      <div
                        className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full"
                        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
                      >
                        {([
                          { id: 'snowflake', label: 'Snowflake' },
                          { id: 'csv',       label: 'CSV' },
                          { id: 'excel',     label: 'Excel' },
                          { id: 'sheets',    label: 'Google Sheets' },
                        ] as const).map(({ id, label }, i, arr) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setPipelineSourceType(id)}
                            className="flex-1 py-2 text-xs font-medium transition-colors"
                            style={{
                              backgroundColor: pipelineSourceType === id ? 'var(--accent)' : 'transparent',
                              color:           pipelineSourceType === id ? 'white' : 'var(--text-muted)',
                              borderRight:     i < arr.length - 1 ? '0.5px solid var(--border)' : undefined,
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* File-based pipeline form */}
                    {pipelineSourceType !== 'snowflake' && (
                      <FilePipelineConnectForm
                        sourceType={pipelineSourceType}
                        domains={domains}
                        domainsLoading={domainsLoading}
                        onDomainCreated={handleDomainCreated}
                      />
                    )}

                    {/* Snowflake form */}
                    {pipelineSourceType === 'snowflake' && (
                    <><form onSubmit={handleConnect}>
                      {/* Source table — shared across all column entries */}
                      <div className="mb-4">
                        <label htmlFor="ae-table-fqn" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Source table
                        </label>
                        <input
                          id="ae-table-fqn" type="text" value={tableFqn}
                          onChange={e => setTableFqn(e.target.value)}
                          placeholder="DATABASE.SCHEMA.TABLE_NAME"
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={inputStyle}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>Full path to the source table whose column values you want to standardize</p>
                      </div>

                      {/* Export table — single shared destination for all columns */}
                      <div className="mb-5">
                        <label htmlFor="ae-export-fqn" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Export table
                        </label>
                        <input
                          id="ae-export-fqn" type="text" value={exportTableFqn}
                          onChange={e => setExportTableFqn(e.target.value)}
                          placeholder="DATABASE.SCHEMA.TABLE_STANDARDIZED"
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={inputStyle}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>This table will be maintained as a copy of the source table with the specified columns replaced with their standardized values</p>
                      </div>

                      {/* Update mode — applies to the whole table */}
                      <div className="mb-5">
                        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Update mode
                        </label>
                        <div
                          className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
                        >
                          {([
                            { id: 'auto',   label: 'Automatic' },
                            { id: 'manual', label: 'Manual' },
                          ] as const).map(({ id, label }, i) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setUpdateMode(id)}
                              disabled={loading}
                              className="flex-1 py-2 text-xs font-medium transition-colors disabled:opacity-50"
                              style={{
                                backgroundColor: updateMode === id ? 'var(--accent)' : 'transparent',
                                color:           updateMode === id ? 'white' : 'var(--text-muted)',
                                borderRight:     i === 0 ? '0.5px solid var(--border)' : undefined,
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-hint)' }}>
                          {updateMode === 'auto'
                            ? 'New values are standardized and exported automatically.'
                            : 'New values are sent to the export file as is and will be standardized when you review and approve the standardizations.'}
                        </p>
                      </div>

                      {/* Export unmapped rows — manual mode only */}
                      {updateMode === 'manual' && (
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
                      )}

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
                              domains={domains}
                              domainsLoading={domainsLoading}
                              busy={loading}
                              onToggle={toggleColumnSelection}
                              onSetDomain={setColumnDomainByName}
                              onDomainCreated={handleDomainCreated}
                            />
                            <button
                              type="button"
                              onClick={() => { setManualColumns(true); if (columnEntries.length === 0) setColumnEntries([mkEntry()]); }}
                              className="mt-2 text-xs font-medium transition-colors"
                              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                            >
                              Can’t see your columns? Enter them manually
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
                                  <div className="flex items-center justify-between mb-2.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                                      Column {idx + 1}
                                    </span>
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
                                  <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
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
                                    <div>
                                      <label className="flex items-center gap-1 text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                                        Domain
                                        <DomainInfoTooltip />
                                      </label>
                                      <CompactDomainPicker
                                        domains={domains}
                                        isLoading={domainsLoading}
                                        value={entry.selectedDomain}
                                        onChange={d => updateEntryDomain(entry.id, d)}
                                        onDomainCreated={handleDomainCreated}
                                        disabled={loading}
                                      />
                                      <p className="text-[10px] mt-1 leading-tight" style={{ color: 'var(--text-muted)' }}>
                                        Domains establishes what the data in the column represents – e.g. Mobile Carriers, Drug Names, Company Names
                                      </p>
                                    </div>
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
                              Pick from the table’s columns instead
                            </button>
                          </>
                        )}
                      </div>

                      {formError && (
                        <div className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                          {formError}
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
                        {loadingStep === 'validating' && (
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
                        {loadingStep === 'idle' && 'Create initial standardizations'}
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
                                void proceedCreate(exp);
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
                              onClick={() => { void proceedCreate(exportTableFqn.trim()); }}
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
                    </>) /* end pipelineSourceType === 'snowflake' */}
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
                            {c.domain_name && (
                              <span className="text-[11px] font-medium rounded-pill px-2.5 py-0.5 flex-shrink-0"
                                style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>
                                {c.domain_name}
                              </span>
                            )}
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
                      <ExportTableDisclosure exportTableFqn={pendingActivation.export_table_fqn} />
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
                          className="w-full py-2.5 rounded-button text-sm font-medium transition-colors flex items-center justify-center gap-2 border"
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
                          className="w-full py-2 rounded-button border-[0.5px] text-xs font-medium transition-colors"
                          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#FECACA'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                        >
                          Cancel pipeline
                        </button>
                      </>
                    )}
                  </>
                )}

              </div>

              {/* One-time standardization — a one-off, no-pipeline alternative */}
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

        {activeTab === 'standardizations' && <StandardizationsView initialOpenDomainId={openDomainId} />}

        {/* ════════════════════════════════════════════════════════════════
            HOW IT WORKS TAB
        ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'how-it-works' && (
          <div style={{ padding: '28px 40px' }}>
            <div className="mx-auto" style={{ maxWidth: 1000 }}>

              {/* Hero */}
              <div className="mb-8">
                <p className="text-[10px] font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}>
                  HOW IT WORKS
                </p>
                <h1 className="text-[28px] font-semibold mb-2" style={{ color: 'var(--text-primary)', lineHeight: 1.25 }}>
                  From messy values to one standard
                  <span style={{ color: 'var(--border)', fontWeight: 400 }}> | </span>
                  Continuous and Automatic
                </h1>
                <p className="text-[14px] leading-relaxed mb-6" style={{ color: 'var(--text-secondary)', maxWidth: 560 }}>
                  Prism recognizes when different values in your database mean the same thing — and standardizes them across your database continuously and automatically.
                </p>

                {/* Hero before → after diagram */}
                <div className="flex items-center gap-8">
                  {/* Before column */}
                  <div className="rounded-card border-[0.5px] overflow-hidden" style={{ width: 216, backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
                    <div className="px-4 py-2.5" style={{ borderBottom: '0.5px solid var(--border)', backgroundColor: 'var(--page-bg)' }}>
                      <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--text-muted)' }}>COMPANY_NAME</span>
                    </div>
                    {[
                      { value: 'Prism Inc', dot: '#16a34a' },
                      { value: 'PRISM', dot: '#DC2626' },
                      { value: 'prism.io', dot: '#DC2626' },
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
                      <svg width="8" height="7" viewBox="0 0 8 7" fill="none" aria-hidden="true">
                        <path d="M4 0L8 7H0L4 0Z" fill="var(--accent)" />
                      </svg>
                      <span className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>Prism</span>
                    </div>
                  </div>

                  {/* After column */}
                  <div className="rounded-card border-[0.5px] overflow-hidden" style={{ width: 216, backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)' }}>
                    <div className="px-4 py-2.5" style={{ borderBottom: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)' }}>
                      <span className="text-[10px] font-semibold tracking-widest font-mono" style={{ color: 'var(--accent)' }}>COMPANY_NAME</span>
                    </div>
                    {['Prism', 'Prism', 'Prism'].map((v, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-4 py-2.5"
                        style={{ borderBottom: i < 2 ? '0.5px solid var(--border-subtle)' : undefined }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#16a34a', flexShrink: 0 }} />
                        <span className="text-[13px] font-mono font-semibold" style={{ color: 'var(--accent-strong)' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Step 01: text left, data-flow graphic right */}
              <div className="flex items-start gap-12 py-8" style={{ borderTop: '0.5px solid var(--border)' }}>
                <div style={{ flex: '0 0 38%', paddingTop: 2 }}>
                  <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>01 —</p>
                  <h2 className="text-[20px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                    Data arrives from everywhere, spelled differently
                  </h2>
                  <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Many data sources e.g. Salesforce, Stripe, Internal Databases, have their own naming convention of the same value. They all land in your warehouse as raw, inconsistent values.
                  </p>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* DATA SOURCES diagram */}
                  <div className="rounded-[10px] border-[0.5px] px-4 py-3.5"
                    style={{ backgroundColor: 'var(--page-bg)', borderColor: 'var(--border)', borderStyle: 'dashed' }}>
                    <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)' }}>DATA SOURCES</p>
                    <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      {([
                        { name: 'Salesforce',  svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><ellipse cx="7" cy="7" rx="5" ry="3.5" stroke="#00A1E0" strokeWidth="1.2"/><path d="M2.5 7h9" stroke="#00A1E0" strokeWidth="1.2" strokeLinecap="round"/><path d="M5 4l-.5 6M9 4l.5 6" stroke="#00A1E0" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                        { name: 'Stripe',      svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="4" width="10" height="6" rx="1" stroke="#6366F1" strokeWidth="1.2"/><path d="M2 6.5h10" stroke="#6366F1" strokeWidth="1.2"/></svg> },
                        { name: 'Customer DB', svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><ellipse cx="7" cy="4" rx="4" ry="1.4" stroke="#6B7280" strokeWidth="1.2"/><path d="M3 4v6c0 .77 1.79 1.4 4 1.4s4-.63 4-1.4V4" stroke="#6B7280" strokeWidth="1.2"/><path d="M3 7c0 .77 1.79 1.4 4 1.4s4-.63 4-1.4" stroke="#6B7280" strokeWidth="1.2"/></svg> },
                        { name: 'CSV uploads', svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 2H3.5A1 1 0 002.5 3v8A1 1 0 003.5 12h7a1 1 0 001-1V5L8.5 2z" stroke="#0F6E56" strokeWidth="1.2"/><path d="M8.5 2v3h3" stroke="#0F6E56" strokeWidth="1.2" strokeLinejoin="round"/><path d="M5 8h4M5 10h2.5" stroke="#0F6E56" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                      ] as { name: string; svg: React.ReactNode }[]).map(s => (
                        <div key={s.name} className="flex items-center gap-2.5 rounded-button border-[0.5px] px-3.5 py-2.5"
                          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                          {s.svg}
                          <span className="text-[12px] font-medium">{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Down arrow */}
                  <div className="flex justify-center py-2.5">
                    <svg width="12" height="16" viewBox="0 0 12 16" fill="none" style={{ color: 'var(--text-muted)' }}>
                      <path d="M6 1v12M1 10l5 4 5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  {/* RAW TABLE diagram */}
                  <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ backgroundColor: 'var(--surface)', borderColor: '#FECACA' }}>
                    <div className="flex items-center justify-between px-4 py-2.5"
                      style={{ backgroundColor: '#FEF2F2', borderBottom: '0.5px solid #FECACA' }}>
                      <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#A32D2D' }}>RAW TABLE</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-pill font-medium"
                        style={{ backgroundColor: '#FEE2E2', color: '#991B1B', border: '0.5px solid #FECACA' }}>
                        inconsistent
                      </span>
                    </div>
                    {([
                      ['JPMorgan', 'Salesforce'],
                      ['Chase',    'Stripe'],
                      ['JPM',      'Customer DB'],
                    ] as [string, string][]).map(([name, src], i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2.5"
                        style={{ borderBottom: i < 2 ? '0.5px solid #FEE2E2' : undefined }}>
                        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{name}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-pill font-medium"
                          style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
                          {src}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Step 02: graphic left, text right */}
              <div className="flex items-start gap-12 py-8" style={{ borderTop: '0.5px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Standardization flow diagram */}
                  <div className="rounded-[10px] border-[0.5px] px-5 py-4"
                    style={{ backgroundColor: 'var(--page-bg)', borderColor: 'var(--border)', borderStyle: 'dashed' }}>
                    <p className="text-[10px] font-semibold uppercase tracking-widest mb-3.5" style={{ color: 'var(--text-muted)' }}>STANDARDIZATION</p>
                    <div className="flex items-center gap-5">
                      {/* Input chips (raw) */}
                      <div className="flex flex-col gap-2" style={{ flex: 1 }}>
                        {['JPMorgan', 'Chase', 'JPM'].map((v, i) => (
                          <div key={i} className="px-3.5 py-2.5 rounded-button border-[0.5px] text-[12px] font-medium"
                            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: '#991B1B' }}>
                            {v}
                          </div>
                        ))}
                      </div>
                      {/* Prism transform arrow */}
                      <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                        <svg width="8" height="7" viewBox="0 0 8 7" fill="none" aria-hidden="true">
                          <path d="M4 0L8 7H0L4 0Z" fill="var(--accent)" />
                        </svg>
                        <svg width="36" height="10" viewBox="0 0 36 10" fill="none" style={{ color: 'var(--accent)' }}>
                          <path d="M1 5h31M27 1l8 4-8 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--accent)' }}>Prism</span>
                      </div>
                      {/* Output chips (canonical) */}
                      <div className="flex flex-col gap-2" style={{ flex: 1 }}>
                        {['JP Morgan', 'JP Morgan', 'JP Morgan'].map((v, i) => (
                          <div key={i} className="px-3.5 py-2.5 rounded-button border-[0.5px] text-[12px] font-semibold"
                            style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)', color: 'var(--accent-strong)' }}>
                            {v}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ flex: '0 0 38%', paddingTop: 2 }}>
                  <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>02 —</p>
                  <h2 className="text-[20px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                    Prism groups the variants into one standardized name
                  </h2>
                  <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    AI groups the variants together and renames them. You do 1 initial review and approval. From then on, every new value is mapped automatically when the source table updates — no manual work, no CASE WHEN blocks.
                  </p>
                </div>
              </div>

              {/* Step 03: text left, standardized table + consumers right */}
              <div className="flex items-start gap-12 py-8 mb-8" style={{ borderTop: '0.5px solid var(--border)' }}>
                <div style={{ flex: '0 0 38%', paddingTop: 2 }}>
                  <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>03 —</p>
                  <h2 className="text-[20px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                    Every downstream tool reads clean values automatically
                  </h2>
                  <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Prism maintains a copy of the source table with the standardized values. The standardized table updates continuously based on the source table. Dashboards stop double-counting. Analytics finally add up. LLMs produce accurate results supplied with consistent data.
                  </p>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* STANDARDIZED TABLE diagram */}
                  <div className="rounded-[10px] border-[0.5px] overflow-hidden" style={{ backgroundColor: 'var(--surface)', borderColor: '#BBF7D0' }}>
                    <div className="flex items-center justify-between px-4 py-2.5"
                      style={{ backgroundColor: '#F0FDF4', borderBottom: '0.5px solid #BBF7D0' }}>
                      <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#15803D' }}>STANDARDIZED TABLE</span>
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium rounded-pill px-2 py-0.5"
                        style={{ backgroundColor: '#DCFCE7', color: '#15803D', border: '0.5px solid #BBF7D0' }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: '#16a34a', display: 'inline-block', flexShrink: 0 }} />
                        Live · auto-updating
                      </span>
                    </div>
                    {['JP Morgan', 'JP Morgan', 'JP Morgan'].map((v, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-4 py-2.5"
                        style={{ borderBottom: i < 2 ? '0.5px solid #D1FAE5' : undefined }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#16a34a', flexShrink: 0 }} />
                        <span className="text-[13px] font-medium" style={{ color: '#15803D' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  {/* Down arrow */}
                  <div className="flex justify-center py-2.5">
                    <svg width="12" height="16" viewBox="0 0 12 16" fill="none" style={{ color: 'var(--text-muted)' }}>
                      <path d="M6 1v12M1 10l5 4 5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  {/* DOWNSTREAM CONSUMERS diagram */}
                  <div className="rounded-[10px] border-[0.5px] px-4 py-3.5"
                    style={{ backgroundColor: 'var(--page-bg)', borderColor: 'var(--border)', borderStyle: 'dashed' }}>
                    <p className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)' }}>DOWNSTREAM CONSUMERS</p>
                    <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      {([
                        { name: 'LLMs',       svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 10.5V8.5A4.5 4.5 0 0111.5 8.5v2" stroke="#7C3AED" strokeWidth="1.2" strokeLinecap="round"/><circle cx="7" cy="4.5" r="2" stroke="#7C3AED" strokeWidth="1.2"/></svg> },
                        { name: 'Dashboards', svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4" height="4" rx="0.7" stroke="#4285F4" strokeWidth="1.2"/><rect x="8.5" y="1.5" width="4" height="4" rx="0.7" stroke="#4285F4" strokeWidth="1.2"/><rect x="1.5" y="8.5" width="4" height="4" rx="0.7" stroke="#4285F4" strokeWidth="1.2"/><rect x="8.5" y="8.5" width="4" height="4" rx="0.7" stroke="#4285F4" strokeWidth="1.2"/></svg> },
                        { name: 'Analytics',  svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 11l3-4 2.5 2.5 3-6 2.5 3.5" stroke="#0F6E56" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                        { name: 'dbt models', svg: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5l5 3v5l-5 3-5-3v-5l5-3z" stroke="#FF694A" strokeWidth="1.2" strokeLinejoin="round"/></svg> },
                      ] as { name: string; svg: React.ReactNode }[]).map(t => (
                        <div key={t.name} className="flex items-center gap-2.5 rounded-button border-[0.5px] px-3.5 py-2.5"
                          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                          {t.svg}
                          <span className="text-[12px] font-medium">{t.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Auto vs manual */}
              <h2 className="text-[15px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)' }}>
                Automatic vs. manual mode
              </h2>
              <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <div className="rounded-card border-[0.5px]"
                  style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--accent-border)', padding: 'var(--card-padding)' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                      style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>Automatic</span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>recommended</span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    New values are standardized and exported on their own — when the queue crosses
                    25 items or on the hourly sweep. Hands-off once it&rsquo;s live.
                  </p>
                </div>
                <div className="rounded-card border-[0.5px]"
                  style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-semibold rounded-pill px-2 py-0.5"
                      style={{ backgroundColor: 'var(--page-bg)', color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}>Manual</span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    New values are sent to the export file as is and will be standardized when you review and approve the standardizations.
                  </p>
                </div>
              </div>

              {/* Good to know */}
              <h2 className="text-[15px] font-semibold mb-2.5" style={{ color: 'var(--text-primary)' }}>
                Good to know
              </h2>
              <div className="rounded-card border-[0.5px] mb-6"
                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}>
                <ul className="flex flex-col gap-2.5">
                  {[
                    'A domain is locked once a pipeline is created — choose it deliberately up front.',
                    'The Standardizations tab is your canonical library: review and edit the confirmed name for any value across every pipeline.',
                    'Matching is case- and whitespace-insensitive, so byte-variant spellings collapse to the same canonical name automatically.',
                    'Mass events (a bulk reload, TRUNCATE, or a Time-Travel restore) are caught by an hourly safety rebuild even if the stream misses them.',
                  ].map((tip, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                          <path d="M3 8l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{tip}</span>
                    </li>
                  ))}
                </ul>
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
