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

  const grantSql = useMemo(() => {
    const app = appName || '<your Prism app name>';
    return [
      `-- Run as a role with grant authority on the schema (its owner, or ACCOUNTADMIN)`,
      `GRANT USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
      `GRANT USAGE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
      `-- one table:`,
      `GRANT SELECT ON TABLE <db>.<schema>.<table> TO APPLICATION "${app}";`,
      `-- or the whole schema, current and future tables:`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
      `GRANT SELECT ON FUTURE TABLES IN SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
      `-- to let Prism write export tables there too:`,
      `GRANT CREATE TABLE ON SCHEMA <db>.<schema> TO APPLICATION "${app}";`,
    ].join('\n');
  }, [appName]);

  // §2.9 caller grants — the one-time admin OPT-IN that lets Prism's
  // interactive work (one-time cleaning, table preview) run with each
  // signed-in user's OWN Snowflake access, so nobody repeats the grant
  // ritual per table. Pipelines still require the durable grants above.
  const callerGrantSql = useMemo(() => {
    const app = appName || '<your Prism app name>';
    return [
      `-- Optional, one-time. Run as a role with MANAGE CALLER GRANTS (e.g. ACCOUNTADMIN).`,
      `-- Lets Prism clean any table the signed-in user can ALREADY read — using that`,
      `-- user's own access, per database you opt in:`,
      `GRANT CALLER USAGE ON DATABASE <db> TO APPLICATION "${app}";`,
      `GRANT INHERITED CALLER USAGE ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
      `GRANT INHERITED CALLER SELECT ON ALL TABLES IN DATABASE <db> TO APPLICATION "${app}";`,
      `-- (add CREATE TABLE the same way to let one-time results export to your schemas:)`,
      `GRANT INHERITED CALLER CREATE TABLE ON ALL SCHEMAS IN DATABASE <db> TO APPLICATION "${app}";`,
    ].join('\n');
  }, [appName]);

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
