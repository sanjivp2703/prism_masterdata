'use client';

import { useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';

function PrismLogo() {
  return (
    <div className="flex items-center gap-2 mb-8 justify-center">
      <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true">
        <polygon points="0,0 0,34 22,17" fill="#1A1A2E" />
        <polygon points="44,0 44,34 22,17" fill="#378ADD" />
        <circle cx="22" cy="17" r="2.2" fill="white" />
      </svg>
      <span className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>Prism</span>
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  );
}

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </label>
  );
}

function Input({ id, value, onChange, placeholder, type = 'text' }: {
  id?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <input
      id={id} type={type} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-sm rounded-button"
      style={{
        height: 36, padding: '0 10px', border: '0.5px solid var(--border)',
        backgroundColor: 'var(--surface)', color: 'var(--text-primary)',
        fontFamily: 'monospace', outline: 'none',
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
      onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
    />
  );
}

function Textarea({ id, value, onChange, placeholder, rows = 4 }: {
  id?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      id={id} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} rows={rows}
      className="w-full text-xs rounded-button resize-none"
      style={{
        padding: '8px 10px', border: '0.5px solid var(--border)',
        backgroundColor: 'var(--surface)', color: 'var(--text-primary)',
        fontFamily: 'monospace', outline: 'none',
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
      onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
    />
  );
}

interface GrantsResult {
  applied: number;
  failed: number;
  errors: { sql: string; error: string | null }[];
  conn_error: string | null;
}

function GrantsSummary({ grants, onContinue }: { grants: GrantsResult; onContinue: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const allOk = grants.applied > 0 && grants.failed === 0 && !grants.conn_error;

  return (
    <div
      className="rounded-card border-[0.5px] p-4"
      style={{ borderColor: allOk ? '#6EE7B7' : '#FCA5A5', backgroundColor: allOk ? '#F0FDF4' : '#FFF5F5' }}
    >
      <div className="flex items-start gap-3">
        {allOk ? (
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="mt-0.5 flex-shrink-0">
            <circle cx="9" cy="9" r="8" stroke="#059669" strokeWidth="1.4" />
            <path d="M5.5 9l2.5 2.5 4.5-4.5" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="mt-0.5 flex-shrink-0">
            <circle cx="9" cy="9" r="8" stroke="#DC2626" strokeWidth="1.4" />
            <path d="M9 5.5v4" stroke="#DC2626" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="9" cy="12" r="0.8" fill="#DC2626" />
          </svg>
        )}
        <div className="flex-1 min-w-0">
          {grants.conn_error ? (
            <p className="text-sm font-medium" style={{ color: '#991B1B' }}>
              Could not connect to apply grants
            </p>
          ) : (
            <p className="text-sm font-medium" style={{ color: allOk ? '#065F46' : '#991B1B' }}>
              {grants.applied} grant{grants.applied !== 1 ? 's' : ''} applied
              {grants.failed > 0 ? `, ${grants.failed} failed` : ''}
            </p>
          )}

          {grants.conn_error && (
            <p className="text-xs mt-1" style={{ color: '#991B1B' }}>{grants.conn_error}</p>
          )}

          {grants.failed > 0 && !grants.conn_error && (
            <>
              <p className="text-xs mt-0.5" style={{ color: '#B91C1C' }}>
                Some grants require ACCOUNTADMIN. Run them manually in Snowflake.
              </p>
              <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="text-xs mt-1 font-medium underline"
                style={{ color: '#991B1B', background: 'none', cursor: 'pointer' }}
              >
                {expanded ? 'Hide' : 'Show'} failed statements
              </button>
              {expanded && (
                <pre
                  className="mt-2 text-[10px] p-2 rounded-button overflow-x-auto"
                  style={{ backgroundColor: '#1A1A2E', color: '#F87171', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  {grants.errors.map(e => `-- ${e.error}\n${e.sql};`).join('\n\n')}
                </pre>
              )}
            </>
          )}

          {(grants.conn_error || grants.failed > 0) && (
            <p className="text-xs mt-2" style={{ color: '#6B7280' }}>
              Credentials were saved. You can apply grants later from Admin → Snowflake connection.
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-4 w-full text-sm font-medium rounded-button flex items-center justify-center"
        style={{ height: 36, backgroundColor: 'var(--accent)', color: '#fff', cursor: 'pointer' }}
      >
        Continue to Prism
      </button>
    </div>
  );
}

function SetupForm() {
  const params  = useSearchParams();
  const router  = useRouter();
  const nextUrl = params.get('next') || '/home';

  const [sfAccount,    setSfAccount]    = useState('');
  const [sfUser,       setSfUser]       = useState('');
  const [sfWarehouse,  setSfWarehouse]  = useState('');
  const [sfRole,       setSfRole]       = useState('');
  const [authMode,     setAuthMode]     = useState<'password' | 'key'>('password');
  const [sfPassword,   setSfPassword]   = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');

  const [testing,     setTesting]     = useState(false);
  const [testResult,  setTestResult]  = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [grantsResult, setGrantsResult] = useState<GrantsResult | null>(null);

  const hasCredential = authMode === 'password' ? sfPassword.trim() !== '' : sfPrivateKey.trim() !== '';
  const canAct = sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && hasCredential;

  async function handleTest() {
    if (!canAct) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/accounts/test-snowflake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sf_account:     sfAccount.trim(),
          sf_user:        sfUser.trim(),
          sf_warehouse:   sfWarehouse.trim(),
          sf_role:        sfRole.trim() || undefined,
          sf_password:    authMode === 'password' ? sfPassword : undefined,
          sf_private_key: authMode === 'key'      ? sfPrivateKey : undefined,
        }),
      });
      const b = await r.json();
      setTestResult({ ok: b.ok, msg: b.ok ? `Connected — Snowflake ${b.version}` : (b.error ?? 'Failed') });
    } catch {
      setTestResult({ ok: false, msg: 'Network error' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!canAct) return;
    setSaving(true);
    setSaveError(null);
    setGrantsResult(null);
    try {
      const r = await fetch('/api/accounts/snowflake-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sf_account:     sfAccount.trim(),
          sf_user:        sfUser.trim(),
          sf_warehouse:   sfWarehouse.trim(),
          sf_role:        sfRole.trim() || undefined,
          sf_password:    authMode === 'password' ? sfPassword : undefined,
          sf_private_key: authMode === 'key'      ? sfPrivateKey : undefined,
        }),
      });
      const b = await r.json();
      if (!r.ok) { setSaveError(b.error || 'Failed to save'); return; }
      setGrantsResult(b.grants as GrantsResult);
    } catch {
      setSaveError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  }

  if (grantsResult) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ width: '100%', maxWidth: 520 }}>
          <PrismLogo />
          <GrantsSummary grants={grantsResult} onContinue={() => router.push(nextUrl)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: '100%', maxWidth: 520 }}>
        <PrismLogo />

        <div className="rounded-card border-[0.5px]" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '32px 28px' }}>
          <h1 className="text-[18px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Connect your Snowflake account
          </h1>
          <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
            Enter your Snowflake credentials. Prism will save them and automatically apply the
            necessary role grants. Requires ACCOUNTADMIN or SYSADMIN.
          </p>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="col-span-2">
              <Label htmlFor="sf-account">Account identifier</Label>
              <Input id="sf-account" value={sfAccount} onChange={setSfAccount} placeholder="xy12345.us-east-1" />
            </div>
            <div>
              <Label htmlFor="sf-user">Username</Label>
              <Input id="sf-user" value={sfUser} onChange={setSfUser} placeholder="PRISM_SVC" />
            </div>
            <div>
              <Label htmlFor="sf-warehouse">Warehouse</Label>
              <Input id="sf-warehouse" value={sfWarehouse} onChange={setSfWarehouse} placeholder="COMPUTE_WH" />
            </div>
            <div className="col-span-2">
              <Label htmlFor="sf-role">Role (optional)</Label>
              <Input id="sf-role" value={sfRole} onChange={setSfRole} placeholder="ACCOUNTADMIN" />
            </div>
          </div>

          {/* Auth toggle */}
          <div className="mb-3">
            <Label>Authentication</Label>
            <div className="flex rounded-button p-[2px]" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)', width: 'fit-content' }}>
              {(['password', 'key'] as const).map(m => (
                <button key={m} type="button" onClick={() => setAuthMode(m)}
                  className="text-xs font-medium rounded-toggle-option px-3 py-1 transition-colors"
                  style={{
                    backgroundColor: authMode === m ? 'var(--surface)' : 'transparent',
                    color: authMode === m ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: authMode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  {m === 'password' ? 'Password' : 'Private key'}
                </button>
              ))}
            </div>
          </div>

          {authMode === 'password' ? (
            <div className="mb-4">
              <Label htmlFor="sf-password">Password</Label>
              <Input id="sf-password" type="password" value={sfPassword} onChange={setSfPassword} placeholder="••••••••" />
            </div>
          ) : (
            <div className="mb-4">
              <Label htmlFor="sf-key">Private key (PEM)</Label>
              <Textarea id="sf-key" value={sfPrivateKey} onChange={setSfPrivateKey}
                placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                rows={5}
              />
            </div>
          )}

          {testResult && (
            <div className="mb-4 flex items-center gap-2 text-xs font-medium" style={{ color: testResult.ok ? '#065F46' : '#991B1B' }}>
              {testResult.ok
                ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#059669" strokeWidth="1.3"/><path d="M4.5 7l2 2 3-3.5" stroke="#059669" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#DC2626" strokeWidth="1.3"/><path d="M5 5l4 4M9 5l-4 4" stroke="#DC2626" strokeWidth="1.3" strokeLinecap="round"/></svg>
              }
              {testResult.msg}
            </div>
          )}

          {saveError && (
            <p className="text-xs mb-3" style={{ color: '#991B1B' }}>{saveError}</p>
          )}

          <div className="flex items-center gap-3">
            <button type="button" onClick={handleTest} disabled={!canAct || testing}
              className="flex items-center gap-2 text-sm font-medium rounded-button px-4"
              style={{
                height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)',
                color: canAct && !testing ? 'var(--text-primary)' : 'var(--text-hint)',
                cursor: canAct && !testing ? 'pointer' : 'not-allowed',
              }}
            >
              {testing && <Spinner />}
              Test connection
            </button>

            <button type="button" onClick={handleSave} disabled={!canAct || saving}
              className="flex items-center gap-2 text-sm font-medium rounded-button px-4"
              style={{
                height: 36,
                backgroundColor: canAct && !saving ? 'var(--accent)' : 'var(--accent-border)',
                color: '#fff',
                cursor: canAct && !saving ? 'pointer' : 'not-allowed',
              }}
            >
              {saving ? <><Spinner /> Applying grants…</> : 'Save and apply grants'}
            </button>

            <button type="button" onClick={() => router.push(nextUrl)}
              className="text-sm ml-auto"
              style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
            >
              Skip, use defaults
            </button>
          </div>
        </div>

        <p className="text-xs text-center mt-4" style={{ color: 'var(--text-hint)' }}>
          Credentials are stored in your account and used only to connect to Snowflake on your behalf.
        </p>
      </div>
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense>
      <SetupForm />
    </Suspense>
  );
}
