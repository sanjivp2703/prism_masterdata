'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColMeta { run_id: number; column_name: string }

/** alias_name → group; key changes on rename (same pattern as RunReviewClient). */
type AliasMap = Record<string, { needs_review: boolean; items: string[] }>;

type Snapshot = { aliasMap: AliasMap; checkedAliases: Set<string> };

interface PageState {
  status:   'grouping' | 'ready' | 'error';
  error?:   string;
  aliasMap: AliasMap;
  accepted: boolean;
}

type DragPayload =
  | { type: 'item';  fromAlias: string; value: string }
  | { type: 'group'; fromAlias: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAliasMap(raw: any[]): AliasMap {
  const m: AliasMap = {};
  for (const g of raw ?? []) {
    const alias = String(g?.alias_name ?? '').trim();
    if (!alias) continue;
    const key = m[alias] ? `${alias}__${Object.keys(m).length}` : alias;
    m[key] = {
      needs_review: g?.needs_review === true,
      items: (g?.items ?? []).map((it: any) => String(it?.literal_value ?? '')).filter(Boolean),
    };
  }
  return m;
}

/** Strip the internal `__n` dedup suffix toAliasMap adds for duplicate names. */
function stripDedupSuffix(key: string): string {
  return key.replace(/__\d+$/, '');
}

function aliasMapToGroups(m: AliasMap) {
  return Object.entries(m).map(([alias_name, g]) => ({
    alias_name: stripDedupSuffix(alias_name),
    needs_review: g.needs_review,
    items: g.items.map(v => ({ literal_value: v })),
  }));
}

function makeName(base: string, map: AliasMap, skip?: string): string {
  if (!map[base] || base === skip) return base;
  let i = 2;
  while (map[`${base} (${i})`] && `${base} (${i})` !== skip) i++;
  return `${base} (${i})`;
}

let _seed = 0;
function nextTempKey() { return `__new_${++_seed}`; }

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function DragDots() {
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(2, 3px)', width: 9, height: 15 }} aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: 'var(--border)' }} />
      ))}
    </div>
  );
}

function CheckmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Export modal ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button type="button" onClick={() => void copy()}
      className="text-[11px] font-medium px-2.5 py-1 rounded-button border-[0.5px] transition-colors"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: copied ? 'var(--confidence-high)' : 'var(--text-secondary)' }}>
      {copied ? 'Copied' : 'Copy SQL'}
    </button>
  );
}

