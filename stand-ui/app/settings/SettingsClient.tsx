'use client';

import { useCallback, useEffect, useState } from 'react';

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
  failed: number;
  errors: { sql: string; error: string | null }[];
  conn_error: string | null;
}

function GrantsPanel({ grants }: { grants: GrantsResult }) {
  const [expanded, setExpanded] = useState(false);
  const allOk = grants.applied > 0 && grants.failed === 0 && !grants.conn_error;
  const color = allOk ? 'var(--confidence-high)' : 'var(--confidence-low)';
  const bg    = allOk ? '#F2FAF7' : '#FDF4F4';
  const border = allOk ? '#BFE3D6' : '#F3C6C6';

  return (
    <div style={{ border: `0.5px solid ${border}`, backgroundColor: bg, borderRadius: 'var(--radius-button)', padding: '10px 12px', fontSize: 12 }}>
      <p style={{ fontWeight: 500, color, margin: 0 }}>
        {grants.conn_error
          ? 'Could not connect to apply grants'
          : `${grants.applied} grant${grants.applied !== 1 ? 's' : ''} applied${grants.failed > 0 ? `, ${grants.failed} failed` : ''}`}
      </p>
      {grants.conn_error && <p style={{ color, margin: '2px 0 0' }}>{grants.conn_error}</p>}
      {grants.failed > 0 && !grants.conn_error && (
        <>
          <p style={{ color: 'var(--confidence-low)', margin: '2px 0 0' }}>
            Some grants require ACCOUNTADMIN. Run them manually in Snowflake.
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

function SnowflakeSection() {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sfAccount, setSfAccount]       = useState('');
  const [sfUser, setSfUser]             = useState('');
  const [sfWarehouse, setSfWarehouse]   = useState('');
  const [sfRole, setSfRole]             = useState('');
  const [authMode, setAuthMode]         = useState<'password' | 'key'>('password');
  const [sfPassword, setSfPassword]     = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');
  const [hasPassword, setHasPassword]   = useState(false);
  const [hasKey, setHasKey]             = useState(false);

  const [testing, setTesting]           = useState(false);
  const [testResult, setTestResult]     = useState<{ ok: boolean; msg: string } | null>(null);
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
        setSfWarehouse(d.sf_warehouse ?? '');
        setSfRole(d.sf_role ?? '');
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
  const canAct = !!(sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && hasCredential);

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
      setTestResult({ ok: b.ok, msg: b.ok ? `Connected — Snowflake ${b.version}` : (b.error ?? 'Connection failed') });
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

  const configured = Boolean(sfAccount.trim() && (hasPassword || hasKey));
  const statusLine = configured
    ? `Configured — account ${maskAccount(sfAccount.trim())} · ${hasKey ? 'private key' : 'password'} auth`
    : 'No workspace credentials saved — using environment defaults';

  return (
    <section style={card}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={sectionTitle}>Snowflake connection</h2>
        <p style={sectionHint}>
          Workspace credentials for reading source tables and writing standardizations. Saving also applies all Prism role grants.
        </p>
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
              <input style={inputStyle} value={sfWarehouse} onChange={e => setSfWarehouse(e.target.value)} placeholder="COMPUTE_WH" />
            </div>
            <div>
              <label style={labelStyle}>Role (optional)</label>
              <input style={inputStyle} value={sfRole} onChange={e => setSfRole(e.target.value)} placeholder="ACCOUNTADMIN" />
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
          {saveError && <p style={{ fontSize: 12, margin: 0, color: 'var(--confidence-low)' }}>✗ {saveError}</p>}
          {clearMsg  && <p style={{ fontSize: 12, margin: 0, color: 'var(--confidence-high)' }}>✓ {clearMsg}</p>}
          {grantsResult && <GrantsPanel grants={grantsResult} />}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
            <button type="button" onClick={handleTest} disabled={!canAct || testing} style={disabledStyle(secondaryBtn, !canAct || testing)}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={handleSave} disabled={!canAct || saving} style={disabledStyle(primaryBtn, !canAct || saving)}>
              {saving ? 'Saving and applying grants…' : 'Save and apply grants'}
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
    setBusyId(member.account_id); setActionError(null);
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
      setBusyId(null);
    }
  }

  async function removeMember(member: Member) {
    if (busyId !== null) return;
    if (!window.confirm(`Remove ${member.name || member.email} from this workspace? Their active sessions will end immediately.`)) return;
    setBusyId(member.account_id); setActionError(null);
    try {
      const r = await fetch(`/api/accounts/members/${member.account_id}`, { method: 'DELETE' });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`);
      setMembers(prev => prev.filter(m => m.account_id !== member.account_id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to remove member');
    } finally {
      setBusyId(null);
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
          <p style={sectionHint}>Everyone with access to this workspace.</p>
        </div>
        <a href="/invite" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>
          Invite teammate
        </a>
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
                          Make admin
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || !canDemote}
                          title={!canDemote ? 'A workspace needs at least one admin' : undefined}
                          style={disabledStyle(smallActionBtn, busy || !canDemote)}
                          onClick={() => changeRole(m, 'user')}
                        >
                          Make member
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy || !canRemove}
                        title={isSelf ? "You can't remove yourself" : isLastAdmin ? 'A workspace needs at least one admin' : undefined}
                        style={disabledStyle({ ...smallActionBtn, color: 'var(--confidence-low)', borderColor: '#F3C6C6' }, busy || !canRemove)}
                        onClick={() => removeMember(m)}
                      >
                        Remove
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
            <TeamSection currentAccountId={session?.accountId ?? null} />
            <PipelineHealthSection />
          </div>
        )}
      </div>
    </div>
  );
}
