'use client';

/**
 * Native-edition source-table picker (docs/NATIVE_APP_PLAN.md N3).
 *
 * Inside a Native App, free-text FQN entry is a dead end: the app can only
 * see what the consumer granted, so the honest UI is (1) a picker over
 * exactly those tables, and (2) the "don't see your table?" panel with the
 * copy-paste grant SQL — the admin-ask kit. Whoever has grant authority on
 * the table (its owner — usually the data team, not necessarily
 * ACCOUNTADMIN) can run it, once per schema if they use the FUTURE TABLES
 * form.
 *
 * Renders nothing special in the standard edition — callers gate on
 * isNativeEdition() and fall back to their existing free-text input.
 */
import { useEffect, useMemo, useState } from 'react';

interface AccessibleTable { fqn: string; db: string; schema: string; table: string }

export default function NativeTablePicker({ value, onChange, inputId }: {
  value: string;
  onChange: (fqn: string) => void;
  inputId?: string;
}) {
  const [tables, setTables] = useState<AccessibleTable[] | null>(null);
  const [appName, setAppName] = useState('');
  const [failed, setFailed] = useState(false);
  const [manual, setManual] = useState(false);
  const [showGrantHelp, setShowGrantHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/accessible-tables', { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { if (!cancelled) { setTables(b.tables ?? []); setAppName(String(b.app_name ?? '')); } })
      .catch(() => { if (!cancelled) { setFailed(true); setManual(true); } });
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

  const selectStyle: React.CSSProperties = {
    width: '100%', fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    border: '0.5px solid var(--border)', borderRadius: 'var(--radius-button)',
    backgroundColor: 'var(--surface)', padding: '10px 12px', color: 'var(--text-secondary)', outline: 'none',
  };

  return (
    <div>
      {!manual && (
        <select
          id={inputId}
          value={tables?.some(t => t.fqn === value) ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={tables === null}
          style={selectStyle}
        >
          <option value="" disabled>
            {tables === null ? 'Loading tables Prism can access…'
              : tables.length === 0 ? 'No tables granted to Prism yet'
              : 'Choose a table…'}
          </option>
          {(tables ?? []).map(t => <option key={t.fqn} value={t.fqn}>{t.fqn}</option>)}
        </select>
      )}
      {manual && (
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="DATABASE.SCHEMA.TABLE_NAME"
          style={selectStyle}
        />
      )}
      <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
        <button type="button" onClick={() => setManual(m => !m)}
          style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {manual ? (failed ? 'Retry the table list' : 'Pick from the list instead') : 'Enter a name manually'}
        </button>
        <button type="button" onClick={() => setShowGrantHelp(v => !v)}
          style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          {showGrantHelp ? 'Hide access help' : "Don't see your table?"}
        </button>
      </div>
      {showGrantHelp && (
        <div style={{ marginTop: 8, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', borderRadius: 'var(--radius-button)', padding: '10px 12px' }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Prism can only see tables your team has granted to it — nothing is shared
            automatically. Send this to whoever owns the schema (they don&apos;t need to be
            ACCOUNTADMIN — the schema owner can run it), then refresh the list:
          </p>
          <pre style={{ marginTop: 8, marginBottom: 0, padding: 10, borderRadius: 'var(--radius-button)', overflowX: 'auto', fontSize: 11, backgroundColor: '#1A1A2E', color: '#E5E7EB', whiteSpace: 'pre' }}>
            {grantSql}
          </pre>
          <button type="button"
            onClick={() => { navigator.clipboard?.writeText(grantSql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            style={{ marginTop: 8, fontSize: 11, fontWeight: 500, color: 'var(--accent)', background: 'none', border: '0.5px solid var(--accent-border)', borderRadius: 'var(--radius-button)', padding: '4px 10px', cursor: 'pointer' }}>
            {copied ? 'Copied' : 'Copy SQL'}
          </button>
        </div>
      )}
    </div>
  );
}