function ExportModal({
  defaultTarget, sourceRelation, onClose, onExport, busy, error, grantsNeeded,
}: {
  defaultTarget:  string;
  sourceRelation: string;
  onClose:     () => void;
  onExport:    (target: string, mode: 'create' | 'overwrite') => void;
  busy:        boolean;
  error:       string | null;
  grantsNeeded: string | null;
}) {
  const [mode, setMode]     = useState<'create' | 'overwrite'>('create');
  const [target, setTarget] = useState(defaultTarget);
  const overwritingSource = target.trim().toUpperCase() === sourceRelation.trim().toUpperCase();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} onClick={busy ? undefined : onClose}>
      <div className="rounded-card border-[0.5px] w-full max-w-md mx-4 overflow-y-auto"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)', maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Export to Snowflake</h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Write a standardized copy of your source table. This does not affect any domain lookup.
        </p>

        <div className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full mb-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
          {([
            { id: 'create',    label: 'Create new table' },
            { id: 'overwrite', label: 'Overwrite existing' },
          ] as const).map(({ id, label }, i) => (
            <button key={id} type="button" onClick={() => setMode(id)} disabled={busy}
              className="flex-1 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{
                backgroundColor: mode === id ? 'var(--accent)' : 'transparent',
                color:           mode === id ? 'white' : 'var(--text-muted)',
                borderRight:     i === 0 ? '0.5px solid var(--border)' : undefined,
              }}>
              {label}
            </button>
          ))}
        </div>

        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          {mode === 'create' ? 'New table' : 'Existing table to overwrite'}
        </label>
        <input
          type="text" value={target} onChange={e => setTarget(e.target.value)}
          placeholder="DATABASE.SCHEMA.TABLE_NAME"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          disabled={busy}
          className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none font-mono disabled:opacity-50"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
        />

        {mode === 'overwrite' && !grantsNeeded && (
          <div className="rounded-button border-[0.5px] px-3 py-2.5 mt-3" style={{ backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }}>
            <p className="text-[11px] leading-relaxed" style={{ color: '#92400E' }}>
              <strong>You are authorizing Prism to write to this table.</strong> The table will be fully
              replaced (<span className="font-mono">CREATE OR REPLACE</span>). Prism is not responsible for
              any data loss. The safe recommendation is to write to a <strong>new</strong> table.
            </p>
          </div>
        )}
        {overwritingSource && !grantsNeeded && (
          <p className="text-[11px] mt-2" style={{ color: 'var(--confidence-low)' }}>
            This is your source table — overwriting it replaces the original data.
          </p>
        )}

        {/* Grant access section */}
        {grantsNeeded && (
          <div className="rounded-button border-[0.5px] mt-3 overflow-hidden" style={{ borderColor: '#FED7AA' }}>
            <div className="px-3 pt-3 pb-2" style={{ backgroundColor: '#FFF7ED' }}>
              <p className="text-[11px] font-semibold mb-0.5" style={{ color: '#92400E' }}>
                Prism needs write access to this location
              </p>
              <p className="text-[11px] leading-relaxed" style={{ color: '#92400E' }}>
                Run the SQL below in Snowflake as <strong>ACCOUNTADMIN</strong> or <strong>SYSADMIN</strong>, then retry the export.
              </p>
            </div>
            <div className="relative" style={{ backgroundColor: '#1A1A2E' }}>
              <pre className="text-[11px] leading-relaxed px-3 pt-3 pb-2 overflow-x-auto font-mono" style={{ color: '#C9D1D9', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {grantsNeeded}
              </pre>
              <div className="absolute top-2 right-2">
                <CopyButton text={grantsNeeded} />
              </div>
            </div>
          </div>
        )}

        {error && !grantsNeeded && (
          <div className="rounded-button border-[0.5px] px-3 py-2 mt-3 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} disabled={busy}
            className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}>
            Cancel
          </button>
          <button type="button" onClick={() => onExport(target.trim(), mode)} disabled={busy || !target.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-button text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--accent)' }}>
            {busy ? <><Spinner /> Exporting…</> : grantsNeeded ? 'Retry export' : `Export ${mode === 'create' ? 'to new table' : '(overwrite)'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OneTimeReviewClient({ session }: { session: string }) {
  const router = useRouter();

  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [sourceRelation, setSourceRelation] = useState('');
  const [columns, setColumns]       = useState<ColMeta[]>([]);
  const [pages, setPages]           = useState<Record<number, PageState>>({});
  const [active, setActive]         = useState(0);

  const [showExport, setShowExport]   = useState(false);
  const [exporting, setExporting]     = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportGrants, setExportGrants] = useState<string | null>(null);
  const [done, setDone]               = useState<{ target: string; rows: number } | null>(null);

  // ── Per-active-column editing state (resets on tab switch) ─────────────────
  const [checkedAliases, setCheckedAliases]     = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey]             = useState<string | null>(null);
  const [editingValue, setEditingValue]         = useState('');
  const [dragOverAlias, setDragOverAlias]       = useState<string | null>(null);
  const [draggingGroup, setDraggingGroup]       = useState<string | null>(null);
  const [openMenu, setOpenMenu]                 = useState<string | null>(null);
  const [undoStack, setUndoStack]               = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack]               = useState<Snapshot[]>([]);
  const [acceptError, setAcceptError]           = useState<string | null>(null);

  const historyRef = useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} });

  // Reset editing state when active column changes.
  useEffect(() => {
    setCheckedAliases(new Set());
    setEditingKey(null);
    setEditingValue('');
    setDragOverAlias(null);
    setDraggingGroup(null);
    setOpenMenu(null);
    setUndoStack([]);
    setRedoStack([]);
    setAcceptError(null);
  }, [active]);

  // ── Keyboard undo/redo ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); historyRef.current.undo(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); historyRef.current.redo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setPage = useCallback((runId: number, patch: Partial<PageState> | ((p: PageState) => PageState)) => {
    setPages(prev => {
      const cur = prev[runId] ?? { status: 'grouping', aliasMap: {}, accepted: false };
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      return { ...prev, [runId]: next };
    });
  }, []);

  // ── Load + group each column ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/one-time/session/${encodeURIComponent(session)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? 'Failed to load session.');
        if (cancelled) return;
        setSourceRelation(body.source_relation ?? '');
        const cols: any[] = body.columns ?? [];
        setColumns(cols.map((c) => ({ run_id: c.run_id, column_name: c.column_name })));
        setLoading(false);

        if (body.exported) { setDone({ target: '', rows: 0 }); return; }

        for (const c of cols) {
          setPages(prev => ({ ...prev, [c.run_id]: { status: 'grouping', aliasMap: {}, accepted: c.accepted === true } }));
          (async () => {
            try {
              let groupsRaw: any[];
              let accepted = c.accepted === true;
              if (c.grouped) {
                const r = await fetch(`/api/one-time/${c.run_id}`);
                const b = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(b?.error ?? 'Failed to load mappings.');
                groupsRaw = b.groups ?? [];
                accepted = b.accepted === true;
              } else {
                const r = await fetch(`/api/one-time/${c.run_id}/group`, { method: 'POST' });
                const b = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(b?.error ?? 'Failed to group values.');
                groupsRaw = b.groups ?? [];
              }
              if (cancelled) return;
              setPage(c.run_id, { status: 'ready', aliasMap: toAliasMap(groupsRaw), accepted });
            } catch (e) {
              if (!cancelled) setPage(c.run_id, { status: 'error', aliasMap: {}, error: e instanceof Error ? e.message : 'Failed.' });
            }
          })();
        }
      } catch (e) {
        if (!cancelled) { setLoadError(e instanceof Error ? e.message : 'Failed to load.'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [session, setPage]);

  const activeCol  = columns[active];
  const activePage = activeCol ? pages[activeCol.run_id] : undefined;
  const activeMap  = activePage?.aliasMap ?? {};

  // ── History helpers ───────────────────────────────────────────────────────

  function snapshot(): Snapshot {
    return { aliasMap: structuredClone(activeMap), checkedAliases: new Set(checkedAliases) };
  }

  function pushHistory() {
    const s = snapshot();
    setUndoStack(prev => [...prev, s]);
    setRedoStack([]);
  }

  function applySnapshot(s: Snapshot) {
    if (!activeCol) return;
    setPage(activeCol.run_id, p => ({ ...p, aliasMap: s.aliasMap, accepted: false }));
    setCheckedAliases(s.checkedAliases);
    setEditingKey(null); setEditingValue('');
    setDragOverAlias(null); setDraggingGroup(null); setOpenMenu(null);
  }

  function undo() {
    if (!undoStack.length) return;
    const s = undoStack[undoStack.length - 1];
    setRedoStack(prev => [...prev, snapshot()]);
    setUndoStack(prev => prev.slice(0, -1));
    applySnapshot(s);
  }

  function redo() {
    if (!redoStack.length) return;
    const s = redoStack[redoStack.length - 1];
    setUndoStack(prev => [...prev, snapshot()]);
    setRedoStack(prev => prev.slice(0, -1));
    applySnapshot(s);
  }

  historyRef.current = { undo, redo };

  // ── Map mutation helper ───────────────────────────────────────────────────

  function mutateMap(fn: (m: AliasMap) => AliasMap) {
    if (!activeCol) return;
    setPage(activeCol.run_id, p => {
      const next = fn(structuredClone(p.aliasMap));
      return { ...p, aliasMap: next, accepted: false };
    });
    if (activePage?.accepted) {
      fetch(`/api/one-time/${activeCol.run_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: false }),
      }).catch(() => {});
    }
  }

  // ── Group mutations ───────────────────────────────────────────────────────

  function addGroup() {
    pushHistory();
    const name = makeName('Unnamed Group', activeMap);
    const key  = nextTempKey();
    mutateMap(m => { m[key] = { needs_review: false, items: [] }; return m; });
    // Rename immediately so user sees a blank name input.
    setEditingKey(key);
    setEditingValue('');
  }

  function deleteGroup(aliasKey: string) {
    const group = activeMap[aliasKey];
    if (!group) return;
    pushHistory();
    mutateMap(m => {
      const displaced = m[aliasKey]?.items ?? [];
      delete m[aliasKey];
      for (const v of displaced) {
        const k = nextTempKey();
        m[k] = { needs_review: true, items: [v] };
      }
      return m;
    });
    setCheckedAliases(prev => { const s = new Set(prev); s.delete(aliasKey); return s; });
    if (editingKey === aliasKey) cancelRename();
    if (openMenu === aliasKey) setOpenMenu(null);
  }

  // ── Rename ────────────────────────────────────────────────────────────────

  function startRename(key: string) {
    setEditingKey(key);
    setEditingValue(key.startsWith('__new_') ? '' : key);
    setOpenMenu(null);
  }

  function cancelRename() {
    setEditingKey(null);
    setEditingValue('');
  }

  function commitRename(oldKey: string) {
    const desired = editingValue.trim() || 'Unnamed Group';
    cancelRename();
    if (desired === oldKey && !oldKey.startsWith('__new_')) return;
    pushHistory();
    mutateMap(m => {
      const group = m[oldKey];
      if (!group) return m;
      const newKey = makeName(desired, m, oldKey);
      delete m[oldKey];
      m[newKey] = group;
      setCheckedAliases(prev => {
        const s = new Set(prev);
        if (s.has(oldKey)) { s.delete(oldKey); s.add(newKey); }
        return s;
      });
      return m;
    });
  }

  // ── Drag items ────────────────────────────────────────────────────────────

  function onDragStartItem(e: React.DragEvent, fromAlias: string, value: string) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'item', fromAlias, value } satisfies DragPayload));
  }

  function onDragStartGroup(e: React.DragEvent, fromAlias: string) {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'group', fromAlias } satisfies DragPayload));
    setDraggingGroup(fromAlias);
  }

  function onDragEndGroup() { setDraggingGroup(null); }

  function onDragOverAlias(e: React.DragEvent, toAlias: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverAlias !== toAlias) setDragOverAlias(toAlias);
  }

  function onDragLeaveAlias(e: React.DragEvent, toAlias: string) {
    if (dragOverAlias === toAlias) setDragOverAlias(null);
  }

  function onDropOnAlias(e: React.DragEvent, toAlias: string) {
    e.preventDefault();
    setDragOverAlias(null); setDraggingGroup(null);
    let payload: DragPayload | null = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
    if (!payload) return;
    pushHistory();

    if (payload.type === 'group') {
      const { fromAlias } = payload;
      if (fromAlias === toAlias) return;
      mutateMap(m => {
        const from = m[fromAlias]; const to = m[toAlias];
        if (!from || !to) return m;
        const existing = new Set(to.items);
        to.items = [...to.items, ...from.items.filter(v => !existing.has(v))];
        delete m[fromAlias];
        setCheckedAliases(prev => { const s = new Set(prev); s.delete(fromAlias); return s; });
        return m;
      });
      return;
    }

    const { fromAlias, value } = payload;
    if (fromAlias === toAlias) return;
    mutateMap(m => {
      if (m[fromAlias]) m[fromAlias].items = m[fromAlias].items.filter(v => v !== value);
      if (m[fromAlias] && m[fromAlias].items.length === 0) delete m[fromAlias];
      if (!m[toAlias]) m[toAlias] = { needs_review: false, items: [] };
      if (!m[toAlias].items.includes(value)) m[toAlias].items.push(value);
      return m;
    });
  }

  // ── Check ─────────────────────────────────────────────────────────────────

  function toggleCheck(key: string) {
    setCheckedAliases(prev => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  }

  function checkAll() {
    setCheckedAliases(new Set(Object.keys(activeMap)));
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const sortedEntries = useMemo(() => {
    const e = Object.entries(activeMap);
    e.sort((a, b) => {
      const ar = a[1].needs_review ? 1 : 0;
      const br = b[1].needs_review ? 1 : 0;
      return br - ar;
    });
    return e;
  }, [activeMap]);

  const reviewCount = useMemo(
    () => Object.values(activeMap).filter(g => g.needs_review).length,
    [activeMap]
  );

  const totalGroups    = sortedEntries.length;
  const uncheckedCount = totalGroups - checkedAliases.size;

  // ── Accept page ───────────────────────────────────────────────────────────

  async function acceptPage() {
    if (!activeCol || !activePage) return;
    const payload = { groups: aliasMapToGroups(activeMap), accepted: true };
    setPage(activeCol.run_id, { accepted: true });
    setAcceptError(null);
    try {
      const r = await fetch(`/api/one-time/${activeCol.run_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b?.error ?? 'Failed to accept.');
      }
      const nextIdx = columns.findIndex((c, i) => i !== active && pages[c.run_id]?.accepted !== true);
      if (nextIdx >= 0) setActive(nextIdx);
    } catch (e) {
      setPage(activeCol.run_id, { accepted: false });
      setAcceptError(e instanceof Error ? e.message : 'Failed to accept.');
    }
  }

  const allAccepted = columns.length > 0 && columns.every(c => pages[c.run_id]?.accepted === true);

  // ── Export ────────────────────────────────────────────────────────────────

  async function doExport(target: string, mode: 'create' | 'overwrite') {
    setExporting(true); setExportError(null); setExportGrants(null);
    try {
      const r = await fetch('/api/one-time/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, target_fqn: target, mode }),
      });
      const b = await r.json().catch(() => ({}));
      if (r.status === 403 && b?.needs_grants) {
        setExportGrants(String(b.grants_sql ?? ''));
        return;
      }
      if (!r.ok) {
        const msg = b?.error ?? 'Export failed.';
        const detail = b?.details ? `\n\nDetails: ${b.details}` : '';
        throw new Error(msg + detail);
      }
      setShowExport(false); setExportGrants(null);
      setDone({ target: b.target_fqn ?? target, rows: b.rows_written ?? 0 });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  // ── Render: loading / error / done ────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center gap-2" style={{ backgroundColor: 'var(--page-bg)' }}>
        <Spinner className="w-5 h-5" /><span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</span>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ backgroundColor: 'var(--page-bg)' }}>
        <p className="text-sm" style={{ color: 'var(--confidence-low)' }}>{loadError}</p>
        <button onClick={() => router.push('/home')} className="text-sm font-medium rounded-button px-4 py-2 text-white" style={{ backgroundColor: 'var(--accent)' }}>Return home</button>
      </div>
    );
  }
  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--page-bg)' }}>
        <div className="rounded-card border-[0.5px] text-center" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '40px 48px', maxWidth: 460 }}>
          <div className="mx-auto mb-4 flex items-center justify-center rounded-full" style={{ width: 48, height: 48, backgroundColor: '#DCFCE7' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#15803D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <h2 className="text-lg font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>Standardization exported</h2>
          <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
            {done.target ? <>Wrote <span className="font-mono" style={{ wordBreak: 'break-all' }}>{done.target}</span></> : 'This session was already exported.'}
          </p>
          {done.rows > 0 && <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>{done.rows.toLocaleString()} rows</p>}
          <button onClick={() => router.push('/home')} className="text-sm font-medium rounded-button px-5 py-2.5 text-white" style={{ backgroundColor: 'var(--accent)' }}>
            Return home
          </button>
        </div>
      </div>
    );
  }

  // ── Render: main ─────────────────────────────────────────────────────────

  return (
    <div onClick={() => setOpenMenu(null)} style={{ backgroundColor: 'var(--page-bg)', minHeight: '100vh' }}>
      {/* Sticky top bar */}
      <div className="sticky top-0 z-30" style={{ backgroundColor: 'var(--surface)', borderBottom: '0.5px solid var(--border)' }}>
        <div className="mx-auto flex items-center justify-between gap-4" style={{ maxWidth: 980, padding: '14px 24px' }}>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>One-time standardization</h1>
            <p className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>{sourceRelation}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => router.push('/home')}
              className="text-xs font-medium rounded-button px-3 py-2 border-[0.5px]"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}>
              Cancel
            </button>
            <button onClick={() => setShowExport(true)} disabled={!allAccepted}
              className="text-xs font-medium rounded-button px-4 py-2 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--accent)' }}
              title={allAccepted ? 'Export to Snowflake' : 'Accept every column to enable export'}>
              Export
            </button>
          </div>
        </div>
        {/* Column tabs */}
        <div className="mx-auto flex items-center gap-1.5 overflow-x-auto" style={{ maxWidth: 980, padding: '0 24px 12px' }}>
          {columns.map((c, i) => {
            const p = pages[c.run_id];
            const isActive = i === active;
            return (
              <button key={c.run_id} onClick={() => setActive(i)}
                className="flex items-center gap-1.5 text-xs font-medium rounded-button px-3 py-1.5 border-[0.5px] whitespace-nowrap transition-colors"
                style={{
                  borderColor:     isActive ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: isActive ? 'var(--accent-tint)' : 'var(--surface)',
                  color:           isActive ? 'var(--accent-strong)' : 'var(--text-secondary)',
                }}>
                <span className="font-mono">{c.column_name}</span>
                {p?.accepted
                  ? <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2.5 7L5.5 10L11.5 4" stroke="#15803D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  : p?.status === 'grouping'
                    ? <Spinner className="w-3 h-3" />
                    : <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--text-hint)' }} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Page content */}
      <div className="mx-auto" style={{ maxWidth: 980, padding: '24px' }}>
        {!activePage || activePage.status === 'grouping' ? (
          <div className="flex items-center justify-center gap-2 py-20">
            <Spinner className="w-5 h-5" /><span className="text-sm" style={{ color: 'var(--text-muted)' }}>Grouping values…</span>
          </div>
        ) : activePage.status === 'error' ? (
          <p className="text-sm py-20 text-center" style={{ color: 'var(--confidence-low)' }}>{activePage.error}</p>
        ) : (
          <div className="rounded-card border-[0.5px] p-6" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
            {/* Card header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Alias groups</h2>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs font-medium"
                  style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)' }}>
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--accent)' }} />
                  {activeCol?.column_name}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Checked{' '}
                  <span className="font-medium" style={{ color: 'var(--accent)' }}>{checkedAliases.size}</span>
                  {' / '}{totalGroups}
                </span>
                {/* Undo */}
                <button
                  type="button"
                  onClick={() => historyRef.current.undo()}
                  disabled={undoStack.length === 0}
                  title="Undo (⌘Z)"
                  className="w-8 h-8 flex items-center justify-center rounded-button border-[0.5px] transition-colors disabled:opacity-30"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-muted)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2 6h6a4 4 0 010 8H4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M2 3l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" transform="scale(-1,1) translate(-4,0)" />
                    <path d="M5 3L2 6l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {/* Accept */}
                <button
                  type="button"
                  onClick={() => void acceptPage()}
                  disabled={activePage.accepted}
                  className="px-4 py-1.5 rounded-button text-sm font-medium transition-colors disabled:cursor-default"
                  style={activePage.accepted
                    ? { border: '0.5px solid #BBF7D0', backgroundColor: '#DCFCE7', color: '#15803D' }
                    : { backgroundColor: 'var(--accent)', color: 'white' }}
                  onMouseEnter={e => { if (!activePage.accepted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                  onMouseLeave={e => { if (!activePage.accepted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                >
                  {activePage.accepted ? '✓ Accepted' : 'Accept mappings'}
                </button>
              </div>
            </div>

            {/* Accept error */}
            {acceptError && (
              <div className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                {acceptError}
              </div>
            )}

            {/* Needs-review callout */}
            {reviewCount > 0 && (
              <div className="flex items-start gap-2.5 rounded-button border-[0.5px] px-4 py-3.5 mb-5 text-sm"
                style={{ backgroundColor: '#FEFCE8', borderColor: '#FDE68A', color: '#78350F' }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5" aria-hidden="true">
                  <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="#D97706" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M8 6v3.5" stroke="#D97706" strokeWidth="1.3" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.7" fill="#D97706" />
                </svg>
                <span>
                  <strong className="font-semibold">{reviewCount} value{reviewCount !== 1 ? 's' : ''} need your review</strong>
                  {' — '}highlighted in yellow. The AI wasn&apos;t confident about these. Drag them into the correct group or accept as-is.
                </span>
              </div>
            )}

            {/* Column headers */}
            <div className="grid items-center mb-1 pb-2 border-b-[0.5px]"
              style={{ gridTemplateColumns: '36px 36px 160px 1fr 32px', borderColor: 'var(--border-subtle)' }}>
              <div />
              <div />
              <div className="px-3 text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>Alias name</div>
              <div className="px-2 text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>Matched values</div>
              <div />
            </div>

            {/* Group rows */}
            <div>
              {sortedEntries.map(([aliasKey, group], idx) => {
                const isChecked        = checkedAliases.has(aliasKey);
                const isGroupDragOver  = dragOverAlias === aliasKey && draggingGroup !== null && draggingGroup !== aliasKey;
                const isItemDragOver   = dragOverAlias === aliasKey && draggingGroup === null;
                const isDragOver       = isGroupDragOver || isItemDragOver;
                const isBeingDragged   = draggingGroup === aliasKey;
                const displayName      = aliasKey.startsWith('__new_') ? '' : stripDedupSuffix(aliasKey);

                return (
                  <div key={aliasKey}>
                    {idx > 0 && <div className="mx-3 border-t-[0.5px]" style={{ borderColor: 'var(--border-subtle)' }} />}
                    <div
                      className="grid items-start py-[13px] rounded-row transition-colors"
                      style={{
                        gridTemplateColumns: '36px 36px 160px 1fr 32px',
                        opacity: isBeingDragged ? 0.4 : 1,
                        ...(isDragOver ? { backgroundColor: 'var(--accent-tint)', borderLeft: '2px solid var(--accent)', paddingLeft: 10 } : {}),
                      }}
                      onMouseEnter={e => { if (!isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--surface-hover)'; }}
                      onMouseLeave={e => { if (!isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = ''; }}
                      onDragOver={e => onDragOverAlias(e, aliasKey)}
                      onDrop={e => onDropOnAlias(e, aliasKey)}
                      onDragLeave={e => onDragLeaveAlias(e, aliasKey)}
                    >
                      {/* Col 1: Checkbox */}
                      <div className="flex justify-center pt-0.5">
                        <button type="button" onClick={() => toggleCheck(aliasKey)}
                          aria-label={isChecked ? 'Uncheck group' : 'Check group'}
                          className="w-[26px] h-[26px] rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                          style={isChecked
                            ? { backgroundColor: 'var(--accent)', border: 'none' }
                            : { backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)' }
                          }>
                          {isChecked && <CheckmarkIcon />}
                        </button>
                      </div>

                      {/* Col 2: Drag handle */}
                      <div className="flex justify-center pt-1.5">
                        {editingKey !== aliasKey && (
                          <span draggable
                            onDragStart={e => onDragStartGroup(e, aliasKey)}
                            onDragEnd={onDragEndGroup}
                            className="cursor-grab p-1 flex items-center justify-center"
                            title="Drag to reorder or merge"
                            aria-label="Drag to reorder group">
                            <DragDots />
                          </span>
                        )}
                      </div>

                      {/* Col 3: Alias name */}
                      <div className="px-3 text-sm" onDoubleClick={() => startRename(aliasKey)} title={editingKey !== aliasKey ? 'Double-click to rename' : undefined}>
                        {isGroupDragOver ? (
                          <span className="text-xs font-medium" style={{ color: 'var(--accent-strong)' }}>
                            Merge into &ldquo;{displayName || '(unnamed)'}&rdquo;
                          </span>
                        ) : editingKey === aliasKey ? (
                          <input
                            autoFocus
                            value={editingValue}
                            onChange={e => setEditingValue(e.target.value)}
                            onBlur={() => commitRename(aliasKey)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(aliasKey); if (e.key === 'Escape') cancelRename(); }}
                            className="w-full px-2 py-1 text-sm rounded-[6px] border-[0.5px] outline-none"
                            style={{ borderColor: 'var(--accent)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                          />
                        ) : (
                          <span className="font-semibold" style={{ color: displayName ? 'var(--text-primary)' : 'var(--text-hint)' }}>
                            {displayName || '(unnamed)'}
                          </span>
                        )}
                      </div>

                      {/* Col 4: Value chips */}
                      <div className="px-2">
                        {group.items.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {group.items.map(value => (
                              <span key={value}
                                draggable
                                onDragStart={e => onDragStartItem(e, aliasKey, value)}
                                className="inline-flex items-center px-2.5 py-1 rounded-pill cursor-move text-xs"
                                style={group.needs_review ? {
                                  backgroundColor: '#FEF9C3', border: '0.5px solid #FDE047', color: '#713F12',
                                } : {
                                  backgroundColor: 'var(--border-subtle)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)',
                                }}>
                                {value}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs italic" style={{ color: 'var(--text-hint)' }}>No items yet</span>
                        )}
                      </div>

                      {/* Col 5: More menu */}
                      <div className="relative flex justify-center pt-0.5">
                        {editingKey !== aliasKey && (
                          <>
                            <button type="button"
                              onClick={e => { e.stopPropagation(); setOpenMenu(prev => prev === aliasKey ? null : aliasKey); }}
                              className="w-7 h-7 rounded-[6px] border-[0.5px] flex items-center justify-center text-sm transition-colors"
                              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-hint)' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                              title="Group actions" aria-label="Group actions">
                              ···
                            </button>
                            {openMenu === aliasKey && (
                              <div className="absolute right-0 top-8 w-32 rounded-button border-[0.5px] z-10 overflow-hidden"
                                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                                onClick={e => e.stopPropagation()}>
                                <button type="button"
                                  onClick={() => { startRename(aliasKey); setOpenMenu(null); }}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}>
                                  Rename
                                </button>
                                <button type="button"
                                  onClick={() => deleteGroup(aliasKey)}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{ color: 'var(--confidence-low)' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEF2F2'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add group */}
            <div className="flex justify-center mt-4 mb-1">
              <button type="button" onClick={addGroup}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-button border-[0.5px] border-dashed text-sm transition-colors"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-hint)' }}
                onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.backgroundColor = 'var(--accent-tint)'; b.style.borderColor = 'var(--accent)'; b.style.color = 'var(--accent)'; }}
                onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.backgroundColor = 'var(--surface)'; b.style.borderColor = 'var(--border)'; b.style.color = 'var(--text-hint)'; }}>
                <span className="text-base leading-none">+</span>
                Add a group
              </button>
            </div>
          </div>
        )}
      </div>

      {showExport && (
        <ExportModal
          defaultTarget={sourceRelation ? `${sourceRelation}_STANDARDIZED` : ''}
          sourceRelation={sourceRelation}
          onClose={() => { setShowExport(false); setExportError(null); setExportGrants(null); }}
          onExport={doExport}
          busy={exporting}
          error={exportError}
          grantsNeeded={exportGrants}
        />
      )}
    </div>
  );
}
