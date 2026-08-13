'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useWarehouseKind } from '@/app/components/use-warehouse-label';
import { isNativeEdition } from '@/app/api/_lib/edition';

// ── Types ────────────────────────────────────────────────────────────────────

interface ColumnOption {
  column_name: string;
  domain_id:   number | null;
  domain_name: string | null;
}

export interface ExportLookupModalProps {
  /** Pipeline context: let the user pick a column first. */
  columns?: ColumnOption[];
  /** Spec context: pre-selected column spec (skip column picker). */
  domainId?: number;
  domainName?: string;
  onClose: () => void;
}

type Format = 'csv' | 'excel' | 'sheets' | 'snowflake';

// ── Helpers ──────────────────────────────────────────────────────────────────

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

async function fetchMappings(domainId: number): Promise<Array<{ canonical_name: string; raw_value: string }>> {
  const res  = await fetch(`/api/global-standardizations?domain_id=${domainId}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  const data = (body?.data ?? {}) as Record<string, { items: Array<{ literal_value: string }> }>;
  const rows: Array<{ canonical_name: string; raw_value: string }> = [];
  for (const [aliasName, group] of Object.entries(data)) {
    for (const it of group.items) rows.push({ canonical_name: aliasName, raw_value: it.literal_value });
  }
  rows.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name) || a.raw_value.localeCompare(b.raw_value));
  return rows;
}

function escapeCsv(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ExportLookupModal({ columns, domainId: propDomainId, domainName: propDomainName, onClose }: ExportLookupModalProps) {
  // If pipeline context with multiple columns, let user pick
  const needsColumnPick = !!(columns && columns.length > 1 && propDomainId == null);
  const [selectedColIdx, setSelectedColIdx] = useState(0);

  const resolvedDomainId   = propDomainId ?? (columns ? columns[selectedColIdx]?.domain_id ?? null : null);
  const resolvedDomainName = propDomainName ?? (columns ? columns[selectedColIdx]?.domain_name ?? null : null);

  const [format,   setFormat]   = useState<Format>('csv');
  const [sfTable,  setSfTable]  = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [success,  setSuccess]  = useState<string | null>(null);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);

  // Which warehouse this installation actually runs on.
  //
  // This modal had no warehouse awareness at all, while the SERVER route it
  // posts to does: global-standardizations/export picks schema EXPORTS on
  // mssql and PUBLIC on Snowflake. So a SQL Server user was shown a
  // `PRISM_DB.PUBLIC.…` default destination while their table was actually
  // written to `PRISM_DB.EXPORTS.…`, and the option was labelled "Snowflake"
  // — a destination that is not the destination, not merely a wrong label
  // (SEC-07 follow-up).
  //
  // Deliberately the SHARED hook rather than a local fetch. The hook seeds its
  // state from a module-level cache SYNCHRONOUSLY, and this modal's own parent
  // (PipelinesView) already calls it, so the cache is warm before the modal
  // ever mounts. A local fetch re-opened a window between mount and resolve in
  // which an mssql user saw the "Snowflake" label and a PRISM_DB.PUBLIC.…
  // placeholder — reintroducing, briefly, the exact wrong-schema string this
  // fix exists to remove — and issued a duplicate request to boot.
  const warehouseKind   = useWarehouseKind();
  const warehouseLabel  = warehouseKind === 'mssql' ? 'SQL Server' : warehouseKind === 'postgres' ? 'PostgreSQL' : warehouseKind === 'mysql' ? 'MySQL' : 'Snowflake';
  const defaultSchema   = warehouseKind === 'mssql' ? 'EXPORTS' : (warehouseKind === 'postgres' || warehouseKind === 'mysql') ? 'prism_exports' : 'PUBLIC';

  async function handleExport() {
    if (resolvedDomainId == null) { setError('No column selected.'); return; }
    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      if (format === 'csv' || format === 'excel') {
        const rows = await fetchMappings(resolvedDomainId);
        if (rows.length === 0) { setError('No mappings found for this column.'); setBusy(false); return; }

        const safeName = (resolvedDomainName ?? 'lookup').replace(/[^a-zA-Z0-9_-]/g, '_');

        if (format === 'csv') {
          const csv = ['canonical_name,raw_value', ...rows.map(r => `${escapeCsv(r.canonical_name)},${escapeCsv(r.raw_value)}`)].join('\n');
          triggerDownload(new Blob([csv], { type: 'text/csv' }), `${safeName}_lookup.csv`);
          setSuccess(`Downloaded ${rows.length} mappings as CSV.`);
        } else {
          const XLSX = await import('xlsx');
          const data = [['canonical_name', 'raw_value'], ...rows.map(r => [r.canonical_name, r.raw_value])];
          const ws   = XLSX.utils.aoa_to_sheet(data);
          const wb   = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Lookup Table');
          const buf  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
          triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeName}_lookup.xlsx`);
          setSuccess(`Downloaded ${rows.length} mappings as Excel.`);
        }
      } else {
        // Sheets or Snowflake — server-side
        const res  = await fetch('/api/global-standardizations/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format,
            domain_id:         resolvedDomainId,
            domain_name:       resolvedDomainName,
            snowflakeTableFqn: format === 'snowflake' ? sfTable.trim() || undefined : undefined,
          }),
        });
        const body = await res.json().catch(() => ({}));

        if (body.needsAuth) {
          window.location.href = '/api/auth/google?returnTo=' + encodeURIComponent(window.location.pathname);
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

        if (format === 'sheets' && body.url) {
          // window.open after an await is often popup-blocked — keep the URL as
          // a visible link in the success state so a blocked popup isn't a dead end.
          setSheetUrl(body.url);
          window.open(body.url, '_blank');
          setSuccess(`Created Google Sheet with ${body.rows ?? 0} mappings.`);
        } else if (format === 'snowflake') {
          setSuccess(`Created ${warehouseLabel} table ${body.table_fqn ?? ''} with ${body.rows ?? 0} mappings.`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  const ALL_FORMATS: Array<{ key: Format; label: string; desc: string }> = [
    { key: 'csv',       label: 'CSV',            desc: 'Download as .csv file' },
    { key: 'excel',     label: 'Excel',          desc: 'Download as .xlsx file' },
    { key: 'sheets',    label: 'Google Sheets',  desc: 'Create a new Google Sheet' },
    { key: 'snowflake', label: warehouseLabel,   desc: `Create a ${warehouseLabel} table` },
  ];
  // Native (Marketplace) edition has no Google integration.
  const FORMATS = ALL_FORMATS.filter(f => f.key !== 'sheets' || !isNativeEdition());

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 60 }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} />

      {/* Panel */}
      <div
        className="relative rounded-card border-[0.5px] w-full max-w-md mx-4"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 24 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Download lookup table</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>

        {/* Column picker (pipeline context with multiple columns) */}
        {needsColumnPick && columns && (
          <div className="mb-4">
            <label className="text-[11px] font-medium block mb-1.5" style={{ color: 'var(--text-secondary)' }}>Column</label>
            <div className="flex flex-wrap gap-1.5">
              {columns.map((col, idx) => (
                <button
                  key={col.column_name}
                  type="button"
                  onClick={() => setSelectedColIdx(idx)}
                  className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors"
                  style={{
                    borderColor: idx === selectedColIdx ? 'var(--accent)' : 'var(--border)',
                    color:       idx === selectedColIdx ? 'var(--accent)' : 'var(--text-secondary)',
                    backgroundColor: idx === selectedColIdx ? 'var(--accent-tint)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {col.column_name}
                  {col.domain_name && <span className="ml-1" style={{ color: 'var(--text-muted)' }}>({col.domain_name})</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Single-column info or spec name */}
        {!needsColumnPick && (columns?.length === 1 || propDomainName) && (
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            {columns?.[0]?.column_name ? `Column: ${columns[0].column_name}` : resolvedDomainName ? `Column: ${resolvedDomainName}` : ''}
          </p>
        )}

        {/* Format selector */}
        <label className="text-[11px] font-medium block mb-1.5" style={{ color: 'var(--text-secondary)' }}>Format</label>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {FORMATS.map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => { setFormat(f.key); setError(null); setSuccess(null); }}
              className="text-left px-3 py-2 rounded-button border-[0.5px] transition-colors"
              style={{
                borderColor: f.key === format ? 'var(--accent)' : 'var(--border)',
                backgroundColor: f.key === format ? 'var(--accent-tint)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <p className="text-[12px] font-medium" style={{ color: f.key === format ? 'var(--accent)' : 'var(--text-primary)' }}>{f.label}</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.desc}</p>
            </button>
          ))}
        </div>

        {/* Warehouse table name */}
        {format === 'snowflake' && (
          <div className="mb-4">
            <label className="text-[11px] font-medium block mb-1.5" style={{ color: 'var(--text-secondary)' }}>Target table</label>
            <input
              type="text"
              value={sfTable}
              onChange={e => setSfTable(e.target.value)}
              // Mirrors the server's defaultFqn EXACTLY (see the export route) —
              // including the no-column-name fallback, which used to show a
              // generic 'DB.SCHEMA.TABLE_NAME' hint while the server would
              // actually create PRISM_DB.<schema>.GLOBAL_CANONICAL_MAPPINGS.
              // The label below promises "leave blank to use default", so the
              // placeholder has to BE that default, not a shape hint.
              placeholder={resolvedDomainName
                ? `PRISM_DB.${defaultSchema}.${resolvedDomainName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_LOOKUP`
                : `PRISM_DB.${defaultSchema}.GLOBAL_CANONICAL_MAPPINGS`}
              className="text-xs rounded-button border-[0.5px] outline-none px-3 py-1.5 w-full font-mono"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
            />
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-hint)' }}>Leave blank to use default</p>
          </div>
        )}

        {/* Error / Success */}
        {error && <p className="text-xs mb-3 px-2 py-1.5 rounded-button" style={{ color: '#DC2626', backgroundColor: '#FEF2F2' }}>{error}</p>}
        {success && (
          <p className="text-xs mb-3 px-2 py-1.5 rounded-button" style={{ color: '#15803D', backgroundColor: '#DCFCE7' }}>
            {success}
            {sheetUrl && (
              <>
                {' '}
                <a href={sheetUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#15803D', textDecoration: 'underline', fontWeight: 500 }}>
                  Open sheet
                </a>
              </>
            )}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-[12px] font-medium px-3 py-1.5 rounded-button border-[0.5px] transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'transparent', cursor: 'pointer' }}
          >
            {success ? 'Close' : 'Cancel'}
          </button>
          {!success && (
            <button
              onClick={handleExport}
              disabled={busy || resolvedDomainId == null}
              className="text-[12px] font-medium px-4 py-1.5 rounded-button border-[0.5px] transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
              style={{ borderColor: 'var(--accent)', color: 'white', backgroundColor: 'var(--accent)', cursor: busy ? 'wait' : 'pointer' }}
            >
              {busy && <Spinner className="w-3 h-3" />}
              {busy ? 'Exporting…' : format === 'csv' || format === 'excel' ? 'Download' : 'Export'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
