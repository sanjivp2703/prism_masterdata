'use client';

/**
 * Native-edition source-table input (docs/NATIVE_APP_PLAN.md N3).
 *
 * A NORMAL type-in field (owner decision 2026-08-13: no dropdown — a real
 * company has too many tables for a select to be usable), augmented with:
 *  - a <datalist> of the tables the app can currently see (type-ahead
 *    suggestions from /api/accounts/accessible-tables; invisible until the
 *    user types, so scale costs nothing), and
 *  - the "don't see your table?" admin-ask panel: copy-paste
 *    GRANT ... TO APPLICATION SQL with the app's real name resolved live.
 *    Whoever owns the schema can run it — ACCOUNTADMIN not required.
 *
 * Standard edition never renders this — callers gate on isNativeEdition().
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { buildNativeAppGrantSql, buildNativeCallerGrantSql } from './native-grant-sql';

interface AccessibleTable { fqn: string; db: string; schema: string; table: string }

export default function NativeTablePicker({ value, onChange, inputId }: {
  value: string;
  onChange: (fqn: string) => void;
  inputId?: string;
}) {
  const [tables, setTables] = useState<AccessibleTable[]>([]);
  const [appName, setAppName] = useState('');
  const [showGrantHelp, setShowGrantHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCaller, setCopiedCaller] = useState(false);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/accessible-tables', { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((b) => { if (!cancelled && b) { setTables(b.tables ?? []); setAppName(String(b.app_name ?? '')); } })
      .catch(() => { /* suggestions are best-effort; the input works without them */ });
    return () => { cancelled = true; };
  }, []);

  const grantSql = useMemo(() => buildNativeAppGrantSql(appName), [appName]);
  // §2.9 caller grants — the one-time admin opt-in for interactive work.
  const callerGrantSql = useMemo(() => buildNativeCallerGrantSql(appName), [appName]);

  return (
    <div>
      <input
        id={inputId}
        list={listId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="DATABASE.SCHEMA.TABLE_NAME"
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        className="w-full px-3.5 py-3 rounded-button border-[0.5px] text-sm outline-none transition-colors"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      />
      <datalist id={listId}>
        {tables.map(t => <option key={t.fqn} value={t.fqn} />)}
      </datalist>
      <button type="button" onClick={() => setShowGrantHelp(v => !v)}
        style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        {showGrantHelp ? 'Hide access help' : "Don't see your table?"}
      </button>
      {showGrantHelp && (
        <div style={{ marginTop: 8, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', borderRadius: 'var(--radius-button)', padding: '10px 12px' }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Prism can only see tables your team has granted to it — nothing is shared
            automatically. Send this to whoever owns the schema (they don&apos;t need to be
            ACCOUNTADMIN), then try again:
          </p>
          <pre style={{ marginTop: 8, marginBottom: 0, padding: 10, borderRadius: 'var(--radius-button)', overflowX: 'auto', fontSize: 11, backgroundColor: '#1A1A2E', color: '#E5E7EB', whiteSpace: 'pre' }}>
            {grantSql}
          </pre>
          <button type="button"
            onClick={() => { navigator.clipboard?.writeText(grantSql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            style={{ marginTop: 8, fontSize: 11, fontWeight: 500, color: 'var(--accent)', background: 'none', border: '0.5px solid var(--accent-border)', borderRadius: 'var(--radius-button)', padding: '4px 10px', cursor: 'pointer' }}>
            {copied ? 'Copied' : 'Copy SQL'}
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '10px 0 0', lineHeight: 1.5 }}>
            One Snowflake limitation to know: tables created <em>after</em> the grant
            aren&apos;t covered automatically (Snowflake doesn&apos;t allow future grants to an
            app) — re-run the &quot;all tables&quot; line whenever new tables are added.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '14px 0 0', lineHeight: 1.5 }}>
            Or skip the per-table ritual for one-time cleaning: an admin can opt in once,
            and Prism will clean any table you can already read — using your own access.
            Pipelines still need the grants above.
          </p>
          <pre style={{ marginTop: 8, marginBottom: 0, padding: 10, borderRadius: 'var(--radius-button)', overflowX: 'auto', fontSize: 11, backgroundColor: '#1A1A2E', color: '#E5E7EB', whiteSpace: 'pre' }}>
            {callerGrantSql}
          </pre>
          <button type="button"
            onClick={() => { navigator.clipboard?.writeText(callerGrantSql).then(() => { setCopiedCaller(true); setTimeout(() => setCopiedCaller(false), 1500); }); }}
            style={{ marginTop: 8, fontSize: 11, fontWeight: 500, color: 'var(--accent)', background: 'none', border: '0.5px solid var(--accent-border)', borderRadius: 'var(--radius-button)', padding: '4px 10px', cursor: 'pointer' }}>
            {copiedCaller ? 'Copied' : 'Copy SQL'}
          </button>
        </div>
      )}
    </div>
  );
}
