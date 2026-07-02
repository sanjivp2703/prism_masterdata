'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppMode } from '@/app/api/_lib/feature-flags';
import { APP_MODE_CONFIG } from '@/app/api/_lib/feature-flags';

// ── JSON modal viewer ─────────────────────────────────────────────────────────

function JsonModal({ title, value, onClose }: { title: string; value: unknown; onClose: () => void }) {
  const pretty = useMemo(() => {
    try {
      const obj = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  // Close on Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex flex-col bg-white rounded-sm shadow-2xl w-full max-w-4xl max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <span className="text-sm font-semibold text-gray-700 font-mono">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none px-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {/* Scrollable JSON body */}
        <div className="overflow-auto flex-1 p-4 bg-gray-950 rounded-b-sm">
          <pre className="text-xs text-green-300 font-mono whitespace-pre leading-relaxed">
            {pretty}
          </pre>
        </div>
      </div>
    </div>
  );
}

// Detect whether a value is a JSON object/array (or a JSON string encoding one).
function isJsonValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'object') return true;
  if (typeof v === 'string') {
    const t = v.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(v); return true; } catch { /* not JSON */ }
    }
  }
  return false;
}

function JsonCell({ colKey, value }: { colKey: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!isJsonValue(value)) {
    // Regular cell — truncate long strings
    const str = value === null ? '' : String(value);
    return (
      <span className={str.length > 80 ? 'cursor-default' : ''} title={str.length > 80 ? str : undefined}>
        {str.length > 80 ? `${str.slice(0, 80)}…` : str || (
          <span className="text-gray-400 italic">null</span>
        )}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors"
      >
        <span>{'{ }'}</span>
        <span>View JSON</span>
      </button>
      {open && <JsonModal title={colKey} value={value} onClose={close} />}
    </>
  );
}

// ── Configuration section ─────────────────────────────────────────────────────

const MODES: AppMode[] = ['basic', 'premium'];

function ConfigSection() {
  const [currentMode, setCurrentMode]     = useState<AppMode | null>(null);
  const [saving,      setSaving]          = useState(false);
  const [restartBanner, setRestartBanner] = useState(false);
  const [error,       setError]           = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/config')
      .then(r => r.json())
      .then(d => { if (d.mode) setCurrentMode(d.mode as AppMode); })
      .catch(() => setError('Could not load configuration.'));
  }, []);

  async function handleModeChange(mode: AppMode) {
    if (mode === currentMode || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res  = await fetch('/api/admin/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setCurrentMode(mode);
      setRestartBanner(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-sm shadow-md p-6">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-6">
        <div className="w-8 h-8 rounded-sm flex items-center justify-center bg-gray-100">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="2.5" stroke="#374151" strokeWidth="1.4" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.54 11.54l1.41 1.41M3.05 12.95l1.42-1.42M11.54 4.46l1.41-1.41" stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-800">Configuration</h2>
      </div>

      {/* Restart required banner */}
      {restartBanner && (
        <div className="flex items-start gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 mb-6">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="mt-0.5 flex-shrink-0" aria-hidden="true">
            <path d="M8 2L14.5 13H1.5L8 2Z" stroke="#92400E" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6v3" stroke="#92400E" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="#92400E" />
          </svg>
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800">Restart required</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Mode saved to <code className="font-mono bg-amber-100 px-1 rounded">.env.local</code>.
              Restart the dev server for the change to take effect.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRestartBanner(false)}
            className="text-amber-500 hover:text-amber-700 text-lg leading-none"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-sm border border-red-200 bg-red-50 px-4 py-3 mb-6 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Mode picker row */}
      <div className="flex items-start gap-6">
        <div className="w-36 pt-0.5 flex-shrink-0">
          <p className="text-sm font-medium text-gray-700">Product Mode</p>
          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
            Controls which features are active
          </p>
        </div>

        {/* Mode cards */}
        <div className="flex gap-3 flex-1">
          {MODES.map(mode => {
            const cfg      = APP_MODE_CONFIG[mode];
            const selected = currentMode === mode;
            const loading  = currentMode === null;
            return (
              <button
                key={mode}
                type="button"
                disabled={saving || loading}
                onClick={() => handleModeChange(mode)}
                className="flex-1 text-left rounded-sm border-2 px-5 py-4 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  borderColor:     selected ? cfg.color : '#E5E7EB',
                  backgroundColor: selected ? cfg.bg    : '#FAFAFA',
                  boxShadow:       selected ? `0 0 0 1px ${cfg.border}` : 'none',
                  cursor:          saving || loading ? 'not-allowed' : 'pointer',
                }}
              >
                {/* Top row: label + active pill */}
                <div className="flex items-center justify-between mb-2">
                  <span
                    className="text-sm font-semibold"
                    style={{ color: selected ? cfg.color : '#374151' }}
                  >
                    {cfg.label}
                  </span>
                  {selected && !loading && (
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-sm"
                      style={{ color: cfg.color, backgroundColor: cfg.border }}
                    >
                      ACTIVE
                    </span>
                  )}
                  {loading && (
                    <span className="w-3 h-3 rounded-full bg-gray-200 animate-pulse" />
                  )}
                </div>
                <p className="text-xs leading-relaxed text-gray-500">
                  {cfg.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Tables tab ────────────────────────────────────────────────────────────────

// ── Snowflake config section ──────────────────────────────────────────────────

interface GrantsResult {
  applied: number;
  failed: number;
  errors: { sql: string; error: string | null }[];
  conn_error: string | null;
}

function GrantsPanel({ grants }: { grants: GrantsResult }) {
  const [expanded, setExpanded] = useState(false);
  const allOk = grants.applied > 0 && grants.failed === 0 && !grants.conn_error;
  const color = allOk ? '#065F46' : '#991B1B';
  const bg    = allOk ? '#F0FDF4' : '#FFF5F5';
  const border = allOk ? '#6EE7B7' : '#FCA5A5';

  return (
    <div className="rounded-sm border p-3 text-xs" style={{ backgroundColor: bg, borderColor: border }}>
      <p className="font-semibold mb-0.5" style={{ color }}>
        {grants.conn_error
          ? 'Could not connect to apply grants'
          : `${grants.applied} grant${grants.applied !== 1 ? 's' : ''} applied${grants.failed > 0 ? `, ${grants.failed} failed` : ''}`}
      </p>
      {grants.conn_error && <p style={{ color }}>{grants.conn_error}</p>}
      {grants.failed > 0 && !grants.conn_error && (
        <>
          <p className="mt-0.5" style={{ color: '#B91C1C' }}>
            Some grants require ACCOUNTADMIN. Run them manually in Snowflake.
          </p>
          <button type="button" onClick={() => setExpanded(v => !v)}
            className="mt-1 underline font-medium" style={{ color: '#991B1B', background: 'none', cursor: 'pointer' }}>
            {expanded ? 'Hide' : 'Show'} failed statements
          </button>
          {expanded && (
            <pre className="mt-2 p-2 rounded-sm overflow-x-auto text-[10px]"
              style={{ backgroundColor: '#1A1A2E', color: '#F87171', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {grants.errors.map(e => `-- ${e.error}\n${e.sql};`).join('\n\n')}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function SnowflakeConfigSection() {
  const [loaded,       setLoaded]       = useState(false);
  const [sfAccount,    setSfAccount]    = useState('');
  const [sfUser,       setSfUser]       = useState('');
  const [sfWarehouse,  setSfWarehouse]  = useState('');
  const [sfRole,       setSfRole]       = useState('');
  const [authMode,     setAuthMode]     = useState<'password' | 'key'>('password');
  const [sfPassword,   setSfPassword]   = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');
  const [hasPassword,  setHasPassword]  = useState(false);
  const [hasKey,       setHasKey]       = useState(false);

  const [testing,      setTesting]      = useState(false);
  const [testResult,   setTestResult]   = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving,       setSaving]       = useState(false);
  const [saveError,    setSaveError]    = useState<string | null>(null);
  const [grantsResult, setGrantsResult] = useState<GrantsResult | null>(null);
  const [clearing,     setClearing]     = useState(false);
  const [clearMsg,     setClearMsg]     = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/accounts/snowflake-config')
      .then(r => r.json())
      .then(d => {
        setSfAccount(d.sf_account    ?? '');
        setSfUser(d.sf_user          ?? '');
        setSfWarehouse(d.sf_warehouse ?? '');
        setSfRole(d.sf_role          ?? '');
        setHasPassword(Boolean(d.has_password));
        setHasKey(Boolean(d.has_private_key));
        setAuthMode(d.has_private_key ? 'key' : 'password');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const hasCredential = authMode === 'password'
    ? (sfPassword.trim() !== '' || hasPassword)
    : (sfPrivateKey.trim() !== '' || hasKey);
  const canAct = !!(sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && hasCredential);

  function buildBody() {
    return {
      sf_account:     sfAccount.trim(),
      sf_user:        sfUser.trim(),
      sf_warehouse:   sfWarehouse.trim(),
      sf_role:        sfRole.trim() || undefined,
      sf_password:    authMode === 'password' && sfPassword.trim() ? sfPassword : undefined,
      sf_private_key: authMode === 'key'      && sfPrivateKey.trim() ? sfPrivateKey : undefined,
    };
  }

  async function handleTest() {
    if (!canAct || testing) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch('/api/accounts/test-snowflake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const b = await r.json();
      setTestResult({ ok: b.ok, msg: b.ok ? `Connected — Snowflake ${b.version}` : (b.error ?? 'Failed') });
    } catch { setTestResult({ ok: false, msg: 'Network error' }); }
    finally   { setTesting(false); }
  }

  async function handleSave() {
    if (!canAct || saving) return;
    setSaving(true); setSaveError(null); setGrantsResult(null); setClearMsg(null);
    try {
      const r = await fetch('/api/accounts/snowflake-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const b = await r.json();
      if (!r.ok) { setSaveError(b.error ?? 'Save failed'); return; }
      setGrantsResult(b.grants as GrantsResult);
      if (sfPassword.trim())   setHasPassword(true);
      if (sfPrivateKey.trim()) setHasKey(true);
      setSfPassword(''); setSfPrivateKey('');
    } catch { setSaveError('Network error'); }
    finally   { setSaving(false); }
  }

  async function handleClear() {
    if (clearing) return;
    setClearing(true); setSaveError(null); setGrantsResult(null); setClearMsg(null);
    try {
      const r = await fetch('/api/accounts/snowflake-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      const b = await r.json();
      if (!r.ok) { setSaveError(b.error ?? 'Clear failed'); return; }
      setSfAccount(''); setSfUser(''); setSfWarehouse(''); setSfRole('');
      setSfPassword(''); setSfPrivateKey('');
      setHasPassword(false); setHasKey(false);
      setClearMsg('Cleared — using system env var defaults');
    } catch { setSaveError('Network error'); }
    finally   { setClearing(false); }
  }

  const inp = 'w-full text-xs font-mono rounded-sm border border-gray-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400';

  return (
    <div className="bg-white rounded-sm shadow-md p-6">
      <div className="flex items-center gap-2 mb-5">
        <div className="w-8 h-8 rounded-sm flex items-center justify-center bg-gray-100">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <ellipse cx="8" cy="4.5" rx="5" ry="2" stroke="#374151" strokeWidth="1.3"/>
            <path d="M3 4.5v7c0 1.1 2.24 2 5 2s5-.9 5-2v-7" stroke="#374151" strokeWidth="1.3"/>
            <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" stroke="#374151" strokeWidth="1.3"/>
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Snowflake connection</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Per-account credentials. Saving also applies all Prism role grants. Leave blank to use env var defaults.
          </p>
        </div>
      </div>

      {!loaded ? (
        <p className="text-xs text-gray-400 animate-pulse">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3">
              <label className="block text-xs font-medium text-gray-500 mb-1">Account identifier</label>
              <input className={inp} value={sfAccount} onChange={e => setSfAccount(e.target.value)} placeholder="xy12345.us-east-1" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Username</label>
              <input className={inp} value={sfUser} onChange={e => setSfUser(e.target.value)} placeholder="PRISM_SVC" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Warehouse</label>
              <input className={inp} value={sfWarehouse} onChange={e => setSfWarehouse(e.target.value)} placeholder="COMPUTE_WH" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Role (optional)</label>
              <input className={inp} value={sfRole} onChange={e => setSfRole(e.target.value)} placeholder="ACCOUNTADMIN" />
            </div>
          </div>

          <div className="flex gap-2 items-center">
            <span className="text-xs font-medium text-gray-500 w-24">Auth method</span>
            <div className="flex rounded-sm border border-gray-200 overflow-hidden">
              {(['password', 'key'] as const).map(m => (
                <button key={m} type="button" onClick={() => setAuthMode(m)} className="text-xs px-3 py-1"
                  style={{ backgroundColor: authMode === m ? '#F3F4F6' : '#FFF', color: authMode === m ? '#111827' : '#6B7280', fontWeight: authMode === m ? 600 : 400 }}>
                  {m === 'password' ? 'Password' : 'Private key'}
                </button>
              ))}
            </div>
          </div>

          {authMode === 'password' ? (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Password {hasPassword && !sfPassword && <span className="text-green-600">(saved — enter new to replace)</span>}
              </label>
              <input type="password" className={inp} value={sfPassword} onChange={e => setSfPassword(e.target.value)} placeholder="••••••••" />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Private key (PEM) {hasKey && !sfPrivateKey && <span className="text-green-600">(saved — paste new to replace)</span>}
              </label>
              <textarea className={`${inp} resize-none`} rows={4} value={sfPrivateKey}
                onChange={e => setSfPrivateKey(e.target.value)}
                placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"} />
            </div>
          )}

          {testResult && (
            <p className="text-xs" style={{ color: testResult.ok ? '#065F46' : '#991B1B' }}>
              {testResult.ok ? '✓' : '✗'} {testResult.msg}
            </p>
          )}
          {saveError  && <p className="text-xs text-red-700">✗ {saveError}</p>}
          {clearMsg   && <p className="text-xs text-green-700">✓ {clearMsg}</p>}
          {grantsResult && <GrantsPanel grants={grantsResult} />}

          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={handleTest} disabled={!canAct || testing}
              className="text-xs font-medium px-3 py-1.5 rounded-sm border border-gray-200 bg-white text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={handleSave} disabled={!canAct || saving}
              className="text-xs font-medium px-3 py-1.5 rounded-sm bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-700">
              {saving ? 'Saving & applying grants…' : 'Save and apply grants'}
            </button>
            {(sfAccount || hasPassword || hasKey) && (
              <button type="button" onClick={handleClear} disabled={clearing}
                className="text-xs font-medium px-3 py-1.5 rounded-sm border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 ml-auto">
                {clearing ? 'Clearing…' : 'Clear (use defaults)'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const TABLES: { name: string; section?: string }[] = [
  { name: 'RUNS',                  section: 'One-Prompt' },
  { name: 'LITERAL_ALIAS_MATCHES', section: 'One-Prompt' },
  { name: 'APPROVED_ALIAS_NAMES',  section: 'One-Prompt' },
  { name: 'VALIDATION_LOG',        section: 'One-Prompt' },
];

function TableSection({ tableName }: { tableName: string }) {
  const [data, setData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch(`/api/admin/table/${tableName}`, { cache: 'no-store' });
        if (response.ok) {
          const result = await response.json();
          setData(result.data || []);
          setError(null);
        } else {
          const body = await response.json().catch(() => ({} as any));
          const msg = (body && (body.error || body.message)) || `${response.status} ${response.statusText}`;
          const details = body?.details ? ` (${String(body.details)})` : '';
          setError(`Failed to fetch: ${msg}${details}`);
        }
      } catch (e) {
        setError(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [tableName]);

  return (
    <div className="bg-white rounded-sm shadow-md p-6">
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">
        {tableName}
        <span className="ml-3 text-sm font-normal text-gray-500">
          ({loading ? '...' : `${data.length} rows`})
        </span>
      </h2>
      {loading ? (
        <div className="text-gray-500 italic">Loading...</div>
      ) : error ? (
        <div className="text-red-600 bg-red-50 p-4 rounded">{error}</div>
      ) : data.length === 0 ? (
        <div className="text-gray-500 italic">No data</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {Object.keys(data[0]).map((key) => (
                  <th
                    key={key}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((row, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  {Object.entries(row).map(([colKey, value]) => (
                    <td key={colKey} className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap max-w-xs">
                      {value === null ? (
                        <span className="text-gray-400 italic">null</span>
                      ) : (
                        <JsonCell colKey={colKey} value={value} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-gray-50 p-8" style={{ paddingTop: 76 }}>
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-6">Admin</h1>
        <div className="space-y-8">

          {/* ── Configuration ──────────────────────────────────────────────── */}
          <div>
            <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4 mt-2">
              Configuration
            </h2>
            <div className="space-y-4">
              <ConfigSection />
              <SnowflakeConfigSection />
            </div>
          </div>

          {/* ── Data tables ────────────────────────────────────────────────── */}
          {TABLES.map((entry, i) => (
            <div key={entry.name}>
              {entry.section && (i === 0 || TABLES[i - 1].section !== entry.section) && (
                <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4 mt-2">
                  {entry.section}
                </h2>
              )}
              <TableSection tableName={entry.name} />
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}
