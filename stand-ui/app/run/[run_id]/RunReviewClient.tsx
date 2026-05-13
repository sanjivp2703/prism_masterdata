'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const UNGROUPED_KEY = '__UNGROUPED__';

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    display_name: string;
    items: Array<{
      run_item_id: number;
      literal_value: string;
      confidence_score: number | null;
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

function formatElapsed(secs: number): string {
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${secs}s`;
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

  const [grouping, setGrouping] = useState(false);
  const [groupingMode, setGroupingMode] = useState<'basic' | 'advanced' | 'one_prompt'>('basic');
  const [groupingError, setGroupingError] = useState<string | null>(null);
  const [groupingResult, setGroupingResult] = useState<{
    groups_created: number;
    items_committed: number;
    elapsed_secs: number;
    llm_elapsed_secs: number | null;
    deterministic_elapsed_secs: number | null;
    estimated_cost_usd: number;
    llm_pairs_scored: number;
    mode: 'basic' | 'advanced' | 'one_prompt';
    chunk_count: number | null;
  } | null>(null);
  const [groupingProgress, setGroupingProgress] = useState<{
    phase: 'loading' | 'llm_scoring' | 'computing' | 'saving' | 'done';
    sub_phase: string;
    items_total: number;
    groups_found: number;
    progress_pct: number;
    llm_calls_made: number;
    llm_calls_total: number;
    estimated_cost_usd: number;
    llm_elapsed_ms?: number;
    deterministic_elapsed_ms?: number;
  } | null>(null);
  const [groupingStartedAt, setGroupingStartedAt] = useState<number | null>(null);
  const [groupingElapsed, setGroupingElapsed] = useState(0);

  const [applyingAssignments, setApplyingAssignments] = useState(false);
  const [assignmentsApplied, setAssignmentsApplied] = useState<{
    assigned: number;
    groups_created: number;
    elapsed_secs: number;
    llm_elapsed_secs: number | null;
    deterministic_elapsed_secs: number | null;
    estimated_cost_usd: number | null;
    total_tokens: number | null;
  } | null>(null);
  const [scoringProgress, setScoringProgress] = useState<{
    phase: 'scoring' | 'saving' | 'done';
    items_scored: number;
    items_total: number;
    pairs_scored: number;
    pairs_total: number;
    estimated_cost_usd?: number;
    llm_elapsed_ms?: number;
    deterministic_elapsed_ms?: number;
    token_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  } | null>(null);
  const [scoringStartedAt, setScoringStartedAt] = useState<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const latestProgressRef = useRef<{
    phase: 'scoring' | 'saving' | 'done';
    items_scored: number; items_total: number;
    pairs_scored: number; pairs_total: number;
    estimated_cost_usd?: number;
    llm_elapsed_ms?: number;
    deterministic_elapsed_ms?: number;
    token_usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  } | null>(null);

  const [sfExportModalOpen, setSfExportModalOpen] = useState(false);
  const [includeOriginalCol, setIncludeOriginalCol] = useState(true);
  const [dragOverAliasName, setDragOverAliasName] = useState<string | null>(null);
  const [draggingGroupName, setDraggingGroupName] = useState<string | null>(null);
  const [openMenuForAliasName, setOpenMenuForAliasName] = useState<string | null>(null);

  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const historyHandlersRef = useRef<{ undo: () => void; redo: () => void }>({
    undo: () => {},
    redo: () => {},
  });

  // ── Download Mapping modal ────────────────────────────────────────────
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [downloadLoading,   setDownloadLoading]   = useState(false);
  // rows uses dynamic keys — works for both the 2-col mapping and the full pasted table
  const [downloadRows,      setDownloadRows]       = useState<Record<string, string>[] | null>(null);
  const [downloadHeaders,   setDownloadHeaders]    = useState<string[]>([]);
  const [downloadTitle,        setDownloadTitle]        = useState<string | null>(null);
  const [downloadSourceColumn, setDownloadSourceColumn] = useState<string>('');
  const [downloadError,        setDownloadError]        = useState<string | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

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

  useEffect(() => {
    if (!applyingAssignments || scoringStartedAt === null) return;
    const id = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - scoringStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [applyingAssignments, scoringStartedAt]);

  useEffect(() => {
    if (!grouping || groupingStartedAt === null) return;
    const id = setInterval(() => {
      setGroupingElapsed(Math.floor((Date.now() - groupingStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [grouping, groupingStartedAt]);

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

  async function applyConfidentAssignments() {
    const startedAt = Date.now();
    setApplyingAssignments(true);
    setAssignmentsApplied(null);
    setScoringProgress(null);
    latestProgressRef.current = null;
    setScoringStartedAt(startedAt);
    setElapsedSecs(0);

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    function startPolling() {
      pollTimer = setInterval(async () => {
        try {
          const r = await fetch(`/api/run/${runId}/apply-confident-assignments`, { cache: 'no-store' });
          const body = await r.json().catch(() => ({}));
          if (body?.progress) {
            latestProgressRef.current = body.progress;
            setScoringProgress(body.progress);
          }
        } catch { /* polling failures are silent */ }
      }, 800);
    }
    function stopPolling() {
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    }

    try {
      startPolling();
      const res = await fetch(`/api/run/${runId}/apply-confident-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      stopPolling();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return;

      const assigned = Number(body?.assigned ?? 0);
      const groupsCreated = Number(body?.groups_created ?? 0);
      const finalElapsed = Math.floor((Date.now() - startedAt) / 1000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastProg = latestProgressRef.current as any;
      const finalCost: number | null = lastProg?.estimated_cost_usd ?? null;
      const finalTokens: number | null = lastProg?.token_usage
        ? (lastProg.token_usage.input_tokens as number) +
          (lastProg.token_usage.output_tokens as number) +
          (lastProg.token_usage.cache_read_input_tokens as number) +
          (lastProg.token_usage.cache_creation_input_tokens as number)
        : null;
      const finalLLMElapsedSecs: number | null =
        typeof lastProg?.llm_elapsed_ms === 'number'
          ? Math.floor(lastProg.llm_elapsed_ms / 1000)
          : null;
      const finalDetElapsedSecs: number | null =
        typeof lastProg?.deterministic_elapsed_ms === 'number'
          ? Math.floor(lastProg.deterministic_elapsed_ms / 1000)
          : null;
      setAssignmentsApplied({ assigned, groups_created: groupsCreated, elapsed_secs: finalElapsed, llm_elapsed_secs: finalLLMElapsedSecs, deterministic_elapsed_secs: finalDetElapsedSecs, estimated_cost_usd: finalCost, total_tokens: finalTokens });

      const refreshed = await fetch(`/api/run/${runId}/alias-mapping`, { cache: 'no-store' });
      const refreshedBody = await refreshed.json().catch(() => ({}));
      if (refreshed.ok) {
        const data = (refreshedBody?.data || {}) as AliasMap;
        setAliasMap(data);
        setUiAliasMap(structuredClone(data));
        setPendingMoves({});
        setPendingAliasNames({});
        setCheckedAliases(new Set());
        setUndoStack([]);
        setRedoStack([]);
      }
    } catch {
      console.warn('apply-confident-assignments failed silently');
    } finally {
      stopPolling();
      setApplyingAssignments(false);
      setScoringProgress(null);
      setScoringStartedAt(null);
    }
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const entries = useMemo(() => {
    const e = Object.entries(uiAliasMap || {}) as Array<[string, AliasMap[string]]>;
    e.sort((a, b) => {
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
  const ungrouped = uiAliasMap?.[UNGROUPED_KEY] || null;

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
  const ungroupedCount = (ungrouped?.items || []).length;

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
      const existingUngrouped = next[UNGROUPED_KEY]?.items || [];
      const existingIds = new Set<number>(existingUngrouped.map((it) => Number(it.run_item_id)));
      const mergedUngrouped = [...existingUngrouped, ...itemsToMove.filter((it) => !existingIds.has(it.run_item_id))];
      next[UNGROUPED_KEY] = { group_id: null, display_name: '', items: mergedUngrouped };
      delete next[aliasName];
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

  async function doGroupUnassigned() {
    const startedAt = Date.now();
    setGrouping(true);
    setGroupingError(null);
    setGroupingResult(null);
    setGroupingProgress(null);
    setGroupingStartedAt(startedAt);
    setGroupingElapsed(0);

    const ungroupedIds = (ungrouped?.items || []).map((it) => it.run_item_id);
    const apiMode = groupingMode;

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    function startPolling() {
      pollTimer = setInterval(async () => {
        try {
          const r = await fetch(`/api/run/${runId}/unassigned-grouping/commit`, { cache: 'no-store' });
          const body = await r.json().catch(() => ({}));
          if (body?.progress) setGroupingProgress(body.progress);
        } catch { /* silent */ }
      }, 800);
    }
    function stopPolling() {
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    }

    try {
      startPolling();
      const res = await fetch(`/api/run/${runId}/unassigned-grouping/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_item_ids: ungroupedIds, mode: apiMode }),
      });
      stopPolling();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body?.details === 'string' && body.details.trim()
          ? body.details.trim()
          : '';
        const msg = body?.error || 'Grouping failed';
        throw new Error(detail ? `${msg}: ${detail}` : msg);
      }

      const finalElapsed = Math.floor((Date.now() - startedAt) / 1000);
      setGroupingResult({
        groups_created:              body?.data?.groups_created    ?? 0,
        items_committed:             body?.data?.items_committed   ?? 0,
        elapsed_secs:                finalElapsed,
        llm_elapsed_secs:            typeof body?.data?.llm_elapsed_ms === 'number'
          ? Math.floor(body.data.llm_elapsed_ms / 1000) : null,
        deterministic_elapsed_secs:  typeof body?.data?.deterministic_elapsed_ms === 'number'
          ? Math.floor(body.data.deterministic_elapsed_ms / 1000) : null,
        estimated_cost_usd:          body?.data?.estimated_cost_usd ?? 0,
        llm_pairs_scored:            body?.data?.llm_pairs_scored  ?? 0,
        mode:                        body?.data?.mode              ?? apiMode,
        chunk_count:                 typeof body?.data?.chunk_count === 'number' ? body.data.chunk_count : null,
      });

      const refreshed = await fetch(`/api/run/${runId}/alias-mapping`, { cache: 'no-store' });
      const refreshedBody = await refreshed.json().catch(() => ({}));
      if (refreshed.ok) {
        const data = (refreshedBody?.data || {}) as AliasMap;
        setAliasMap(data);
        setUiAliasMap(structuredClone(data));
        setPendingMoves({});
        setPendingAliasNames({});
        setCheckedAliases(new Set());
        setUndoStack([]);
        setRedoStack([]);
      }
    } catch (e) {
      setGroupingError(e instanceof Error ? e.message : 'Grouping failed');
    } finally {
      stopPolling();
      setGrouping(false);
      setGroupingProgress(null);
      setGroupingStartedAt(null);
    }
  }

  async function doExport() {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    setCopiedSql(false);

    try {
      const res = await fetch(`/api/run/${runId}/export-to-snowflake`, {
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
          include_original_col: includeOriginalCol,
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

            <button
              type="button"
              onClick={() => void applyConfidentAssignments()}
              disabled={loadingAliasMap || applyingAssignments || !!aliasMapError}
              className="px-3 py-1.5 rounded-button border-[0.5px] text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                borderColor: 'var(--border)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
            >
              {applyingAssignments ? 'Applying…' : 'Apply confident assignments'}
            </button>

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
          </div>
        </div>

        {/* Apply assignments progress */}
        {applyingAssignments && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-5 space-y-2"
            style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)' }}
          >
            <div className="flex items-center justify-between text-sm font-medium" style={{ color: 'var(--accent-strong)' }}>
              <span>
                {!scoringProgress
                  ? 'Starting confidence scoring…'
                  : scoringProgress.phase === 'saving'
                  ? 'Saving assignments…'
                  : `Scoring — ${scoringProgress.items_scored} / ${scoringProgress.items_total} items`}
              </span>
              <span className="flex items-center gap-3 tabular-nums text-xs" style={{ color: 'var(--accent)' }}>
                <span>{formatElapsed(elapsedSecs)}</span>
                {scoringProgress?.llm_elapsed_ms != null && scoringProgress.llm_elapsed_ms > 0 && (
                  <span style={{ color: 'var(--text-muted)' }}>LLM {formatElapsed(Math.floor(scoringProgress.llm_elapsed_ms / 1000))}</span>
                )}
                <span className="font-semibold text-sm">
                  {!scoringProgress ? '…'
                    : scoringProgress.phase === 'saving' ? '100%'
                    : `${Math.round((scoringProgress.items_scored / Math.max(scoringProgress.items_total, 1)) * 100)}%`}
                </span>
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--accent-border)' }}>
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  backgroundColor: 'var(--accent)',
                  width: !scoringProgress ? '0%'
                    : scoringProgress.phase === 'saving' ? '100%'
                    : `${Math.round((scoringProgress.items_scored / Math.max(scoringProgress.items_total, 1)) * 100)}%`,
                }}
              />
            </div>
            {scoringProgress && (
              <div className="flex items-center justify-between text-xs tabular-nums" style={{ color: 'var(--accent)' }}>
                <span>
                  {scoringProgress.pairs_scored.toLocaleString()} / {scoringProgress.pairs_total.toLocaleString()} comparisons
                </span>
                {scoringProgress.estimated_cost_usd !== undefined && scoringProgress.estimated_cost_usd > 0 && (
                  <span>
                    ~${scoringProgress.estimated_cost_usd < 0.01
                      ? scoringProgress.estimated_cost_usd.toFixed(4)
                      : scoringProgress.estimated_cost_usd.toFixed(3)} USD
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Apply assignments result */}
        {assignmentsApplied && !applyingAssignments && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
            style={{ backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' }}
          >
            <p className="font-medium" style={{ color: 'var(--confidence-high)' }}>
              {assignmentsApplied.assigned > 0
                ? <>Assigned {assignmentsApplied.assigned} item{assignmentsApplied.assigned !== 1 ? 's' : ''} to existing aliases{assignmentsApplied.groups_created > 0 ? ` (created ${assignmentsApplied.groups_created} new group${assignmentsApplied.groups_created !== 1 ? 's' : ''})` : ''}.</>
                : 'No items passed the confidence gate.'}
            </p>
            <div className="flex items-center gap-4 mt-1 text-xs tabular-nums" style={{ color: 'var(--confidence-high)' }}>
              <span>⏱ total {formatElapsed(assignmentsApplied.elapsed_secs)}</span>
              {assignmentsApplied.llm_elapsed_secs !== null && assignmentsApplied.llm_elapsed_secs > 0 && (
                <span>LLM {formatElapsed(assignmentsApplied.llm_elapsed_secs)}</span>
              )}
              {assignmentsApplied.deterministic_elapsed_secs !== null && assignmentsApplied.deterministic_elapsed_secs > 0 && (
                <span>det. {formatElapsed(assignmentsApplied.deterministic_elapsed_secs)}</span>
              )}
              {assignmentsApplied.estimated_cost_usd !== null && assignmentsApplied.estimated_cost_usd > 0 && (
                <span>~${assignmentsApplied.estimated_cost_usd < 0.01
                  ? assignmentsApplied.estimated_cost_usd.toFixed(4)
                  : assignmentsApplied.estimated_cost_usd.toFixed(3)} USD</span>
              )}
            </div>
          </div>
        )}

        {/* Export error */}
        {exportError && (
          <div
            className="rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            {exportError}
          </div>
        )}

        {/* Export success */}
        {exportResult?.view_fqn && (
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
                                  style={{
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

            {/* ── Divider ──────────────────────────────────────────────── */}
            <div
              className="border-t-[0.5px] my-6"
              style={{ borderColor: 'var(--border-subtle)' }}
            />

            {/* ── Ungrouped items section ──────────────────────────────── */}
            <div>
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Ungrouped items
                  </span>
                  {ungroupedCount > 0 && (
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      {ungroupedCount} value{ungroupedCount !== 1 ? 's' : ''} need{ungroupedCount === 1 ? 's' : ''} a home
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {/* Mode toggle */}
                  <div
                    className="flex items-center gap-0.5 rounded-button p-0.5"
                    style={{ backgroundColor: 'var(--accent-tint)' }}
                  >
                    {(['basic', 'advanced', 'one_prompt'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setGroupingMode(mode)}
                        disabled={grouping}
                        className="px-3 py-1.5 rounded-toggle-option text-xs font-medium transition-all disabled:cursor-not-allowed"
                        style={groupingMode === mode
                          ? {
                              backgroundColor: 'var(--surface)',
                              color: 'var(--accent)',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                            }
                          : { color: 'var(--text-muted)' }
                        }
                      >
                        {mode === 'basic' ? 'Basic' : mode === 'advanced' ? 'Advanced' : '1 Prompt'}
                      </button>
                    ))}
                  </div>

                  {/* Auto-group button */}
                  <button
                    type="button"
                    onClick={() => void doGroupUnassigned()}
                    disabled={grouping || ungroupedCount === 0}
                    className="px-4 py-1.5 rounded-button text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--accent)' }}
                    onMouseEnter={(e) => { if (!grouping && ungroupedCount > 0) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
                  >
                    {grouping ? 'Grouping…' : 'Auto-group'}
                  </button>
                </div>
              </div>

              {/* Grouping error */}
              {groupingError && (
                <div
                  className="rounded-button border-[0.5px] px-4 py-3 mb-3 text-sm"
                  style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
                >
                  {groupingError}
                </div>
              )}

              {/* Grouping progress */}
              {grouping && (
                <div
                  className="rounded-button border-[0.5px] px-4 py-3 mb-3 space-y-2"
                  style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent-border)' }}
                >
                  <div className="flex items-center justify-between text-sm font-medium" style={{ color: 'var(--accent-strong)' }}>
                    <span>
                      {!groupingProgress
                        ? 'Starting…'
                        : groupingProgress.phase === 'llm_scoring'
                        ? groupingProgress.sub_phase
                        : groupingProgress.phase === 'saving'
                        ? `Saving — ${groupingProgress.sub_phase}`
                        : groupingProgress.phase === 'loading'
                        ? groupingProgress.sub_phase
                        : `${groupingProgress.sub_phase}${groupingProgress.items_total > 0 ? ` (${groupingProgress.items_total} items)` : ''}`}
                    </span>
                    <span className="flex items-center gap-3 tabular-nums text-xs" style={{ color: 'var(--accent)' }}>
                      <span>{formatElapsed(groupingElapsed)}</span>
                      {groupingProgress?.phase === 'llm_scoring' && (groupingProgress.llm_elapsed_ms ?? 0) > 0 && (
                        <span style={{ color: 'var(--text-muted)' }}>LLM {formatElapsed(Math.floor((groupingProgress.llm_elapsed_ms ?? 0) / 1000))}</span>
                      )}
                      <span className="font-semibold text-sm">
                        {groupingProgress ? `${groupingProgress.progress_pct}%` : '…'}
                      </span>
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--accent-border)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-500 ease-out"
                      style={{
                        backgroundColor: 'var(--accent)',
                        width: groupingProgress ? `${groupingProgress.progress_pct}%` : '0%',
                      }}
                    />
                  </div>
                  {groupingProgress && (
                    <div className="flex items-center justify-between text-xs tabular-nums" style={{ color: 'var(--accent)' }}>
                      <span>
                        {groupingProgress.phase === 'llm_scoring' && groupingProgress.llm_calls_total > 0
                          ? `${groupingProgress.llm_calls_made.toLocaleString()} / ${groupingProgress.llm_calls_total.toLocaleString()} pair comparisons`
                          : groupingProgress.groups_found > 0
                          ? `${groupingProgress.groups_found} group${groupingProgress.groups_found !== 1 ? 's' : ''} found so far`
                          : 'Scanning…'}
                      </span>
                      {groupingProgress.estimated_cost_usd > 0 && (
                        <span>
                          ~${groupingProgress.estimated_cost_usd < 0.01
                            ? groupingProgress.estimated_cost_usd.toFixed(4)
                            : groupingProgress.estimated_cost_usd.toFixed(3)} USD
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Grouping result */}
              {groupingResult && !grouping && (
                <div
                  className="rounded-button border-[0.5px] px-4 py-3 mb-3 text-sm"
                  style={{ backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' }}
                >
                  <p className="font-medium" style={{ color: 'var(--confidence-high)' }}>
                    Created {groupingResult.groups_created} group{groupingResult.groups_created !== 1 ? 's' : ''} from {groupingResult.items_committed} item{groupingResult.items_committed !== 1 ? 's' : ''}.
                  </p>
                  <div className="flex items-center gap-4 mt-1 text-xs tabular-nums" style={{ color: 'var(--confidence-high)' }}>
                    <span>⏱ total {formatElapsed(groupingResult.elapsed_secs)}</span>
                    {groupingResult.llm_elapsed_secs !== null && groupingResult.llm_elapsed_secs > 0 && (
                      <span>LLM {formatElapsed(groupingResult.llm_elapsed_secs)}</span>
                    )}
                    {groupingResult.deterministic_elapsed_secs !== null && groupingResult.deterministic_elapsed_secs > 0 && (
                      <span>det. {formatElapsed(groupingResult.deterministic_elapsed_secs)}</span>
                    )}
                    {groupingResult.chunk_count !== null && groupingResult.chunk_count > 1 && (
                      <span>{groupingResult.chunk_count} parallel chunks</span>
                    )}
                    {groupingResult.llm_pairs_scored > 0 && (
                      <span>{groupingResult.llm_pairs_scored.toLocaleString()} pairs LLM-scored</span>
                    )}
                    {groupingResult.estimated_cost_usd > 0 && (
                      <span>~${groupingResult.estimated_cost_usd < 0.01
                        ? groupingResult.estimated_cost_usd.toFixed(4)
                        : groupingResult.estimated_cost_usd.toFixed(3)} USD</span>
                    )}
                  </div>
                </div>
              )}

              {/* Ungrouped drop zone */}
              <div
                className="rounded-row border-[0.5px] border-dashed px-4 py-4 min-h-[60px]"
                style={dragOverAliasName === UNGROUPED_KEY
                  ? { backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent)' }
                  : { backgroundColor: 'var(--border-subtle)', borderColor: 'var(--border)' }
                }
                onDragOver={(e) => onDragOverAlias(e, UNGROUPED_KEY)}
                onDrop={(e) => onDropOnAlias(e, UNGROUPED_KEY)}
                onDragLeave={(e) => onDragLeaveAlias(e, UNGROUPED_KEY)}
              >
                {ungroupedCount > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {(ungrouped?.items || []).map((it) => {
                      const meta = initialItemMeta.get(it.run_item_id);
                      const initialGroupId = meta?.initial_group_id ?? null;
                      const initialScore = meta?.confidence_score ?? null;
                      const pending = pendingMoves[it.run_item_id];

                      const showScore =
                        initialGroupId === null &&
                        typeof initialScore === 'number' &&
                        Number.isFinite(initialScore) &&
                        (pending === undefined || pending === null);

                      return (
                        <span
                          key={it.run_item_id}
                          draggable
                          onDragStart={(e) =>
                            onDragStart(e, {
                              type: 'item',
                              fromAliasName: UNGROUPED_KEY,
                              run_item_id: it.run_item_id,
                              literal_value: String(it.literal_value),
                            })
                          }
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-pill cursor-grab text-xs"
                          style={{
                            backgroundColor: 'var(--surface)',
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
                  <p className="text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                    Drag items here to leave them ungrouped
                  </p>
                )}
              </div>
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
