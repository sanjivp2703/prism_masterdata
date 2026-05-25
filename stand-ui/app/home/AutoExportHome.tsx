'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DomainSelector, { type Domain } from '@/app/components/DomainSelector';
import PipelinesView, { type Pipeline } from './PipelinesView';

// ── Prism mark ───────────────────────────────────────────────────────────────
function PrismMark({ size = 40 }: { size?: number }) {
  const h  = size;
  const w  = Math.round(size * 1.28);
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <polygon points={`0,0 0,${h} ${cx},${cy}`} fill="#1A1A2E" />
      <polygon points={`${w},0 ${w},${h} ${cx},${cy}`} fill="#378ADD" />
      <circle cx={cx} cy={cy} r={size * 0.065} fill="white" />
    </svg>
  );
}

// ── Step icons ────────────────────────────────────────────────────────────────
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

// ── Spinner ──────────────────────────────────────────────────────────────────
function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Pulse dot ─────────────────────────────────────────────────────────────────
function PulseDot({ color = '#16a34a' }: { color?: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', backgroundColor: color, opacity: 0.4, animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite' }} />
      <span style={{ borderRadius: '50%', width: 8, height: 8, backgroundColor: color, display: 'block' }} />
    </span>
  );
}

// ── Countdown bar ─────────────────────────────────────────────────────────────
// (kept for potential future use; not currently rendered)

