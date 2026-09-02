'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { isNativeEdition } from '@/app/api/_lib/edition';
import { buildNativeAppDbGrantSql, buildNativeCallerGrantSql, buildNativeGrantRefreshTaskSql, buildNativeStarterSql } from '@/app/components/native-grant-sql';
import { buildMssqlDataAccessSql } from '@/app/components/mssql-access-sql';

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

function Spinner({ dark }: { dark?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: dark ? '2px solid var(--border)' : '2px solid rgba(255,255,255,0.4)',
      borderTopColor: dark ? 'var(--accent)' : '#fff',
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

/** Read-only code block with a copy button. */
function CodeBlock({ code, maxHeight = 220 }: { code: string; maxHeight?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className="text-[11px] p-3 rounded-button overflow-auto"
        style={{ backgroundColor: '#1A1A2E', color: '#E5E7EB', maxHeight, whiteSpace: 'pre', lineHeight: 1.5 }}
      >
        {code}
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        }}
        className="absolute top-2 right-2 text-[11px] font-medium rounded-button px-2 py-1"
        style={{
          backgroundColor: copied ? '#0F6E56' : 'rgba(255,255,255,0.12)',
          color: '#fff', cursor: 'pointer',
        }}
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

function StepHeader({ step, title }: { step: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map(n => (
          <span key={n} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: '50%',
            fontSize: 11, fontWeight: 500,
            backgroundColor: n === step ? 'var(--accent)' : n < step ? 'var(--accent-tint)' : 'var(--page-bg)',
            color: n === step ? '#fff' : n < step ? 'var(--accent-strong)' : 'var(--text-hint)',
            border: n === step ? 'none' : '0.5px solid var(--border)',
          }}>
            {n < step ? '✓' : n}
          </span>
        ))}
      </div>
      <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
    </div>
  );
}

// ── Step 1: choose the data warehouse platform ───────────────────────────────

type Platform = 'snowflake' | 'mssql' | 'postgres' | 'mysql';

/** Narrow an untrusted string to a Platform ('snowflake' fallback). */
function asPlatform(v: unknown): Platform {
  return v === 'mssql' || v === 'postgres' || v === 'mysql' ? v : 'snowflake';
}

const PLATFORM_LABELS: Record<Platform, string> = {
  snowflake: 'Snowflake',
  mssql:     'SQL Server',
  postgres:  'PostgreSQL',
  mysql:     'MySQL',
};

