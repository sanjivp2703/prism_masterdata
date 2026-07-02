'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { DomainScopeNotice, DomainChangeConfirmModal, UndoButton } from '@/app/components/DomainChangeWarning';

// ── Constants ─────────────────────────────────────────────────────────────────

const UNGROUPED_KEY = '__UNGROUPED__';

const BLUE = {
  accent:    'var(--accent)',
  strong:    'var(--accent-strong)',
  tint:      'var(--accent-tint)',
  border:    'var(--accent-border)',
  badgeText: 'var(--accent-strong)',
};

// ── Types ─────────────────────────────────────────────────────────────────────

type GlobalItem = { literal_value: string; run_id: number; confirmed_at: string };

type GlobalAliasMap = Record<string, { items: GlobalItem[] }>;

type DragPayload =
  | { type: 'item';  fromAliasName: string; literal_value: string }
  | { type: 'group'; fromAliasName: string };

type Snapshot = {
  uiAliasMap:        GlobalAliasMap;
  nextTempGroupId:   number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFilename(ext: string) {
  const ts = new Date().toISOString().slice(0, 10);
  return `domain-standardizations-${ts}.${ext}`;
}

function computeDelta(
  original: GlobalAliasMap,
  current: GlobalAliasMap,
): { item_moves: Record<string, string>; deleted_literals: string[] } {
  const origMap: Record<string, string> = {};
  for (const [alias, { items }] of Object.entries(original)) {
    for (const item of items) origMap[item.literal_value] = alias;
  }

  const curMap: Record<string, string | null> = {};
  for (const [alias, { items }] of Object.entries(current)) {
    for (const item of items) {
      curMap[item.literal_value] = alias === UNGROUPED_KEY ? null : alias;
    }
  }

  const item_moves: Record<string, string>  = {};
  const deleted_literals: string[]          = [];

  for (const [litVal, origAlias] of Object.entries(origMap)) {
    const curAlias = curMap[litVal];
    if (curAlias === undefined || curAlias === null) {
      deleted_literals.push(litVal);
    } else if (curAlias !== origAlias) {
      item_moves[litVal] = curAlias;
    }
  }

  return { item_moves, deleted_literals };
}

// ── Sub-components ────────────────────────────────────────────────────────────


function DragDots() {
  return (
    <div
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: 'repeat(2, 3px)', width: 9, height: 15 }}
      aria-hidden="true"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: 'var(--border)' }} />
      ))}
    </div>
  );
}

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GlobalStandardizationsClient({
  domainId,
  pipelineIds,
}: {
  domainId?: number | null;
  pipelineIds?: number[];
}) {
  const [aliasMap,      setAliasMap]      = useState<GlobalAliasMap | null>(null);
  const [uiAliasMap,   setUiAliasMap]   = useState<GlobalAliasMap | null>(null);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading standardizations…');

  // Queue / filtered view state
  const [originalQueueItems,  setOriginalQueueItems]  = useState<Set<string>>(new Set());
  const [showQueueOnly,       setShowQueueOnly]       = useState(false);
  const [acceptedQueue,       setAcceptedQueue]       = useState(false);

  // Accept state
  const [acceptSuccess,       setAcceptSuccess]       = useState(false);
  const acceptTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveProgress,  setSaveProgress]  = useState(0);
  const progressTimer   = useRef<ReturnType<typeof setInterval> | null>(null);


  const [nextTempGroupId, setNextTempGroupId] = useState(-1);

  const [editingAliasKey,   setEditingAliasKey]   = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState('');
  const [renameError,       setRenameError]       = useState<string | null>(null);

  const [dragOverAliasName,  setDragOverAliasName]  = useState<string | null>(null);
  const [draggingGroupName,  setDraggingGroupName]  = useState<string | null>(null);
  const [openMenuForAlias,   setOpenMenuForAlias]   = useState<string | null>(null);

  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const historyRef = useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} });

  // Confirm gate: any write to the lookup affects the whole domain, so saveChanges
  // pauses on a confirm modal whose resolution it awaits before committing.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);
  function askDomainChangeConfirm(): Promise<boolean> {
    return new Promise((resolve) => { confirmResolveRef.current = resolve; setConfirmOpen(true); });
  }
  function resolveDomainChangeConfirm(ok: boolean) {
    setConfirmOpen(false);
    const r = confirmResolveRef.current;
    confirmResolveRef.current = null;
    r?.(ok);
  }

  const router = useRouter();

  // Drag state
  const dragPayloadRef = useRef<DragPayload | null>(null);

  // Export modal
  const [exportModalOpen, setExportModalOpen]   = useState(false);
  const [saving,           setSaving]            = useState(false);
  const [saveError,        setSaveError]         = useState<string | null>(null);

  // Snowflake export sub-state
  const [sfTableFqn,       setSfTableFqn]        = useState('STAND_DB.STAND_INTERNAL.GLOBAL_CANONICAL_MAPPINGS');
  const [sfExportResult,   setSfExportResult]    = useState<{ table_fqn: string; rows: number } | null>(null);
  const [sfExportError,    setSfExportError]     = useState<string | null>(null);
  const [sfExporting,      setSfExporting]       = useState(false);

  // Google Sheets sub-state
  const [sheetsLoading,    setSheetsLoading]     = useState(false);
  const [sheetsError,      setSheetsError]       = useState<string | null>(null);
  const [sheetsUrl,        setSheetsUrl]         = useState<string | null>(null);

  // ── Load ─────────────────────────────────────────────────────────────────

  async function loadAliasMap(cancelled: () => boolean): Promise<GlobalAliasMap | null> {
    const url = domainId != null
      ? `/api/global-standardizations?domain_id=${domainId}`
      : '/api/global-standardizations';
    const res  = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || 'Failed to load global standardizations');
    if (cancelled()) return null;
    return (body?.data || {}) as GlobalAliasMap;
  }

  function applyAliasMap(data: GlobalAliasMap) {
    setAliasMap(data);
    setUiAliasMap(structuredClone(data));
    setEditingAliasKey(null);
    setUndoStack([]);
    setRedoStack([]);
  }

  useEffect(() => {
    let isCancelled = false;
    const cancelled = () => isCancelled;

    async function init() {
      setLoading(true);
      setLoadingMessage('Loading standardizations…');
      setLoadError(null);
      try {
        // 1. Load confirmed alias map from DB
        const data = await loadAliasMap(cancelled);
        if (!data || cancelled()) return;
        applyAliasMap(data);

        // 2. If no pipeline context, done
        if (!pipelineIds || pipelineIds.length === 0) return;

        // 3. Fetch queue literals for all pipelines
        const queueResults = await Promise.all(
          pipelineIds.map(pid =>
            fetch(`/api/pipelines/${pid}/queue`)
              .then(r => r.json().catch(() => ({ items: [] })))
              .then((b: { items?: { literal_value: string }[] }) => b.items ?? [])
              .catch(() => [] as { literal_value: string }[]),
          ),
        );
        if (cancelled()) return;
        const allLiterals = queueResults.flat().map(i => i.literal_value);
        if (allLiterals.length === 0) return;

        setOriginalQueueItems(new Set(allLiterals));
        setShowQueueOnly(true);

        // 4. Run LLM grouping on queue items (display only — no DB write yet)
        setLoadingMessage(`Analyzing ${allLiterals.length} new value${allLiterals.length !== 1 ? 's' : ''}…`);
        const proposeResults = await Promise.all(
          pipelineIds.map(pid =>
            fetch(`/api/pipelines/${pid}/propose-groupings`, { method: 'POST' })
              .then(r => r.json().catch(() => ({ groups: [] })))
              .catch(() => ({ groups: [] })) as Promise<{ groups: { alias_name: string; items: string[]; review_items: string[] }[] }>,
          ),
        );
        if (cancelled()) return;

        // Merge proposed groups into uiAliasMap.
        // run_id=-1 = proposed (confident), run_id=-2 = proposed (needs review — yellow)
        setUiAliasMap(prev => {
          const next = structuredClone(prev ?? data);
          const allExisting = new Set(
            Object.values(next).flatMap(g => g.items.map(i => i.literal_value)),
          );
          for (const result of proposeResults) {
            for (const group of (result.groups ?? [])) {
              const alias       = group.alias_name;
              const reviewSet   = new Set(group.review_items ?? []);
              if (!next[alias]) next[alias] = { items: [] };
              for (const lv of group.items) {
                if (!allExisting.has(lv)) {
                  next[alias].items.push({
                    literal_value: lv,
                    run_id:        reviewSet.has(lv) ? -2 : -1,
                    confirmed_at:  '',
                  });
                  allExisting.add(lv);
                }
              }
            }
          }
          return next;
        });
      } catch (e) {
        if (!cancelled()) setLoadError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled()) setLoading(false);
      }
    }

    void init();
    return () => { isCancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── History ───────────────────────────────────────────────────────────────

  function captureSnapshot(): Snapshot | null {
    if (!uiAliasMap) return null;
    return {
      uiAliasMap:      structuredClone(uiAliasMap),
      nextTempGroupId,
    };
  }

  function applySnapshot(snap: Snapshot) {
    setUiAliasMap(snap.uiAliasMap);
    setNextTempGroupId(snap.nextTempGroupId);
    setEditingAliasKey(null);
    setEditingAliasValue('');
    setRenameError(null);
    setOpenMenuForAlias(null);
    setDragOverAliasName(null);
    setDraggingGroupName(null);
  }

  function pushHistory() {
    const snap = captureSnapshot();
    if (!snap) return;
    setUndoStack((prev) => [...prev, snap]);
    setRedoStack([]);
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap    = undoStack[undoStack.length - 1];
    const current = captureSnapshot();
    if (current) setRedoStack((prev) => [...prev, current]);
    setUndoStack((prev) => prev.slice(0, -1));
    applySnapshot(snap);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const snap    = redoStack[redoStack.length - 1];
    const current = captureSnapshot();
    if (current) setUndoStack((prev) => [...prev, current]);
    setRedoStack((prev) => prev.slice(0, -1));
    applySnapshot(snap);
  }

  historyRef.current = { undo, redo };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); historyRef.current.undo(); }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); historyRef.current.redo(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── Rename ────────────────────────────────────────────────────────────────

  function startRename(key: string) {
    setEditingAliasKey(key);
    setEditingAliasValue(key);
    setRenameError(null);
  }

  function cancelRename() {
    setEditingAliasKey(null);
    setEditingAliasValue('');
    setRenameError(null);
  }

  function commitRename(oldKey: string) {
    if (!uiAliasMap) return;
    const newKey = editingAliasValue.trim();
    if (!newKey) { cancelRename(); return; }
    if (newKey === oldKey) { cancelRename(); return; }
    if (newKey === UNGROUPED_KEY) {
      setRenameError('That name is reserved.');
      return;
    }
    if (uiAliasMap[newKey] !== undefined) {
      setRenameError(`"${newKey}" already exists. Choose a different name.`);
      return;
    }
    pushHistory();
    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      next[newKey] = next[oldKey];
      delete next[oldKey];
      return next;
    });
    setEditingAliasKey(null);
    setEditingAliasValue('');
    setRenameError(null);
  }

  // ── Add / Delete group ────────────────────────────────────────────────────

  function addGroup() {
    if (!uiAliasMap) return;
    pushHistory();
    const id  = nextTempGroupId;
    const key = `New group ${Math.abs(id)}`;
    setNextTempGroupId((p) => p - 1);
    setUiAliasMap((prev) => ({ ...prev!, [key]: { items: [] } }));
    // Start rename immediately
    setTimeout(() => startRename(key), 50);
  }

  function deleteGroup(key: string) {
    if (!uiAliasMap) return;
    pushHistory();
    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next   = { ...prev };
      const group  = next[key];
      // Move items to ungrouped (they'll be deleted from DB on export)
      const ungrouped = next[UNGROUPED_KEY] ?? { items: [] };
      next[UNGROUPED_KEY] = { items: [...ungrouped.items, ...(group?.items ?? [])] };
      delete next[key];
      return next;
    });
  }

  // ── Drag helpers ──────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    dragPayloadRef.current = payload;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', payload.type);
    if (payload.type === 'group') setDraggingGroupName(payload.fromAliasName);
  }

  function onDragStartGroup(e: React.DragEvent, aliasName: string) {
    onDragStart(e, { type: 'group', fromAliasName: aliasName });
  }

  function onDragEndGroup() {
    setDraggingGroupName(null);
    setDragOverAliasName(null);
  }

  function onDragOverAlias(e: React.DragEvent, targetAlias: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverAliasName(targetAlias);
  }

  function onDragLeaveAlias(e: React.DragEvent, targetAlias: string) {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    setDragOverAliasName((prev) => (prev === targetAlias ? null : prev));
  }

  function onDropOnAlias(e: React.DragEvent, targetAlias: string) {
    e.preventDefault();
    setDragOverAliasName(null);
    setDraggingGroupName(null);
    const payload = dragPayloadRef.current;
    dragPayloadRef.current = null;
    if (!payload || !uiAliasMap) return;

    if (payload.type === 'item') {
      const { fromAliasName, literal_value } = payload;
      if (fromAliasName === targetAlias) return;
      pushHistory();
      setUiAliasMap((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        const src  = next[fromAliasName];
        if (!src) return next;
        const itemIdx = src.items.findIndex((it) => it.literal_value === literal_value);
        if (itemIdx < 0) return next;
        const [item] = src.items.splice(itemIdx, 1);
        if (!next[targetAlias]) next[targetAlias] = { items: [] };
        next[targetAlias].items.push(item);
        return next;
      });
    } else if (payload.type === 'group') {
      const { fromAliasName } = payload;
      if (fromAliasName === targetAlias) return;
      if (targetAlias === UNGROUPED_KEY) return; // can't merge into ungrouped
      pushHistory();
      setUiAliasMap((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        const src  = next[fromAliasName];
        if (!src) return next;
        if (!next[targetAlias]) next[targetAlias] = { items: [] };
        next[targetAlias].items.push(...src.items);
        delete next[fromAliasName];
        return next;
      });
    }
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const groupEntries = useMemo(() => {
    if (!uiAliasMap) return [];
    return Object.entries(uiAliasMap)
      .filter(([k]) => k !== UNGROUPED_KEY)
      .sort(([a, ga], [b, gb]) => {
        // Groups with items still needing review float to the top.
        const aReview = ga.items.some(i => i.run_id === -2) ? 1 : 0;
        const bReview = gb.items.some(i => i.run_id === -2) ? 1 : 0;
        if (aReview !== bReview) return bReview - aReview;
        return a.localeCompare(b);
      });
  }, [uiAliasMap]);

  // When showing only queue items, filter to groups that contain at least one
  // literal that was in the queue at page load.
  const displayedGroupEntries = useMemo(() => {
    if (!showQueueOnly || originalQueueItems.size === 0) return groupEntries;
    return groupEntries.filter(([, group]) =>
      group.items.some(item => originalQueueItems.has(item.literal_value)),
    );
  }, [groupEntries, showQueueOnly, originalQueueItems]);

  const ungrouped      = uiAliasMap?.[UNGROUPED_KEY];
  const ungroupedCount = ungrouped?.items.length ?? 0;
  const totalGroups    = groupEntries.length;

  // ── Accept (save changes to DB) ──────────────────────────────────────────

  const hasChanges = useMemo(() => {
    if (!aliasMap || !uiAliasMap) return false;
    // Proposed items (run_id=-1 confident, run_id=-2 needs review) are unsaved
    const hasProposed = Object.values(uiAliasMap).some(g => g.items.some(i => i.run_id < 0));
    if (hasProposed) return true;
    const { item_moves, deleted_literals } = computeDelta(aliasMap, uiAliasMap);
    return Object.keys(item_moves).length > 0 || deleted_literals.length > 0;
  }, [aliasMap, uiAliasMap]);

  async function handleAccept() {
    setSaveError(null);
    try {
      // Collect proposed items (run_id=-1) — these come from LLM grouping of queue items
      const new_items: Record<string, string[]> = {};
      for (const [alias, { items }] of Object.entries(uiAliasMap ?? {})) {
        if (alias === UNGROUPED_KEY) continue;
        for (const item of items) {
          if (item.run_id < 0) {
            if (!new_items[alias]) new_items[alias] = [];
            new_items[alias].push(item.literal_value);
          }
        }
      }

      // Collect manual edits to existing (confirmed) mappings
      const { item_moves, deleted_literals } = computeDelta(aliasMap!, uiAliasMap!);

      const hasNewItems = Object.keys(new_items).length > 0;
      const hasDelta    = Object.keys(item_moves).length > 0 || deleted_literals.length > 0;

      if (!hasNewItems && !hasDelta) return;

      // Only prompt domain-change confirm when touching existing mappings.
      // Ask BEFORE setting saving=true so the modal button shows "Apply" not "Applying…".
      if (hasDelta) {
        const confirmed = await askDomainChangeConfirm();
        if (!confirmed) return;
      }

      setSaving(true);
      setSaveProgress(0);

      // Animate progress bar from 0 → 80% while the request is in flight
      if (progressTimer.current) clearInterval(progressTimer.current);
      progressTimer.current = setInterval(() => {
        setSaveProgress(p => p < 80 ? p + 2 : p);
      }, 60);

      const res = await fetch('/api/global-standardizations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          new_items,
          domain_id:               domainId,
          pipeline_ids_to_dequeue: hasNewItems && pipelineIds?.length ? pipelineIds : [],
          item_moves,
          deleted_literals,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to accept');

      // Jump to 100% and navigate after a brief moment so the user sees completion
      if (progressTimer.current) clearInterval(progressTimer.current);
      setSaveProgress(100);
      setAcceptedQueue(true);
      await new Promise(r => setTimeout(r, 400));
      const dest = domainId != null
        ? `/home?tab=standardizations&open_domain_id=${domainId}`
        : '/home?tab=standardizations';
      router.push(dest);
    } catch (e) {
      if (progressTimer.current) clearInterval(progressTimer.current);
      setSaveProgress(0);
      setSaveError(e instanceof Error ? e.message : 'Failed to accept');
    } finally {
      setSaving(false);
    }
  }

  async function saveChanges(): Promise<boolean> {
    if (!aliasMap || !uiAliasMap) return false;
    const { item_moves, deleted_literals } = computeDelta(aliasMap, uiAliasMap);
    const hasDelta = Object.keys(item_moves).length > 0 || deleted_literals.length > 0;
    if (!hasDelta) return true; // nothing to save

    // Editing pre-existing standardizations is domain-wide — confirm before writing.
    const confirmed = await askDomainChangeConfirm();
    if (!confirmed) return false;

    setSaving(true);
    setSaveError(null);
    try {
      const res  = await fetch('/api/global-standardizations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ item_moves, deleted_literals }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to save changes');
      // Refresh the server snapshot so future diffs are correct
      setAliasMap(structuredClone(uiAliasMap));
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save changes');
      return false;
    } finally {
      setSaving(false);
    }
  }

  // ── Export: CSV (client-side) ─────────────────────────────────────────────

  async function doCsvExport() {
    if (!uiAliasMap) return;

    const lines: string[] = ['canonical_name,raw_value'];
    for (const [alias, { items }] of Object.entries(uiAliasMap)) {
      if (alias === UNGROUPED_KEY) continue;
      for (const item of items) {
        const a = alias.includes(',') ? `"${alias.replace(/"/g, '""')}"` : alias;
        const v = item.literal_value.includes(',')
          ? `"${item.literal_value.replace(/"/g, '""')}"`
          : item.literal_value;
        lines.push(`${a},${v}`);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = buildFilename('csv');
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Export: Excel (client-side) ───────────────────────────────────────────

  async function doExcelExport() {
    if (!uiAliasMap) return;

    const XLSX   = await import('xlsx');
    const data: string[][] = [['canonical_name', 'raw_value']];
    for (const [alias, { items }] of Object.entries(uiAliasMap)) {
      if (alias === UNGROUPED_KEY) continue;
      for (const item of items) {
        data.push([alias, item.literal_value]);
      }
    }
    const ws  = XLSX.utils.aoa_to_sheet(data);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Domain Standardizations');
    const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = buildFilename('xlsx');
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Export: Google Sheets ─────────────────────────────────────────────────

  async function doSheetsExport() {
    setSheetsLoading(true);
    setSheetsError(null);
    setSheetsUrl(null);
    try {
      const res  = await fetch('/api/global-standardizations/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ format: 'sheets' }),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.needsAuth) {
        window.location.href = '/api/auth/google';
        return;
      }
      if (!res.ok) throw new Error(body?.error || 'Failed to export to Google Sheets');
      setSheetsUrl(body.url);
      window.open(body.url, '_blank');
    } catch (e) {
      setSheetsError(e instanceof Error ? e.message : 'Failed to export to Google Sheets');
    } finally {
      setSheetsLoading(false);
    }
  }

  // ── Export: Snowflake table ───────────────────────────────────────────────

  async function doSnowflakeExport() {
    setSfExporting(true);
    setSfExportError(null);
    setSfExportResult(null);
    try {
      const res  = await fetch('/api/global-standardizations/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ format: 'snowflake', snowflakeTableFqn: sfTableFqn }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to create Snowflake table');
      setSfExportResult({ table_fqn: body.table_fqn, rows: body.rows });
    } catch (e) {
      setSfExportError(e instanceof Error ? e.message : 'Failed to create Snowflake table');
    } finally {
      setSfExporting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const totalItems = useMemo(() => {
    if (!uiAliasMap) return 0;
    let count = 0;
    for (const [k, { items }] of Object.entries(uiAliasMap)) {
      if (k !== UNGROUPED_KEY) count += items.length;
    }
    return count;
  }, [uiAliasMap]);

  return (
    <div onClick={() => setOpenMenuForAlias(null)}>
      {/* ── Card ──────────────────────────────────────────────────────────── */}
      <div
        className="rounded-card border-[0.5px] p-6"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        {/* ── Card header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Canonical groups
            </h2>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs font-medium"
              style={{ backgroundColor: BLUE.tint, color: BLUE.badgeText }}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: BLUE.accent }} />
              Domain Library
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              <span className="font-medium" style={{ color: BLUE.accent }}>{totalGroups}</span>
              {' groups · '}
              <span className="font-medium" style={{ color: BLUE.accent }}>{totalItems}</span>
              {' values'}
            </span>

            {originalQueueItems.size > 0 && (
              <button
                type="button"
                onClick={() => setShowQueueOnly(v => !v)}
                className="px-3 py-1.5 rounded-button text-xs font-medium border-[0.5px] transition-colors"
                style={showQueueOnly
                  ? { backgroundColor: BLUE.accent, color: 'white', borderColor: BLUE.accent }
                  : { backgroundColor: 'var(--surface)', color: BLUE.accent, borderColor: BLUE.border }
                }
                onMouseEnter={e => { if (!showQueueOnly) (e.currentTarget as HTMLButtonElement).style.backgroundColor = BLUE.tint; }}
                onMouseLeave={e => { if (!showQueueOnly) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
              >
                {showQueueOnly ? 'Show all' : `Proposed (${originalQueueItems.size > 99 ? '99+' : originalQueueItems.size})`}
              </button>
            )}

            <UndoButton onUndo={() => historyRef.current.undo()} disabled={saving || undoStack.length === 0} />

            {/* Accept — writes queue + edits to the lookup table */}
            <button
              type="button"
              onClick={() => void handleAccept()}
              disabled={loading || !!loadError || saving || !hasChanges}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-button text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                backgroundColor: acceptSuccess ? '#16a34a' : BLUE.accent,
                color: 'white',
              }}
              onMouseEnter={(e) => { if (!saving && hasChanges) (e.currentTarget as HTMLButtonElement).style.backgroundColor = acceptSuccess ? '#15803d' : BLUE.strong; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = acceptSuccess ? '#16a34a' : BLUE.accent; }}
            >
              {saving ? (
                <><Spinner className="w-3.5 h-3.5" /> Saving…</>
              ) : acceptSuccess ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Accepted
                </>
              ) : (
                'Accept'
              )}
            </button>

            {/* Export */}
            <button
              type="button"
              onClick={() => {
                setSaveError(null);
                setSfExportResult(null);
                setSfExportError(null);
                setSheetsUrl(null);
                setSheetsError(null);
                setExportModalOpen(true);
              }}
              disabled={loading || !!loadError}
              className="px-4 py-1.5 rounded-button text-sm font-medium border-[0.5px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--surface)', color: BLUE.accent, borderColor: BLUE.border }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = BLUE.tint; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
            >
              Export
            </button>
          </div>
        </div>

        {/* Progress bar — shown while applying standardizations */}
        {saving && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Applying standardizations…</span>
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>{saveProgress}%</span>
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ height: 6, backgroundColor: 'var(--accent-tint)', border: '0.5px solid var(--accent-border)' }}>
              <div
                style={{
                  height: '100%',
                  width: `${saveProgress}%`,
                  backgroundColor: 'var(--accent)',
                  borderRadius: 9999,
                  transition: saveProgress === 100 ? 'width 0.2s ease-out' : 'width 0.06s linear',
                }}
              />
            </div>
          </div>
        )}

        {/* Domain-wide scope notice */}
        <DomainScopeNotice style={{ marginBottom: 16 }} />

        <DomainChangeConfirmModal
          open={confirmOpen}
          busy={saving}
          confirmLabel="Apply to all tables"
          body="You're editing this domain's standardizations. Saving writes to the shared lookup, so every table with a pipeline in this domain will standardize using these mappings too."
          onCancel={() => resolveDomainChangeConfirm(false)}
          onConfirm={() => resolveDomainChangeConfirm(true)}
        />

        {/* Save error banner */}
        {saveError && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            {saveError}
          </div>
        )}

        {/* Rename error banner */}
        {renameError && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm"
            style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}
          >
            {renameError}
          </div>
        )}

        {/* Review notice — shown when any proposed items need human sign-off */}
        {!loading && !loadError && (() => {
          const reviewCount = Object.values(uiAliasMap ?? {})
            .flatMap(g => g.items)
            .filter(i => i.run_id === -2).length;
          if (reviewCount === 0) return null;
          return (
            <div
              className="flex items-start gap-2.5 rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm"
              style={{ backgroundColor: '#FEFCE8', borderColor: '#FDE68A', color: '#78350F' }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5" aria-hidden="true">
                <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="#D97706" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M8 6v3.5" stroke="#D97706" strokeWidth="1.3" strokeLinecap="round" />
                <circle cx="8" cy="11.5" r="0.7" fill="#D97706" />
              </svg>
              <span>
                <strong className="font-semibold">{reviewCount} value{reviewCount !== 1 ? 's' : ''} need your review</strong>
                {' — '}highlighted in yellow at the top. The AI wasn&apos;t confident about these groupings.
                Drag them into the correct group or rename them before accepting.
              </span>
            </div>
          );
        })()}

        {/* ── Loading / error / content ──────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center gap-2 py-4" style={{ color: 'var(--text-muted)' }}>
            <Spinner className="w-4 h-4" />
            <span className="text-sm italic">{loadingMessage}</span>
          </div>
        ) : loadError ? (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            {loadError}
          </div>
        ) : (
          <>
            {/* ── Column headers ──────────────────────────────────────────── */}
            <div
              className="grid items-center mb-1 pb-2 border-b-[0.5px]"
              style={{ gridTemplateColumns: '36px 180px 1fr 32px', borderColor: 'var(--border-subtle)' }}
            >
              <div />
              <div className="px-3 text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
                Canonical name
              </div>
              <div className="px-2 text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-hint)' }}>
                Raw values
              </div>
              <div />
            </div>

            {/* ── Group rows ──────────────────────────────────────────────── */}
            <div>
              {displayedGroupEntries.length === 0 && (
                <p className="text-sm italic py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                  {showQueueOnly
                    ? 'No groupings found for the new values.'
                    : 'No domain standardizations yet. Accept a run to populate them.'}
                </p>
              )}

              {displayedGroupEntries.map(([aliasName, group], idx) => {
                const isGroupDragOver =
                  dragOverAliasName === aliasName &&
                  draggingGroupName !== null &&
                  draggingGroupName !== aliasName;
                const isItemDragOver = dragOverAliasName === aliasName && draggingGroupName === null;
                const isDragOver     = isGroupDragOver || isItemDragOver;
                const isBeingDragged = draggingGroupName === aliasName;

                return (
                  <div key={aliasName}>
                    {idx > 0 && (
                      <div className="mx-3 border-t-[0.5px]" style={{ borderColor: 'var(--border-subtle)' }} />
                    )}
                    <div
                      className="grid items-start py-[13px] rounded-row transition-colors"
                      style={{
                        gridTemplateColumns: '36px 180px 1fr 32px',
                        opacity: isBeingDragged ? 0.4 : 1,
                        ...(isDragOver
                          ? { backgroundColor: BLUE.tint, borderLeft: `2px solid ${BLUE.accent}`, paddingLeft: 10 }
                          : {}),
                      }}
                      onMouseEnter={(e) => {
                        if (!isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--surface-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = '';
                      }}
                      onDragOver={(e) => onDragOverAlias(e, aliasName)}
                      onDrop={(e) => onDropOnAlias(e, aliasName)}
                      onDragLeave={(e) => onDragLeaveAlias(e, aliasName)}
                    >
                      {/* Col 1: Drag handle */}
                      <div className="flex justify-center pt-1.5">
                        {editingAliasKey !== aliasName && (
                          <span
                            draggable
                            onDragStart={(e) => onDragStartGroup(e, aliasName)}
                            onDragEnd={onDragEndGroup}
                            className="cursor-grab p-1 flex items-center justify-center"
                            title="Drag to reorder or merge"
                          >
                            <DragDots />
                          </span>
                        )}
                      </div>

                      {/* Col 3: Canonical name */}
                      <div
                        className="px-3 text-sm"
                        onDoubleClick={() => startRename(aliasName)}
                        title={editingAliasKey !== aliasName ? 'Double-click to rename' : undefined}
                      >
                        {isGroupDragOver ? (
                          <span className="text-xs font-medium" style={{ color: BLUE.strong }}>
                            Merge into &ldquo;{aliasName}&rdquo;
                          </span>
                        ) : editingAliasKey === aliasName ? (
                          <input
                            autoFocus
                            value={editingAliasValue}
                            onChange={(e) => setEditingAliasValue(e.target.value)}
                            onBlur={() => commitRename(aliasName)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(aliasName);
                              if (e.key === 'Escape') cancelRename();
                            }}
                            className="w-full px-2 py-1 text-sm rounded-[6px] border-[0.5px] outline-none"
                            style={{
                              borderColor:     BLUE.accent,
                              backgroundColor: 'var(--surface)',
                              color:           'var(--text-primary)',
                            }}
                          />
                        ) : (
                          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {aliasName}
                          </span>
                        )}
                      </div>

                      {/* Col 4: Raw values */}
                      <div className="px-2">
                        {group.items.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {group.items.map((item, itemIdx) => {
                              const needsReview = item.run_id === -2;
                              const isProposed  = item.run_id === -1;
                              return (
                              <span
                                key={`${aliasName}:${itemIdx}:${item.literal_value}`}
                                draggable
                                onDragStart={(e) =>
                                  onDragStart(e, {
                                    type: 'item',
                                    fromAliasName: aliasName,
                                    literal_value: item.literal_value,
                                  })
                                }
                                className="inline-flex items-center px-2.5 py-1 rounded-pill cursor-move text-xs"
                                title={needsReview ? 'Needs review — AI wasn\'t confident. Drag to correct group or accept as-is.' : isProposed ? 'Proposed — click Accept to confirm' : undefined}
                                style={needsReview
                                  ? { backgroundColor: '#FEF9C3', border: '0.5px solid #FDE047', color: '#713F12' }
                                  : isProposed
                                  ? { backgroundColor: '#FFFBEB', border: '0.5px solid #FDE68A', color: '#92400E' }
                                  : { backgroundColor: 'var(--border-subtle)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)' }
                                }
                              >
                                {item.literal_value}
                              </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs italic" style={{ color: 'var(--text-hint)' }}>
                            No values yet
                          </span>
                        )}
                      </div>

                      {/* Col 5: More menu */}
                      <div className="relative flex justify-center pt-0.5">
                        {editingAliasKey !== aliasName && (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuForAlias((prev) => prev === aliasName ? null : aliasName);
                              }}
                              className="w-7 h-7 rounded-[6px] border-[0.5px] flex items-center justify-center text-sm transition-colors"
                              style={{
                                borderColor:     'var(--border)',
                                backgroundColor: 'var(--surface)',
                                color:           'var(--text-hint)',
                              }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                              title="Group actions"
                            >
                              ···
                            </button>

                            {openMenuForAlias === aliasName && (
                              <div
                                className="absolute right-0 top-8 w-32 rounded-button border-[0.5px] z-10 overflow-hidden"
                                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => { startRename(aliasName); setOpenMenuForAlias(null); }}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { deleteGroup(aliasName); setOpenMenuForAlias(null); }}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{ color: 'var(--confidence-low)' }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEF2F2'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}
                                >
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

            {/* ── Add group button ─────────────────────────────────────────── */}
            {!loading && !loadError && (
              <button
                type="button"
                onClick={addGroup}
                className="mt-3 flex items-center gap-1.5 text-sm transition-colors px-2 py-1 rounded-button"
                style={{ color: BLUE.accent }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = BLUE.tint; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Add a group
              </button>
            )}

          </>
        )}
      </div>

      {/* ── Export modal ──────────────────────────────────────────────────── */}
      {exportModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
          onClick={() => setExportModalOpen(false)}
        >
          <div
            className="rounded-card border-[0.5px] w-[420px] max-h-[90vh] overflow-y-auto"
            style={{
              backgroundColor: 'var(--surface)',
              borderColor:     'var(--border)',
              padding:         'var(--card-padding)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Export Domain Standardizations
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>
                  Changes are saved to the database before export.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setExportModalOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Save error */}
            {saveError && (
              <div
                className="rounded-button border-[0.5px] px-3 py-2.5 mb-4 text-sm"
                style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
              >
                {saveError}
              </div>
            )}

            {/* Unsaved changes notice */}
            {hasChanges && (
              <div
                className="rounded-button border-[0.5px] px-3 py-2.5 mb-4 text-sm"
                style={{ backgroundColor: BLUE.tint, borderColor: BLUE.border, color: BLUE.badgeText }}
              >
                You have unsaved changes. Click <strong>Accept</strong> first to include them in server-side exports (Sheets, Snowflake).
              </div>
            )}

<div className="flex flex-col gap-0.5">
              {/* Excel */}
              <button
                type="button"
                onClick={() => void doExcelExport()}
                disabled={saving}
                className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full disabled:opacity-50"
                onMouseEnter={(e) => { if (!saving) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: BLUE.tint, color: BLUE.accent }}>
                  {saving ? <Spinner className="w-4 h-4" /> : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M5.5 9l1.5 2 1.5-2M5.5 11l1.5-2 1.5 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Download as Excel</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>.xlsx file · saves changes first</p>
                </div>
              </button>

              {/* CSV */}
              <button
                type="button"
                onClick={() => void doCsvExport()}
                disabled={saving}
                className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full disabled:opacity-50"
                onMouseEnter={(e) => { if (!saving) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: BLUE.tint, color: BLUE.accent }}>
                  {saving ? <Spinner className="w-4 h-4" /> : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M5 9.5h6M5 11.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Download as CSV</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>.csv file · saves changes first</p>
                </div>
              </button>

              {/* Divider */}
              <div className="my-1" style={{ height: '0.5px', backgroundColor: 'var(--border-subtle)' }} />

              {/* Google Sheets */}
              <button
                type="button"
                onClick={() => void doSheetsExport()}
                disabled={sheetsLoading || saving}
                className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full disabled:opacity-60 disabled:cursor-not-allowed"
                onMouseEnter={(e) => { if (!sheetsLoading && !saving) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#E8F5E9' }}>
                  {sheetsLoading ? (
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="#1E8E3E" strokeWidth="3" />
                      <path className="opacity-75" fill="#1E8E3E" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="2.5" y="1" width="9" height="11.5" rx="1" fill="#1E8E3E" />
                      <path d="M8.5 1v3.5H12L8.5 1z" fill="#0D652D" />
                      <rect x="2.5" y="6" width="9" height="6.5" fill="#34A853" />
                      <path d="M4.5 8h5M4.5 9.5h5M4.5 11h3" stroke="white" strokeWidth="0.8" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {sheetsLoading ? 'Exporting to Google Sheets…' : 'Export to Google Sheets'}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>
                    {sheetsUrl ? 'Opened in new tab ↗' : 'Creates a new spreadsheet'}
                  </p>
                </div>
              </button>

              {sheetsUrl && !sheetsLoading && (
                <a
                  href={sheetsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 mx-1 mt-0.5 px-3 py-2 rounded-button text-xs font-medium"
                  style={{ backgroundColor: '#E8F5E9', color: '#1E8E3E', border: '0.5px solid #A8D5B5' }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 10l8-8M10 2H4M10 2v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Open Google Sheet
                </a>
              )}

              {sheetsError && !sheetsLoading && (
                <p className="mx-1 mt-0.5 px-3 py-2 rounded-button text-xs" style={{ backgroundColor: '#FEF2F2', color: 'var(--confidence-low)', border: '0.5px solid #FECACA' }}>
                  {sheetsError}
                </p>
              )}

              {/* Divider */}
              <div className="my-1" style={{ height: '0.5px', backgroundColor: 'var(--border-subtle)' }} />

              {/* Snowflake table */}
              <div className="px-3 pt-2.5 pb-2">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#E0F2FE', color: '#0369A1' }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M8 3v10M3 8h10M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Export to Snowflake table</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>Creates or replaces a table</p>
                  </div>
                </div>
                <input
                  value={sfTableFqn}
                  onChange={(e) => setSfTableFqn(e.target.value)}
                  placeholder="DATABASE.SCHEMA.TABLE_NAME"
                  className="w-full px-3 py-2 rounded-button border-[0.5px] text-xs font-mono outline-none mb-2"
                  style={{
                    borderColor:     'var(--border)',
                    backgroundColor: 'var(--surface)',
                    color:           'var(--text-primary)',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = BLUE.accent; }}
                  onBlur={(e) =>  { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
                {sfExportResult && (
                  <div className="rounded-button border-[0.5px] px-3 py-2 mb-2 text-xs" style={{ backgroundColor: '#ECFDF5', borderColor: '#A7F3D0', color: 'var(--confidence-high)' }}>
                    Created <code className="font-mono">{sfExportResult.table_fqn}</code> with {sfExportResult.rows.toLocaleString()} rows.
                  </div>
                )}
                {sfExportError && (
                  <div className="rounded-button border-[0.5px] px-3 py-2 mb-2 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                    {sfExportError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void doSnowflakeExport()}
                  disabled={sfExporting || saving || !sfTableFqn.trim()}
                  className="w-full py-2 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: '#0369A1' }}
                  onMouseEnter={(e) => { if (!sfExporting && !saving) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#075985'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0369A1'; }}
                >
                  {sfExporting ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <Spinner />
                      Creating table…
                    </span>
                  ) : (
                    'Create Snowflake table'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