// ── Export table disclosure ───────────────────────────────────────────────────
function ExportTableDisclosure({ exportTableFqn }: { exportTableFqn: string }) {
  const [open, setOpen] = useState(false);
  const exportTable = exportTableFqn.trim() || 'DB.SCHEMA.TABLE_STANDARDIZED';

  return (
    <div
      className="rounded-[10px] border-[0.5px] mb-4 overflow-hidden"
      style={{ borderColor: '#CBD5E1', backgroundColor: '#F8FAFC' }}
    >
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-2.5 px-3.5 py-3 text-left"
        style={{ backgroundColor: 'transparent' }}
      >
        {/* Info icon */}
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

        {/* Chevron */}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ flexShrink: 0, marginTop: 2, color: '#94A3B8', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          <path d="M2.5 4.5l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Expanded detail */}
      {open && (
        <div
          className="px-3.5 pb-3.5 flex flex-col gap-2.5"
          style={{ borderTop: '0.5px solid #E2E8F0' }}
        >
          <p className="text-[11px] mt-3" style={{ color: '#64748B' }}>
            After each standardization pass, Prism rebuilds the export table
            with all confirmed mappings:
          </p>

          <ol className="flex flex-col gap-2 mt-0.5">
            <li className="flex gap-2.5 items-start">
              <span
                className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}
              >1</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>Export table created / replaced</p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  <span className="font-mono">{exportTable}</span> — same schema as the source
                  table but with the watched column replaced by the canonical standardized name.
                  Only rows with a confirmed mapping are included; unmapped rows are excluded.
                </p>
              </div>
            </li>
            <li className="flex gap-2.5 items-start">
              <span
                className="text-[10px] font-semibold rounded-full flex-shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16, backgroundColor: '#DBEAFE', color: '#2563EB', marginTop: 1 }}
              >2</span>
              <div>
                <p className="text-[11px] font-semibold" style={{ color: '#1E293B' }}>Rebuilt on every pass</p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: '#64748B' }}>
                  Every time new values are standardized the table is fully
                  refreshed — always a complete, consistent snapshot of confirmed
                  mappings at that point in time.
                </p>
              </div>
            </li>
          </ol>

          <div
            className="rounded-[8px] px-3 py-2 mt-1"
            style={{ backgroundColor: '#FFF7ED', border: '0.5px solid #FED7AA' }}
          >
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

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AutoExportHome() {
  const router = useRouter();

  type Tab = 'connect' | 'pipelines';
  const [activeTab, setActiveTab] = useState<Tab>('connect');

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => r.json())
      .then(d => setIsAdmin(d.role === 'admin'))
      .catch(() => setIsAdmin(false));
  }, []);

  // ── Pipeline DB state ─────────────────────────────────────────────────────
  const [activePipelineId, setActivePipelineId] = useState<number | null>(null);

  // pendingActivation: pipeline info waiting for user to explicitly kick off polling
  const [pendingActivation, setPendingActivation] = useState<Pipeline | null>(null);

  // ── Auto-connect after completing the initial standardization run ──────────
  // After accepting on the run page, we stored the pipeline_id in localStorage.
  // On mount: look it up and show the "ready to launch" card (pendingActivation).
  useEffect(() => {
    // ── Restore active pipeline for auto-expand after page navigation ─────
    // The pipeline is always polled server-side; we just remember which one
    // the user last started so we can auto-expand it in the Pipelines view.
    // prism_ae_active_pid — persists across same-tab navigation so PipelinesView
    // can auto-expand. prism_ae_jump_pipelines is a one-shot flag written only
    // when the user clicks "Begin Pipeline Standardization"; it auto-switches the
    // tab once and is then removed so subsequent visits start on Connect.
    const activePidStr = sessionStorage.getItem('prism_ae_active_pid');
    const shouldJump   = sessionStorage.getItem('prism_ae_jump_pipelines') === '1';
    sessionStorage.removeItem('prism_ae_jump_pipelines');

    if (activePidStr) {
      const pid = Number(activePidStr);
      if (Number.isFinite(pid) && pid > 0) {
        setActivePipelineId(pid);
        if (shouldJump) setActiveTab('pipelines');
      }
    }

    const pendingId = localStorage.getItem('prism_ae_pending_pipeline_id');
    if (pendingId) {
      localStorage.removeItem('prism_ae_pending_pipeline_id');
      const pid = Number(pendingId);
      if (!Number.isFinite(pid) || pid <= 0) return;

      fetch('/api/pipelines')
        .then(r => r.json())
        .then(body => {
          const pl: Pipeline | undefined = (body.pipelines ?? []).find(
            (p: Pipeline) => p.pipeline_id === pid,
          );
          if (!pl) return;

          // Restore form state for context
          setTableFqn(pl.table_fqn);
          setColumnName(pl.column_name);
          if (pl.domain_id) {
            setSelectedDomain({
              domain_id:    pl.domain_id,
              name:         pl.domain_name ?? '',
              usage_count:  0,
              last_used_at: null,
              created_at:   null,
            });
          }

          // Show the "ready to launch" card instead of auto-starting
          setPendingActivation(pl);
        })
        .catch(() => {});
      return;
    }

    // Fallback: legacy localStorage key (handles transition for existing users)
    const raw = localStorage.getItem('prism_ae_pending_connect');
    if (!raw) return;
    localStorage.removeItem('prism_ae_pending_connect');
    try {
      const { table_fqn, column_name, domain_id, domain_name } = JSON.parse(raw);
      if (!table_fqn || !column_name) return;
      setTableFqn(table_fqn);
      setColumnName(column_name);
      if (domain_id) {
        setSelectedDomain({ domain_id, name: domain_name ?? '', usage_count: 0, last_used_at: null, created_at: null });
      }
    } catch { /* malformed — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Domain selection ──────────────────────────────────────────────────────
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);

  // ── Connection form ───────────────────────────────────────────────────────
  const [tableFqn,        setTableFqn]        = useState('TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT');
  const [columnName,      setColumnName]      = useState('RAW_CARRIER_VALUE');
  const [exportTableFqn,  setExportTableFqn]  = useState('TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT_STANDARDIZED');
  // Track if the user manually edited the export table so we stop auto-updating it
  const [exportTableEdited, setExportTableEdited] = useState(false);

  // Auto-suggest export table name based on source table (unless user has edited it)
  useEffect(() => {
    if (exportTableEdited) return;
    const trimmed = tableFqn.trim();
    setExportTableFqn(trimmed ? `${trimmed}_STANDARDIZED` : '');
  }, [tableFqn, exportTableEdited]);

  const [loadingStep, setLoadingStep] = useState<'idle' | 'validating' | 'connecting' | 'creating-run' | 'processing'>('idle');
  const loading    = loadingStep !== 'idle';
  const [formError,  setFormError]  = useState<string | null>(null);


  // ── Polling state ─────────────────────────────────────────────────────────
  // Polling is now server-driven (see instrumentation.ts / pipeline-poller.ts).
  // activePipelineId tracks which pipeline the user most recently started in
  // this session — used only for auto-expanding it in the Pipelines view.

  // ── Helpers: save / clear pipeline in DB ─────────────────────────────────
  async function savePipeline(
    table:         string,
    column:        string,
    domain:        Domain | null,
    status:        Pipeline['status'],
    exportTable:   string | null,
  ): Promise<number> {
    const res  = await fetch('/api/pipelines', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        table_fqn:        table,
        column_name:      column,
        domain_id:        domain?.domain_id ?? null,
        export_table_fqn: exportTable || null,
        status,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `Failed to save pipeline (HTTP ${res.status})`);
    const pid = body?.pipeline?.pipeline_id;
    if (!pid) throw new Error('Pipeline was saved but no ID was returned — check Snowflake connection.');
    return Number(pid);
  }

  // ── Connect handler ───────────────────────────────────────────────────────
  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const table      = tableFqn.trim();
    const column     = columnName.trim();
    const exportTable = exportTableFqn.trim() || null;
    if (!table || !column || loading) return;

    if (!selectedDomain) {
      setFormError('Please select a domain before connecting.');
      return;
    }
    if (!exportTable) {
      setFormError('Please specify an export table name.');
      return;
    }

    setFormError(null);

    try {
      // Step 1: validate the table exists and column is readable
      setLoadingStep('validating');
      const sourceRes  = await fetch(`/api/auto-export/source?table_fqn=${encodeURIComponent(table)}&column_name=${encodeURIComponent(column)}`);
      const sourceBody = await sourceRes.json().catch(() => ({}));
      if (!sourceRes.ok) throw new Error(sourceBody?.error ?? 'Failed to reach table');

      // Step 2: check whether a baseline has been established for this source
      setLoadingStep('connecting');
      const baselineRes  = await fetch(`/api/auto-export/baseline?table_fqn=${encodeURIComponent(table)}&column_name=${encodeURIComponent(column)}`);
      const baselineBody = await baselineRes.json().catch(() => ({}));

      if (baselineBody.hasBaseline) {
        // Baseline exists — save pipeline then show the "ready to launch" card
        const pid = await savePipeline(table, column, selectedDomain, 'active', exportTable);
        const pendingPl: Pipeline = {
          pipeline_id:         pid,
          name:                null,
          table_fqn:           table,
          column_name:         column,
          export_table_fqn:    exportTable,
          domain_id:           selectedDomain?.domain_id ?? null,
          domain_name:         selectedDomain?.name ?? null,
          status:              'active',
          mode:                'auto',
          queue_size:          0,
          total_new_values:    0,
          total_mapped:        0,
          last_polled_at:      null,
          last_queue_empty_at: null,
          created_at:          new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        };
        setActivePipelineId(pid);
        setPendingActivation(pendingPl);
      } else {
        // No baseline — create the pipeline, then open the run review page so
        // the user can inspect and adjust the initial groupings before accepting.
        setLoadingStep('creating-run');
        const pid = await savePipeline(table, column, selectedDomain, 'pending_baseline', exportTable);

        // Create a run with LLM-suggested groupings (no auto-export).
        setLoadingStep('processing');
        const initRes  = await fetch(`/api/pipelines/${pid}/create-initial-run`, { method: 'POST' });
        const initBody = await initRes.json().catch(() => ({}));
        if (!initRes.ok) throw new Error(initBody?.error ?? 'Failed to create initial mapping run.');

        if (initBody.run_id) {
          // Navigate to the run review page. After the user accepts, the export
          // route advances the pipeline to 'paused' and the home page will show
          // the activation card via prism_ae_pending_pipeline_id in localStorage.
          router.push(`/run/${initBody.run_id}`);
        } else {
          // Source table was empty — pipeline was advanced to 'paused' automatically.
          const pendingPl: Pipeline = {
            pipeline_id:         pid,
            name:                null,
            table_fqn:           table,
            column_name:         column,
            export_table_fqn:    exportTable,
            domain_id:           selectedDomain?.domain_id ?? null,
            domain_name:         selectedDomain?.name ?? null,
            status:              'paused',
            mode:                'auto',
            queue_size:          0,
            total_new_values:    0,
            total_mapped:        0,
            last_polled_at:      null,
            last_queue_empty_at: new Date().toISOString(),
            created_at:          new Date().toISOString(),
            updated_at:          new Date().toISOString(),
          };
          setActivePipelineId(pid);
          setPendingActivation(pendingPl);
        }
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
      setLoadingStep('idle');
    } finally {
      setLoadingStep('idle');
    }
  }

  // ── Begin standardization (launch polling from activation card) ──────────
  function handleBeginStandardization() {
    if (!pendingActivation) return;
    const pl = pendingActivation;

    // Mark pipeline active in DB so the server-side poller picks it up
    if (pl.pipeline_id) {
      fetch(`/api/pipelines/${pl.pipeline_id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'active' }),
      }).catch(() => {});
    }

    // Remember which pipeline to auto-expand (survives same-tab navigation)
    if (pl.pipeline_id) {
      sessionStorage.setItem('prism_ae_active_pid', String(pl.pipeline_id));
      sessionStorage.setItem('prism_ae_jump_pipelines', '1'); // one-shot tab jump
    }

    setActivePipelineId(pl.pipeline_id || null);
    setPendingActivation(null);
    setActiveTab('pipelines');
  }

  // ── Cancel pipeline (from activation card) ────────────────────────────────
  async function handleCancelPipeline() {
    if (!pendingActivation) return;
    const pl = pendingActivation;

    if (pl.pipeline_id) {
      await fetch(`/api/pipelines/${pl.pipeline_id}`, { method: 'DELETE' }).catch(() => {});
    }

    // Clear Redis baseline so if they reconnect it starts fresh
    fetch(
      `/api/auto-export/source?table_fqn=${encodeURIComponent(pl.table_fqn)}&column_name=${encodeURIComponent(pl.column_name)}`,
      { method: 'DELETE' },
    ).catch(() => {});

    setPendingActivation(null);
    setActivePipelineId(null);
    setFormError(null);
    setLoadingStep('idle');
  }

  // ── Activate from Pipelines view (re-activate a paused pipeline) ─────────
  function handleActivatePipeline(p: Pipeline) {
    // Mark the pipeline active in DB — server-side poller will pick it up
    fetch(`/api/pipelines/${p.pipeline_id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: 'active' }),
    }).catch(() => {});

    sessionStorage.setItem('prism_ae_active_pid', String(p.pipeline_id));
    setActivePipelineId(p.pipeline_id);
  }

  const steps = [
    { icon: <IconConnect />,    label: 'Connect your source table',    sub: 'Point Prism at the Snowflake column you want to watch for new values' },
    { icon: <IconClassify />,   label: 'Continuous classification',    sub: 'New values are automatically detected and classified against the canonical library every 30 seconds' },
    { icon: <IconAutoExport />, label: 'Zero-touch export',            sub: 'Confirmed mappings are written back to the destination table and the global classification map — no manual step required' },
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`@keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>

      <div
        className="min-h-screen"
        style={{ backgroundColor: 'var(--page-bg)', paddingTop: 'calc(var(--page-padding-y) + 44px)' }}
      >
        <div className="w-full max-w-7xl mx-auto" style={{ padding: '0 32px' }}>

          {/* ── Top bar: logo + invite ───────────────────────────────────── */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <PrismMark size={34} />
              <span className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
                Prism
              </span>
            </div>
            {isAdmin !== false && (
              <Link
                href="/invite"
                style={{ visibility: isAdmin === true ? 'visible' : 'hidden', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, borderRadius: 8, padding: '6px 14px', border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent)', textDecoration: 'none' }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="5.5" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1 12c0-2.5 2-4 4.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  <path d="M10.5 8v4M8.5 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                Invite teammate
              </Link>
            )}
          </div>

          {/* ── Page-level tab bar ──────────────────────────────────────── */}
          <div
            className="flex gap-0 mb-0"
            style={{ borderBottom: '0.5px solid var(--border)' }}
          >
            {([
              { id: 'connect',   label: 'Connect' },
              { id: 'pipelines', label: 'Pipelines' },
            ] as const).map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="px-5 pb-3 pt-1 text-sm font-medium transition-colors"
                style={{
                  color:        activeTab === id ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: `2px solid ${activeTab === id ? 'var(--accent)' : 'transparent'}`,
                  marginBottom: '-0.5px',
                }}
              >
                {label}
                {id === 'pipelines' && activePipelineId != null && (
                  <span
                    className="ml-1.5 inline-flex items-center justify-center rounded-full text-[10px] font-semibold"
                    style={{ width: 16, height: 16, backgroundColor: '#16a34a', color: 'white', verticalAlign: 'middle' }}
                  >
                    1
                  </span>
                )}
              </button>
            ))}
          </div>

        </div>{/* /max-w-7xl (tab bar) */}

        {/* ══════════════════════════════════════════════════════════════════
            CONNECT TAB — two-column layout: branding left, form/status right
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === 'connect' && (
          <div
            className="w-full max-w-7xl mx-auto"
            style={{ padding: 'calc(var(--page-padding-y) * 0.8) 32px' }}
          >
            <div className="grid grid-cols-[380px_1fr] gap-20 items-start">

              {/* ── Left: branding + steps ──────────────────────────────── */}
              <div>
                <p className="text-[15px] leading-relaxed mb-10" style={{ color: 'var(--text-secondary)', maxWidth: 360 }}>
                  Automatically classify incoming values from your Snowflake
                  pipelines — new data is detected, standardized against the
                  canonical library, and exported without any manual step.
                </p>

                <div className="flex flex-col gap-6">
                  {steps.map(({ icon, label, sub }, i) => (
                    <div key={i} className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>
                        {icon}
                      </div>
                      <div className="pt-0.5">
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
                        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{sub}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Right: connection form / activation card / status panel ── */}
              <div
                className="rounded-card border-[0.5px]"
                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
              >
                {/* ── State 1: Connection form ──────────────────────────────── */}
                {!pendingActivation && (
                  <>
                    <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Connect source table</h2>
                    <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
                      Prism will build the initial mapping, then poll every 30 seconds.
                    </p>

                    <div className="mb-5">
                      <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Domain</label>
                      <DomainSelector isAdmin={isAdmin === true} value={selectedDomain} onChange={setSelectedDomain} />
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>
                        What kind of data this table contains — used to scope classifications
                      </p>
                    </div>

                    <form onSubmit={handleConnect}>
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
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>Fully qualified — database, schema, and table separated by dots</p>
                      </div>

                      <div className="mb-4">
                        <label htmlFor="ae-column" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Column</label>
                        <input
                          id="ae-column" type="text" value={columnName}
                          onChange={e => setColumnName(e.target.value)}
                          placeholder="COLUMN_NAME"
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>The column containing values to watch for changes</p>
                      </div>

                      <div className="mb-6">
                        <label htmlFor="ae-export-table" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                          Export table
                        </label>
                        <input
                          id="ae-export-table" type="text" value={exportTableFqn}
                          onChange={e => {
                            setExportTableFqn(e.target.value);
                            setExportTableEdited(true);
                          }}
                          placeholder="DATABASE.SCHEMA.TABLE_STANDARDIZED"
                          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                          disabled={loading}
                          className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors disabled:opacity-50"
                          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-hint)' }}>
                          New Snowflake table with the same structure as the source, but with standardized values replacing the watched column.
                          Only rows with confirmed mappings are included.
                        </p>
                      </div>

                      {formError && (
                        <div className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                          {formError}
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={!tableFqn.trim() || !columnName.trim() || !exportTableFqn.trim() || loading}
                        className="w-full py-3 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)' }}
                        onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                      >
                        {loadingStep === 'validating'   && <span className="inline-flex items-center justify-center gap-2"><Spinner />Checking table…</span>}
                        {loadingStep === 'connecting'   && <span className="inline-flex items-center justify-center gap-2"><Spinner />Checking baseline…</span>}
                        {loadingStep === 'creating-run' && <span className="inline-flex items-center justify-center gap-2"><Spinner />Creating pipeline…</span>}
                        {loadingStep === 'processing'   && <span className="inline-flex items-center justify-center gap-2"><Spinner />Building initial groups…</span>}
                        {loadingStep === 'idle'         && 'Create initial mapping'}
                      </button>
                    </form>
                  </>
                )}

                {/* ── State 2: Activation card (post-initial-mapping) ────────── */}
                {pendingActivation && (
                  <>
                    {/* Success badge */}
                    <div className="flex items-center gap-2 mb-5">
                      <div
                        className="flex items-center justify-center rounded-full flex-shrink-0"
                        style={{ width: 28, height: 28, backgroundColor: '#DCFCE7' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M2.5 7l3 3 6-6" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Initial mapping complete</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Your pipeline is ready to go live</p>
                      </div>
                    </div>

                    {/* Pipeline summary */}
                    <div
                      className="rounded-[10px] border-[0.5px] px-4 py-3 mb-6 flex flex-col gap-2"
                      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
                    >
                      {pendingActivation.domain_name && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Domain</span>
                          <span
                            className="text-[11px] font-medium rounded-full px-2.5 py-0.5"
                            style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}
                          >
                            {pendingActivation.domain_name}
                          </span>
                        </div>
                      )}
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Table</span>
                        <span className="text-xs font-mono text-right" style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                          {pendingActivation.table_fqn}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Column</span>
                        <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>
                          {pendingActivation.column_name}
                        </span>
                      </div>
                      {pendingActivation.export_table_fqn && (
                        <div className="flex items-start justify-between gap-4">
                          <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>Export table</span>
                          <span className="text-xs font-mono text-right truncate" style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                            {pendingActivation.export_table_fqn}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* ── Export table disclosure ───────────────────── */}
                    {pendingActivation.export_table_fqn && (
                      <ExportTableDisclosure exportTableFqn={pendingActivation.export_table_fqn} />
                    )}

                    {/* ── Primary CTA: Begin Pipeline Standardization ── */}
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
                      Prism will start polling every 30 seconds and automatically classify new values
                    </p>

                    {/* Cancel */}
                    <button
                      onClick={handleCancelPipeline}
                      className="w-full py-2 rounded-button border-[0.5px] text-xs font-medium transition-colors"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = '#FECACA';
                        (e.currentTarget as HTMLButtonElement).style.color = '#DC2626';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                        (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
                      }}
                    >
                      Cancel pipeline
                    </button>
                  </>
                )}

              </div>{/* end right card */}
            </div>{/* end grid */}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            PIPELINES TAB — full-width list grouped by domain
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === 'pipelines' && (
          <div
            className="w-full max-w-7xl mx-auto"
            style={{ padding: 'calc(var(--page-padding-y) * 0.8) 32px var(--page-padding-y)' }}
          >
            {/* Section header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Pipelines</h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  All configured source connections, grouped by domain
                </p>
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

      </div>{/* end page */}
    </>
  );
}
