'use client';

import { useCallback, useEffect, useState } from 'react';
import { isNativeEdition } from '@/app/api/_lib/edition';

// ── Shared styling helpers ────────────────────────────────────────────────────

const card: React.CSSProperties = {
  backgroundColor: 'var(--surface)',
  border: '0.5px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  padding: 24,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
  margin: 0,
};

const sectionHint: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  margin: '2px 0 0',
  lineHeight: 1.4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  border: '0.5px solid var(--border)',
  borderRadius: 'var(--radius-button)',
  backgroundColor: 'var(--surface)',
  padding: '7px 10px',
  color: 'var(--text-secondary)',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: 4,
};

const primaryBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: '7px 14px',
  borderRadius: 'var(--radius-button)',
  border: '0.5px solid var(--accent)',
  backgroundColor: 'var(--accent)',
  color: '#FFFFFF',
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: '7px 14px',
  borderRadius: 'var(--radius-button)',
  border: '0.5px solid var(--border)',
  backgroundColor: 'var(--surface)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};

const dangerBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: '7px 14px',
  borderRadius: 'var(--radius-button)',
  border: '0.5px solid #F3C6C6',
  backgroundColor: 'var(--surface)',
  color: 'var(--confidence-low)',
  cursor: 'pointer',
};

function disabledStyle(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...base, opacity: 0.4, cursor: 'not-allowed' } : base;
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        border: '0.5px solid #F3C6C6',
        backgroundColor: '#FDF4F4',
        borderRadius: 'var(--radius-button)',
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <p style={{ fontSize: 12, color: 'var(--confidence-low)', margin: 0, flex: 1 }}>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} style={secondaryBtn}>
          Retry
        </button>
      )}
    </div>
  );
}

function humanDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Snowflake connection section ──────────────────────────────────────────────

interface GrantsResult {
  applied: number;
  skipped?: number;
  failed: number;
  errors: { sql: string; error: string | null }[];
  conn_error: string | null;
}