function StepPlatform({ platform, onSelect, onNext }: {
  platform: Platform;
  onSelect: (p: Platform) => void;
  onNext: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function handleNext() {
    if (saving) return;
    setSaving(true);
    try {
      // Persist the platform choice (workspace_config.warehouse_type). Saving
      // credentials later re-asserts it, so a network blip here is harmless.
      await fetch('/api/accounts/warehouse-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: platform }),
      });
    } catch { /* re-persisted on credential save */ }
    setSaving(false);
    onNext();
  }

  const card = (key: Platform, title: string, blurb: string) => (
    <button type="button" onClick={() => onSelect(key)}
      className="flex-1 rounded-card border-[0.5px] p-4 text-left"
      style={{
        borderColor: platform === key ? 'var(--accent)' : 'var(--border)',
        backgroundColor: platform === key ? 'var(--accent-tint)' : 'var(--surface)',
        cursor: 'pointer',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {platform === key && (
          <span className="inline-block rounded-full" style={{ width: 8, height: 8, backgroundColor: 'var(--accent)' }} />
        )}
      </div>
      <p className="text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{blurb}</p>
    </button>
  );

  return (
    <div>
      <StepHeader step={1} title="Where does your data live?" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Pick the platform your company uses. Prism runs entirely against it — your data never
        moves to another warehouse.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-5">
        {card('snowflake', 'Snowflake', 'Cloud data warehouse. Prism watches tables through streams on a dedicated warehouse.')}
        {/* Native (Marketplace) edition is Snowflake-only — hide the other platforms. */}
        {!isNativeEdition() && card('mssql', 'Microsoft SQL Server', 'On-prem, VM, or Azure SQL. Prism watches tables through Change Tracking or scheduled scans.')}
        {!isNativeEdition() && card('postgres', 'PostgreSQL', 'Open-source database — self-hosted or managed (RDS, Cloud SQL, Supabase, Neon). Prism watches tables through scheduled scans.')}
        {!isNativeEdition() && card('mysql', 'MySQL', 'Open-source database — self-hosted or managed (RDS/Aurora, Cloud SQL, PlanetScale). Prism watches tables through scheduled scans. Requires MySQL 8.0.19+.')}
      </div>
      <button
        type="button" onClick={handleNext} disabled={saving}
        className="w-full flex items-center justify-center gap-2 text-sm font-medium rounded-button"
        style={{ height: 36, backgroundColor: saving ? 'var(--accent-border)' : 'var(--accent)', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer' }}
      >
        {saving ? <><Spinner /> Saving…</> : `Continue with ${PLATFORM_LABELS[platform]}`}
      </button>
    </div>
  );
}

// ── Step 2: run the install script ───────────────────────────────────────────

// No comment lines in the copyable shell blocks — interactive zsh (macOS
// default) doesn't accept '#' comments, so pasting one errors confusingly.
const KEYPAIR_COMMANDS = `openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub`;

const SHOW_PUBLIC_KEY_COMMAND = `grep -v "PUBLIC KEY" rsa_key.pub | tr -d '\\n'; echo`;

const SHOW_PUBLIC_KEY_COMMAND_WIN = `(Get-Content rsa_key.pub | Where-Object {$_ -notmatch "PUBLIC KEY"}) -join ""`;

const SERVICE_USER_SQL = `CREATE USER IF NOT EXISTS PRISM_SVC
  DEFAULT_ROLE = PRISM_SERVICE
  DEFAULT_WAREHOUSE = PRISM_WH
  -- () not Snowflake's default of ALL: with ALL, every role granted to this
  -- user activates on every session, so narrowing Prism's configured role
  -- would not actually narrow its privileges.
  DEFAULT_SECONDARY_ROLES = ()
  TYPE = SERVICE;

GRANT ROLE PRISM_SERVICE TO USER PRISM_SVC;

-- Already had a PRISM_SVC before today? CREATE USER IF NOT EXISTS leaves an
-- existing account untouched, so apply this once:
ALTER USER PRISM_SVC SET DEFAULT_SECONDARY_ROLES = ();

-- Replace <public key here> with the text you copied.
-- Keep the quote marks around it.
ALTER USER PRISM_SVC SET RSA_PUBLIC_KEY = '<public key here>';`;

/**
 * Part D — per-schema data-access grants, generated from the schemas the admin
 * types in. Covers reading source tables (incl. future ones) and creating the
 * "Table" / "View" output objects next to them (Prism owns what it creates, so
 * no further write grants are needed for its own outputs) — the #1 post-setup
 * failure was a view-mode pipeline hitting a missing CREATE VIEW grant,
 * discovered only at activation.
 *
 * Deliberately grants NO write access on the customer's existing tables: the
 * "Column" output mode's `GRANT UPDATE` is per-table, case-by-case, executed
 * only after the user consents on that specific table in the connect form
 * (`grantColumnModeUpdateAccess` / `columnModeGrantSql` in export-table.ts).
 * The trailing comment states this policy where the admin runs the grants.
 * Returns null when any entry isn't a DB.SCHEMA pair.
 */
function buildDataAccessGrants(input: string): string | null {
  const schemas: Array<{ db: string; schema: string }> = [];
  for (const s of input.split(',').map(x => x.trim()).filter(Boolean)) {
    const parts = s.split('.').map(p => p.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    schemas.push({ db: parts[0], schema: parts[1] });
  }
  if (schemas.length === 0) return null;
  const blocks = schemas.map(({ db, schema }) =>
`-- ${db}.${schema}
GRANT USAGE ON DATABASE ${db} TO ROLE PRISM_SERVICE;
GRANT USAGE ON SCHEMA ${db}.${schema} TO ROLE PRISM_SERVICE;
GRANT SELECT ON ALL TABLES IN SCHEMA ${db}.${schema} TO ROLE PRISM_SERVICE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ${db}.${schema} TO ROLE PRISM_SERVICE;
GRANT CREATE TABLE ON SCHEMA ${db}.${schema} TO ROLE PRISM_SERVICE;
GRANT CREATE VIEW ON SCHEMA ${db}.${schema} TO ROLE PRISM_SERVICE;`);
  blocks.push(
`-- Note: this gives Prism READ access to your tables plus the ability to
-- create its OWN output tables and views (which it owns and maintains).
-- Prism gets NO write access to your existing tables here. The one feature
-- that writes to a source table — the "Column" output mode, which adds and
-- fills <column>_STANDARDIZED companion columns — asks for your consent when
-- you set it up, and UPDATE is then granted for that specific table only:
--   GRANT UPDATE ON TABLE <database>.<schema>.<table> TO ROLE PRISM_SERVICE;`);
  return blocks.join('\n\n');
}

/** Plain-language numbered instructions. `start` continues numbering across
 *  lists split around a code block. */
function Steps({ items, start = 1 }: { items: React.ReactNode[]; start?: number }) {
  return (
    <ol className="mb-3" style={{ listStyle: 'none', padding: 0 }}>
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 mb-2">
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: '50%', flexShrink: 0, marginTop: 1,
            fontSize: 10, fontWeight: 500,
            backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)',
            border: '0.5px solid var(--accent-border)',
          }}>
            {start + i}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-secondary)', lineHeight: 1.55 }}>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-semibold mt-5 mb-2" style={{ color: 'var(--text-primary)' }}>
      {children}
    </h3>
  );
}

function StepInstallScript({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [script, setScript] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);

  // Part D — schemas holding the customer's source tables; the grant SQL is
  // generated from this input.
  const [dataSchemas, setDataSchemas] = useState('');
  const dataGrants = buildDataAccessGrants(dataSchemas);

  // Post-script spot check on Continue. Prism can only look inside Snowflake
  // if it already has SOME connection (a preconfigured host, or a re-run of
  // setup) — a truly fresh install has none until the next step, so this
  // check passes the user through and step 5 stays the authoritative gate.
  const [checking, setChecking] = useState(false);
  const [checkFailures, setCheckFailures] = useState<CheckItem[] | null>(null);
  const INSTALL_CHECK_KEYS = ['database', 'schemas', 'tables', 'udf', 'warehouse'];

  async function handleContinue() {
    if (checking) return;
    setChecking(true);
    setCheckFailures(null);
    try {
      const r = await fetch('/api/accounts/verify-install?scope=install', { cache: 'no-store' });
      const b = await r.json();
      if (!b?.connected) { onNext(); return; } // no connection to check with yet
      // Mirror of the SQL Server step's guard: the route branches on the ACTIVE
      // adapter, and the two platforms' check keys partly overlap, so reading
      // the other platform's results can pass green having verified nothing.
      if (b?.warehouse_type && b.warehouse_type !== 'snowflake') {
        setCheckFailures([{
          key: 'platform',
          label: 'Prism is currently configured for SQL Server, not Snowflake',
          ok: false,
          detail: 'These Snowflake install checks could not be run against the active connection. Go back one step and pick Snowflake again.',
        }]);
        return;
      }
      const bad = (Array.isArray(b.checks) ? b.checks : [])
        .filter((c: CheckItem) => INSTALL_CHECK_KEYS.includes(c.key) && !c.ok);
      if (bad.length === 0) { onNext(); return; }
      setCheckFailures(bad);
    } catch {
      onNext(); // a flaky network must not trap the user on this step
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/install-script', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        if (b?.ok) setScript(String(b.script));
        else setScriptError(String(b?.error ?? 'Install script unavailable.'));
      })
      .catch(() => { if (!cancelled) setScriptError('Could not load the install script.'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <StepHeader step={2} title="Set up Prism inside your Snowflake" />
      <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
        This step runs in your own Snowflake account, so you stay in control — Prism never asks
        for your admin credentials. Four short parts, about five minutes.
      </p>

      <SectionTitle>Part A — Run the install script in Snowflake</SectionTitle>
      <Steps items={[
        <>In Snowflake, open a new <strong>SQL worksheet</strong> (Projects → Worksheets → <strong>+</strong>)
          and set its role to <strong>ACCOUNTADMIN</strong>.</>,
        <>Copy the script below and paste it into the worksheet.</>,
        <>Use <strong>Run All</strong> (the dropdown next to the ▶ button) — the plain ▶ runs only the
          current statement. Re-running the script is safe.</>,
      ]} />

      {script && <CodeBlock code={script} maxHeight={240} />}
      {!script && !scriptError && (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Spinner dark /> Loading install script…
        </div>
      )}
      {scriptError && (
        <p className="text-xs rounded-button p-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {scriptError}
        </p>
      )}

      <SectionTitle>Part B — Create Prism&apos;s login key</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism signs in with a key pair instead of a password: <strong>rsa_key.p8</strong> (private —
        treat it like a password) and <strong>rsa_key.pub</strong> (public).
      </p>
      <Steps items={[
        <>Open a terminal. <strong>Mac:</strong> ⌘ + space, type Terminal, press return.{' '}
          <strong>Windows:</strong> right-click the Start button and choose{' '}
          <strong>Terminal (PowerShell)</strong>. If <span style={{ fontFamily: 'monospace' }}>openssl</span> isn&apos;t
          recognized there, install it with{' '}
          <span style={{ fontFamily: 'monospace' }}>winget install ShiningLight.OpenSSL.Light</span>,
          then close and reopen the terminal.</>,
        <>Paste the two commands below and press return. They create the two key files in the
          folder you&apos;re in (your home folder by default).</>,
      ]} />
      <CodeBlock code={KEYPAIR_COMMANDS} maxHeight={90} />

      <SectionTitle>Part C — Give Snowflake the public key</SectionTitle>
      <Steps items={[
        <>In the same terminal, run the line for your system — it prints the public key as one long
          line. Copy that line.</>,
      ]} />
      <p className="text-[11px] mb-1" style={{ color: 'var(--text-hint)' }}>Mac / Linux:</p>
      <CodeBlock code={SHOW_PUBLIC_KEY_COMMAND} maxHeight={60} />
      <p className="text-[11px] mb-1 mt-2" style={{ color: 'var(--text-hint)' }}>Windows (PowerShell):</p>
      <CodeBlock code={SHOW_PUBLIC_KEY_COMMAND_WIN} maxHeight={60} />
      <div className="mt-3" />
      <Steps start={2} items={[
        <>Paste the block below at the bottom of your Snowflake worksheet.</>,
        <>Replace <strong>&lt;public key here&gt;</strong> on the last line with the line you copied,
          keeping the quote marks.</>,
        <>Highlight just these pasted statements and press <strong>▶</strong> to run them. (Using
          Run All instead is harmless — the install script above is safe to re-run — but only these
          three statements are needed.)</>,
      ]} />
      <CodeBlock code={SERVICE_USER_SQL} maxHeight={200} />

      <SectionTitle>Part D — Give Prism access to your data</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism reads your source tables and creates its standardized output next to them — that
        needs grants on the schemas where your data lives. Type those schemas below and run the
        generated statements in the same worksheet. These grants give Prism <strong>no write
        access to your existing tables</strong>: the only feature that writes to a source table
        (the &quot;Column&quot; output mode) asks for your consent when you set it up, and update access is
        granted for that specific table only at that moment. You can come back and re-run this
        anytime for new schemas; a pipeline on a schema without these grants pauses with an access
        message instead of standardizing.
      </p>
      <input
        type="text" value={dataSchemas}
        onChange={e => setDataSchemas(e.target.value)}
        placeholder="DATABASE.SCHEMA, ANOTHER_DB.ANOTHER_SCHEMA"
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        className="w-full px-3.5 py-2.5 mb-2 rounded-button border-[0.5px] text-sm outline-none font-mono"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
      />
      {dataSchemas.trim() && !dataGrants && (
        <p className="text-[11px] mb-2" style={{ color: '#B45309' }}>
          Each entry needs the form DATABASE.SCHEMA (two parts, separated by a dot). Separate
          multiple schemas with commas.
        </p>
      )}
      {dataGrants && <CodeBlock code={dataGrants} maxHeight={220} />}

      {checkFailures && (
        <div className="mt-5 rounded-card border-[0.5px] p-3" style={{ borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#991B1B' }}>
            Prism connected to your Snowflake and couldn&apos;t find everything the script creates:
          </p>
          {checkFailures.map(c => (
            <div key={c.key} className="mb-1.5">
              <p className="text-xs font-medium" style={{ color: '#991B1B' }}>✕ {c.label}</p>
              {c.detail && <p className="text-[11px]" style={{ color: '#B91C1C' }}>{c.detail}</p>}
            </div>
          ))}
          <p className="text-[11px] mt-2" style={{ color: '#B91C1C' }}>
            Usually this means the script hasn&apos;t been run yet, only partially ran, or ran in a
            different Snowflake account. Run it (Run All, as ACCOUNTADMIN) and try again.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button
          type="button" onClick={handleContinue} disabled={checking}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{
            height: 36,
            backgroundColor: checking ? 'var(--accent-border)' : 'var(--accent)',
            color: '#fff',
            cursor: checking ? 'not-allowed' : 'pointer',
          }}
        >
          {checking
            ? <><Spinner /> Checking your Snowflake…</>
            : (checkFailures ? 'I’ve re-run it — check again' : 'I’ve run the script — continue')}
        </button>
        {checkFailures && (
          <button type="button" onClick={onNext}
            className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
          >
            Continue anyway
          </button>
        )}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-hint)' }}>
        Everything is verified again in the last step, so nothing breaks if something was missed.
      </p>
    </div>
  );
}

// ── Step 2 (SQL Server): run the install script ───────────────────────────────

const MSSQL_SERVICE_LOGIN_SQL = `CREATE LOGIN prism_svc WITH PASSWORD = '<strong generated password>';
USE PRISM_DB;
CREATE USER prism_svc FOR LOGIN prism_svc;
ALTER ROLE PRISM_SERVICE ADD MEMBER prism_svc;`;

// buildMssqlDataAccessSql moved to the shared module (also used by the
// connect form's inline access-SQL panel) — app/components/mssql-access-sql.ts

function StepInstallScriptMssql({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [script, setScript] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  // Part C — database.schema pairs holding the source tables; the access SQL
  // is generated from this input (mirrors the Snowflake step's Part D).
  const [dataSchemas, setDataSchemas] = useState('');
  const dataAccessSql = buildMssqlDataAccessSql(dataSchemas);
  const [checking, setChecking] = useState(false);
  const [checkFailures, setCheckFailures] = useState<CheckItem[] | null>(null);
  const INSTALL_CHECK_KEYS = ['database', 'schemas', 'tables', 'roles'];

  async function handleContinue() {
    if (checking) return;
    setChecking(true);
    setCheckFailures(null);
    try {
      const r = await fetch('/api/accounts/verify-install?scope=install', { cache: 'no-store' });
      const b = await r.json();
      if (!b?.connected) { onNext(); return; }
      // The route picks its branch from the ACTIVE adapter, not from us. If the
      // platform choice never persisted, we'd get Snowflake's checks — whose
      // keys don't overlap ours — and sail through green having verified
      // nothing. Refuse to interpret another platform's results.
      if (b?.warehouse_type && b.warehouse_type !== 'mssql') {
        setCheckFailures([{
          key: 'platform',
          label: 'Prism is still configured for Snowflake, not SQL Server',
          ok: false,
          detail: 'The SQL Server platform choice from step 1 did not save, so these install checks could not be run. Go back one step and pick Microsoft SQL Server again.',
        }]);
        return;
      }
      const bad = (Array.isArray(b.checks) ? b.checks : [])
        .filter((c: CheckItem) => INSTALL_CHECK_KEYS.includes(c.key) && !c.ok);
      if (bad.length === 0) { onNext(); return; }
      setCheckFailures(bad);
    } catch {
      onNext();
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/install-script?warehouse=mssql', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        if (b?.ok) setScript(String(b.script));
        else setScriptError(String(b?.error ?? 'Install script unavailable.'));
      })
      .catch(() => { if (!cancelled) setScriptError('Could not load the install script.'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <StepHeader step={2} title="Set up Prism inside your SQL Server" />
      <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
        This step runs in your own SQL Server, so you stay in control — Prism never asks for your
        admin credentials. Three short parts, about five minutes.
      </p>

      <SectionTitle>Part A — Run the install script</SectionTitle>
      <Steps items={[
        <>Open <strong>SQL Server Management Studio</strong> or <strong>Azure Data Studio</strong> and
          connect as a <strong>sysadmin</strong> (or any login that can create databases and roles).</>,
        <>Copy the script below into a new query window and run it. Re-running it is safe.</>,
      ]} />
      {script && <CodeBlock code={script} maxHeight={240} />}
      {!script && !scriptError && (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Spinner dark /> Loading install script…
        </div>
      )}
      {scriptError && (
        <p className="text-xs rounded-button p-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {scriptError}
        </p>
      )}

      <SectionTitle>Part B — Create Prism&apos;s service login</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism signs in as a machine identity, never as a person. Replace the placeholder with a
        strong generated password and keep it for the next step. To cut Prism off at any time:
        {' '}<span style={{ fontFamily: 'monospace' }}>ALTER LOGIN prism_svc DISABLE;</span>
        {' '}Run Part A first — until the install script has run, the{' '}
        <span style={{ fontFamily: 'monospace' }}>USE PRISM_DB</span> line below fails with
        &quot;Database &apos;PRISM_DB&apos; does not exist&quot;. (Re-running this block later? The
        CREATE LOGIN line will report the login already exists — skip just that line.)
      </p>
      <CodeBlock code={MSSQL_SERVICE_LOGIN_SQL} maxHeight={140} />

      <SectionTitle>Part C — Give Prism access to your data</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism reads your source tables and creates its standardized output next to them. Type
        where your data lives (most SQL Server tables live under{' '}
        <span style={{ fontFamily: 'monospace' }}>dbo</span>) and run the generated statements
        in the same query window. <span style={{ fontFamily: 'monospace' }}>DATABASE.SCHEMA</span>{' '}
        sets up every table in the schema; add{' '}
        <span style={{ fontFamily: 'monospace' }}>DATABASE.SCHEMA.TABLE</span> entries instead to
        set up only specific tables. The generated SQL includes Change Tracking, which lets
        Prism detect new, changed, or deleted values within about a minute instead of on a
        scheduled scan — skip those lines if you prefer, and Prism will offer to enable it (with
        your consent) the first time you connect a table. Nothing here gives Prism{' '}
        <strong>write access to your existing tables</strong>. You can come back and re-run this
        anytime for new databases or tables.
      </p>
      <input
        type="text" value={dataSchemas}
        onChange={e => setDataSchemas(e.target.value)}
        placeholder="DATABASE.dbo — or DATABASE.dbo.ORDERS for one table"
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        className="w-full px-3.5 py-2.5 mb-2 rounded-button border-[0.5px] text-sm outline-none font-mono"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
      />
      {dataSchemas.trim() && !dataAccessSql && (
        <p className="text-[11px] mb-2" style={{ color: '#B45309' }}>
          Each entry needs the form DATABASE.SCHEMA (whole schema) or DATABASE.SCHEMA.TABLE
          (one table), using plain names. Separate multiple entries with commas.
        </p>
      )}
      {dataAccessSql && <CodeBlock code={dataAccessSql} maxHeight={260} />}

      {checkFailures && (
        <div className="mt-5 rounded-card border-[0.5px] p-3" style={{ borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#991B1B' }}>
            Prism connected to your SQL Server and couldn&apos;t find everything the script creates:
          </p>
          {checkFailures.map(c => (
            <div key={c.key} className="mb-1.5">
              <p className="text-xs font-medium" style={{ color: '#991B1B' }}>✕ {c.label}</p>
              {c.detail && <p className="text-[11px]" style={{ color: '#B91C1C' }}>{c.detail}</p>}
            </div>
          ))}
          <p className="text-[11px] mt-2" style={{ color: '#B91C1C' }}>
            Usually this means the script hasn&apos;t been run yet, only partially ran, or ran against a
            different server. Run it as a sysadmin and try again.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button
          type="button" onClick={handleContinue} disabled={checking}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: checking ? 'var(--accent-border)' : 'var(--accent)', color: '#fff', cursor: checking ? 'not-allowed' : 'pointer' }}
        >
          {checking
            ? <><Spinner /> Checking your SQL Server…</>
            : (checkFailures ? 'I\u2019ve re-run it — check again' : 'I\u2019ve run the script — continue')}
        </button>
        {checkFailures && (
          <button type="button" onClick={onNext} className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
            Continue anyway
          </button>
        )}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-hint)' }}>
        Everything is verified again in the last step, so nothing breaks if something was missed.
      </p>
    </div>
  );
}

// ── Step 3 (SQL Server): service credentials ─────────────────────────────────

function StepCredentialsMssql({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [server, setServer]     = useState('');
  const [port, setPort]         = useState('1433');
  const [database, setDatabase] = useState('PRISM_DB');
  const [user, setUser]         = useState('prism_svc');
  const [password, setPassword] = useState('');
  const [trustCert, setTrustCert] = useState(false);
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [busy, setBusy]         = useState<'test' | 'save' | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [tested, setTested]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/workspace-mssql', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.server)   setServer(String(b.server));
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        setTrustCert(Boolean(b.trust_server_cert));
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canAct = Boolean(server.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function submit(testOnly: boolean) {
    if (busy || !canAct) return;
    setBusy(testOnly ? 'test' : 'save');
    setError(null);
    try {
      const r = await fetch('/api/accounts/workspace-mssql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_only: testOnly || undefined,
          server: server.trim(),
          port: Number(port) || 1433,
          database: database.trim() || 'PRISM_DB',
          user: user.trim(),
          password: password,
          trust_server_cert: trustCert,
        }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Request failed.')); return; }
      if (testOnly) setTested(true);
      else onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <StepHeader step={3} title="Connect Prism to your SQL Server" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Enter the service login from the previous step. The password is stored encrypted and never
        shown again.
      </p>

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="ms-server">Server</Label>
          <Input id="ms-server" value={server} onChange={setServer} placeholder="sql.yourcompany.com or yourserver.database.windows.net" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="ms-port">Port</Label>
            <Input id="ms-port" value={port} onChange={setPort} placeholder="1433" />
          </div>
          <div className="flex-1">
            <Label htmlFor="ms-database">Database</Label>
            <Input id="ms-database" value={database} onChange={setDatabase} placeholder="PRISM_DB" />
          </div>
        </div>
        <div>
          <Label htmlFor="ms-user">Login</Label>
          <Input id="ms-user" value={user} onChange={setUser} placeholder="prism_svc" />
        </div>
        <div>
          <Label htmlFor="ms-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="ms-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={trustCert} onChange={e => setTrustCert(e.target.checked)} />
          Trust the server certificate (self-signed certs — common for on-prem/dev servers)
        </label>
      </div>

      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      {tested && !error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#0F6E56', backgroundColor: '#F0FDF9', border: '0.5px solid #99E5CF' }}>
          Connection works.
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
          Back
        </button>
        <button type="button" onClick={() => submit(true)} disabled={!canAct || busy !== null}
          className="text-sm font-medium rounded-button px-4 flex items-center gap-2"
          style={{ height: 36, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'test' ? <><Spinner dark /> Testing…</> : 'Test connection'}
        </button>
        <button type="button" onClick={() => submit(false)} disabled={!canAct || busy !== null}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canAct && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'save' ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}

// ── Step 2: service credentials ───────────────────────────────────────────────


function StepCredentials({ prefillAccount, onBack, onSaved }: {
  prefillAccount: string; onBack: () => void; onSaved: () => void;
}) {
  const [sfAccount,    setSfAccount]    = useState(prefillAccount);
  const [sfUser,       setSfUser]       = useState('PRISM_SVC');
  const [sfWarehouse,  setSfWarehouse]  = useState('PRISM_WH');
  const [sfRole,       setSfRole]       = useState('PRISM_SERVICE');
  const [authMode,     setAuthMode]     = useState<'key' | 'password'>('key');
  const [sfPassword,   setSfPassword]   = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  // The GET prefills every non-secret field (saved workspace row, falling back
  // to the server's env config), and reports whether a reusable secret already
  // exists. Two distinct cases with different copy: a key SAVED in Prism from
  // an earlier pass through this step, vs. one preconfigured on the host by
  // the operator (env) — a normal customer install has neither.
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [hasEnvSecret,   setHasEnvSecret]   = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/workspace-snowflake', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.sf_account)   setSfAccount(prev => prev || String(b.sf_account));
        if (b.sf_user)      setSfUser(String(b.sf_user));
        if (b.sf_warehouse) setSfWarehouse(String(b.sf_warehouse));
        if (b.sf_role)      setSfRole(String(b.sf_role));
        setHasSavedSecret(Boolean(b.has_password || b.has_private_key));
        setHasEnvSecret(Boolean(b.has_env_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const typedSecret = authMode === 'password' ? sfPassword.trim() !== '' : sfPrivateKey.trim() !== '';
  const canSave = Boolean(sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && (typedSecret || hasSavedSecret || hasEnvSecret));

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/accounts/workspace-snowflake', {
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
      if (!r.ok || !b.ok) { setError(b.error || 'Failed to save'); return; }
      onSaved();
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <StepHeader step={3} title="Give Prism its sign-in details" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Now tell Prism how to sign in as the PRISM_SVC user you created in the last step. The
        first four boxes are usually already filled in correctly — most people only need to add
        the private key. Prism tests the connection before saving anything, and stores it
        encrypted.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="col-span-2">
          <Label htmlFor="ws-account">Account identifier</Label>
          <Input id="ws-account" value={sfAccount} onChange={setSfAccount} placeholder="xy12345.us-east-1" />
        </div>
        <div>
          <Label htmlFor="ws-user">Username</Label>
          <Input id="ws-user" value={sfUser} onChange={setSfUser} placeholder="PRISM_SVC" />
        </div>
        <div>
          <Label htmlFor="ws-warehouse">Warehouse</Label>
          <Input id="ws-warehouse" value={sfWarehouse} onChange={setSfWarehouse} placeholder="PRISM_WH" />
        </div>
        <div className="col-span-2">
          <Label htmlFor="ws-role">Role</Label>
          <Input id="ws-role" value={sfRole} onChange={setSfRole} placeholder="PRISM_SERVICE" />
        </div>
      </div>

      <div className="mb-3">
        <Label>Authentication</Label>
        <div className="flex rounded-button p-[2px]" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)', width: 'fit-content' }}>
          {(['key', 'password'] as const).map(m => (
            <button key={m} type="button" onClick={() => setAuthMode(m)}
              className="text-xs font-medium rounded-toggle-option px-3 py-1 transition-colors"
              style={{
                backgroundColor: authMode === m ? 'var(--surface)' : 'transparent',
                color: authMode === m ? 'var(--text-primary)' : 'var(--text-muted)',
                boxShadow: authMode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {m === 'key' ? 'Private key (recommended)' : 'Password'}
            </button>
          ))}
        </div>
      </div>

      {authMode === 'key' ? (
        <div className="mb-4">
          <Label htmlFor="ws-key">Private key (the rsa_key.p8 file from the last step)</Label>
          <Textarea id="ws-key" value={sfPrivateKey} onChange={setSfPrivateKey}
            placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
            rows={5}
          />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)', lineHeight: 1.5 }}>
            To see it: run <span style={{ fontFamily: 'monospace' }}>cat rsa_key.p8</span> in your
            terminal (Mac or PowerShell) and copy everything it prints, including the BEGIN/END lines.
          </p>
          {hasSavedSecret && !sfPrivateKey.trim() && (
            <p className="text-[11px] mt-1 font-medium" style={{ color: '#065F46' }}>
              A key is already saved from an earlier save — leave this blank to keep it, or paste a
              new one to replace it.
            </p>
          )}
          {!hasSavedSecret && hasEnvSecret && !sfPrivateKey.trim() && (
            <p className="text-[11px] mt-1 font-medium" style={{ color: '#065F46' }}>
              Your Prism host was preconfigured with a key — leave this blank to use it.
            </p>
          )}
        </div>
      ) : (
        <div className="mb-4">
          <Label htmlFor="ws-password">Password</Label>
          <Input id="ws-password" type="password" value={sfPassword} onChange={setSfPassword}
            placeholder="••••••••" />
          {hasSavedSecret && !sfPassword.trim() && (
            <p className="text-[11px] mt-1 font-medium" style={{ color: '#065F46' }}>
              A password is already saved from an earlier save — leave this blank to keep it.
            </p>
          )}
          {!hasSavedSecret && hasEnvSecret && !sfPassword.trim() && (
            <p className="text-[11px] mt-1 font-medium" style={{ color: '#065F46' }}>
              Your Prism host was preconfigured with a credential — leave this blank to use it.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs mb-3 rounded-button p-2" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button type="button" onClick={handleSave} disabled={!canSave || saving}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{
            height: 36,
            backgroundColor: canSave && !saving ? 'var(--accent)' : 'var(--accent-border)',
            color: '#fff',
            cursor: canSave && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? <><Spinner /> Testing and saving…</> : 'Test and save connection'}
        </button>
      </div>
    </div>
  );
}

// ── Step 4: AI provider ───────────────────────────────────────────────────────

function StepLlmProvider({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState<'anthropic' | 'openai' | 'gemini'>('anthropic');
  const [key,      setKey]      = useState('');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // A provider may already be connected (saved earlier, or Claude via the
  // server's env var) — in that case keeping it is a legitimate primary path.
  const [existing, setExisting] = useState<'checking' | 'workspace' | 'env' | 'none'>('checking');
  const [existingProvider, setExistingProvider] = useState<'anthropic' | 'openai' | 'gemini'>('anthropic');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/llm-provider', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        const s = b?.source;
        setExisting(s === 'workspace' || s === 'env' ? s : 'none');
        const p = (['openai', 'gemini'] as const).find(x => x === b?.provider) ?? 'anthropic';
        setExistingProvider(p);
        if (s === 'workspace') setProvider(p);
      })
      .catch(() => { if (!cancelled) setExisting('none'); });
    return () => { cancelled = true; };
  }, []);

  // With a Claude key already on the server (env), a blank save adopts it —
  // the admin never has to hunt for the key to copy it here. No env path for
  // OpenAI/Gemini.
  const envAdoptable = provider === 'anthropic' && existing === 'env';
  const canSave = Boolean(key.trim()) || envAdoptable;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/accounts/llm-provider', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, credential: key.trim() }),
      });
      const b = await r.json();
      if (!r.ok || !b.ok) { setError(b.error || 'Failed to save'); return; }
      onSaved();
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  }

  const providerCard = (p: 'anthropic' | 'openai' | 'gemini', name: string, tag: string | null, blurb: string) => (
    <button type="button" onClick={() => { setProvider(p); setError(null); }}
      className="rounded-card border-[0.5px]"
      style={{
        padding: '14px 14px', textAlign: 'left', width: '100%',
        borderColor: provider === p ? 'var(--accent)' : 'var(--border)',
        backgroundColor: provider === p ? 'var(--accent-tint)' : 'var(--surface)',
        cursor: 'pointer',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</span>
        {tag && (
          <span className="text-[10px] font-medium rounded-pill px-1.5 py-0.5"
            style={{ backgroundColor: 'var(--surface)', border: '0.5px solid var(--accent-border)', color: 'var(--accent-strong)' }}
          >
            {tag}
          </span>
        )}
        {provider === p && (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="ml-auto flex-shrink-0">
            <circle cx="7" cy="7" r="6" fill="var(--accent)" />
            <path d="M4.5 7l2 2 3-3.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{blurb}</p>
    </button>
  );

  return (
    <div>
      <StepHeader step={4} title="Connect your AI provider" />
      <p className="text-sm mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism uses an AI model for the grouping work, running on your company&apos;s own account
        with the provider — usage bills there, not to us. The distinct text values from the
        columns you standardize are sent to this provider (never your credentials, never full
        source rows). Choose which provider Prism may use.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-4">
        {providerCard('anthropic', 'Claude', null, 'By Anthropic. Prism’s default — tuned and tested on Claude.')}
        {providerCard('openai', 'OpenAI', null, 'Use your OpenAI account. Prism runs on GPT-4.1.')}
        {providerCard('gemini', 'Gemini', null, 'By Google. Prism runs on Gemini Flash.')}
      </div>

      {provider === 'anthropic' ? (
        <Steps items={[
          <>Sign in at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
              className="underline" style={{ color: 'var(--accent)' }}>
              console.anthropic.com
            </a>{' '}
            (or create your company&apos;s account first).</>,
          <>Under <strong>Settings → API keys</strong>, click <strong>Create key</strong> — name it
            &quot;Prism&quot;.</>,
          <>Copy the key (starts with <strong>sk-ant-</strong>; it&apos;s shown only once) and paste it
            below. Prism verifies it with Anthropic before saving, and stores it encrypted.</>,
        ]} />
      ) : provider === 'gemini' ? (
        <>
          <Steps items={[
            <>Sign in at{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                className="underline" style={{ color: 'var(--accent)' }}>
                aistudio.google.com
              </a>{' '}
              with your company&apos;s Google account.</>,
            <>Click <strong>Create API key</strong> (choose or create a Google Cloud project if
              asked).</>,
            <>Copy the key (starts with <strong>AIza</strong>) and paste it below. Prism verifies it
              with Google before saving, and stores it encrypted.</>,
          ]} />
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-hint)', lineHeight: 1.5 }}>
            All of Prism&apos;s AI work will run on <strong>Gemini Flash</strong> — the Gemini
            model best suited to Prism&apos;s high-volume, strict-JSON grouping calls.
          </p>
          {/* A setup REQUIREMENT, not a caveat about Prism. Google's free tier
              allows 20 generate-content requests per DAY (verified live); a
              single 30-value grouping run consumes most of that, so a free key
              breaks on the first pipeline baseline and stays broken until the
              quota resets. Stating the requirement up front is the difference
              between a working install and an unexplainable failure. */}
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <strong>Billing must be enabled on your Google AI Studio project.</strong> Google&apos;s
            free tier allows only 20 requests per day, which a single standardization run uses up.
            {' '}
            <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noopener noreferrer"
              className="underline" style={{ color: 'var(--accent)' }}>
              Gemini rate limits
            </a>
          </p>
        </>
      ) : (
        <>
          <Steps items={[
            <>Sign in at{' '}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
                className="underline" style={{ color: 'var(--accent)' }}>
                platform.openai.com
              </a>{' '}
              (or create your company&apos;s account first).</>,
            <>Under <strong>API keys</strong>, click <strong>Create new secret key</strong> — name it
              &quot;Prism&quot;.</>,
            <>Copy the key (starts with <strong>sk-</strong>; it&apos;s shown only once) and paste it
              below. Prism verifies it with OpenAI before saving, and stores it encrypted.</>,
          ]} />
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-hint)', lineHeight: 1.5 }}>
            All of Prism&apos;s AI work will run on <strong>GPT-4.1</strong> — the OpenAI model best
            suited to Prism&apos;s high-volume, strict-JSON grouping calls.
          </p>
        </>
      )}

      {existing === 'workspace' && (
        <div className="mb-4 rounded-button border-[0.5px] p-3" style={{ borderColor: '#BFE3D6', backgroundColor: '#F2FAF7' }}>
          <p className="text-xs font-medium" style={{ color: '#065F46' }}>
            ✓ {existingProvider === 'openai' ? 'OpenAI' : existingProvider === 'gemini' ? 'Gemini' : 'Claude'} is
            already connected for this workspace. Save to replace it, or keep it and continue.
          </p>
        </div>
      )}
      {envAdoptable && (
        <div className="mb-4 rounded-button border-[0.5px] p-3" style={{ borderColor: '#BFE3D6', backgroundColor: '#F2FAF7' }}>
          <p className="text-xs font-medium" style={{ color: '#065F46' }}>
            ✓ An Anthropic key is already configured on the server. Leave the field blank and
            save to adopt it as the workspace key, or paste a different one.
          </p>
        </div>
      )}

      <div className="mb-4">
        <Label htmlFor="llm-credential">
          {provider === 'openai' ? 'OpenAI API key'
            : provider === 'gemini' ? 'Google AI API key'
            : 'Anthropic API key'}
        </Label>
        <Input id="llm-credential" type="password" value={key} onChange={setKey}
          placeholder={provider === 'openai' ? 'sk-...'
            : provider === 'gemini' ? 'AIza...'
            : 'sk-ant-...'} />
      </div>

      {error && (
        <p className="text-xs mb-3 rounded-button p-2" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button type="button" onClick={handleSave} disabled={!canSave || saving}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{
            height: 36,
            backgroundColor: canSave && !saving ? 'var(--accent)' : 'var(--accent-border)',
            color: '#fff',
            cursor: canSave && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving
            ? <><Spinner /> Checking credential…</>
            : (!key.trim() && envAdoptable ? 'Use the server’s key' : 'Check and save')}
        </button>
        {(existing === 'workspace' || existing === 'env') && (
          <button type="button" onClick={onSaved}
            className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
          >
            Keep current setup
          </button>
        )}
      </div>
    </div>
  );
}

// ── Step 4: verification checklist ───────────────────────────────────────────

interface CheckItem {
  key: string; label: string; ok: boolean;
  warning?: string; detail?: string; fix?: string;
}

function StepVerify({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const [running, setRunning] = useState(true);
  const [checks,  setChecks]  = useState<CheckItem[]>([]);
  const [allOk,   setAllOk]   = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>('snowflake');
  // Bumped by the re-run button; the effect owns the fetch for both the
  // initial run and re-runs.
  const [runToken, setRunToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/verify-install', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        setChecks(Array.isArray(b?.checks) ? b.checks : []);
        setAllOk(Boolean(b?.ok));
        setPlatform(asPlatform(b?.warehouse_type));
        if (b?.connected === false) setError(String(b?.error ?? 'Could not connect.'));
      })
      .catch(() => { if (!cancelled) setError('Network error — could not reach server'); })
      .finally(() => { if (!cancelled) setRunning(false); });
    return () => { cancelled = true; };
  }, [runToken]);

  const runChecks = useCallback(() => {
    setRunning(true);
    setError(null);
    setRunToken(t => t + 1);
  }, []);

  return (
    <div>
      <StepHeader step={5} title="Check that everything works" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism now signs in and checks each piece from the earlier steps, one by one.{' '}
        <strong style={{ color: '#0F6E56' }}>Green</strong> means ready.{' '}
        <strong style={{ color: '#BA7517' }}>Orange</strong> means it works, but there&apos;s a note
        worth reading. <strong style={{ color: '#A32D2D' }}>Red</strong> means something&apos;s
        missing — each red row tells you exactly what to do. These checks don&apos;t cost anything
        to run, so re-run them as often as you like.
      </p>

      {running && (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Spinner dark /> Checking your {PLATFORM_LABELS[platform]}…
        </div>
      )}

      {!running && error && (
        <p className="text-xs mb-3 rounded-button p-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}

      {!running && checks.length > 0 && (
        <div className="rounded-card border-[0.5px] mb-4" style={{ borderColor: 'var(--border)' }}>
          {checks.map((c, i) => (
            <div key={c.key} className="flex items-start gap-2.5 px-3 py-2.5"
              style={{ borderTop: i > 0 ? '0.5px solid var(--border-subtle)' : 'none' }}
            >
              {c.ok ? (
                c.warning ? (
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="mt-0.5 flex-shrink-0">
                    <circle cx="7.5" cy="7.5" r="6.5" stroke="#BA7517" strokeWidth="1.3" />
                    <path d="M7.5 4.5v3.5" stroke="#BA7517" strokeWidth="1.4" strokeLinecap="round" />
                    <circle cx="7.5" cy="10.4" r="0.7" fill="#BA7517" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="mt-0.5 flex-shrink-0">
                    <circle cx="7.5" cy="7.5" r="6.5" stroke="#0F6E56" strokeWidth="1.3" />
                    <path d="M4.7 7.5l2 2 3.6-4" stroke="#0F6E56" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="mt-0.5 flex-shrink-0">
                  <circle cx="7.5" cy="7.5" r="6.5" stroke="#A32D2D" strokeWidth="1.3" />
                  <path d="M5.3 5.3l4.4 4.4M9.7 5.3l-4.4 4.4" stroke="#A32D2D" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
              <div className="min-w-0">
                <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{c.label}</p>
                {c.detail && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{c.detail}</p>}
                {c.warning && <p className="text-xs mt-0.5" style={{ color: '#BA7517' }}>{c.warning}</p>}
                {!c.ok && c.fix && <p className="text-xs mt-0.5" style={{ color: '#A32D2D' }}>{c.fix}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button type="button" onClick={runChecks} disabled={running}
          className="text-sm font-medium rounded-button px-4"
          style={{
            height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)',
            color: running ? 'var(--text-hint)' : 'var(--text-primary)',
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          Re-run checks
        </button>
        <button type="button" onClick={onFinish} disabled={running}
          className="flex-1 text-sm font-medium rounded-button flex items-center justify-center"
          style={{
            height: 36,
            backgroundColor: allOk ? 'var(--accent)' : 'var(--surface)',
            border: allOk ? 'none' : '0.5px solid var(--border)',
            color: allOk ? '#fff' : 'var(--text-muted)',
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {allOk ? 'Finish setup' : 'Finish anyway'}
        </button>
      </div>
      {!allOk && !running && (
        <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-hint)' }}>
          You can finish now and fix the remaining items later from Settings → {PLATFORM_LABELS[platform]} connection.
        </p>
      )}
    </div>
  );
}

// ── Admin onboarding (fast path + 3-step flow) ───────────────────────────────

function AdminOnboarding({ nextUrl }: { nextUrl: string }) {
  const router = useRouter();
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4 | 5>(0); // 0 = deciding fast path vs flow
  const [platform, setPlatform] = useState<Platform>('snowflake');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/warehouse-type', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        const t = b?.saved ?? b?.resolved;
        if (!cancelled && (t === 'mssql' || t === 'postgres' || t === 'mysql')) setPlatform(t);
      })
      .catch(() => {});
    // Non-admins can't read warehouse-type (admin-only); the connection status
    // route reports the resolved platform for everyone.
    fetch('/api/accounts/test-snowflake', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        const t = b?.warehouse_type;
        if (!cancelled && (t === 'mssql' || t === 'postgres' || t === 'mysql')) setPlatform(t);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [conn, setConn] = useState<'checking' | 'ok' | 'none'>('checking');
  const [connWarehouse, setConnWarehouse] = useState('');
  const [connRole, setConnRole] = useState('');
  const [prefillAccount, setPrefillAccount] = useState('');

  // Existing pipelines depend on the CURRENT connection (table_fqn/export_table_fqn
  // point at objects in that specific warehouse account). Switching connections
  // doesn't touch them, but they'll start failing/pausing against whatever gets
  // connected next — warn before letting an admin walk into that blind.
  const [activePipelineCount, setActivePipelineCount] = useState<number | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/pipelines', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        if (cancelled || !Array.isArray(b?.pipelines)) return;
        const live = new Set(
          (b.pipelines as Array<{ pipeline_id: number; status: string }>)
            .filter(p => p?.status === 'active' || p?.status === 'paused')
            .map(p => p.pipeline_id),
        );
        setActivePipelineCount(live.size);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/test-snowflake', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        setConn(b?.ok ? 'ok' : 'none');
        setConnWarehouse(String(b?.warehouse ?? ''));
        setConnRole(String(b?.role ?? ''));
        if (b?.account) setPrefillAccount(String(b.account));
        if (!b?.ok) setStep(1); // no working connection — straight into the flow
      })
      .catch(() => { if (!cancelled) { setConn('none'); setStep(1); } });
    return () => { cancelled = true; };
  }, []);

  if (step === 0 && conn === 'checking') {
    return (
      <div className="flex items-center gap-2 justify-center py-8">
        <Spinner dark />
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Checking for an existing connection…</span>
      </div>
    );
  }

  if (step === 0) {
    // conn === 'ok' — fast path.
    return (
      <div>
        <h1 className="text-[18px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          {platform === 'postgres' ? 'Connect your Postgres database' : platform === 'mysql' ? 'Connect your MySQL database' : `Connect your ${PLATFORM_LABELS[platform]} account`}
        </h1>
        <div className="mt-4 rounded-button border-[0.5px] p-3" style={{ borderColor: '#BFE3D6', backgroundColor: '#F2FAF7' }}>
          <p className="text-xs font-medium" style={{ color: '#065F46' }}>
            ✓ This workspace already has a working {PLATFORM_LABELS[platform]} connection
            {connWarehouse ? ` (warehouse ${connWarehouse})` : ''}
            {connRole ? `, running as role ${connRole}` : ''}.
          </p>
          <button type="button" onClick={() => router.push(nextUrl)}
            className="mt-2 w-full text-sm font-medium rounded-button flex items-center justify-center"
            style={{ height: 34, backgroundColor: 'var(--accent)', color: '#fff', cursor: 'pointer' }}
          >
            Continue with existing connection
          </button>
        </div>
        <div className="flex items-center justify-center gap-4 mt-3">
          <button type="button" onClick={() => setStep(5)}
            className="text-xs font-medium" style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
          >
            Verify the install
          </button>
          <span style={{ color: 'var(--border)' }}>·</span>
          <button
            type="button"
            onClick={() => {
              if (activePipelineCount && activePipelineCount > 0) setConfirmSwitch(true);
              else setStep(1);
            }}
            className="text-xs font-medium" style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
          >
            Set up a different connection
          </button>
        </div>
        {confirmSwitch && (
          <div className="mt-3 rounded-button border-[0.5px] p-3" style={{ borderColor: '#F3D9A6', backgroundColor: '#FFFAF0' }}>
            <p className="text-xs font-medium" style={{ color: '#92620A' }}>
              {activePipelineCount} active pipeline{activePipelineCount === 1 ? '' : 's'} {activePipelineCount === 1 ? 'depends' : 'depend'} on the current connection.
            </p>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: '#92620A' }}>
              Switching doesn&apos;t delete anything in the current warehouse or in Prism, but every existing pipeline will start
              failing against whatever gets connected next — they&apos;ll pause with an error until you reconnect the original
              warehouse or remove them.
            </p>
            <div className="flex items-center gap-2 mt-2.5">
              <button type="button" onClick={() => setStep(1)}
                className="text-xs font-medium rounded-button flex items-center justify-center"
                style={{ height: 30, paddingLeft: 12, paddingRight: 12, backgroundColor: '#92620A', color: '#fff', cursor: 'pointer' }}
              >
                Continue anyway
              </button>
              <button type="button" onClick={() => setConfirmSwitch(false)}
                className="text-xs font-medium rounded-button flex items-center justify-center"
                style={{ height: 30, paddingLeft: 12, paddingRight: 12, backgroundColor: 'transparent', color: '#92620A', border: '0.5px solid #F3D9A6', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === 1) return <StepPlatform platform={platform} onSelect={setPlatform} onNext={() => setStep(2)} />;
  if (step === 2) {
    if (platform === 'mssql')    return <StepInstallScriptMssql onBack={() => setStep(1)} onNext={() => setStep(3)} />;
    if (platform === 'postgres') return <StepInstallScriptPostgres onBack={() => setStep(1)} onNext={() => setStep(3)} />;
    if (platform === 'mysql')    return <StepInstallScriptMysql onBack={() => setStep(1)} onNext={() => setStep(3)} />;
    return <StepInstallScript onBack={() => setStep(1)} onNext={() => setStep(3)} />;
  }
  if (step === 3) {
    if (platform === 'mssql') {
      return <StepCredentialsMssql onBack={() => setStep(2)} onSaved={() => setStep(4)} />;
    }
    if (platform === 'postgres') {
      return <StepCredentialsPostgres onBack={() => setStep(2)} onSaved={() => setStep(4)} />;
    }
    if (platform === 'mysql') {
      return <StepCredentialsMysql onBack={() => setStep(2)} onSaved={() => setStep(4)} />;
    }
    return (
      <StepCredentials
        prefillAccount={prefillAccount}
        onBack={() => setStep(2)}
        onSaved={() => setStep(4)}
      />
    );
  }
  if (step === 4) return <StepLlmProvider onBack={() => setStep(3)} onSaved={() => setStep(5)} />;
  return <StepVerify onBack={() => setStep(4)} onFinish={() => router.push(nextUrl)} />;
}

// ── Step 2 (PostgreSQL): run the install script ──────────────────────────────

const PG_SERVICE_LOGIN_SQL = `CREATE ROLE prism_svc LOGIN PASSWORD '<strong generated password>';
GRANT prism_service TO prism_svc;
ALTER ROLE prism_svc SET statement_timeout = '600s';`;

function StepInstallScriptPostgres({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [script, setScript] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailures, setCheckFailures] = useState<CheckItem[] | null>(null);
  // Source-schema grants generator (the Part D analog — schemas, not
  // DB.SCHEMA: one Prism installation covers ONE Postgres database).
  const [grantSchemas, setGrantSchemas] = useState('');
  const INSTALL_CHECK_KEYS = ['database', 'schemas', 'tables', 'roles'];

  async function handleContinue() {
    if (checking) return;
    setChecking(true);
    setCheckFailures(null);
    try {
      const r = await fetch('/api/accounts/verify-install?scope=install', { cache: 'no-store' });
      const b = await r.json();
      if (!b?.connected) { onNext(); return; }
      // Same platform-mismatch guard as the SQL Server step: the route picks
      // its branch from the ACTIVE adapter — refuse to interpret another
      // platform's checks as green.
      if (b?.warehouse_type && b.warehouse_type !== 'postgres') {
        setCheckFailures([{
          key: 'platform',
          label: 'Prism is still configured for a different platform, not PostgreSQL',
          ok: false,
          detail: 'The PostgreSQL platform choice from step 1 did not save, so these install checks could not be run. Go back one step and pick PostgreSQL again.',
        }]);
        return;
      }
      const bad = (Array.isArray(b.checks) ? b.checks : [])
        .filter((c: CheckItem) => INSTALL_CHECK_KEYS.includes(c.key) && !c.ok);
      if (bad.length === 0) { onNext(); return; }
      setCheckFailures(bad);
    } catch {
      onNext();
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/install-script?warehouse=postgres', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        if (b?.ok) setScript(String(b.script));
        else setScriptError(String(b?.error ?? 'Install script unavailable.'));
      })
      .catch(() => { if (!cancelled) setScriptError('Could not load the install script.'); });
    return () => { cancelled = true; };
  }, []);

  const schemaList = grantSchemas.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const grantsSql = schemaList.map(s =>
    `GRANT USAGE ON SCHEMA ${s} TO prism_service;\n` +
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO prism_service;\n` +
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO prism_service;`,
  ).join('\n\n');

  return (
    <div>
      <StepHeader step={2} title="Set up Prism inside your Postgres database" />
      <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
        This step runs in your own database, so you stay in control — Prism never asks for your
        admin credentials. Three short parts, about five minutes.
      </p>
      <p className="text-xs mb-1 mt-2 rounded-button p-2.5" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)', lineHeight: 1.55 }}>
        Postgres cannot query across databases — this installation standardizes tables in this
        one database. Run everything below connected to the database that holds your source tables.
      </p>

      <SectionTitle>Part A — Run the install script</SectionTitle>
      <Steps items={[
        <>Connect to your database as a <strong>superuser</strong> (or the database owner), with
          psql, pgAdmin, or your usual SQL client:{' '}
          <span style={{ fontFamily: 'monospace' }}>psql -h &lt;host&gt; -U postgres -d &lt;database&gt; -f 01_internal_tables.postgres.sql</span></>,
        <>Or copy the script below into a query window and run it. Re-running it is safe.</>,
      ]} />
      {script && <CodeBlock code={script} maxHeight={240} />}
      {!script && !scriptError && (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Spinner dark /> Loading install script…
        </div>
      )}
      {scriptError && (
        <p className="text-xs rounded-button p-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {scriptError}
        </p>
      )}

      <SectionTitle>Part B — Create Prism&apos;s service login</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism signs in as a machine identity, never as a person. Replace the placeholder with a
        strong generated password and keep it for the next step. To cut Prism off at any time:
        {' '}<span style={{ fontFamily: 'monospace' }}>ALTER ROLE prism_svc NOLOGIN;</span>
      </p>
      <CodeBlock code={PG_SERVICE_LOGIN_SQL} maxHeight={120} />

      <SectionTitle>Part C — Grant read access to your source schemas</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Type the schema name(s) that hold the tables you want to standardize (comma or space
        separated) and run the generated grants. This is your control surface — schemas you never
        grant stay invisible to Prism.
      </p>
      <Input id="pg-grant-schemas" value={grantSchemas} onChange={setGrantSchemas} placeholder="public, sales" />
      {schemaList.length > 0 && (
        <div className="mt-2">
          <CodeBlock code={grantsSql} maxHeight={170} />
          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-hint)', lineHeight: 1.5 }}>
            Note: ALTER DEFAULT PRIVILEGES only covers tables created by the role that runs it —
            if several roles create tables in a schema, run it once per owning role
            (…&nbsp;<span style={{ fontFamily: 'monospace' }}>FOR ROLE &lt;owner&gt;</span>&nbsp;…).
          </p>
        </div>
      )}

      {checkFailures && (
        <div className="mt-5 rounded-card border-[0.5px] p-3" style={{ borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#991B1B' }}>
            Prism connected to your Postgres and couldn&apos;t find everything the script creates:
          </p>
          {checkFailures.map(c => (
            <div key={c.key} className="mb-1.5">
              <p className="text-xs font-medium" style={{ color: '#991B1B' }}>✕ {c.label}</p>
              {c.detail && <p className="text-[11px]" style={{ color: '#B91C1C' }}>{c.detail}</p>}
            </div>
          ))}
          <p className="text-[11px] mt-2" style={{ color: '#B91C1C' }}>
            Usually this means the script hasn&apos;t been run yet, only partially ran, or ran against
            a different database. Run it as a superuser in the right database and try again.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button
          type="button" onClick={handleContinue} disabled={checking}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: checking ? 'var(--accent-border)' : 'var(--accent)', color: '#fff', cursor: checking ? 'not-allowed' : 'pointer' }}
        >
          {checking
            ? <><Spinner /> Checking your Postgres…</>
            : (checkFailures ? 'I’ve re-run it — check again' : 'I’ve run the script — continue')}
        </button>
        {checkFailures && (
          <button type="button" onClick={onNext} className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
            Continue anyway
          </button>
        )}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-hint)' }}>
        Everything is verified again in the last step, so nothing breaks if something was missed.
      </p>
    </div>
  );
}

// ── Step 3 (PostgreSQL): service credentials ─────────────────────────────────

function StepCredentialsPostgres({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [host, setHost]         = useState('');
  const [port, setPort]         = useState('5432');
  const [database, setDatabase] = useState('');
  const [user, setUser]         = useState('prism_svc');
  const [password, setPassword] = useState('');
  const [sslmode, setSslmode]   = useState<'disable' | 'require' | 'verify-full'>('require');
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [busy, setBusy]         = useState<'test' | 'save' | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [tested, setTested]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/workspace-postgres', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.host)     setHost(String(b.host));
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        if (b.sslmode === 'disable' || b.sslmode === 'require' || b.sslmode === 'verify-full') setSslmode(b.sslmode);
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canAct = Boolean(host.trim() && database.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function submit(testOnly: boolean) {
    if (busy || !canAct) return;
    setBusy(testOnly ? 'test' : 'save');
    setError(null);
    try {
      const r = await fetch('/api/accounts/workspace-postgres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_only: testOnly || undefined,
          host: host.trim(),
          port: Number(port) || 5432,
          database: database.trim(),
          user: user.trim(),
          password: password,
          sslmode,
        }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Request failed.')); return; }
      if (testOnly) setTested(true);
      else onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <StepHeader step={3} title="Connect Prism to your Postgres" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Enter the service login from the previous step. The password is stored encrypted and never
        shown again.
      </p>

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="pg-host">Host</Label>
          <Input id="pg-host" value={host} onChange={setHost} placeholder="db.yourcompany.com or mydb.abc.us-east-1.rds.amazonaws.com" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="pg-port">Port</Label>
            <Input id="pg-port" value={port} onChange={setPort} placeholder="5432" />
          </div>
          <div className="flex-1">
            <Label htmlFor="pg-database">Database</Label>
            <Input id="pg-database" value={database} onChange={setDatabase} placeholder="the database holding your source tables" />
          </div>
        </div>
        <div>
          <Label htmlFor="pg-user">Login role</Label>
          <Input id="pg-user" value={user} onChange={setUser} placeholder="prism_svc" />
        </div>
        <div>
          <Label htmlFor="pg-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="pg-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
        <div>
          <Label htmlFor="pg-sslmode">TLS</Label>
          <select
            id="pg-sslmode" value={sslmode}
            onChange={e => setSslmode(e.target.value as 'disable' | 'require' | 'verify-full')}
            className="w-full text-sm rounded-button px-2.5"
            style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
          >
            <option value="require">Require (managed providers — RDS, Cloud SQL, Supabase, Neon)</option>
            <option value="verify-full">Verify full (TLS with certificate verification)</option>
            <option value="disable">Disable (only for servers without TLS)</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      {tested && !error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#0F6E56', backgroundColor: '#F0FDF9', border: '0.5px solid #99E5CF' }}>
          Connection works.
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
          Back
        </button>
        <button type="button" onClick={() => submit(true)} disabled={!canAct || busy !== null}
          className="text-sm font-medium rounded-button px-4 flex items-center gap-2"
          style={{ height: 36, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'test' ? <><Spinner dark /> Testing…</> : 'Test connection'}
        </button>
        <button type="button" onClick={() => submit(false)} disabled={!canAct || busy !== null}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canAct && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'save' ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}

// ── Step 2 (MySQL): run the install script ───────────────────────────────────

const MY_SERVICE_LOGIN_SQL = `CREATE USER 'prism_svc'@'%' IDENTIFIED BY '<strong generated password>';
GRANT 'prism_service' TO 'prism_svc'@'%';
SET DEFAULT ROLE 'prism_service' TO 'prism_svc'@'%';`;

function StepInstallScriptMysql({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [script, setScript] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailures, setCheckFailures] = useState<CheckItem[] | null>(null);
  // Source-grants generator (the Part D analog — DATABASES, not schemas:
  // MySQL has no schema level, and database-wide SELECT covers future tables).
  const [grantDbs, setGrantDbs] = useState('');
  const INSTALL_CHECK_KEYS = ['database', 'schemas', 'tables', 'roles'];

  async function handleContinue() {
    if (checking) return;
    setChecking(true);
    setCheckFailures(null);
    try {
      const r = await fetch('/api/accounts/verify-install?scope=install', { cache: 'no-store' });
      const b = await r.json();
      if (!b?.connected) { onNext(); return; }
      // Same platform-mismatch guard as the other steps: the route picks its
      // branch from the ACTIVE adapter — refuse to interpret another
      // platform's checks as green.
      if (b?.warehouse_type && b.warehouse_type !== 'mysql') {
        setCheckFailures([{
          key: 'platform',
          label: 'Prism is still configured for a different platform, not MySQL',
          ok: false,
          detail: 'The MySQL platform choice from step 1 did not save, so these install checks could not be run. Go back one step and pick MySQL again.',
        }]);
        return;
      }
      const bad = (Array.isArray(b.checks) ? b.checks : [])
        .filter((c: CheckItem) => INSTALL_CHECK_KEYS.includes(c.key) && !c.ok);
      if (bad.length === 0) { onNext(); return; }
      setCheckFailures(bad);
    } catch {
      onNext();
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/install-script?warehouse=mysql', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled) return;
        if (b?.ok) setScript(String(b.script));
        else setScriptError(String(b?.error ?? 'Install script unavailable.'));
      })
      .catch(() => { if (!cancelled) setScriptError('Could not load the install script.'); });
    return () => { cancelled = true; };
  }, []);

  const dbList = grantDbs.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const grantsSql = dbList.map(d =>
    `GRANT SELECT ON \`${d}\`.* TO 'prism_svc'@'%';`,
  ).join('\n');

  return (
    <div>
      <StepHeader step={2} title="Set up Prism on your MySQL server" />
      <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
        This step runs on your own server, so you stay in control — Prism never asks for your
        admin credentials. Three short parts, about five minutes.
      </p>
      <p className="text-xs mb-1 mt-2 rounded-button p-2.5" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)', lineHeight: 1.55 }}>
        MySQL joins across databases on one server — connect tables from any database Prism is
        granted. Requires MySQL 8.0.19 or newer.
      </p>

      <SectionTitle>Part A — Run the install script</SectionTitle>
      <Steps items={[
        <>Connect to your server as <strong>root</strong> (or an admin account), with the mysql
          client, MySQL Workbench, or your usual SQL client:{' '}
          <span style={{ fontFamily: 'monospace' }}>mysql -h &lt;host&gt; -u root -p &lt; 01_internal_tables.mysql.sql</span></>,
        <>Or copy the script below into a query window and run it. Re-running it is safe.</>,
      ]} />
      {script && <CodeBlock code={script} maxHeight={240} />}
      {!script && !scriptError && (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: 'var(--text-muted)' }}>
          <Spinner dark /> Loading install script…
        </div>
      )}
      {scriptError && (
        <p className="text-xs rounded-button p-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {scriptError}
        </p>
      )}

      <SectionTitle>Part B — Create Prism&apos;s service account</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Prism signs in as a machine identity, never as a person. Replace the placeholder with a
        strong generated password and keep it for the next step. To cut Prism off at any time:
        {' '}<span style={{ fontFamily: 'monospace' }}>ALTER USER &apos;prism_svc&apos;@&apos;%&apos; ACCOUNT LOCK;</span>
      </p>
      <CodeBlock code={MY_SERVICE_LOGIN_SQL} maxHeight={120} />

      <SectionTitle>Part C — Grant read access to your source databases</SectionTitle>
      <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Type the database name(s) that hold the tables you want to standardize (comma or space
        separated) and run the generated grants. Database-wide SELECT automatically covers tables
        created later. This is your control surface — databases you never grant stay invisible
        to Prism.
      </p>
      <Input id="my-grant-dbs" value={grantDbs} onChange={setGrantDbs} placeholder="erp, sales" />
      {dbList.length > 0 && (
        <div className="mt-2">
          <CodeBlock code={grantsSql} maxHeight={170} />
        </div>
      )}

      {checkFailures && (
        <div className="mt-5 rounded-card border-[0.5px] p-3" style={{ borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#991B1B' }}>
            Prism connected to your MySQL and couldn&apos;t find everything the script creates:
          </p>
          {checkFailures.map(c => (
            <div key={c.key} className="mb-1.5">
              <p className="text-xs font-medium" style={{ color: '#991B1B' }}>✕ {c.label}</p>
              {c.detail && <p className="text-[11px]" style={{ color: '#B91C1C' }}>{c.detail}</p>}
            </div>
          ))}
          <p className="text-[11px] mt-2" style={{ color: '#B91C1C' }}>
            Usually this means the script hasn&apos;t been run yet, only partially ran, or ran against
            a different server. Run it as an admin on the right server and try again.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}
        >
          Back
        </button>
        <button
          type="button" onClick={handleContinue} disabled={checking}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: checking ? 'var(--accent-border)' : 'var(--accent)', color: '#fff', cursor: checking ? 'not-allowed' : 'pointer' }}
        >
          {checking
            ? <><Spinner /> Checking your MySQL…</>
            : (checkFailures ? 'I’ve re-run it — check again' : 'I’ve run the script — continue')}
        </button>
        {checkFailures && (
          <button type="button" onClick={onNext} className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
            Continue anyway
          </button>
        )}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-hint)' }}>
        Everything is verified again in the last step, so nothing breaks if something was missed.
      </p>
    </div>
  );
}

// ── Step 3 (MySQL): service credentials ──────────────────────────────────────

function StepCredentialsMysql({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [host, setHost]         = useState('');
  const [port, setPort]         = useState('3306');
  const [database, setDatabase] = useState('');
  const [user, setUser]         = useState('prism_svc');
  const [password, setPassword] = useState('');
  const [ssl, setSsl]           = useState<'false' | 'true' | 'strict'>('true');
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [busy, setBusy]         = useState<'test' | 'save' | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [tested, setTested]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/workspace-mysql', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.host)     setHost(String(b.host));
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        if (b.ssl === 'false' || b.ssl === 'true' || b.ssl === 'strict') setSsl(b.ssl);
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Unlike Postgres, database is OPTIONAL here — it is only the session
  // default (MySQL joins across databases), so host + user + secret suffice.
  const canAct = Boolean(host.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function submit(testOnly: boolean) {
    if (busy || !canAct) return;
    setBusy(testOnly ? 'test' : 'save');
    setError(null);
    try {
      const r = await fetch('/api/accounts/workspace-mysql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_only: testOnly || undefined,
          host: host.trim(),
          port: Number(port) || 3306,
          database: database.trim() || undefined,
          user: user.trim(),
          password: password,
          ssl,
        }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Request failed.')); return; }
      if (testOnly) setTested(true);
      else onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <StepHeader step={3} title="Connect Prism to your MySQL" />
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Enter the service account from the previous step. The password is stored encrypted and
        never shown again.
      </p>

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="my-host">Host</Label>
          <Input id="my-host" value={host} onChange={setHost} placeholder="db.yourcompany.com or mydb.abc.us-east-1.rds.amazonaws.com" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="my-port">Port</Label>
            <Input id="my-port" value={port} onChange={setPort} placeholder="3306" />
          </div>
          <div className="flex-1">
            <Label htmlFor="my-database">Database (optional — session default only)</Label>
            <Input id="my-database" value={database} onChange={setDatabase} placeholder="prism_internal" />
          </div>
        </div>
        <div>
          <Label htmlFor="my-user">Service account</Label>
          <Input id="my-user" value={user} onChange={setUser} placeholder="prism_svc" />
        </div>
        <div>
          <Label htmlFor="my-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="my-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
        <div>
          <Label htmlFor="my-ssl">TLS</Label>
          <select
            id="my-ssl" value={ssl}
            onChange={e => setSsl(e.target.value as 'false' | 'true' | 'strict')}
            className="w-full text-sm rounded-button px-2.5"
            style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
          >
            <option value="true">Require (managed providers — RDS/Aurora, Cloud SQL, PlanetScale)</option>
            <option value="strict">Strict (TLS with certificate verification)</option>
            <option value="false">Disable (only for servers without TLS)</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      {tested && !error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#0F6E56', backgroundColor: '#F0FDF9', border: '0.5px solid #99E5CF' }}>
          Connection works.
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={onBack}
          className="text-sm font-medium rounded-button px-4"
          style={{ height: 36, border: '0.5px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
          Back
        </button>
        <button type="button" onClick={() => submit(true)} disabled={!canAct || busy !== null}
          className="text-sm font-medium rounded-button px-4 flex items-center gap-2"
          style={{ height: 36, border: '0.5px solid var(--accent-border)', backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'test' ? <><Spinner dark /> Testing…</> : 'Test connection'}
        </button>
        <button type="button" onClick={() => submit(false)} disabled={!canAct || busy !== null}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canAct && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canAct && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'save' ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}

// ── Personal (non-admin) variant — unchanged behavior ────────────────────────


function PersonalSetupFormMssql({ nextUrl }: { nextUrl: string }) {
  const router = useRouter();
  const [server, setServer]     = useState('');
  const [port, setPort]         = useState('1433');
  // Blank, NOT the workspace's PRISM_DB — that is Prism's internal database
  // and a personal login has no rights on it, so prefilling it made every
  // save fail with a misleading "login failed" (finding #26).
  const [database, setDatabase] = useState('');
  const [user, setUser]         = useState('');
  const [password, setPassword] = useState('');
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [workspaceServer, setWorkspaceServer] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/mssql-config', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.server)   { setServer(String(b.server)); setWorkspaceServer(true); }
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canSave = Boolean(server.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function handleSave() {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/accounts/mssql-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: server.trim(), port: Number(port) || 1433, database: database.trim(), user: user.trim(), password }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Save failed.')); return; }
      router.push(nextUrl);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Connect your own SQL Server login{' '}
        <span className="text-sm font-normal" style={{ color: 'var(--text-hint)' }}>(optional)</span>
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        You don&apos;t need this to use Prism. It&apos;s used in three situations, always on
        tables you choose to connect: one-time standardizations on a table Prism&apos;s service
        login can&apos;t see; turning on Change Tracking for a pipeline when the service login
        can&apos;t; and granting the service login access to one table when you enable an output
        mode that writes to it. The last two change settings on that table, not just read from
        it. Credentials are stored encrypted. You can always come back to this from Settings.
      </p>
      <div className="flex flex-col gap-3">
        {/* Read-only when the workspace has a server (finding #27): there is
            one SQL Server per installation, a different host would only
            break the connection, and an editable field let any member point
            the Prism host at an arbitrary address. */}
        {workspaceServer ? (
          <div>
            <Label htmlFor="pms-server">Server</Label>
            <div
              id="pms-server"
              className="w-full px-3.5 py-2.5 rounded-button border-[0.5px] text-sm font-mono"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)', color: 'var(--text-muted)' }}
            >
              {server}{port && port !== '1433' ? `, port ${port}` : ''}
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>
              Your company&apos;s SQL Server, already set up by your admin — you only need your own login below.
            </p>
          </div>
        ) : (
        <div>
          <Label htmlFor="pms-server">Server</Label>
          <Input id="pms-server" value={server} onChange={setServer} placeholder="sql.yourcompany.com" />
        </div>
        )}
        <div className="flex gap-3">
          {!workspaceServer && (
            <div className="flex-1">
              <Label htmlFor="pms-port">Port</Label>
              <Input id="pms-port" value={port} onChange={setPort} placeholder="1433" />
            </div>
          )}
          <div className="flex-1">
            <Label htmlFor="pms-database">Database (optional)</Label>
            <Input id="pms-database" value={database} onChange={setDatabase} placeholder="Your login's default" />
          </div>
        </div>
        <div>
          <Label htmlFor="pms-user">Your login</Label>
          <Input id="pms-user" value={user} onChange={setUser} placeholder="" />
        </div>
        <div>
          <Label htmlFor="pms-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="pms-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
      </div>
      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={!canSave || busy}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canSave && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canSave && !busy ? 'pointer' : 'not-allowed' }}>
          {busy ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
        <button type="button" onClick={() => router.push(nextUrl)}
          className="text-sm" style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function PersonalSetupFormPg({ nextUrl }: { nextUrl: string }) {
  const router = useRouter();
  const [host, setHost]         = useState('');
  const [port, setPort]         = useState('5432');
  const [database, setDatabase] = useState('');
  const [user, setUser]         = useState('');
  const [password, setPassword] = useState('');
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/pg-config', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.host)     setHost(String(b.host));
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canSave = Boolean(host.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function handleSave() {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/accounts/pg-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host.trim(), port: Number(port) || 5432, database: database.trim(), user: user.trim(), password }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Save failed.')); return; }
      router.push(nextUrl);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Connect your own Postgres login{' '}
        <span className="text-sm font-normal" style={{ color: 'var(--text-hint)' }}>(optional)</span>
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        You don&apos;t need this to use Prism. It&apos;s used for one-time standardizations on a
        table Prism&apos;s service role can&apos;t see, and for granting the service role access to
        one table when you enable an output mode that writes to it. Credentials are stored
        encrypted. You can always come back to this from Settings.
      </p>
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="ppg-host">Host</Label>
          <Input id="ppg-host" value={host} onChange={setHost} placeholder="db.yourcompany.com" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="ppg-port">Port</Label>
            <Input id="ppg-port" value={port} onChange={setPort} placeholder="5432" />
          </div>
          <div className="flex-1">
            <Label htmlFor="ppg-database">Database</Label>
            <Input id="ppg-database" value={database} onChange={setDatabase} placeholder="same database as the workspace" />
          </div>
        </div>
        <div>
          <Label htmlFor="ppg-user">Your login role</Label>
          <Input id="ppg-user" value={user} onChange={setUser} placeholder="" />
        </div>
        <div>
          <Label htmlFor="ppg-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="ppg-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
      </div>
      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={!canSave || busy}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canSave && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canSave && !busy ? 'pointer' : 'not-allowed' }}>
          {busy ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
        <button type="button" onClick={() => router.push(nextUrl)}
          className="text-sm" style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function PersonalSetupFormMysql({ nextUrl }: { nextUrl: string }) {
  const router = useRouter();
  const [host, setHost]         = useState('');
  const [port, setPort]         = useState('3306');
  const [database, setDatabase] = useState('');
  const [user, setUser]         = useState('');
  const [password, setPassword] = useState('');
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/mysql-config', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (cancelled || !b) return;
        if (b.host)     setHost(String(b.host));
        if (b.port)     setPort(String(b.port));
        if (b.database) setDatabase(String(b.database));
        if (b.user)     setUser(String(b.user));
        setHasSavedSecret(Boolean(b.has_secret));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canSave = Boolean(host.trim() && user.trim() && (password.trim() || hasSavedSecret));

  async function handleSave() {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/accounts/mysql-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host.trim(), port: Number(port) || 3306, database: database.trim(), user: user.trim(), password }),
      });
      const b = await r.json();
      if (!r.ok || b?.error) { setError(String(b?.error ?? 'Save failed.')); return; }
      router.push(nextUrl);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Connect your own MySQL account{' '}
        <span className="text-sm font-normal" style={{ color: 'var(--text-hint)' }}>(optional)</span>
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}>
        You don&apos;t need this to use Prism. It&apos;s used for one-time standardizations on a
        table Prism&apos;s service account can&apos;t see, and for granting the service account
        access to one table when you enable an output mode that writes to it. Credentials are
        stored encrypted. You can always come back to this from Settings.
      </p>
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="pmy-host">Host</Label>
          <Input id="pmy-host" value={host} onChange={setHost} placeholder="db.yourcompany.com" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="pmy-port">Port</Label>
            <Input id="pmy-port" value={port} onChange={setPort} placeholder="3306" />
          </div>
          <div className="flex-1">
            <Label htmlFor="pmy-database">Database (optional)</Label>
            <Input id="pmy-database" value={database} onChange={setDatabase} placeholder="session default only" />
          </div>
        </div>
        <div>
          <Label htmlFor="pmy-user">Your account</Label>
          <Input id="pmy-user" value={user} onChange={setUser} placeholder="" />
        </div>
        <div>
          <Label htmlFor="pmy-password">Password{hasSavedSecret ? ' (blank keeps the saved one)' : ''}</Label>
          <Input id="pmy-password" type="password" value={password} onChange={setPassword} placeholder={hasSavedSecret ? '••••••••' : ''} />
        </div>
      </div>
      {error && (
        <p className="text-xs rounded-button p-3 mt-3" style={{ color: '#991B1B', backgroundColor: '#FFF5F5', border: '0.5px solid #FCA5A5' }}>
          {error}
        </p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={!canSave || busy}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium rounded-button"
          style={{ height: 36, backgroundColor: canSave && !busy ? 'var(--accent)' : 'var(--accent-border)', color: '#fff', cursor: canSave && !busy ? 'pointer' : 'not-allowed' }}>
          {busy ? <><Spinner /> Saving…</> : 'Save and continue'}
        </button>
        <button type="button" onClick={() => router.push(nextUrl)}
          className="text-sm" style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function PersonalSetupForm({ nextUrl }: { nextUrl: string }) {
  const router = useRouter();

  const [sfAccount,    setSfAccount]    = useState('');
  const [sfUser,       setSfUser]       = useState('');
  const [sfWarehouse,  setSfWarehouse]  = useState('');
  const [sfRole,       setSfRole]       = useState('');
  const [authMode,     setAuthMode]     = useState<'password' | 'key'>('password');
  const [sfPassword,   setSfPassword]   = useState('');
  const [sfPrivateKey, setSfPrivateKey] = useState('');

  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [saveError,  setSaveError]  = useState<string | null>(null);

  // One Snowflake account per workspace — prefill it so members only type
  // their own username + credential.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/test-snowflake', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (!cancelled && b?.account) setSfAccount(prev => (prev ? prev : String(b.account)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const hasCredential = authMode === 'password' ? sfPassword.trim() !== '' : sfPrivateKey.trim() !== '';
  const canAct = sfAccount.trim() && sfUser.trim() && sfWarehouse.trim() && sfRole.trim() && hasCredential;

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
      setTestResult({
        ok: b.ok,
        msg: b.ok
          ? `Connected — Snowflake ${b.version}${b.warning ? ` — ⚠ ${b.warning}` : ''}`
          : (b.error ?? 'Failed'),
      });
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
      router.push(nextUrl);
    } catch {
      setSaveError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="text-[18px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Connect your Snowflake account
        <span className="ml-2 text-xs font-normal align-middle" style={{ color: 'var(--text-hint)' }}>
          (optional)
        </span>
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        You don&apos;t need this to use Prism. It&apos;s used in two situations: one-time
        standardizations on tables Prism itself can&apos;t see, and enabling change tracking
        on tables you connect as pipelines when the service role can&apos;t. Credentials are
        stored encrypted and only ever used for tables you choose to connect — feel free to
        skip this for now.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="col-span-2">
          <Label htmlFor="sf-account">Account identifier</Label>
          <Input id="sf-account" value={sfAccount} onChange={setSfAccount} placeholder="xy12345.us-east-1" />
        </div>
        <div>
          <Label htmlFor="sf-user">Username</Label>
          <Input id="sf-user" value={sfUser} onChange={setSfUser} placeholder="your Snowflake username" />
        </div>
        <div>
          <Label htmlFor="sf-warehouse">Warehouse</Label>
          <Input id="sf-warehouse" value={sfWarehouse} onChange={setSfWarehouse} placeholder="e.g. COMPUTE_WH" />
        </div>
        <div className="col-span-2">
          <Label htmlFor="sf-role">Role</Label>
          <Input id="sf-role" value={sfRole} onChange={setSfRole} placeholder="your Snowflake role" />
        </div>
      </div>

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
          {saving ? <><Spinner /> Saving…</> : 'Save'}
        </button>

        <button type="button" onClick={() => router.push(nextUrl)}
          className="text-sm ml-auto"
          style={{ color: 'var(--text-muted)', background: 'none', cursor: 'pointer' }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ── Native-edition first run (docs/NATIVE_APP_PLAN.md N3 · §2.9) ─────────────
// Inside the Native App there is nothing to configure: the app IS the
// warehouse identity (no credentials), AI runs on Snowflake Cortex in-account
// (no keys), and access arrives as Snowflake grants. So first-run collapses
// to: here's the grant SQL, go. Replaces BOTH the admin credential wizard and
// the personal-credentials variant, which describe surfaces this edition
// doesn't have.

function NativeSetup({ nextUrl, role }: { nextUrl: string; role: 'admin' | 'user' }) {
  const router = useRouter();
  const [appName, setAppName] = useState('');
  // null = still checking; the SQL block shows only when AI is NOT working.
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  // null = still loading the list (fresh installs can legitimately see none —
  // Prism only enumerates what the app or the caller session can already see,
  // which before the first opt-in may be nothing; the type-in covers that).
  const [dbList, setDbList] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [manualDb, setManualDb] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/accounts/databases', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        if (cancelled) return;
        if (b?.app_name) setAppName(String(b.app_name));
        setDbList(Array.isArray(b?.databases) ? b.databases.map(String) : []);
      })
      .catch(() => { if (!cancelled) setDbList([]); });
    fetch('/api/accounts/ai-status', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => { if (!cancelled) setAiConfigured(b?.configured === true); })
      .catch(() => { if (!cancelled) setAiConfigured(false); });
    return () => { cancelled = true; };
  }, []);

  const toggleDb = (db: string) =>
    setSelected(s => (s.includes(db) ? s.filter(d => d !== db) : [...s, db]));
  const addManualDb = () => {
    const db = manualDb.trim().replace(/^"|"$/g, '');
    if (!db) return;
    setDbList(l => (l && l.includes(db) ? l : [...(l ?? []), db]));
    setSelected(s => (s.includes(db) ? s : [...s, db]));
    setManualDb('');
  };
  // Everyone sees the checklist; only an admin role holder can run the SQL,
  // so non-admins get a one-line pointer instead of a run instruction.
  const runLine = role === 'admin'
    ? 'Run this as ACCOUNTADMIN.'
    : 'Ask an admin to run this as ACCOUNTADMIN.';

  return (
    <div>
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
        Prism is ready
      </h1>

      {aiConfigured === true ? (
        <>
          <SectionTitle>AI</SectionTitle>
          <p className="text-sm" style={{ color: 'var(--confidence-high)', lineHeight: 1.6 }}>
            ✓ AI is enabled. Nothing to run.
          </p>
        </>
      ) : (
        <>
          <SectionTitle>Enable AI</SectionTitle>
          <p className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Run this as ACCOUNTADMIN to enable AI:
          </p>
          <div className="mt-2">
            <CodeBlock code={buildNativeStarterSql(appName)} maxHeight={140} />
          </div>
        </>
      )}

      <SectionTitle>Choose your data</SectionTitle>
      <p className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Select the databases to use with Prism:
      </p>
      <div className="mt-2 rounded-button border-[0.5px]"
        style={{ borderColor: 'var(--border)', maxHeight: 180, overflowY: 'auto' }}>
        {dbList === null ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)', padding: '10px 12px' }}>
            Loading databases…
          </p>
        ) : dbList.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)', padding: '10px 12px' }}>
            Prism can&apos;t see any databases yet — type a name below to add one.
          </p>
        ) : (
          dbList.map(db => (
            <label key={db} className="flex items-center gap-2.5 text-sm cursor-pointer select-none"
              style={{ color: 'var(--text-primary)', padding: '8px 12px', borderBottom: '0.5px solid var(--border)' }}>
              <input type="checkbox" checked={selected.includes(db)} onChange={() => toggleDb(db)}
                style={{ accentColor: 'var(--accent)' }} />
              <span className="font-mono text-xs">{db}</span>
            </label>
          ))
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={manualDb}
          onChange={e => setManualDb(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManualDb(); } }}
          placeholder="Add a database Prism can't see yet"
          className="flex-1 rounded-button border-[0.5px] text-sm"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)', color: 'var(--text-primary)', padding: '8px 12px' }}
        />
        <button type="button" onClick={addManualDb}
          className="rounded-button border-[0.5px] text-sm font-medium"
          style={{ borderColor: 'var(--border)', backgroundColor: 'transparent', color: 'var(--text-secondary)', padding: '8px 14px', cursor: 'pointer' }}
        >
          Add
        </button>
      </div>
      {selected.length > 0 && (
        <>
          <p className="text-sm mt-3" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {runLine}
          </p>
          <div className="mt-2">
            <CodeBlock code={buildNativeCallerGrantSql(appName, selected)} maxHeight={220} />
          </div>
          <p className="text-sm mt-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Also run this — it lets pipelines (background standardization, which runs
            with nobody signed in) read those databases and turns on change detection
            for their tables:
          </p>
          <div className="mt-2">
            <CodeBlock code={buildNativeAppDbGrantSql(appName, selected)} maxHeight={220} />
          </div>
          <p className="text-sm mt-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Optional — keep pipeline access fresh. Pipelines need a direct grant per
            table, and Snowflake doesn&apos;t extend those to tables created (or recreated)
            later. This hourly task re-grants automatically. It uses each
            database&apos;s PUBLIC schema — change that if yours differs:
          </p>
          <div className="mt-2">
            <CodeBlock code={buildNativeGrantRefreshTaskSql(appName, selected)} maxHeight={220} />
          </div>
        </>
      )}

      <div className="mt-6 flex justify-end">
        <button
          onClick={() => router.push(nextUrl)}
          className="rounded-button text-sm font-medium"
          style={{ backgroundColor: 'var(--accent)', color: '#fff', padding: '10px 18px', border: 'none', cursor: 'pointer' }}
        >
          Go to Prism
        </button>
      </div>
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

function SetupForm() {
  const params  = useSearchParams();
  const nextUrl = params.get('next') || '/home';

  // Admins get the guided workspace onboarding; regular users get the optional
  // personal-credentials variant. Don't render either until the role is known —
  // a flash of the admin-oriented copy would be actively confusing.
  const [role, setRole] = useState<'admin' | 'user' | null>(null);
  // The installation's warehouse platform — decides which personal-credentials
  // form regular users see. test-snowflake GET is member-readable and reports
  // warehouse_type on SQL Server installs.
  const [platform, setPlatform] = useState<Platform>('snowflake');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(r => r.json())
      .then(b => {
        if (!cancelled && b?.authenticated) setRole(b.role === 'admin' ? 'admin' : 'user');
      })
      .catch(() => {});
    fetch('/api/accounts/test-snowflake', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(b => {
        const t = b?.warehouse_type;
        if (!cancelled && (t === 'mssql' || t === 'postgres' || t === 'mysql')) setPlatform(t);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (role === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <PrismLogo />
        <div className="flex items-center gap-2">
          <Spinner dark />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading your workspace…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: '100%', maxWidth: role === 'admin' ? 620 : 520 }}>
        <PrismLogo />

        <div className="rounded-card border-[0.5px]" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '32px 28px' }}>
          {isNativeEdition()
            ? <NativeSetup nextUrl={nextUrl} role={role} />
            : role === 'admin'
            ? <AdminOnboarding nextUrl={nextUrl} />
            : platform === 'mssql'    ? <PersonalSetupFormMssql nextUrl={nextUrl} />
            : platform === 'postgres' ? <PersonalSetupFormPg nextUrl={nextUrl} />
            : platform === 'mysql'    ? <PersonalSetupFormMysql nextUrl={nextUrl} />
            : <PersonalSetupForm nextUrl={nextUrl} />}
        </div>

        <p className="text-xs text-center mt-4" style={{ color: 'var(--text-hint)' }}>
          {isNativeEdition()
            ? 'This edition of Prism runs inside your Snowflake account and stores no credentials at all — access is granted through Snowflake, and AI runs on Snowflake Cortex.'
            : role === 'admin'
            ? 'Prism only ever stores the low-privilege service credentials and your AI provider key, encrypted. Admin credentials are never saved.'
            : `Credentials are stored encrypted in your account and used only to connect to ${PLATFORM_LABELS[platform]} on your behalf.`}
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
