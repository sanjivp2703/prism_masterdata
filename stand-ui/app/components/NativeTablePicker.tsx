'use client';

/**
 * Native-edition source-table input (docs/NATIVE_APP_PLAN.md N3).
 *
 * A NORMAL type-in field (owner decision 2026-08-13: no dropdown — a real
 * company has too many tables for a select to be usable), augmented with:
 *  - a <datalist> of the tables the app can currently see (type-ahead
 *    suggestions from /api/accounts/accessible-tables; invisible until the
 *    user types, so scale costs nothing), and
 *  - the "don't see your table?" admin-ask panel, offering both access paths
 *    (2026-09-01): per-table via the app's Security tab in Snowsight (the
 *    manifest's source_table reference; a short follow-up SQL covers change
 *    tracking + the output schema), or schema-scoped copy-paste
 *    GRANT ... TO APPLICATION SQL with the app's real name resolved live.
 *    Whoever owns the schema can run either — ACCOUNTADMIN not required.
 *
 * Standard edition never renders this — callers gate on isNativeEdition().
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { buildNativeAppGrantSql, buildNativeReferenceFollowupSql } from './native-grant-sql';

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
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/accessible-tables', { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((b) => { if (!cancelled && b) { setTables(b.tables ?? []); setAppName(String(b.app_name ?? '')); } })
      .catch(() => { /* suggestions are best-effort; the input works without them */ });
    return () => { cancelled = true; };
  }, []);

  const grantSql    = useMemo(() => buildNativeAppGrantSql(appName, value), [appName, value]);
  const followupSql = useMemo(() => buildNativeReferenceFollowupSql(appName, value), [appName, value]);

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
          <p style={{ fontSize: 12, color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>
            Grant one table with clicks
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
            In Snowsight, open Data products, then Apps, then {appName || 'the Prism app'},
            then Security. Under Pipeline source tables, choose Add and pick your table.
            Then run this so Prism can detect changes and create the standardized output
            table in that schema:
          </p>
          <pre style={{ marginTop: 8, marginBottom: 0, padding: 10, borderRadius: 'var(--radius-button)', overflowX: 'auto', fontSize: 11, backgroundColor: '#1A1A2E', color: '#E5E7EB', whiteSpace: 'pre' }}>
            {followupSql}
          </pre>
          <p style={{ fontSize: 12, color: 'var(--text-primary)', margin: '12px 0 0', fontWeight: 600 }}>
            Or grant the whole schema with SQL
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Read access to every table in the schema plus change detection for your table, in one run:
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
            The schema grant covers every table in the schema right now — a table created
            or recreated later needs it re-run. The hourly grant-refresh task on the setup
            page does that automatically. A table added in the Security tab stays granted
            until you remove it there.
          </p>
        </div>
      )}
    </div>
  );
}