function GrantsPanel({ grants }: { grants: GrantsResult }) {
  const [expanded, setExpanded] = useState(false);
  const skipped = grants.skipped ?? 0;
  const allOk = (grants.applied > 0 || skipped > 0) && grants.failed === 0 && !grants.conn_error;
  const color = allOk ? 'var(--confidence-high)' : 'var(--confidence-low)';
  const bg    = allOk ? '#F2FAF7' : '#FDF4F4';
  const border = allOk ? '#BFE3D6' : '#F3C6C6';

  return (
    <div style={{ border: `0.5px solid ${border}`, backgroundColor: bg, borderRadius: 'var(--radius-button)', padding: '10px 12px', fontSize: 12 }}>
      <p style={{ fontWeight: 500, color, margin: 0 }}>
        {grants.conn_error
          ? 'Could not connect to apply grants'
          : `${grants.applied} grant${grants.applied !== 1 ? 's' : ''} applied${skipped > 0 ? ` · ${skipped} already in place from install` : ''}${grants.failed > 0 ? ` · ${grants.failed} failed` : ''}`}
      </p>
      {grants.conn_error && <p style={{ color, margin: '2px 0 0' }}>{grants.conn_error}</p>}
      {grants.failed > 0 && !grants.conn_error && (
        <>
          <p style={{ color: 'var(--confidence-low)', margin: '2px 0 0' }}>
            These statements need ACCOUNTADMIN and their objects weren&apos;t found — run
            01_internal_tables.sql as ACCOUNTADMIN, or re-save with an elevated role.
          </p>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{ marginTop: 4, textDecoration: 'underline', fontWeight: 500, color: 'var(--confidence-low)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12 }}
          >
            {expanded ? 'Hide' : 'Show'} failed statements
          </button>
          {expanded && (
            <pre style={{ marginTop: 8, padding: 8, borderRadius: 'var(--radius-button)', overflowX: 'auto', fontSize: 10, backgroundColor: '#1A1A2E', color: '#F87171', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {grants.errors.map(e => `-- ${e.error}\n${e.sql};`).join('\n\n')}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function maskAccount(account: string): string {
  if (!account) return account;
  const dot = account.indexOf('.');
  const locator = dot === -1 ? account : account.slice(0, dot);
  const suffix = dot === -1 ? '' : account.slice(dot);
  const visible = locator.slice(0, Math.min(2, locator.length));
  return `${visible}${'•'.repeat(Math.max(3, locator.length - visible.length))}${suffix}`;
}

/**
 * The REAL service-connection state — the one pipelines, the poller and every
 * export actually use.
 *
 * Fixes KI-37: the status line above it is derived from ACCOUNTS.sf_* (the
 * caller's personal row), which createSnowflakeConnection never reads. So this
 * page could report "configured" while the connection running the pipelines was
 * broken, or the reverse — and it disagreed with /setup, which reads the true
 * source. An admin who lands here to diagnose a failing pipeline needs the
 * honest answer and a pointer to where it is actually changed.
 *
 * Reads the same endpoint the setup wizard does, so the two can no longer
 * disagree. That route is admin-only, so this renders nothing for non-admins —
 * correct, since a non-admin cannot fix a workspace-level connection anyway and
 * the personal section above is the part that concerns them.
 */
function ServiceConnectionStatus() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'hidden' }                                   // non-admin, or unreadable
    | { kind: 'ready'; source: string; account: string | null; user: string | null; hasKey: boolean; hasPassword: boolean }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/workspace-snowflake', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) return { kind: 'hidden' as const };     // 401/403 for non-admins
        const b = await r.json().catch(() => ({}));
        return {
          kind: 'ready' as const,
          source:  String(b?.source ?? 'none'),
          account: b?.sf_account ?? null,
          user:    b?.sf_user ?? null,
          // Auth KIND of the service connection. The response has carried these
          // all along; Settings just never rendered them, so an admin checking
          // "is the service connection on key-pair auth?" had nowhere to look —
          // the only "X auth" text on the page describes their own PERSONAL
          // credentials row, which is usually empty and is a different thing
          // entirely (SET-S16). Secrets are never sent, only these booleans.
          hasKey:      b?.has_private_key === true,
          hasPassword: b?.has_password === true,
        };
      })
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState({ kind: 'hidden' }); });
    return () => { cancelled = true; };
  }, []);

  if (state.kind !== 'ready') return null;

  const { source, account, user, hasKey, hasPassword } = state;
  // Key-pair wins when both are present — that is what the connection actually
  // uses, and saying "password auth" there would be actively misleading.
  const authKind = hasKey ? 'key-pair auth' : hasPassword ? 'password auth' : null;
  const connected = source === 'workspace' || source === 'env';
  const where =
    source === 'workspace' ? 'workspace credentials'
    : source === 'env'     ? 'server environment variables'
    : 'not configured';

  return (
    <div
      className="mt-2 px-3 py-2 rounded-button text-xs"
      style={{
        backgroundColor: connected ? 'var(--accent-tint)' : '#FFFBEB',
        border: `0.5px solid ${connected ? 'var(--accent-border)' : '#FDE9C8'}`,
        color: connected ? 'var(--accent-strong)' : '#BA7517',
      }}
    >
      <strong>Service connection (used by all pipelines): </strong>
      {connected
        ? <>{where}{account ? ` · account ${maskAccount(String(account))}` : ''}{user ? ` · user ${String(user)}` : ''}{authKind ? ` · ${authKind}` : ''}</>
        : <>not configured — pipelines cannot run</>}
      {' '}
      <a href="/setup" className="underline font-medium">
        {connected ? 'Change it in setup' : 'Set it up'}
      </a>
      <div style={{ marginTop: 2, opacity: 0.85 }}>
        Saving the personal credentials below does <strong>not</strong> change this.
      </div>
    </div>
  );
}

function SnowflakeSection() {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sfAccount, setSfAccount]       = useState('');
  const [sfUser, setSfUser]             = useState('');
  const [sfWarehouse, setSfWarehouse]   = useState('PRISM_WH');
  const [sfRole, setSfRole]             = useState('PRISM_SERVICE');
  const [authMode, setAuthMode]         = useState<'password' | 'key'>('password');
  const [sfPassword, setSfPassword]     = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');
  const [hasPassword, setHasPassword]   = useState(false);
  const [hasKey, setHasKey]             = useState(false);

  const [testing, setTesting]           = useState(false);
  const [testResult, setTestResult]     = useState<{ ok: boolean; msg: string; warning?: string } | null>(null);
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState<string | null>(null);
  const [grantsResult, setGrantsResult] = useState<GrantsResult | null>(null);
  const [clearing, setClearing]         = useState(false);
  const [clearMsg, setClearMsg]         = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadState('loading');
    setLoadError(null);
    fetch('/api/accounts/snowflake-config', { cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
        setSfAccount(d.sf_account ?? '');
        setSfUser(d.sf_user ?? '');
        setSfWarehouse(d.sf_warehouse ?? 'PRISM_WH');
        setSfRole(d.sf_role ?? 'PRISM_SERVICE');
        setHasPassword(Boolean(d.has_password));
        setHasKey(Boolean(d.has_private_key));
        setAuthMode(d.has_private_key ? 'key' : 'password');
        setLoadState('ready');
      })
      .catch(e => {
        setLoadError(e instanceof Error ? e.message : 'Network error');
        setLoadState('error');
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasCredential = authMode === 'password'
    ? (sfPassword.trim() !== '' || hasPassword)
    : (sfPrivateKey.trim() !== '' || hasKey);
  const canAct = !!(sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && sfRole.trim() && hasCredential);

  function buildBody() {
    return {
      sf_account:     sfAccount.trim(),
      sf_user:        sfUser.trim(),
      sf_warehouse:   sfWarehouse.trim(),
      sf_role:        sfRole.trim() || undefined,
      sf_password:    authMode === 'password' && sfPassword.trim() ? sfPassword : undefined,
      sf_private_key: authMode === 'key' && sfPrivateKey.trim() ? sfPrivateKey : undefined,
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
      setTestResult({
        ok: b.ok,
        msg: b.ok
          ? `Connected — Snowflake ${b.version}${b.used === 'saved' ? ' (saved credentials)' : ''}`
          : (b.error ?? 'Connection failed'),
        warning: b.warning || undefined,
      });
    } catch { setTestResult({ ok: false, msg: 'Network error' }); }
    finally { setTesting(false); }
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
    finally { setSaving(false); }
  }

  async function handleClear() {
    if (clearing) return;
    if (!window.confirm('Clear the saved Snowflake credentials? Prism will fall back to the server environment defaults.')) return;
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
      setClearMsg('Cleared — using environment defaults');
    } catch { setSaveError('Network error'); }
    finally { setClearing(false); }
  }

  // NOTE: this describes the caller's PERSONAL credentials (ACCOUNTS.sf_*),
  // which is what this section reads and writes. It is deliberately NOT called
  // "workspace" any more — createSnowflakeConnection never reads this row, so
  // the old wording claimed a pipeline-affecting change this page cannot make
  // (KI-38). The real service-connection state is shown separately below.
  const configured = Boolean(sfAccount.trim() && (hasPassword || hasKey));
  const statusLine = configured
    ? `Saved — account ${maskAccount(sfAccount.trim())} · ${hasKey ? 'private key' : 'password'} auth`
    : 'No personal credentials saved (optional — see below)';

  return (
    <section style={card}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={sectionTitle}>Your personal Snowflake credentials <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></h2>
        <p style={sectionHint}>
          Stored encrypted against your own account. Pipelines, the poller and all exports use
          the workspace service connection, not these. Prism uses yours in three situations,
          always on tables you choose to connect: one-time standardizations of a table the
          service connection can&rsquo;t see; turning on change tracking for a pipeline when the
          service role can&rsquo;t; and granting the service role access to one table when you
          enable an output mode that writes to it. The last two change settings on that table,
          not just read from it.
        </p>
        <ServiceConnectionStatus />
      </div>

      {loadState === 'loading' && (
        <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Loading connection details…</p>
      )}

      {loadState === 'error' && (
        <ErrorNote
          message={`Couldn't load the saved Snowflake configuration${loadError ? ` (${loadError})` : ''}. To avoid overwriting saved credentials, the form is hidden until it loads.`}
          onRetry={load}
        />
      )}

      {loadState === 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Current status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 7, height: 7, borderRadius: '50%',
                backgroundColor: configured ? 'var(--confidence-high)' : 'var(--text-hint)',
                flexShrink: 0,
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>{statusLine}</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Account identifier</label>
              <input style={inputStyle} value={sfAccount} onChange={e => setSfAccount(e.target.value)} placeholder="xy12345.us-east-1" />
            </div>
            <div>
              <label style={labelStyle}>Username</label>
              <input style={inputStyle} value={sfUser} onChange={e => setSfUser(e.target.value)} placeholder="PRISM_SVC" />
            </div>
            <div>
              <label style={labelStyle}>Warehouse</label>
              <input style={inputStyle} value={sfWarehouse} onChange={e => setSfWarehouse(e.target.value)} placeholder="PRISM_WH" />
            </div>
            <div>
              <label style={labelStyle}>Role</label>
              <input style={inputStyle} value={sfRole} onChange={e => setSfRole(e.target.value)} placeholder="PRISM_SERVICE" />
            </div>
          </div>

          {/* Auth method toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', width: 92 }}>Auth method</span>
            <div style={{ display: 'flex', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-button)', overflow: 'hidden' }}>
              {(['password', 'key'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMode(m)}
                  style={{
                    fontSize: 12,
                    padding: '5px 12px',
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: authMode === m ? 'var(--accent-tint)' : 'var(--surface)',
                    color: authMode === m ? 'var(--accent-strong)' : 'var(--text-muted)',
                    fontWeight: authMode === m ? 500 : 400,
                  }}
                >
                  {m === 'password' ? 'Password' : 'Private key'}
                </button>
              ))}
            </div>
          </div>

          {authMode === 'password' ? (
            <div>
              <label style={labelStyle}>
                Password {hasPassword && !sfPassword && <span style={{ color: 'var(--confidence-high)' }}>(saved — enter new to replace)</span>}
              </label>
              <input type="password" style={inputStyle} value={sfPassword} onChange={e => setSfPassword(e.target.value)} placeholder="••••••••" />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>
                Private key (PEM) {hasKey && !sfPrivateKey && <span style={{ color: 'var(--confidence-high)' }}>(saved — paste new to replace)</span>}
              </label>
              <textarea
                style={{ ...inputStyle, resize: 'none' }}
                rows={4}
                value={sfPrivateKey}
                onChange={e => setSfPrivateKey(e.target.value)}
                placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
              />
            </div>
          )}

          {testResult && (
            <p style={{ fontSize: 12, margin: 0, color: testResult.ok ? 'var(--confidence-high)' : 'var(--confidence-low)' }}>
              {testResult.ok ? '✓' : '✗'} {testResult.msg}
            </p>
          )}
          {testResult?.warning && (
            <p style={{ fontSize: 12, margin: 0, color: 'var(--confidence-med)' }}>
              ⚠ {testResult.warning}
            </p>
          )}
          {saveError && <p style={{ fontSize: 12, margin: 0, color: 'var(--confidence-low)' }}>✗ {saveError}</p>}
          {clearMsg  && <p style={{ fontSize: 12, margin: 0, color: 'var(--confidence-high)' }}>✓ {clearMsg}</p>}
          {grantsResult && <GrantsPanel grants={grantsResult} />}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
            <button type="button" onClick={handleTest} disabled={!canAct || testing} style={disabledStyle(secondaryBtn, !canAct || testing)}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={handleSave} disabled={!canAct || saving} style={disabledStyle(primaryBtn, !canAct || saving)}>
              {/* Not "…and apply grants": the grants pass only runs when the
                  caller is an admin (snowflake-config returns {grants:null}
                  otherwise), so the old label promised a non-admin something
                  that silently did not happen. GrantsPanel below reports the
                  result whenever grants DID run. */}
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
            {(sfAccount || hasPassword || hasKey) && (
              <button type="button" onClick={handleClear} disabled={clearing} style={{ ...disabledStyle(dangerBtn, clearing), marginLeft: 'auto' }}>
                {clearing ? 'Clearing…' : 'Clear (use defaults)'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Team section ──────────────────────────────────────────────────────────────

interface Member {
  account_id: number;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  picture_url: string | null;
  created_at: string | null;
}

function RolePill({ role }: { role: 'admin' | 'user' }) {
  const isAdmin = role === 'admin';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 'var(--radius-pill)',
        backgroundColor: isAdmin ? 'var(--accent-tint)' : 'var(--border-subtle)',
        border: `0.5px solid ${isAdmin ? 'var(--accent-border)' : 'var(--border)'}`,
        color: isAdmin ? 'var(--accent-strong)' : 'var(--text-muted)',
      }}
    >
      {isAdmin ? 'Admin' : 'Member'}
    </span>
  );
}

function TeamSection({ currentAccountId }: { currentAccountId: number | null }) {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers]     = useState<Member[]>([]);
  const [busyId, setBusyId]       = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<'role' | 'remove' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadState('loading');
    setLoadError(null);
    fetch('/api/accounts/members', { cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
        const list: Member[] = Array.isArray(d?.members) ? d.members : [];
        setMembers(list);
        setLoadState('ready');
      })
      .catch(e => {
        setLoadError(e instanceof Error ? e.message : 'Network error');
        setLoadState('error');
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const adminCount = members.filter(m => m.role === 'admin').length;

  async function changeRole(member: Member, newRole: 'admin' | 'user') {
    if (busyId !== null || newRole === member.role) return;
    const label = newRole === 'admin' ? 'an admin' : 'a member';
    if (!window.confirm(`Make ${member.name || member.email} ${label}?`)) return;
    setBusyId(member.account_id); setBusyAction('role'); setActionError(null);
    try {
      const r = await fetch(`/api/accounts/members/${member.account_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`);
      setMembers(prev => prev.map(m => (m.account_id === member.account_id ? { ...m, role: newRole } : m)));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update role');
    } finally {
      setBusyId(null); setBusyAction(null);
    }
  }

  async function removeMember(member: Member) {
    if (busyId !== null) return;
    if (!window.confirm(`Remove ${member.name || member.email} from this workspace? Their active sessions will end immediately.`)) return;
    setBusyId(member.account_id); setBusyAction('remove'); setActionError(null);
    try {
      const r = await fetch(`/api/accounts/members/${member.account_id}`, { method: 'DELETE' });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`);
      setMembers(prev => prev.filter(m => m.account_id !== member.account_id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to remove member');
    } finally {
      setBusyId(null); setBusyAction(null);
    }
  }

  const smallActionBtn: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: 'var(--radius-button)',
    border: '0.5px solid var(--border)',
    backgroundColor: 'var(--surface)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  };

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={sectionTitle}>Team</h2>
          <p style={sectionHint}>Everyone with access to this workspace. Every member can view all pipelines, mappings, and the data values Prism standardizes.</p>
        </div>
        {/* Native edition: Snowflake owns membership — no email invitations. */}
        {!isNativeEdition() && (
          <a href="/invite" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>
            Invite teammate
          </a>
        )}
      </div>

      {loadState === 'loading' && (
        <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Loading members…</p>
      )}

      {loadState === 'error' && (
        <ErrorNote message={`Couldn't load workspace members${loadError ? ` (${loadError})` : ''}.`} onRetry={load} />
      )}

      {loadState === 'ready' && (
        <>
          {actionError && (
            <div style={{ marginBottom: 10 }}>
              <ErrorNote message={actionError} />
            </div>
          )}
          {members.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>No members yet</p>
          ) : (
            <div>
              {members.map((m, i) => {
                const isSelf = currentAccountId !== null && m.account_id === currentAccountId;
                const isLastAdmin = m.role === 'admin' && adminCount <= 1;
                const busy = busyId === m.account_id;
                const canDemote  = !isLastAdmin;
                const canRemove  = !isSelf && !isLastAdmin;
                return (
                  <div
                    key={m.account_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '11px 0',
                      borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)',
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
                        backgroundColor: 'var(--accent-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {m.picture_url ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={m.picture_url} alt="" width={30} height={30} style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                      ) : (
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                          {(m.name || m.email || '?').charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>

                    {/* Name + email */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', margin: 0, lineHeight: 1.3 }}>
                        {m.name || m.email}{isSelf && <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}> (you)</span>}
                      </p>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '1px 0 0', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.email}
                      </p>
                    </div>

                    <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0 }}>
                      Joined {humanDate(m.created_at)}
                    </span>

                    <RolePill role={m.role} />

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {m.role === 'user' ? (
                        <button type="button" disabled={busy} style={disabledStyle(smallActionBtn, busy)} onClick={() => changeRole(m, 'admin')}>
                          {busy && busyAction === 'role' ? 'Updating…' : 'Make admin'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || !canDemote}
                          title={!canDemote ? 'A workspace needs at least one admin' : undefined}
                          style={disabledStyle(smallActionBtn, busy || !canDemote)}
                          onClick={() => changeRole(m, 'user')}
                        >
                          {busy && busyAction === 'role' ? 'Updating…' : 'Make member'}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy || !canRemove}
                        title={isSelf ? "You can't remove yourself" : isLastAdmin ? 'A workspace needs at least one admin' : undefined}
                        style={disabledStyle({ ...smallActionBtn, color: 'var(--confidence-low)', borderColor: '#F3C6C6' }, busy || !canRemove)}
                        onClick={() => removeMember(m)}
                      >
                        {busy && busyAction === 'remove' ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Pipeline health section ───────────────────────────────────────────────────

interface PipelineEntry {
  pipeline_id: number;
  name: string | null;
  table_fqn: string;
  column_name: string;
  status: string;
  status_message: string | null;
}


function PipelineHealthSection() {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineEntry[]>([]);

  const load = useCallback(() => {
    setLoadState('loading');
    setLoadError(null);
    fetch('/api/pipelines', { cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
        const list: PipelineEntry[] = Array.isArray(d?.pipelines) ? d.pipelines : [];
        // GET /api/pipelines virtually expands multi-column Sheets pipelines —
        // dedupe on pipeline_id so counts reflect actual pipeline rows.
        const seen = new Set<number>();
        const deduped: PipelineEntry[] = [];
        for (const p of list) {
          if (seen.has(p.pipeline_id)) continue;
          seen.add(p.pipeline_id);
          deduped.push(p);
        }
        setPipelines(deduped);
        setLoadState('ready');
      })
      .catch(e => {
        setLoadError(e instanceof Error ? e.message : 'Network error');
        setLoadState('error');
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const active  = pipelines.filter(p => p.status === 'active').length;
  const paused  = pipelines.filter(p => p.status === 'paused').length;
  const pending = pipelines.filter(p => p.status === 'pending_baseline').length;
  const flagged = pipelines.filter(p => p.status_message);

  const stat = (count: number, label: string, color: string) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 20, fontWeight: 600, color }}>{count}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );

  return (
    <section style={card}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={sectionTitle}>Pipeline health</h2>
        <p style={sectionHint}>A read-only rollup of your pipelines. Manage them from the home page.</p>
      </div>

      {loadState === 'loading' && (
        <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Loading pipelines…</p>
      )}

      {loadState === 'error' && (
        <ErrorNote message={`Couldn't load pipelines${loadError ? ` (${loadError})` : ''}.`} onRetry={load} />
      )}

      {loadState === 'ready' && (
        pipelines.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>No pipelines yet</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 28 }}>
              {stat(active, 'active', 'var(--confidence-high)')}
              {stat(paused, 'paused', 'var(--confidence-med)')}
              {pending > 0 && stat(pending, 'setting up', 'var(--text-muted)')}
            </div>

            {flagged.length > 0 && (
              <div>
                <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', margin: '0 0 6px' }}>
                  Needs attention
                </p>
                <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-button)' }}>
                  {flagged.map((p, i) => (
                    <div
                      key={p.pipeline_id}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        padding: '9px 12px',
                        borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', flexShrink: 0 }}>
                        {p.name || p.table_fqn}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--confidence-med)' }}>{p.status_message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {flagged.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: 0 }}>All pipelines are healthy</p>
            )}
          </div>
        )
      )}
    </section>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

interface SessionInfo {
  authenticated: boolean;
  accountId?: number;
  role?: string;
}

export default function SettingsClient() {
  const [session, setSession]   = useState<SessionInfo | null>(null);
  const [sessionState, setSessionState] = useState<'loading' | 'error' | 'ready'>('loading');

  const loadSession = useCallback(() => {
    setSessionState('loading');
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        setSession(r.ok ? d : { authenticated: false });
        setSessionState('ready');
      })
      .catch(() => setSessionState('error'));
  }, []);

  useEffect(() => { loadSession(); }, [loadSession]);

  const isAdmin = sessionState === 'ready' && session?.authenticated && session?.role === 'admin';

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--page-bg)', padding: '32px 40px 48px', paddingTop: 84 }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 20px' }}>
          Settings
        </h1>

        {sessionState === 'loading' && (
          <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Loading…</p>
        )}

        {sessionState === 'error' && (
          <div style={{ maxWidth: 480 }}>
            <ErrorNote message="Couldn't verify your session." onRetry={loadSession} />
          </div>
        )}

        {sessionState === 'ready' && !isAdmin && (
          <div style={{ ...card, textAlign: 'center', padding: '48px 24px' }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              You need admin access
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Workspace settings can only be changed by an admin. Ask a workspace admin for access.
            </p>
          </div>
        )}

        {isAdmin && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <SnowflakeSection />
            {/* Native: no Team section — everyone is admin (owner decision
                2026-08-28) and membership is the Snowflake-side application
                role grant, managed in Snowflake, not here. */}
            {!isNativeEdition() && <TeamSection currentAccountId={session?.accountId ?? null} />}
            <PipelineHealthSection />
          </div>
        )}
      </div>
    </div>
  );
}
