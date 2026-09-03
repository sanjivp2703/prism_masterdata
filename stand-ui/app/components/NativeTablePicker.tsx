'use client';

/**
 * Native-edition source-table input (docs/NATIVE_APP_PLAN.md N3).
 *
 * A NORMAL type-in field (owner decision 2026-08-13: no dropdown — a real
 * company has too many tables for a select to be usable), augmented with:
 *  - a <datalist> of the tables the app can currently see (type-ahead
 *    suggestions from /api/accounts/accessible-tables; invisible until the
 *    user types, so scale costs nothing), and
 *  - the "don't see your table?" admin-ask panel: the DATABASE-scoped
 *    GRANT ... TO APPLICATION block (db taken from the typed FQN, app name
 *    resolved live) — the single grant path (owner decision 2026-09-02: no
 *    per-table or per-schema rituals, ever). One run covers every table in
 *    the database incl. change detection; the setup page's hourly task keeps
 *    it current. Whoever owns the database can run it.
 *
 * Standard edition never renders this — callers gate on isNativeEdition().
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { buildNativeAppDbGrantSql, dbFromFqn } from './native-grant-sql';

interface AccessibleTable { fqn: string; db: string; schema: string; table: string; app_visible?: boolean }

export default function NativeTablePicker({ value, onChange, inputId }: {
  value: string;
  onChange: (fqn: string) => void;
  inputId?: string;
}) {
  const [tables, setTables] = useState<AccessibleTable[]>([]);
  const [appName, setAppName] = useState('');
  const [showGrantHelp, setShowGrantHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/accessible-tables', { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((b) => { if (!cancelled && b) { setTables(b.tables ?? []); setAppName(String(b.app_name ?? '')); } })
      .catch(() => { /* suggestions are best-effort; the input works without them */ });
    return () => { cancelled = true; };
  }, []);

  const grantSql = useMemo(() => {
    const db = dbFromFqn(value);
    return buildNativeAppDbGrantSql(appName, db ? [db] : undefined);
  }, [appName, value]);

  // The typed table exists in the suggestions but only through the CALLER's
  // own access (app_visible false): a pipeline on it would pause on its first
  // poll. Surface that before creation instead of after.
  const callerOnly = useMemo(() => {
    const typed = value.trim().toUpperCase();
    if (!typed) return false;
    const hit = tables.find(t => t.fqn.toUpperCase() === typed);
    return hit ? hit.app_visible === false : false;
  }, [tables, value]);

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
      {callerOnly && (
        <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: 'var(--confidence-low)', lineHeight: 1.5 }}>
          Only you can see this table right now. Pipelines run in the background with
          the app&apos;s own access — run the access SQL below (or the setup page&apos;s
          block for this database) first.
        </p>
      )}
      <button type="button" onClick={() => setShowGrantHelp(v => !v)}
        style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        {showGrantHelp ? 'Hide access help' : "Don't see your table?"}
      </button>
      {showGrantHelp && (
        <div style={{ marginTop: 8, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', borderRadius: 'var(--radius-button)', padding: '10px 12px' }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Run this once for the database — it gives Prism read access to every table in
            it and turns on change detection for all of them:
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
            The role that owns the database can run this — ACCOUNTADMIN is not required.
            Covers every table in the database right now — a table created or recreated
            later needs it re-run. The hourly grant-refresh task on the setup page does
            that automatically.
          </p>
        </div>
      )}
    </div>
  );
}
