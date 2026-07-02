'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DomainScopeNotice, DomainChangeConfirmModal, UndoButton } from '@/app/components/DomainChangeWarning';

const UNGROUPED_KEY = '__UNGROUPED__';

// ── Multi-column standardization wizard ────────────────────────────────────────
// When a pipeline is created with more than one column, AutoExportHome seeds this
// in sessionStorage so the run page walks the user through each column's
// standardization in order (stepper + back/continue) rather than leaving the
// remaining columns as pending_baseline.
const COL_WIZARD_KEY = 'prism_ae_col_wizard';
interface ColWizard {
  kind?: 'create' | 'standardize'; // create → review run from full source; standardize → from the queue (manual mode)
  pids: number[];            // pipeline_id per column, in order
  cols: string[];            // column name per column (stepper labels)
  runs: (number | null)[];   // review run_id per column once created (null = not yet)
}

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    display_name: string;
    items: Array<{
      run_item_id: number;
      literal_value: string;
      confidence_score: number | null;
      needs_review?: boolean;
    }>;
  }
>;

type DragPayload =
  | { type: 'item'; fromAliasName: string; run_item_id: number; literal_value: string }
  | { type: 'group'; fromAliasName: string };

type Snapshot = {
  uiAliasMap: AliasMap;
  pendingMoves: Record<number, number | null>;
  pendingAliasNames: Record<number, string>;
  checkedAliases: Set<string>;
  nextTempGroupId: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatConfidence(score: number) {
  if (!Number.isFinite(score)) return '';
  if (score >= 0 && score <= 1) return `${Math.round(score * 100)}%`;
  return String(score);
}

function confidenceColorClass(score: number): string {
  if (score >= 0.9) return 'text-confidence-high';
  if (score >= 0.7) return 'text-confidence-med';
  return 'text-confidence-low';
}

function getStatusLabel(status: string | undefined): string {
  if (!status) return 'In review';
  switch (status.toLowerCase()) {
    case 'completed': return 'Completed';
    case 'created':   return 'Created';
    default:          return 'In review';
  }
}

function CheckmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 7L5.5 10L11.5 4"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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

// ── Include-original-column toggle ────────────────────────────────────────────

function IncludeOriginalToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none" onClick={() => onChange(!value)}>
      <div
        className="relative flex-shrink-0"
        style={{ width: 36, height: 20 }}
      >
        <div
          className="absolute inset-0 rounded-full transition-colors"
          style={{ backgroundColor: value ? 'var(--accent)' : 'var(--border)' }}
        />
        <div
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
          style={{ transform: value ? 'translateX(18px)' : 'translateX(2px)' }}
        />
      </div>
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Include original column
      </span>
    </label>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RunReviewClient({
  runId,
  initialRunStatus,
}: {
  runId: string;
  initialRunStatus?: string;
}) {
  const router = useRouter();
  const isAutoExport = process.env.NEXT_PUBLIC_APP_MODE === 'premium';

  const [aliasMap, setAliasMap] = useState<AliasMap | null>(null);
  const [uiAliasMap, setUiAliasMap] = useState<AliasMap | null>(null);
  const [aliasMapError, setAliasMapError] = useState<string | null>(null);
  const [loadingAliasMap, setLoadingAliasMap] = useState(true);

  const [checkedAliases, setCheckedAliases] = useState<Set<string>>(new Set());
  const [nextTempGroupId, setNextTempGroupId] = useState(-1);
  const [pendingMoves, setPendingMoves] = useState<Record<number, number | null>>({});
  const [pendingAliasNames, setPendingAliasNames] = useState<Record<number, string>>({});
  const [editingAliasKey, setEditingAliasKey] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<any>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  // ── Column wizard (multi-column pipeline creation) ──────────────────────────
  const [wizard, setWizard] = useState<ColWizard | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(COL_WIZARD_KEY);
      if (!raw) { setWizard(null); return; }
      const w = JSON.parse(raw) as ColWizard;
      // Only keep the wizard if this run actually belongs to it.
      if (Array.isArray(w?.runs) && w.runs.includes(Number(runId))) setWizard(w);
      else setWizard(null);
    } catch { setWizard(null); }
  }, [runId]);

  const colIndex   = wizard ? wizard.runs.indexOf(Number(runId)) : -1;
  const inWizard   = wizard != null && wizard.pids.length > 1 && colIndex >= 0;
  const isLastCol  = inWizard && colIndex === wizard!.pids.length - 1;

  // Prefetch the NEXT column's review run in the background while the user reviews
  // THIS one, so "Accept & continue" reuses it (advanceWizardForward checks
  // runs[next]) and navigates instantly instead of building it on click.
  const prefetchedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!inWizard || colIndex < 0) return;
    const next = colIndex + 1;
    if (next >= wizard!.pids.length) return;          // last column — nothing ahead
    if (wizard!.runs[next] != null) return;           // already built
    const nextPid = wizard!.pids[next];
    if (prefetchedRef.current.has(nextPid)) return;   // already attempted this column
    prefetchedRef.current.add(nextPid);

    const route = wizard!.kind === 'standardize'
      ? `/api/pipelines/${nextPid}/standardize-run`
      : `/api/pipelines/${nextPid}/create-initial-run`;
    let cancelled = false;
    // Small delay so the CURRENT column's page (its alias-mapping fetch) gets
    // priority; the user spends far longer reviewing than this head start costs.
    const timer = setTimeout(async () => {
      try {
        const res  = await fetch(route, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (cancelled || !res.ok || !body?.run_id) return;  // empty/all-null column → built on demand at accept
        const builtRunId = Number(body.run_id);
        setWizard(prev => {
          if (!prev) return prev;
          const runs = [...prev.runs];
          runs[next] = builtRunId;
          const updated = { ...prev, runs };
          try { sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
          return updated;
        });
      } catch { /* best-effort — advanceWizardForward will build it on demand */ }
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [inWizard, colIndex, wizard]);


  const [sfExportModalOpen, setSfExportModalOpen] = useState(false);
  const [includeOriginalCol, setIncludeOriginalCol] = useState(true);
  const [dragOverAliasName, setDragOverAliasName] = useState<string | null>(null);
  const [draggingGroupName, setDraggingGroupName] = useState<string | null>(null);
  const [openMenuForAliasName, setOpenMenuForAliasName] = useState<string | null>(null);

  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [confirmAcceptOpen, setConfirmAcceptOpen] = useState(false);
  const historyHandlersRef = useRef<{ undo: () => void; redo: () => void }>({
    undo: () => {},
    redo: () => {},
  });

  // Wall-clock timer: from the Accept click to the next page navigating away.
  // Reported to /api/timing (server-side log) via sendBeacon, which survives the
  // navigation. Temporary profiling aid.
  const acceptStartRef = useRef<number | null>(null);
  function reportAcceptNav() {
    const t0 = acceptStartRef.current;
    if (t0 == null) return;
    acceptStartRef.current = null;
    const ms = Date.now() - t0;
    try {
      const blob = new Blob([JSON.stringify({ label: 'accept.click_to_next_page', ms })], { type: 'application/json' });
      navigator.sendBeacon('/api/timing', blob);
    } catch { /* ignore */ }
  }

  // ── Download Mapping modal ────────────────────────────────────────────
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadLoading,   setDownloadLoading]   = useState(false);
  // rows uses dynamic keys — works for both the 2-col mapping and the full pasted table
  const [downloadRows,      setDownloadRows]       = useState<Record<string, string>[] | null>(null);
  const [downloadHeaders,   setDownloadHeaders]    = useState<string[]>([]);
  const [downloadTitle,        setDownloadTitle]        = useState<string | null>(null);
  const [downloadSourceColumn, setDownloadSourceColumn] = useState<string>('');
  const [downloadError,        setDownloadError]        = useState<string | null>(null);

  // ── Google Sheets export ──────────────────────────────────────────────
  const [googleSheetsLoading, setGoogleSheetsLoading] = useState(false);
  const [googleSheetsError,   setGoogleSheetsError]   = useState<string | null>(null);
  const [googleSheetsUrl,     setGoogleSheetsUrl]     = useState<string | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    // Reset export state — when the column wizard navigates between runs the
    // component stays mounted, so stale `exporting`/error flags must be cleared.
    setExporting(false);
    setExportResult(null);
    setExportError(null);

    async function loadAliasMapping() {
      setLoadingAliasMap(true);
      setAliasMapError(null);

      try {
        const res = await fetch(`/api/run/${runId}/alias-mapping`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(body?.error || 'Failed to load alias mapping');

        if (!cancelled) {
          const data = (body?.data || {}) as AliasMap;
          setAliasMap(data);
          setUiAliasMap(structuredClone(data));
          setPendingMoves({});
          setPendingAliasNames({});
          setCheckedAliases(new Set());
          setEditingAliasKey(null);
          setUndoStack([]);
          setRedoStack([]);
          setRenameError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setAliasMap(null);
          setUiAliasMap(null);
          setAliasMapError(e instanceof Error ? e.message : 'Failed to load alias mapping');
        }
      } finally {
        if (!cancelled) setLoadingAliasMap(false);
      }
    }

    loadAliasMapping();
    return () => { cancelled = true; };
  }, [runId]);

  // ── History ───────────────────────────────────────────────────────────────

  function captureSnapshot(): Snapshot | null {
    if (!uiAliasMap) return null;
    return {
      uiAliasMap: structuredClone(uiAliasMap),
      pendingMoves: { ...pendingMoves },
      pendingAliasNames: { ...pendingAliasNames },
      checkedAliases: new Set(checkedAliases),
      nextTempGroupId,
    };
  }

  function applySnapshot(snap: Snapshot) {
    setUiAliasMap(snap.uiAliasMap);
    setPendingMoves(snap.pendingMoves);
    setPendingAliasNames(snap.pendingAliasNames);
    setCheckedAliases(snap.checkedAliases);
    setNextTempGroupId(snap.nextTempGroupId);
    setEditingAliasKey(null);
    setEditingAliasValue('');
    setRenameError(null);
    setOpenMenuForAliasName(null);
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
    const snap = undoStack[undoStack.length - 1];
    const current = captureSnapshot();
    if (current) setRedoStack((prev) => [...prev, current]);
    setUndoStack((prev) => prev.slice(0, -1));
    applySnapshot(snap);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const snap = redoStack[redoStack.length - 1];
    const current = captureSnapshot();
    if (current) setUndoStack((prev) => [...prev, current]);
    setRedoStack((prev) => prev.slice(0, -1));
    applySnapshot(snap);
  }

  historyHandlersRef.current = { undo, redo };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        historyHandlersRef.current.undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        historyHandlersRef.current.redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────


  // ── Computed ──────────────────────────────────────────────────────────────

  const entries = useMemo(() => {
    const e = Object.entries(uiAliasMap || {}) as Array<[string, AliasMap[string]]>;
    e.sort((a, b) => {
      // Groups that still need review float to the very top of the list.
      const aReview = a[1]?.items?.some(i => i.needs_review) ? 1 : 0;
      const bReview = b[1]?.items?.some(i => i.needs_review) ? 1 : 0;
      if (aReview !== bReview) return bReview - aReview;

      const ag = a[1]?.group_id;
      const bg = b[1]?.group_id;
      if (ag == null && bg == null) return 0;
      if (ag == null) return 1;
      if (bg == null) return -1;
      if (ag < 0 && bg >= 0) return 1;
      if (bg < 0 && ag >= 0) return -1;
      return ag - bg;
    });
    return e;
  }, [uiAliasMap]);

  const groupEntries = useMemo(
    () => entries.filter(([aliasName]) => aliasName !== UNGROUPED_KEY),
    [entries]
  );

  const initialItemMeta = useMemo(() => {
    const meta = new Map<number, { initial_group_id: number | null; confidence_score: number | null }>();
    for (const [, group] of Object.entries(aliasMap || {})) {
      const gid = group?.group_id ?? null;
      for (const it of group?.items || []) {
        meta.set(it.run_item_id, { initial_group_id: gid, confidence_score: it.confidence_score ?? null });
      }
    }
    return meta;
  }, [aliasMap]);

  const totalGroups = groupEntries.length;
  const uncheckedCount = totalGroups - checkedAliases.size;
  const reviewItems = useMemo(() =>
    Object.values(uiAliasMap ?? {}).flatMap(g => g.items).filter(i => i.needs_review),
  [uiAliasMap]);
  const reviewCount = reviewItems.length;

  // ── Group mutations ───────────────────────────────────────────────────────

  function toggle(aliasName: string) {
    if (aliasName === UNGROUPED_KEY) return;
    setCheckedAliases((prev) => {
      const next = new Set(prev);
      if (next.has(aliasName)) next.delete(aliasName);
      else next.add(aliasName);
      return next;
    });
  }

  function checkAll() {
    setCheckedAliases(new Set(groupEntries.map(([aliasName]) => aliasName)));
  }

  function makeUniqueGroupName(base: string, excludeKey?: string) {
    const map = uiAliasMap || {};
    if (!map[base] || base === excludeKey) return base;
    let i = 2;
    while (map[`${base} (${i})`] && `${base} (${i})` !== excludeKey) i += 1;
    return `${base} (${i})`;
  }

  function addGroup() {
    pushHistory();
    const name = makeUniqueGroupName('Unnamed Group');
    const gid = nextTempGroupId;
    setNextTempGroupId((v) => v - 1);
    setUiAliasMap((prev) => {
      const next: AliasMap = structuredClone(prev || ({} as any));
      next[name] = { group_id: gid, display_name: name, items: [] };
      return next;
    });
    setRenameError(null);
    setEditingAliasKey(name);
    setEditingAliasValue('');
  }

  function onDragStart(e: React.DragEvent, payload: Extract<DragPayload, { type: 'item' }>) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
  }

  function onDragStartGroup(e: React.DragEvent, fromAliasName: string) {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'group', fromAliasName } satisfies DragPayload));
    setDraggingGroupName(fromAliasName);
  }

  function onDragEndGroup() {
    setDraggingGroupName(null);
  }

  function mergeGroups(fromAliasName: string, toAliasName: string) {
    if (fromAliasName === toAliasName) return;
    const fromGroup = uiAliasMap?.[fromAliasName];
    const toGroup = uiAliasMap?.[toAliasName];
    if (!fromGroup || !toGroup) return;

    const toGroupId = toGroup.group_id;
    setPendingMoves((prev) => {
      const next = { ...prev };
      for (const it of fromGroup.items || []) next[it.run_item_id] = toGroupId;
      return next;
    });

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      const from = next[fromAliasName];
      const to = next[toAliasName];
      if (!from || !to) return prev;
      const existingIds = new Set((to.items || []).map((it) => it.run_item_id));
      to.items = [...(to.items || []), ...(from.items || []).filter((it) => !existingIds.has(it.run_item_id))];
      delete next[fromAliasName];
      return next;
    });

    if (typeof fromGroup.group_id === 'number') {
      setPendingAliasNames((prev) => {
        const next = { ...prev };
        delete next[fromGroup.group_id as number];
        return next;
      });
    }

    setCheckedAliases((prev) => {
      const next = new Set(prev);
      next.delete(fromAliasName);
      return next;
    });

    if (editingAliasKey === fromAliasName) cancelRename();
    if (dragOverAliasName === fromAliasName) setDragOverAliasName(null);
    if (openMenuForAliasName === fromAliasName) setOpenMenuForAliasName(null);
    setDraggingGroupName(null);
  }

  function onDropOnAlias(e: React.DragEvent, toAliasName: string) {
    e.preventDefault();
    setDragOverAliasName(null);
    setDraggingGroupName(null);

    let payload: DragPayload | null = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')); }
    catch { payload = null; }
    if (!payload) return;

    pushHistory();

    if (payload.type === 'group') {
      const { fromAliasName } = payload;
      if (fromAliasName === toAliasName || toAliasName === UNGROUPED_KEY) return;
      mergeGroups(fromAliasName, toAliasName);
      return;
    }

    const { fromAliasName, run_item_id, literal_value } = payload;
    if (fromAliasName === toAliasName) return;

    setPendingMoves((prev) => {
      const toGroupId = uiAliasMap?.[toAliasName]?.group_id;
      if (typeof toGroupId !== 'number' && toGroupId !== null) return prev;
      return { ...prev, [run_item_id]: toGroupId };
    });

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      const from = next[fromAliasName];
      if (!from) return prev;
      let to = next[toAliasName];
      if (!to) {
        if (toAliasName === UNGROUPED_KEY) {
          to = { group_id: null, display_name: '', items: [] };
          next[toAliasName] = to;
        } else {
          return prev;
        }
      }
      const dragged = (from.items || []).find((it) => it.run_item_id === run_item_id);
      from.items = (from.items || []).filter((it) => it.run_item_id !== run_item_id);
      to.items = [...(to.items || []), { run_item_id, literal_value, confidence_score: dragged?.confidence_score ?? null }];
      return next;
    });
  }

  function startRename(aliasName: string) {
    setRenameError(null);
    setEditingAliasKey(aliasName);
    setEditingAliasValue(uiAliasMap?.[aliasName]?.display_name ?? aliasName);
  }

  function cancelRename() {
    setRenameError(null);
    setEditingAliasKey(null);
    setEditingAliasValue('');
  }

  function commitRename(oldAliasName: string) {
    const desired = editingAliasValue.trim();
    let newAliasName = desired || 'Unnamed Group';
    const currentDisplayName = uiAliasMap?.[oldAliasName]?.display_name ?? oldAliasName;
    if (newAliasName === currentDisplayName) { cancelRename(); return; }
    pushHistory();

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      if (prev[newAliasName] && newAliasName !== oldAliasName) {
        newAliasName = makeUniqueGroupName(newAliasName, oldAliasName);
      }
      const group = prev[oldAliasName];
      if (!group) { cancelRename(); return prev; }

      const next: AliasMap = structuredClone(prev);
      delete next[oldAliasName];
      next[newAliasName] = { ...group, display_name: newAliasName };

      const gid = group.group_id;
      if (typeof gid === 'number') {
        setPendingAliasNames((p) => ({ ...p, [gid]: newAliasName }));
      }
      setCheckedAliases((p) => {
        const s = new Set(p);
        if (s.has(oldAliasName)) { s.delete(oldAliasName); s.add(newAliasName); }
        return s;
      });

      cancelRename();
      return next;
    });
  }

  function onDragOverAlias(e: React.DragEvent, toAliasName: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverAliasName !== toAliasName) setDragOverAliasName(toAliasName);
  }

  function onDragLeaveAlias(e: React.DragEvent, toAliasName: string) {
    if (dragOverAliasName === toAliasName) setDragOverAliasName(null);
  }

  function deleteGroup(aliasName: string) {
    if (aliasName === UNGROUPED_KEY) return;
    const group = uiAliasMap?.[aliasName];
    if (!group) return;
    pushHistory();

    const itemsToMove = (group.items || []).map((it) => ({
      run_item_id: it.run_item_id,
      literal_value: String(it.literal_value),
      confidence_score: it.confidence_score ?? null,
    }));

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      delete next[aliasName];
      // Create a singleton review group for each displaced item
      for (const it of itemsToMove) {
        const key = `__review_${it.run_item_id}__`;
        next[key] = {
          group_id:     null,
          display_name: String(it.literal_value),
          items: [{ ...it, needs_review: true }],
        };
      }
      return next;
    });

    setPendingMoves((prev) => {
      const next = { ...prev };
      for (const it of itemsToMove) next[it.run_item_id] = null;
      return next;
    });

    const gid = group.group_id;
    if (typeof gid === 'number') {
      setPendingAliasNames((prev) => { const next = { ...prev }; delete next[gid]; return next; });
    }

    setCheckedAliases((prev) => { const next = new Set(prev); next.delete(aliasName); return next; });
    if (editingAliasKey === aliasName) cancelRename();
    if (dragOverAliasName === aliasName) setDragOverAliasName(null);
    if (openMenuForAliasName === aliasName) setOpenMenuForAliasName(null);
  }

  async function doExport() {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    setCopiedSql(false);

    try {
      const res = await fetch(`/api/run/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_groups: Object.entries(uiAliasMap || {})
            .filter(([aliasName]) => aliasName !== UNGROUPED_KEY)
            .filter(([, g]) => typeof g?.group_id === 'number' && g.group_id < 0)
            .map(([alias_name_literal_value, g]) => ({ temp_group_id: g.group_id, alias_name_literal_value })),
          moves: Object.entries(pendingMoves).map(([run_item_id, group_id]) => ({
            run_item_id: Number(run_item_id), group_id,
          })),
          alias_name_changes: Object.entries(pendingAliasNames).map(([group_id, alias_name_literal_value]) => ({
            group_id: Number(group_id), alias_name_literal_value,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Export failed');

      setExportResult(body?.data || null);
      setPendingMoves({});
      setPendingAliasNames({});

      const refreshed = await fetch(`/api/run/${runId}/alias-mapping`, { cache: 'no-store' });
      const refreshedBody = await refreshed.json().catch(() => ({}));
      if (refreshed.ok) {
        const data = (refreshedBody?.data || {}) as AliasMap;
        setAliasMap(data);
        setUiAliasMap(structuredClone(data));
        setUndoStack([]);
        setRedoStack([]);
      }
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  // Accepting writes to the domain-wide lookup. If the user edited the proposed
  // standardizations (any undo history), confirm first that this affects every
  // table with a pipeline in the domain; an unedited accept goes straight through.
  function requestAcceptStandardizations() {
    if (isAutoExport && undoStack.length > 0) {
      setConfirmAcceptOpen(true);
      return;
    }
    void doAcceptStandardizations();
  }

  async function doAcceptStandardizations() {
    setConfirmAcceptOpen(false);
    acceptStartRef.current = Date.now();
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/run/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Defer the lookup writes — just persist this column's reviewed groups
          // and mark it approved. The actual upserts happen at "Begin Pipeline
          // Standardization", behind a progress bar, so accepting each column is fast.
          defer: true,
          new_groups: Object.entries(uiAliasMap || {})
            .filter(([aliasName]) => aliasName !== UNGROUPED_KEY)
            .filter(([, g]) => typeof g?.group_id === 'number' && g.group_id < 0)
            .map(([alias_name_literal_value, g]) => ({ temp_group_id: g.group_id, alias_name_literal_value })),
          moves: Object.entries(pendingMoves).map(([run_item_id, group_id]) => ({
            run_item_id: Number(run_item_id), group_id,
          })),
          alias_name_changes: Object.entries(pendingAliasNames).map(([group_id, alias_name_literal_value]) => ({
            group_id: Number(group_id), alias_name_literal_value,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to accept standardizations');

      // Multi-column wizard: move on to the next column instead of going home.
      if (inWizard) {
        const advanced = await advanceWizardForward();
        if (advanced) return; // navigated to the next column's run
        // No further columns with data — finish.
      }

      // Fall back to the wizard's pipeline_id when the export couldn't resolve it
      // (e.g. multi-column Sheets where only the first column matches pipeline.column_name).
      const effectivePid = body?.pipeline_id ?? (wizard ? wizard.pids[0] : undefined);
      await finishWizard(effectivePid);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Failed to accept standardizations');
      setExporting(false);
    }
  }

  // ── Wizard navigation ───────────────────────────────────────────────────────

  /** Clear the wizard and return to home (optionally surfacing the activation card). */
  async function finishWizard(pipelineId?: number | string) {
    try { sessionStorage.removeItem(COL_WIZARD_KEY); } catch { /* ignore */ }
    const pid = pipelineId ? Number(pipelineId) : null;
    if (pid && Number.isFinite(pid) && pid > 0) {
      localStorage.setItem('prism_ae_pending_pipeline_id', String(pid));
      // Pre-fetch pipeline data while still on the run page so the home page can
      // show the activation card instantly without its own Snowflake round-trip.
      try {
        const r    = await fetch('/api/pipelines');
        const body = await r.json();
        const all  = (body.pipelines ?? []) as any[];
        const pl   = all.find((p: any) => p.pipeline_id === pid);
        if (pl) {
          const siblings = all
            .filter((p: any) => p.table_fqn === pl.table_fqn &&
              (pl.export_table_fqn ? p.export_table_fqn === pl.export_table_fqn : true))
            .sort((a: any, b: any) => a.pipeline_id - b.pipeline_id);
          sessionStorage.setItem('prism_ae_activation_data', JSON.stringify({ pl, siblings }));
        }
      } catch { /* non-fatal — home page falls back to its own fetch */ }
    }
    reportAcceptNav();
    router.push('/home');
  }

  /**
   * Move to the next column that has data. Reuses an already-created review run
   * when one exists, otherwise builds it via create-initial-run. Columns whose
   * source is empty (run_id === null) are skipped. Returns true if it navigated.
   */
  async function advanceWizardForward(): Promise<boolean> {
    if (!wizard) return false;
    const cur = wizard.runs.indexOf(Number(runId));
    const w: ColWizard = { ...wizard, runs: [...wizard.runs] };

    for (let next = cur + 1; next < w.pids.length; next++) {
      // Already have a run for this column — just open it.
      if (w.runs[next] != null) {
        sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
        reportAcceptNav();
        router.push(`/run/${w.runs[next]}`);
        return true;
      }
      // Build the review run for this column — from the queue for a 'standardize'
      // wizard (manual mode), or from the full source for a 'create' wizard.
      const route = w.kind === 'standardize'
        ? `/api/pipelines/${w.pids[next]}/standardize-run`
        : `/api/pipelines/${w.pids[next]}/create-initial-run`;
      const res  = await fetch(route, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.run_id) {
        w.runs[next] = Number(body.run_id);
        sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
        reportAcceptNav();
        router.push(`/run/${body.run_id}`);
        return true;
      }
      // Empty source (run_id: null) or a soft error — skip this column and try the next.
      w.runs[next] = null;
    }
    // Persist any skips we recorded so a later Back pass doesn't retry them.
    sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
    return false;
  }

  /** Go back to the previous already-standardized column (no export). */
  function goToPreviousColumn() {
    if (!wizard) return;
    const cur = wizard.runs.indexOf(Number(runId));
    for (let prev = cur - 1; prev >= 0; prev--) {
      const rid = wizard.runs[prev];
      if (rid != null) {
        router.push(`/run/${rid}`);
        return;
      }
    }
  }

  function onExportClick() {
    setSfExportModalOpen(true);
  }

  function proceedSfExport() {
    if (uncheckedCount > 0) checkAll();
    setSfExportModalOpen(false);
    void doExport();
  }

  const viewFqn = exportResult?.view_fqn ? String(exportResult.view_fqn) : '';
  const viewSql = viewFqn ? `SELECT * FROM ${viewFqn};` : '';

  async function copyViewSql() {
    if (!viewSql) return;
    try {
      await navigator.clipboard.writeText(viewSql);
      setCopiedSql(true);
      window.setTimeout(() => setCopiedSql(false), 1200);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = viewSql;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedSql(true);
        window.setTimeout(() => setCopiedSql(false), 1200);
      } catch { /* ignore */ }
    }
  }

  // ── Download Mapping helpers ─────────────────────────────────────────────

  async function openDownloadModal() {
    setDownloadModalOpen(true);
    setDownloadRows(null);
    setDownloadHeaders([]);
    setDownloadTitle(null);
    setDownloadSourceColumn('');
    setDownloadLoading(true);
    setDownloadError(null);
    setGoogleSheetsLoading(false);
    setGoogleSheetsError(null);
    setGoogleSheetsUrl(null);
    try {
      const res  = await fetch(`/api/run/${runId}/export-mapping`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to load mapping');
      setDownloadRows(body.rows         || []);
      setDownloadHeaders(body.headers   || []);
      setDownloadTitle(body.title       || null);
      setDownloadSourceColumn(body.sourceColumn ?? '');
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to load mapping');
    } finally {
      setDownloadLoading(false);
    }
  }

  // ── Google Sheets export ─────────────────────────────────────────────────

  async function doGoogleSheetsExportWithConfig(inc: boolean) {
    triggerOpExport();
    setGoogleSheetsLoading(true);
    setGoogleSheetsError(null);
    setGoogleSheetsUrl(null);
    try {
      const res = await fetch(`/api/run/${runId}/export-to-google-sheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeOriginalCol: inc }),
      });

      if (res.status === 401) {
        // Need Google auth — redirect preserving the desired export config
        const base = window.location.href.split('?')[0];
        const returnTo = `${base}?gsExport=1&includeOriginalCol=${inc}`;
        window.location.href = `/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to create Google Sheet');

      setGoogleSheetsUrl(data.url);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setGoogleSheetsError(err instanceof Error ? err.message : 'Failed to export to Google Sheets');
    } finally {
      setGoogleSheetsLoading(false);
    }
  }

  async function doGoogleSheetsExport() {
    await doGoogleSheetsExportWithConfig(includeOriginalCol);
  }

  // After returning from Google OAuth, auto-trigger the export.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gsExport') !== '1') return;

    const inc = params.get('includeOriginalCol') !== 'false';

    // Clean up URL params
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('gsExport');
    cleanUrl.searchParams.delete('includeOriginalCol');
    cleanUrl.searchParams.delete('gauth');
    window.history.replaceState({}, '', cleanUrl.toString());

    setIncludeOriginalCol(inc);
    setDownloadModalOpen(true);
    setGoogleSheetsLoading(true);
    void doGoogleSheetsExportWithConfig(inc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── One-prompt backend write trigger ────────────────────────────────────
  // Fires on the first download/export action to signal the user is done
  // making corrections. The backend is idempotent — repeated calls are no-ops.
  // Never blocks the download; errors are silently swallowed.

  function triggerOpExport(): void {
    fetch(`/api/run/${runId}/export`, { method: 'POST' }).catch(() => {});
  }

  // ── CSV / Excel helpers ───────────────────────────────────────────────────

  function escapeCsv(val: string): string {
    if (/[,"\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
    return val;
  }

  function resolvedHeaders(): string[] {
    if (downloadHeaders.length > 0) return downloadHeaders;
    if (downloadRows && downloadRows.length > 0) return Object.keys(downloadRows[0]);
    return [];
  }

  // Apply the includeOriginalCol toggle to headers + row data.
  // When false: remove the stdCol, swap its values into the source column slot.
  function buildExportData(): { headers: string[]; rows: Record<string, string>[] } {
    const hdrs = resolvedHeaders();
    const rows = downloadRows ?? [];
    if (includeOriginalCol || !downloadSourceColumn) return { headers: hdrs, rows };
    const stdColName = `standardized_${downloadSourceColumn}`;
    if (!hdrs.includes(stdColName)) return { headers: hdrs, rows };
    const newHeaders = hdrs.filter(h => h !== stdColName);
    const newRows = rows.map(r => {
      const row = { ...r };
      row[downloadSourceColumn] = r[stdColName] ?? r[downloadSourceColumn] ?? '';
      delete row[stdColName];
      return row;
    });
    return { headers: newHeaders, rows: newRows };
  }

  function buildFilename(ext: string): string {
    const titlePart = (downloadTitle || `run_${runId}`)
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
    const colPart = (downloadSourceColumn || 'column').replace(/[^\w]/g, '_');
    return `${titlePart}_${colPart}_standardized.${ext}`;
  }

  async function doCsvDownload() {
    if (!downloadRows) return;
    triggerOpExport();
    const { headers: hdrs, rows } = buildExportData();
    const lines = [
      hdrs.map(h => escapeCsv(h)).join(','),
      ...rows.map(r => hdrs.map(h => escapeCsv(r[h] ?? '')).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = buildFilename('csv');
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doExcelDownload() {
    if (!downloadRows) return;
    triggerOpExport();
    const XLSX = await import('xlsx');
    const { headers: hdrs, rows } = buildExportData();
    const aoaData = [hdrs, ...rows.map(r => hdrs.map(h => r[h] ?? ''))];
    const ws  = XLSX.utils.aoa_to_sheet(aoaData);
    const wb  = XLSX.utils.book_new();
    const sheetName = (downloadTitle ?? 'Standardized Mapping').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = buildFilename('xlsx');
    a.click();
    URL.revokeObjectURL(url);
  }


  // ── Render ────────────────────────────────────────────────────────────────

  const statusLabel = getStatusLabel(initialRunStatus);

  return (
    <div onClick={() => setOpenMenuForAliasName(null)}>
      {/* ── Column wizard stepper (multi-column pipeline creation) ──────── */}
      {inWizard && (
        <div
          className="rounded-card border-[0.5px] px-6 py-4 mb-4 flex items-center justify-between"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            {wizard!.cols.map((_, i) => {
              const done    = i < colIndex;
              const current = i === colIndex;
              return (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center justify-center rounded-full text-xs font-medium transition-colors"
                    style={{
                      width: 24,
                      height: 24,
                      backgroundColor: current ? 'var(--accent)' : done ? 'var(--accent-tint)' : 'var(--page-bg)',
                      color:           current ? 'white' : done ? 'var(--accent-strong)' : 'var(--text-hint)',
                      border:          current ? 'none' : '0.5px solid var(--border)',
                    }}
                  >
                    {i + 1}
                  </span>
                  {i < wizard!.cols.length - 1 && (
                    <span style={{ width: 18, height: '0.5px', backgroundColor: 'var(--border)' }} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Column{' '}
            <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{colIndex + 1}</span>
            {' '}of {wizard!.pids.length}
            {wizard!.cols[colIndex] && (
              <span style={{ color: 'var(--text-secondary)' }}> · {wizard!.cols[colIndex]}</span>
            )}
          </div>
        </div>
      )}

      {/* ── White surface card ─────────────────────────────────────────── */}
      <div
        className="rounded-card border-[0.5px] p-6"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border)',
        }}
      >
        {/* Card header */}
        <div className="flex items-center justify-between mb-6">
          {/* Left: title + status pill */}
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Alias groups
            </h2>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs font-medium"
              style={{
                backgroundColor: 'var(--accent-tint)',
                color: 'var(--accent-strong)',
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: 'var(--accent)' }}
              />
              {statusLabel}
            </span>
          </div>

          {/* Right: counter + apply button + export button */}
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Checked{' '}
              <span className="font-medium" style={{ color: 'var(--accent)' }}>
                {checkedAliases.size}
              </span>
              {' / '}
              {totalGroups}
            </span>

            <UndoButton onUndo={() => historyHandlersRef.current.undo()} disabled={exporting || undoStack.length === 0} />

            {isAutoExport ? (
              <>
                {inWizard && colIndex > 0 && (
                  <button
                    type="button"
                    onClick={goToPreviousColumn}
                    disabled={exporting}
                    className="px-4 py-1.5 rounded-button text-sm font-medium border-[0.5px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  onClick={requestAcceptStandardizations}
                  disabled={exporting || loadingAliasMap || !!aliasMapError}
                  className="px-4 py-1.5 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--accent)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                >
                  {exporting
                    ? 'Saving…'
                    : inWizard && !isLastCol
                      ? 'Accept & continue'
                      : 'Accept Standardizations'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void openDownloadModal()}
                  disabled={loadingAliasMap || !!aliasMapError}
                  className="px-3 py-1.5 rounded-button text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: '#4BAE4F', color: '#FFFFFF' }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#439A47';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#4BAE4F';
                  }}
                >
                  Export to Spreadsheet
                </button>

                <button
                  type="button"
                  onClick={onExportClick}
                  disabled={exporting || loadingAliasMap || !!aliasMapError}
                  className="px-4 py-1.5 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--accent)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                >
                  {exporting ? 'Exporting…' : 'Export to Snowflake'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Domain-wide scope notice (premium: accepting writes to the shared lookup) */}
        {isAutoExport && <DomainScopeNotice style={{ marginBottom: 20 }} />}

        <DomainChangeConfirmModal
          open={confirmAcceptOpen}
          busy={exporting}
          confirmLabel="Accept for all tables"
          body="You changed the proposed standardizations. Accepting writes them to the shared lookup for this domain, so every other table with a pipeline in this domain will standardize using these mappings too."
          onCancel={() => setConfirmAcceptOpen(false)}
          onConfirm={() => void doAcceptStandardizations()}
        />

        {/* Export error */}
        {exportError && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            {exportError}
          </div>
        )}

        {/* Export success — not shown in auto_export mode (we redirect instead) */}
        {!isAutoExport && exportResult?.view_fqn && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
            style={{ backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ color: 'var(--confidence-high)' }}>View created:</span>
              <code
                className="text-xs px-2 py-1 rounded-[6px]"
                style={{ backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)', color: 'var(--text-secondary)' }}
              >
                {viewSql}
              </code>
              <button
                type="button"
                onClick={() => void copyViewSql()}
                className="px-3 py-1 rounded-[6px] border-[0.5px] text-xs font-medium"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-secondary)' }}
              >
                {copiedSql ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Rename error */}
        {renameError && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-4 text-sm"
            style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E' }}
          >
            {renameError}
          </div>
        )}

        {/* ── Needs-review callout (top of page) — message only ─────────── */}
        {reviewCount > 0 && (
          <div
            className="flex items-start gap-2.5 rounded-button border-[0.5px] px-4 py-3.5 mb-5 text-sm"
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
              Drag them into the correct group or accept as-is.
            </span>
          </div>
        )}

        {/* ── Loading / error / content ─────────────────────────────────── */}
        {loadingAliasMap ? (
          <p className="text-sm italic py-4" style={{ color: 'var(--text-muted)' }}>
            Loading groups…
          </p>
        ) : aliasMapError ? (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            {aliasMapError}
          </div>
        ) : (
          <>
            {/* ── Column headers ──────────────────────────────────────── */}
            <div
              className="grid items-center mb-1 pb-2 border-b-[0.5px]"
              style={{
                gridTemplateColumns: '36px 36px 160px 1fr 32px',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div />
              <div />
              <div
                className="px-3 text-[10px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-hint)' }}
              >
                Alias name
              </div>
              <div
                className="px-2 text-[10px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-hint)' }}
              >
                Matched values
              </div>
              <div />
            </div>

            {/* ── Group rows ──────────────────────────────────────────── */}
            <div>
              {groupEntries.map(([aliasName, group], idx) => {
                const isChecked = checkedAliases.has(aliasName);
                const isGroupDragOver =
                  dragOverAliasName === aliasName &&
                  draggingGroupName !== null &&
                  draggingGroupName !== aliasName;
                const isItemDragOver =
                  dragOverAliasName === aliasName && draggingGroupName === null;
                const isDragOver = isGroupDragOver || isItemDragOver;
                const isBeingDragged = draggingGroupName === aliasName;

                return (
                  <div key={aliasName}>
                    {idx > 0 && (
                      <div
                        className="mx-3 border-t-[0.5px]"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      />
                    )}
                    <div
                      className="grid items-start py-[13px] rounded-row transition-colors"
                      style={{
                        gridTemplateColumns: '36px 36px 160px 1fr 32px',
                        opacity: isBeingDragged ? 0.4 : 1,
                        ...(isDragOver
                          ? {
                              backgroundColor: 'var(--accent-tint)',
                              borderLeft: '2px solid var(--accent)',
                              paddingLeft: 10,
                            }
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
                      {/* Col 1: Checkbox */}
                      <div className="flex justify-center pt-0.5">
                        <button
                          type="button"
                          onClick={() => toggle(aliasName)}
                          aria-label={isChecked ? 'Uncheck group' : 'Check group'}
                          className="w-[26px] h-[26px] rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                          style={isChecked
                            ? { backgroundColor: 'var(--accent)', border: 'none' }
                            : { backgroundColor: 'var(--surface)', border: '0.5px solid var(--border)' }
                          }
                        >
                          {isChecked && <CheckmarkIcon />}
                        </button>
                      </div>

                      {/* Col 2: Drag handle */}
                      <div className="flex justify-center pt-1.5">
                        {editingAliasKey !== aliasName && (
                          <span
                            draggable
                            onDragStart={(e) => onDragStartGroup(e, aliasName)}
                            onDragEnd={onDragEndGroup}
                            className="cursor-grab p-1 flex items-center justify-center"
                            title="Drag to reorder or merge"
                            aria-label="Drag to reorder group"
                          >
                            <DragDots />
                          </span>
                        )}
                      </div>

                      {/* Col 3: Alias name */}
                      <div
                        className="px-3 text-sm"
                        onDoubleClick={() => startRename(aliasName)}
                        title={editingAliasKey !== aliasName ? 'Double-click to rename' : undefined}
                      >
                        {isGroupDragOver ? (
                          <span className="text-xs font-medium" style={{ color: 'var(--accent-strong)' }}>
                            Merge into &ldquo;{group.display_name || aliasName}&rdquo;
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
                              borderColor: 'var(--accent)',
                              backgroundColor: 'var(--surface)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        ) : (
                          <span
                            className="font-semibold"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {group.display_name || aliasName}
                          </span>
                        )}
                      </div>

                      {/* Col 4: Matched values */}
                      <div className="px-2">
                        {(group.items || []).length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {(group.items || []).map((it) => {
                              const meta = initialItemMeta.get(it.run_item_id);
                              const initialGroupId = meta?.initial_group_id ?? null;
                              const initialScore = meta?.confidence_score ?? null;
                              const pending = pendingMoves[it.run_item_id];

                              const showScore =
                                initialGroupId !== null &&
                                typeof initialScore === 'number' &&
                                Number.isFinite(initialScore) &&
                                (pending === undefined || pending === initialGroupId);

                              return (
                                <span
                                  key={it.run_item_id}
                                  draggable
                                  onDragStart={(e) =>
                                    onDragStart(e, {
                                      type: 'item',
                                      fromAliasName: aliasName,
                                      run_item_id: it.run_item_id,
                                      literal_value: String(it.literal_value),
                                    })
                                  }
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill cursor-move text-xs"
                                  style={it.needs_review ? {
                                    backgroundColor: '#FEF9C3',
                                    border: '0.5px solid #FDE047',
                                    color: '#713F12',
                                  } : {
                                    backgroundColor: 'var(--border-subtle)',
                                    border: '0.5px solid var(--border)',
                                    color: 'var(--text-secondary)',
                                  }}
                                >
                                  {String(it.literal_value)}
                                  {showScore && (
                                    <span className={`text-[10px] font-medium ${confidenceColorClass(initialScore!)}`}>
                                      {formatConfidence(initialScore!)}
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs italic" style={{ color: 'var(--text-hint)' }}>
                            No items yet
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
                                setOpenMenuForAliasName((prev) => prev === aliasName ? null : aliasName);
                              }}
                              className="w-7 h-7 rounded-[6px] border-[0.5px] flex items-center justify-center text-sm transition-colors"
                              style={{
                                borderColor: 'var(--border)',
                                backgroundColor: 'var(--surface)',
                                color: 'var(--text-hint)',
                              }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
                              title="Group actions"
                              aria-label="Group actions"
                            >
                              ···
                            </button>

                            {openMenuForAliasName === aliasName && (
                              <div
                                className="absolute right-0 top-8 w-32 rounded-button border-[0.5px] z-10 overflow-hidden"
                                style={{
                                  backgroundColor: 'var(--surface)',
                                  borderColor: 'var(--border)',
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => { startRename(aliasName); setOpenMenuForAliasName(null); }}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ''; }}
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteGroup(aliasName)}
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

            {/* ── Add group button ─────────────────────────────────────── */}
            <div className="flex justify-center mt-4 mb-1">
              <button
                type="button"
                onClick={addGroup}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-button border-[0.5px] border-dashed text-sm transition-colors group"
                style={{
                  borderColor: 'var(--border)',
                  backgroundColor: 'var(--surface)',
                  color: 'var(--text-hint)',
                }}
                onMouseEnter={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.backgroundColor = 'var(--accent-tint)';
                  btn.style.borderColor = 'var(--accent)';
                  btn.style.color = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.backgroundColor = 'var(--surface)';
                  btn.style.borderColor = 'var(--border)';
                  btn.style.color = 'var(--text-hint)';
                }}
              >
                <span className="text-base leading-none">+</span>
                Add a group
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Confirmation modal ─────────────────────────────────────────── */}
      {sfExportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div
            className="w-full max-w-sm rounded-card border-[0.5px] p-6"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              Export to Snowflake
            </h3>
            <p className="text-xs mb-5" style={{ color: 'var(--text-hint)' }}>
              A view will be created in Snowflake with the standardized column appended.
            </p>

            {/* Include original column toggle */}
            <IncludeOriginalToggle
              value={includeOriginalCol}
              onChange={setIncludeOriginalCol}
            />

            {/* Unreviewed warning */}
            {uncheckedCount > 0 && (
              <div
                className="mt-4 rounded-button border-[0.5px] px-3 py-2.5 text-sm"
                style={{ backgroundColor: '#FEF9C3', borderColor: '#FDE68A', color: '#92400E' }}
              >
                {uncheckedCount} group{uncheckedCount !== 1 ? 's' : ''} haven&apos;t been reviewed yet.
              </div>
            )}

            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setSfExportModalOpen(false)}
                className="px-4 py-2 rounded-button border-[0.5px] text-sm font-medium transition-colors"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-secondary)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={proceedSfExport}
                className="px-4 py-2 rounded-button text-white text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--accent)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
              >
                {uncheckedCount > 0 ? 'Export anyway' : 'Export'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Download Mapping modal ───────────────────────────────────────── */}
      {downloadModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
          onClick={() => setDownloadModalOpen(false)}
        >
          <div
            className="rounded-card border-[0.5px] w-[380px]"
            style={{
              backgroundColor: 'var(--surface)',
              borderColor:     'var(--border)',
              padding:         'var(--card-padding)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Download Mapping
              </h3>
              <button
                type="button"
                onClick={() => setDownloadModalOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                aria-label="Close"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Loading skeleton while rows are fetched */}
            {downloadLoading && (
              <div className="flex items-center gap-2 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Loading mapping data…
              </div>
            )}

            {/* Error fetching rows */}
            {!downloadLoading && downloadError && (
              <div className="rounded-button border-[0.5px] px-3 py-2.5 text-sm" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
                {downloadError}
              </div>
            )}

            {/* Options */}
            {!downloadLoading && !downloadError && (
              <div className="flex flex-col gap-0.5">

                {/* Excel */}
                <button
                  type="button"
                  onClick={() => void doExcelDownload()}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full"
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                >
                  <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M5.5 9l1.5 2 1.5-2M5.5 11l1.5-2 1.5 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Download as Excel</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>.xlsx file</p>
                  </div>
                </button>

                {/* CSV */}
                <button
                  type="button"
                  onClick={() => void doCsvDownload()}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full"
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                >
                  <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent)' }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M5 9.5h6M5 11.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Download as CSV</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>.csv file</p>
                  </div>
                </button>

                {/* Divider */}
                <div className="my-1" style={{ height: '0.5px', backgroundColor: 'var(--border-subtle)' }} />

                {/* Google Sheets */}
                <button
                  type="button"
                  onClick={() => void doGoogleSheetsExport()}
                  disabled={googleSheetsLoading}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-button text-left transition-colors w-full disabled:opacity-60 disabled:cursor-not-allowed"
                  onMouseEnter={(e) => { if (!googleSheetsLoading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                >
                  <div className="w-8 h-8 rounded-button flex items-center justify-center flex-shrink-0 flex-shrink-0" style={{ backgroundColor: '#E8F5E9' }}>
                    {googleSheetsLoading ? (
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="#1E8E3E" strokeWidth="3" />
                        <path className="opacity-75" fill="#1E8E3E" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <rect x="2.5" y="1" width="9" height="11.5" rx="1" fill="#1E8E3E" />
                        <path d="M8.5 1v3.5H12L8.5 1z" fill="#0D652D" />
                        <rect x="2.5" y="6" width="9" height="6.5" rx="0" fill="#34A853" />
                        <path d="M4.5 8h5M4.5 9.5h5M4.5 11h3" stroke="white" strokeWidth="0.8" strokeLinecap="round" />
                        <rect x="2.5" y="1" width="9" height="11.5" rx="1" stroke="#1E8E3E" strokeWidth="0.5" fill="none" />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {googleSheetsLoading ? 'Exporting to Google Sheets…' : 'Export to Google Sheets'}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-hint)' }}>
                      {googleSheetsUrl ? 'Opened in new tab ↗' : 'Creates a new spreadsheet'}
                    </p>
                  </div>
                </button>

                {/* Google Sheets result / error */}
                {googleSheetsUrl && !googleSheetsLoading && (
                  <a
                    href={googleSheetsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 mx-1 mt-0.5 px-3 py-2 rounded-button text-xs font-medium transition-colors"
                    style={{ backgroundColor: '#E8F5E9', color: '#1E8E3E', border: '0.5px solid #A8D5B5' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2 10l8-8M10 2H4M10 2v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Open Google Sheet
                  </a>
                )}
                {googleSheetsError && !googleSheetsLoading && (
                  <p className="mx-1 mt-0.5 px-3 py-2 rounded-button text-xs" style={{ backgroundColor: '#FEF2F2', color: 'var(--confidence-low)', border: '0.5px solid #FECACA' }}>
                    {googleSheetsError}
                  </p>
                )}

              </div>
            )}

            {/* Include original column toggle — shown once rows are loaded */}
            {!downloadLoading && !downloadError && downloadRows && downloadSourceColumn && (
              <div className="mt-3 pt-3" style={{ borderTop: '0.5px solid var(--border)' }}>
                <IncludeOriginalToggle
                  value={includeOriginalCol}
                  onChange={setIncludeOriginalCol}
                />
              </div>
            )}

            {/* Summary when loaded */}
            {!downloadLoading && !downloadError && downloadRows && (
              <p className="mt-4 text-xs text-center" style={{ color: 'var(--text-hint)' }}>
                {downloadTitle && <><strong style={{ color: 'var(--text-secondary)' }}>{downloadTitle}</strong>{' · '}</>}
                {downloadRows.length} row{downloadRows.length !== 1 ? 's' : ''}
                {downloadHeaders.length > 0 && ` · ${downloadHeaders.length} column${downloadHeaders.length !== 1 ? 's' : ''}`}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
