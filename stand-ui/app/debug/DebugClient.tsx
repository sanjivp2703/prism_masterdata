'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Operator-only raw table inspector (ported from the old /admin page).
// The backing route (/api/admin/table/[tableName]) 404s unless
// PRISM_DEBUG_TOOLS=true, matching the server gate on this page.

const TABLES = [
  'RUNS',
  'LITERAL_ALIAS_MATCHES',
  'APPROVED_ALIAS_NAMES',
  'VALIDATION_LOG',
];

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          backgroundColor: 'var(--surface)',
          borderRadius: 'var(--radius-card)',
          width: '100%', maxWidth: 900, maxHeight: '90vh',
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 16px', borderBottom: '0.5px solid var(--border)', flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-hint)', fontSize: 18, lineHeight: 1, padding: 4 }}
          >
            ✕
          </button>
        </div>
        <div style={{ overflow: 'auto', flex: 1, padding: 16, backgroundColor: '#1A1A2E' }}>
          <pre style={{ fontSize: 11, color: '#86EFAC', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre', lineHeight: 1.6, margin: 0 }}>
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
    const str = value === null ? '' : String(value);
    return (
      <span title={str.length > 80 ? str : undefined}>
        {str.length > 80 ? `${str.slice(0, 80)}…` : str || (
          <span style={{ color: 'var(--text-hint)', fontStyle: 'italic' }}>null</span>
        )}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px',
          borderRadius: 'var(--radius-pill)',
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          backgroundColor: 'var(--accent-tint)',
          color: 'var(--accent-strong)',
          border: '0.5px solid var(--accent-border)',
          cursor: 'pointer',
        }}
      >
        <span>{'{ }'}</span>
        <span>View JSON</span>
      </button>
      {open && <JsonModal title={colKey} value={value} onClose={close} />}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DebugClient() {
  const [tableName, setTableName] = useState(TABLES[0]);
  const [data, setData]           = useState<Record<string, unknown>[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/table/${tableName}`, { cache: 'no-store' });
        if (cancelled) return;
        if (response.ok) {
          const result = await response.json();
          setData(result.data || []);
        } else {
          const body = await response.json().catch(() => ({} as any));
          const msg = (body && (body.error || body.message)) || `${response.status} ${response.statusText}`;
          const details = body?.details ? ` (${String(body.details)})` : '';
          setError(`Failed to fetch: ${msg}${details}`);
          setData([]);
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
          setData([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, [tableName]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--page-bg)', padding: '32px 40px 48px', paddingTop: 84 }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>
          Debug tools
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 20px' }}>
          Operator-only raw table inspector. Enabled via PRISM_DEBUG_TOOLS.
        </p>

        <div
          style={{
            backgroundColor: 'var(--surface)',
            border: '0.5px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            padding: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>Table</label>
            <select
              value={tableName}
              onChange={e => setTableName(e.target.value)}
              style={{
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                border: '0.5px solid var(--border)',
                borderRadius: 'var(--radius-button)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text-secondary)',
                padding: '6px 8px',
              }}
            >
              {TABLES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>
              {loading ? 'Loading…' : `${data.length} rows (limit 1000)`}
            </span>
          </div>

          {loading ? (
            <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: 0 }}>Loading…</p>
          ) : error ? (
            <div
              style={{
                border: '0.5px solid #F3C6C6',
                backgroundColor: '#FDF4F4',
                borderRadius: 'var(--radius-button)',
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--confidence-low)',
              }}
            >
              {error}
            </div>
          ) : data.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: 0 }}>No rows</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {Object.keys(data[0]).map((key) => (
                      <th
                        key={key}
                        style={{
                          padding: '8px 12px',
                          textAlign: 'left',
                          fontSize: 11,
                          fontWeight: 500,
                          color: 'var(--text-muted)',
                          borderBottom: '0.5px solid var(--border)',
                          whiteSpace: 'nowrap',
                          backgroundColor: 'var(--surface-hover)',
                        }}
                      >
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, idx) => (
                    <tr key={idx}>
                      {Object.entries(row).map(([colKey, value]) => (
                        <td
                          key={colKey}
                          style={{
                            padding: '8px 12px',
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            borderBottom: '0.5px solid var(--border-subtle)',
                            whiteSpace: 'nowrap',
                            maxWidth: 360,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {value === null ? (
                            <span style={{ color: 'var(--text-hint)', fontStyle: 'italic' }}>null</span>
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
      </div>
    </div>
  );
}
