'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SpecScopeNotice, SpecChangeConfirmModal, UndoButton } from '@/app/components/SpecChangeWarning';
import ToastHost, { showToast } from '@/app/components/Toast';
import { reportError } from '@/app/api/_lib/report-error';
import {
  applyConventionRules,
  validateConventionViolations,
  hasAnyRule,
  describeConventionRules,
  type ConventionRules,
} from '@/app/api/_lib/convention-rules';
import { useWarehouseLabel } from '@/app/components/use-warehouse-label';

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
  nextTempGroupId: number;
};

// ── State-blob autosave types + patch mirror ─────────────────────────────────
// The RUNS.state blob is the run's source of truth. The client keeps the blob
// loaded at page load (baseState) and, when saving, applies the SAME pending-UI
// patch the export path sends (new_groups / moves / alias_name_changes) so the
// autosaved blob matches what the server computes at "Accept Standardizations".

interface BlobGroup {
  group_id:          number;
  alias_name:        string;
  alias_name_source: string;
  confidence:        string;
  from_lookup_chunk: boolean;
  needs_review?:     boolean;
  items:             Array<{ literal_value: string; matched_from_lookup: boolean }>;
}

interface RunStateBlob {
  status:    string;
  items:     Array<{ run_item_id?: number; literal_value: string; matched_from_lookup: boolean; [k: string]: unknown }>;
  groups:    BlobGroup[];
  ungrouped: Array<{ literal_value: string; matched_from_lookup: boolean }>;
  rev?:      number;
  [k: string]: unknown;
}

interface ExportPatch {
  new_groups:         Array<{ temp_group_id: number; alias_name_literal_value: string }>;
  moves:              Array<{ run_item_id: number; group_id: number | null }>;
  alias_name_changes: Array<{ group_id: number; alias_name_literal_value: string }>;
}

// Client mirror of applyStatePatch in /api/run/[run_id]/export/route.ts.
function applyStatePatchToBlob(state: RunStateBlob, patch: ExportPatch): RunStateBlob {
  let groups    = (state.groups ?? []).map((g) => ({ ...g, items: [...(g.items ?? [])] }));
  let ungrouped = [...(state.ungrouped ?? [])];
  const items   = state.items ?? [];

  // 1. Create new groups (client uses negative temp IDs).
  const tempToReal = new Map<number, number>();
  let nextGroupId = Math.max(0, ...groups.map((g) => g.group_id)) + 1;
  for (const ng of patch.new_groups) {
    const realId = nextGroupId++;
    tempToReal.set(ng.temp_group_id, realId);
    groups.push({
      group_id:          realId,
      alias_name:        ng.alias_name_literal_value,
      alias_name_source: 'user_override',
      confidence:        'h',
      from_lookup_chunk: false,
      items:             [],
    });
  }

  // 2. Apply item moves.
  for (const mv of patch.moves) {
    const targetGroupId = typeof mv.group_id === 'number' && mv.group_id < 0
      ? tempToReal.get(mv.group_id) ?? null
      : mv.group_id;

    const item = items.find((it) => it.run_item_id === mv.run_item_id);
    if (!item) continue;
    const { literal_value } = item;

    for (const g of groups) {
      g.items = g.items.filter((gi) => gi.literal_value !== literal_value);
    }
    ungrouped = ungrouped.filter((u) => u.literal_value !== literal_value);

    if (targetGroupId === null) {
      ungrouped.push({ literal_value, matched_from_lookup: item.matched_from_lookup });
    } else {
      const target = groups.find((g) => g.group_id === targetGroupId);
      if (target) {
        target.items.push({ literal_value, matched_from_lookup: item.matched_from_lookup });
      }
    }
  }

  // 3. Rename groups.
  for (const chg of patch.alias_name_changes) {
    const g = groups.find((gr) => gr.group_id === chg.group_id);
    if (g) {
      g.alias_name = chg.alias_name_literal_value;
      g.alias_name_source = 'user_override';
    }
  }

  // Drop empty groups created by moves.
  groups = groups.filter((g) => g.items.length > 0);

  return { ...state, groups, ungrouped };
}

const AUTOSAVE_INTERVAL_MS = 30_000;

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
  sourceRelation,
  sourceColumn,
  convention,
  standardizationRules,
  domainName,
}: {
  runId: string;
  initialRunStatus?: string;
  sourceRelation?: string;
  sourceColumn?: string;
  /** The column's deterministic naming convention (regex and/or form rules) — renames must conform. */
  convention?: { type: string | null; value: string; rules: ConventionRules | null } | null;
  /** The column's free-text standardization rules — displayed so the reviewer sees the contract. */
  standardizationRules?: string[];
  /** The column name — titles the standardization-rules panel (was the domain name). */
  domainName?: string;
}) {
  const warehouseLabel = useWarehouseLabel();
  const router = useRouter();
  const isAutoExport = true; // single-tier product — pipeline mode is the only mode

  const [aliasMap, setAliasMap] = useState<AliasMap | null>(null);
  const [uiAliasMap, setUiAliasMap] = useState<AliasMap | null>(null);
  const [aliasMapError, setAliasMapError] = useState<string | null>(null);
  const [loadingAliasMap, setLoadingAliasMap] = useState(true);
  // Bump to re-run the alias-mapping fetch (retry after a load failure, or
  // reload server truth after an autosave conflict).
  const [aliasMapReload, setAliasMapReload] = useState(0);

  const [nextTempGroupId, setNextTempGroupId] = useState(-1);
  const [pendingMoves, setPendingMoves] = useState<Record<number, number | null>>({});
  const [pendingAliasNames, setPendingAliasNames] = useState<Record<number, string>>({});
  const [editingAliasKey, setEditingAliasKey] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<any>(null);

  // Set when advancing the multi-column wizard fails to BUILD the next column's
  // review run (server error / network) — distinct from a genuinely-empty column.
  const [wizardAdvanceError, setWizardAdvanceError] = useState<{ column: string } | null>(null);
  const [retryingAdvance, setRetryingAdvance] = useState(false);

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
  // Superseded flag: once the user proceeds manually (advanceWizardForward), the
  // delayed prefetch must never write its (possibly stale) wizard snapshot back.
  const advanceInFlightRef = useRef(false);
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
      if (advanceInFlightRef.current) return; // user already proceeded manually
      try {
        const res  = await fetch(route, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (cancelled || advanceInFlightRef.current || !res.ok || !body?.run_id) return;  // empty/all-null column → built on demand at accept
        const builtRunId = Number(body.run_id);
        setWizard(prev => {
          if (!prev) return prev;
          // Merge into the LATEST persisted wizard (not this closure's snapshot)
          // so we never clobber a newer sessionStorage write with stale data.
          let latest: ColWizard = prev;
          try {
            const raw = sessionStorage.getItem(COL_WIZARD_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as ColWizard;
              if (Array.isArray(parsed?.runs)) latest = parsed;
            }
          } catch { /* fall back to prev */ }
          if (latest.runs[next] != null) return prev;   // someone already set it
          const runs = [...latest.runs];
          runs[next] = builtRunId;
          const updated = { ...latest, runs };
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
  const [hoveredDividerIdx, setHoveredDividerIdx] = useState<number | null>(null);
  const [groupOrder, setGroupOrder] = useState<string[] | null>(null);

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
    exportingRef.current = false;
    setExportResult(null);
    setExportError(null);
    setWizardAdvanceError(null);
    setRetryingAdvance(false);

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
  }, [runId, aliasMapReload]);

  // ── Autosave (RUNS.state blob) ─────────────────────────────────────────────
  // A 30 s timer PUTs the full state blob (with optimistic-concurrency rev)
  // whenever the user has unsaved changes; pagehide/beforeunload flush via
  // sendBeacon. Suspended while an export is in flight.

  const baseStateRef = useRef<RunStateBlob | null>(null);
  const revRef       = useRef(0);
  const dirtyRef     = useRef(false);
  const savingRef    = useRef(false);
  // Autosave-failure signal. The ref is what autosave() reads (it runs on a
  // timer outside React's render cycle); the state drives the banner.
  const saveFailedRef = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);
  function markSaveFailed() {
    if (saveFailedRef.current) return; // already warned — don't toast every tick
    saveFailedRef.current = true;
    setSaveFailed(true);
  }
  // One warning per outage, not one every 30s (see autosave / KI-84).
  const loadFailureWarnedRef = useRef(false);
  const exportingRef = useRef(false);

  function markDirty() { dirtyRef.current = true; }

  // Same request payload the export path sends — single source for both.
  function buildExportPatch(): ExportPatch {
    return {
      new_groups: Object.entries(uiAliasMap || {})
        .filter(([aliasName]) => aliasName !== UNGROUPED_KEY)
        .filter(([, g]) => typeof g?.group_id === 'number' && g.group_id < 0)
        .map(([alias_name_literal_value, g]) => ({
          temp_group_id: g.group_id as number,
          alias_name_literal_value,
        })),
      moves: Object.entries(pendingMoves).map(([run_item_id, group_id]) => ({
        run_item_id: Number(run_item_id), group_id,
      })),
      alias_name_changes: Object.entries(pendingAliasNames).map(([group_id, alias_name_literal_value]) => ({
        group_id: Number(group_id), alias_name_literal_value,
      })),
    };
  }

  function buildStateBlob(): RunStateBlob | null {
    const base = baseStateRef.current;
    if (!base) return null;
    return applyStatePatchToBlob(base, buildExportPatch());
  }
  const buildStateBlobRef = useRef<() => RunStateBlob | null>(buildStateBlob);
  buildStateBlobRef.current = buildStateBlob;

  async function loadBaseState(): Promise<boolean> {
    try {
      const res  = await fetch(`/api/run/${runId}/state`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return false;
      const st = (body?.state ?? body?.data ?? null) as RunStateBlob | null;
      if (st && typeof st === 'object') {
        baseStateRef.current = st;
        revRef.current = Number(st.rev ?? 0) || 0;
        return true;
      }
    } catch { /* autosave stays disabled until the blob loads */ }
    return false;
  }
  const loadBaseStateRef = useRef(loadBaseState);
  loadBaseStateRef.current = loadBaseState;

  useEffect(() => {
    dirtyRef.current = false;
    baseStateRef.current = null;
    revRef.current = 0;
    void loadBaseStateRef.current();
  }, [runId]);

  async function autosave() {
    if (!dirtyRef.current || savingRef.current || exportingRef.current) return;
    let blob = buildStateBlob();
    // A null blob means baseStateRef never loaded — the mount-time GET failed
    // (warehouse outage), and loadBaseState only re-runs on mount, after a 409,
    // or after an export. So autosave silently no-op'd on EVERY 30s tick for
    // the rest of the session while the page stayed fully editable: the user
    // kept working and their edits existed only in browser memory.
    //
    // Retry the load here instead of bailing — this is the one place that knows
    // the save is being prevented. If it still fails, TELL the user rather than
    // returning quietly; they can then copy their work out or reload before
    // losing more. See KI-84.
    if (!blob) {
      const recovered = await loadBaseStateRef.current();
      blob = recovered ? buildStateBlob() : null;
      if (!blob) {
        if (!loadFailureWarnedRef.current) {
          loadFailureWarnedRef.current = true;
          showToast(
            'Your changes are NOT being saved — Prism could not load this run from the warehouse. ' +
            'Reload the page once the connection recovers; edits made now may be lost.',
            'error',
          );
        }
        return;
      }
      // Recovered — allow a future failure to warn again.
      loadFailureWarnedRef.current = false;
    }
    savingRef.current = true;
    try {
      const res = await fetch(`/api/run/${runId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: blob, expectedRev: revRef.current }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        revRef.current = typeof body?.rev === 'number' ? body.rev : revRef.current + 1;
        dirtyRef.current = false;
        // Recovered from a previous failed save — clear the warning.
        if (saveFailedRef.current) {
          saveFailedRef.current = false;
          setSaveFailed(false);
        }
      } else if (res.status === 409) {
        // Someone else saved a newer state — take server truth (simplest safe
        // resolution), warn, and rehydrate the review UI from it.
        const body = await res.json().catch(() => ({}));
        if (typeof body?.currentRev === 'number') revRef.current = body.currentRev;
        await loadBaseStateRef.current();
        dirtyRef.current = false;
        showToast('This run was updated elsewhere — reloaded latest', 'info');
        setAliasMapReload((n) => n + 1);
      } else {
        // Any other failure (500 during a warehouse outage, gateway error).
        // Edits stay in memory and retry on the next tick, so nothing is lost
        // — but silence here meant a reviewer could work for an hour through
        // an outage with no hint their changes were not being persisted, and
        // then close the tab. Say so, once, until a save succeeds again.
        markSaveFailed();
      }
    } catch {
      // Network error — same reasoning as above; retry on the next tick.
      markSaveFailed();
    }
    finally { savingRef.current = false; }
  }
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;

  useEffect(() => {
    const timer = setInterval(() => { void autosaveRef.current(); }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Flush unsaved changes when the page is being closed/hidden, and warn on
  // accidental closes.
  //
  // DO NOT switch this back to navigator.sendBeacon. sendBeacon can only issue
  // POST, and /api/run/[run_id]/state exports GET and PUT only — so every
  // beacon flush 405'd and silently persisted NOTHING. The bug survived a long
  // time because sendBeacon returns `true` regardless of the response status,
  // its response is unreadable by design, and the call sat in a bare try/catch:
  // there was no signal anywhere that the save had failed. (The OTHER beacon in
  // this file works only because /api/timing does export POST.)
  //
  // fetch(..., { keepalive: true }) survives page unload the same way, but uses
  // the PUT the route actually implements AND lets us see the status, so a
  // future method/route change surfaces instead of silently losing edits.
  useEffect(() => {
    let lastBeaconAt = 0;
    function flushBeacon() {
      if (!dirtyRef.current || exportingRef.current) return;
      if (Date.now() - lastBeaconAt < 1000) return; // pagehide + beforeunload double-fire
      const blob = buildStateBlobRef.current();
      if (!blob) return;
      try {
        lastBeaconAt = Date.now();
        void fetch(`/api/run/${runId}/state`, {
          method:      'PUT',
          keepalive:   true,
          headers:     { 'Content-Type': 'application/json' },
          body:        JSON.stringify({ state: blob, expectedRev: revRef.current }),
        })
          .then((res) => {
            // A 409 here means someone else advanced the blob; the closing tab
            // has nowhere to show a toast, but we must not fail silently in the
            // logs the way the old beacon did.
            if (!res.ok) reportError(new Error(`unload flush failed: HTTP ${res.status}`), { runId });
          })
          .catch((err) => reportError(err, { runId, phase: 'unload-flush' }));
      } catch (err) { reportError(err, { runId, phase: 'unload-flush-sync' }); }
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current || exportingRef.current) return;
      flushBeacon();
      e.preventDefault();
      e.returnValue = '';
    }
    function onPageHide() { flushBeacon(); }
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [runId]);

  // ── History ───────────────────────────────────────────────────────────────

  function captureSnapshot(): Snapshot | null {
    if (!uiAliasMap) return null;
    return {
      uiAliasMap: structuredClone(uiAliasMap),
      pendingMoves: { ...pendingMoves },
      pendingAliasNames: { ...pendingAliasNames },
      nextTempGroupId,
    };
  }

  function applySnapshot(snap: Snapshot) {
    setUiAliasMap(snap.uiAliasMap);
    setPendingMoves(snap.pendingMoves);
    setPendingAliasNames(snap.pendingAliasNames);
    setNextTempGroupId(snap.nextTempGroupId);
    setEditingAliasKey(null);
    setEditingAliasValue('');
    setRenameError(null);
    setDragOverAliasName(null);
    setDraggingGroupName(null);
  }

  function pushHistory() {
    const snap = captureSnapshot();
    if (!snap) return;
    markDirty();
    setUndoStack((prev) => [...prev, snap]);
    setRedoStack([]);
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap = undoStack[undoStack.length - 1];
    const current = captureSnapshot();
    if (current) setRedoStack((prev) => [...prev, current]);
    setUndoStack((prev) => prev.slice(0, -1));
    markDirty();
    applySnapshot(snap);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const snap = redoStack[redoStack.length - 1];
    const current = captureSnapshot();
    if (current) setUndoStack((prev) => [...prev, current]);
    setRedoStack((prev) => prev.slice(0, -1));
    markDirty();
    applySnapshot(snap);
  }

  historyHandlersRef.current = { undo, redo };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Don't hijack undo/redo while typing — let the field's native
      // text-editing history handle it.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
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
    if (groupOrder) {
      const orderMap = new Map(groupOrder.map((k, i) => [k, i]));
      e.sort((a, b) => {
        const ai = orderMap.get(a[0]);
        const bi = orderMap.get(b[0]);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        return 0;
      });
    } else {
      e.sort((a, b) => {
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
    }
    return e;
  }, [uiAliasMap, groupOrder]);

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
  const reviewItems = useMemo(() =>
    Object.values(uiAliasMap ?? {}).flatMap(g => g.items).filter(i => i.needs_review),
  [uiAliasMap]);
  const reviewCount = reviewItems.length;

  // ── Group mutations ───────────────────────────────────────────────────────

  function makeUniqueGroupName(base: string, excludeKey?: string) {
    const map = uiAliasMap || {};
    if (!map[base] || base === excludeKey) return base;
    let i = 2;
    while (map[`${base} (${i})`] && `${base} (${i})` !== excludeKey) i += 1;
    return `${base} (${i})`;
  }

  function addGroup(afterIdx?: number) {
    pushHistory();
    const name = makeUniqueGroupName('Unnamed Group');
    const gid = nextTempGroupId;
    setNextTempGroupId((v) => v - 1);
    setUiAliasMap((prev) => {
      const next: AliasMap = structuredClone(prev || ({} as any));
      next[name] = { group_id: gid, display_name: name, items: [] };
      return next;
    });
    if (typeof afterIdx === 'number') {
      setGroupOrder((prev) => {
        const order = prev ?? groupEntries.map(([k]) => k);
        const copy = [...order];
        const insertPos = Math.min(afterIdx, copy.length);
        copy.splice(insertPos, 0, name);
        return copy;
      });
    } else {
      setGroupOrder((prev) => {
        const order = prev ?? groupEntries.map(([k]) => k);
        return [...order, name];
      });
    }
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

    if (editingAliasKey === fromAliasName) cancelRename();
    if (dragOverAliasName === fromAliasName) setDragOverAliasName(null);
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

    if (payload.type === 'group') {
      const { fromAliasName } = payload;
      // No-op drops (same target) must not arm the undo stack.
      if (fromAliasName === toAliasName || toAliasName === UNGROUPED_KEY) return;
      pushHistory();
      mergeGroups(fromAliasName, toAliasName);
      return;
    }

    const { fromAliasName, run_item_id, literal_value } = payload;
    // Dropping a chip back where it started is a no-op — don't arm undo/dirty.
    if (fromAliasName === toAliasName) return;
    pushHistory();

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

    // Same 200-char cap the LLM's proposed names get (sanitizeProposedName) —
    // also bounds the string any convention regex is tested against.
    if (newAliasName.length > 200) {
      setRenameError('Alias names are limited to 200 characters.');
      return;
    }

    // Enforce the column's deterministic naming conventions. Mirror the server's
    // treatment of LLM-proposed names: first auto-apply the mechanical form rules
    // (case, separators, …), then reject the rename if the result still violates
    // the regex pattern or a checkable rule (word count, length). The edit stays
    // open so the user can fix or Escape out.
    if (convention) {
      if (hasAnyRule(convention.rules)) {
        // `|| newAliasName` matters: a mechanical rule can reduce a name to the
        // empty string (special_chars='alnum_only' on '---'), and without this
        // fallback the empty result was committed as both the map key and the
        // display name. OneTimeReviewClient already had this guard; this client
        // did not, so the two review UIs disagreed. Keeping the pre-transform
        // value here lets the validation below reject it with a useful reason
        // instead of silently accepting an empty group name.
        newAliasName = applyConventionRules(newAliasName, convention.rules) || newAliasName;
        if (newAliasName === currentDisplayName) { cancelRename(); return; }
      }
      const problems = validateConventionViolations(newAliasName, convention.rules ?? null);
      if (convention.type === 'regex' && convention.value.trim()) {
        let re: RegExp | null = null;
        try { re = new RegExp(`^(?:${convention.value.trim()})$`); } catch { re = null; }
        if (re && !re.test(newAliasName)) {
          problems.unshift(`must match the column's naming pattern: ${convention.value.trim()}`);
        }
      }
      if (problems.length > 0) {
        setRenameError(
          `"${newAliasName}" doesn't meet this column's naming convention — ${problems.join('; ')}. ` +
          `The group keeps its previous name until the new one conforms.`,
        );
        return;
      }
    }
    setRenameError(null);
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
      setGroupOrder((prev) => prev?.map((k) => k === oldAliasName ? newAliasName : k) ?? null);

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


  async function doExport() {
    setExporting(true);
    exportingRef.current = true;
    setExportError(null);
    setExportResult(null);

    try {
      const res = await fetch(`/api/run/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildExportPatch()),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Export failed');

      setExportResult(body?.data || null);
      setPendingMoves({});
      setPendingAliasNames({});
      // The server persisted the patched state — autosave has nothing newer.
      dirtyRef.current = false;
      void loadBaseStateRef.current();

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
      exportingRef.current = false;
    }
  }

  // Accepting writes this column's confirmed mappings. If the user edited the
  // proposed standardizations (any undo history), confirm first that this updates
  // the mappings this column reuses; an unedited accept goes straight through.
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
    exportingRef.current = true;
    setExportError(null);
    setWizardAdvanceError(null);
    try {
      const res = await fetch(`/api/run/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Defer the lookup writes — just persist this column's reviewed groups
          // and mark it approved. The actual upserts happen at "Begin Pipeline
          // Standardization", behind a progress bar, so accepting each column is fast.
          defer: true,
          ...buildExportPatch(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to accept standardizations');

      // The server persisted the patched state — autosave has nothing newer.
      dirtyRef.current = false;

      // Already-LIVE pipeline (manual re-standardization review): the server
      // ignored `defer` and exported the reviewer's decisions for real — no
      // "Begin Pipeline" step exists for a running pipeline, so skip the
      // activation card entirely and return to the pipelines page.
      if (body?.pipeline_active === true) {
        try { sessionStorage.removeItem(COL_WIZARD_KEY); } catch { /* ignore */ }
        reportAcceptNav();
        router.push('/home?tab=pipelines');
        return;
      }

      // Multi-column wizard: move on to the next column instead of going home.
      if (inWizard) {
        const outcome = await advanceWizardForward();
        if (outcome === 'navigated') return; // navigated to the next column's run
        if (outcome === 'error') {
          // This column WAS accepted, but the next column's review run failed to
          // build — stay here with an inline retry instead of skipping the column.
          setExporting(false);
          exportingRef.current = false;
          return;
        }
        // 'done' — no further columns with data — finish.
      }

      // Fall back to the wizard's pipeline_id when the export couldn't resolve it
      // (e.g. multi-column Sheets where only the first column matches pipeline.column_name).
      const effectivePid = body?.pipeline_id ?? (wizard ? wizard.pids[0] : undefined);
      await finishWizard(effectivePid);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Failed to accept standardizations');
      setExporting(false);
      exportingRef.current = false;
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
   * when one exists, otherwise builds it via create-initial-run.
   *
   * Outcomes:
   *   'navigated' — opened the next column's run
   *   'done'      — no further columns with data (genuinely-empty columns skipped)
   *   'error'     — building a column's run FAILED (server/network). The failed
   *                 column is NOT skipped and the failure is NOT persisted —
   *                 wizardAdvanceError is set so the UI offers a retry.
   *
   * A column is only skipped when the API responds 200 with an explicit
   * { run_id: null } (create-initial-run / standardize-run's empty-source shape).
   */
  async function advanceWizardForward(): Promise<'navigated' | 'done' | 'error'> {
    if (!wizard) return 'done';
    advanceInFlightRef.current = true; // supersede the background prefetch
    const cur = wizard.runs.indexOf(Number(runId));
    const w: ColWizard = { ...wizard, runs: [...wizard.runs] };

    for (let next = cur + 1; next < w.pids.length; next++) {
      // Already have a run for this column — just open it.
      if (w.runs[next] != null) {
        sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
        reportAcceptNav();
        router.push(`/run/${w.runs[next]}`);
        return 'navigated';
      }
      // Build the review run for this column — from the queue for a 'standardize'
      // wizard (manual mode), or from the full source for a 'create' wizard.
      const route = w.kind === 'standardize'
        ? `/api/pipelines/${w.pids[next]}/standardize-run`
        : `/api/pipelines/${w.pids[next]}/create-initial-run`;
      let res: Response | null = null;
      try { res = await fetch(route, { method: 'POST' }); } catch { res = null; }
      const body = res ? await res.json().catch(() => ({})) : {};

      if (res?.ok && body?.run_id) {
        w.runs[next] = Number(body.run_id);
        sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
        reportAcceptNav();
        router.push(`/run/${body.run_id}`);
        return 'navigated';
      }

      if (res?.ok && body && 'run_id' in body && body.run_id == null) {
        // Explicit empty source ({ run_id: null }) — genuinely nothing to review.
        // Record the skip and try the next column.
        w.runs[next] = null;
        continue;
      }

      // Server error or network failure — NOT an empty column. Persist only the
      // genuine skips recorded so far, surface a retry, and don't advance.
      sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
      const colName = w.cols[next] ?? `column ${next + 1}`;
      setWizardAdvanceError({ column: colName });
      showToast(
        body?.error
          ? `Couldn't prepare "${colName}" for review: ${body.error}`
          : `Couldn't prepare "${colName}" for review. Check your connection and retry.`,
        'error',
      );
      return 'error';
    }
    // Persist any skips we recorded so a later Back pass doesn't retry them.
    sessionStorage.setItem(COL_WIZARD_KEY, JSON.stringify(w));
    return 'done';
  }

  /** Retry advancing after a failed next-column build (this run stays accepted). */
  async function retryWizardAdvance() {
    if (retryingAdvance) return;
    setRetryingAdvance(true);
    try {
      const outcome = await advanceWizardForward();
      if (outcome === 'navigated') {
        setWizardAdvanceError(null);
        return;
      }
      if (outcome === 'done') {
        setWizardAdvanceError(null);
        await finishWizard(wizard ? wizard.pids[0] : undefined);
      }
      // 'error' — wizardAdvanceError already refreshed; stay for another retry.
    } finally {
      setRetryingAdvance(false);
    }
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

  function proceedSfExport() {
    setSfExportModalOpen(false);
    void doExport();
  }

  // The "View created" success banner was removed 2026-08-08 (UI-07): it was
  // unreachable twice over. Its condition was `!isAutoExport && …`, but
  // isAutoExport is a hardcoded `true` (single-tier product), so the first half
  // was permanently false; and nothing in the codebase ever set
  // exportResult.view_fqn, so the second half could not become true either.
  // Views are created at activation now, not on export, and the card's
  // "Recreate view now" button is the surface for that.

  // ── Download Mapping helpers ─────────────────────────────────────────────

  // Commit the current review state to the lookup (same export POST + body the
  // "Accept Standardizations" path uses, minus `defer`). Awaited and checked —
  // the spreadsheet export reads LITERAL_ALIAS_MATCHES, which is empty until
  // this write lands. The backend is idempotent, so repeat calls are safe.
  async function ensureExportWritten(): Promise<void> {
    exportingRef.current = true; // suspend autosave while the export is in flight
    try {
      const res = await fetch(`/api/run/${runId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildExportPatch()),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Export failed');
      }
      dirtyRef.current = false;
      void loadBaseStateRef.current();
    } finally {
      exportingRef.current = false;
    }
  }

  // ── Google Sheets export ─────────────────────────────────────────────────

  async function doGoogleSheetsExportWithConfig(inc: boolean) {
    setGoogleSheetsLoading(true);
    setGoogleSheetsError(null);
    setGoogleSheetsUrl(null);
    try {
      // Make sure the mappings are committed before exporting them (idempotent —
      // usually already done when the download modal opened).
      await ensureExportWritten();

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
    // The export was already committed (awaited) when the modal loaded its rows.
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
    // The export was already committed (awaited) when the modal loaded its rows.
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
    <div>
      <ToastHost />

      {/* Autosave failure. Persistent (not a toast) because the condition
          persists: the reviewer needs to see it for as long as saves are
          failing, not for four seconds. Clears itself on the next good save. */}
      {saveFailed && (
        <div
          className="sticky top-0 z-40 text-xs font-medium"
          style={{
            backgroundColor: 'var(--accent-tint)',
            borderBottom: '0.5px solid var(--confidence-low)',
            color: 'var(--confidence-low)',
            padding: '8px 24px',
          }}
        >
          Couldn’t save your changes — still retrying. Your edits are safe in this tab; keep it open until this clears.
        </div>
      )}

      {/* ── Sticky top bar ───────────────────────────────────────────── */}
      <div className="sticky top-0 z-30" style={{ backgroundColor: 'var(--surface)', borderBottom: '0.5px solid var(--border)' }}>
        <div className="mx-auto flex items-center justify-between gap-4" style={{ maxWidth: 980, padding: '14px 24px' }}>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>Standardization review</h1>
            {sourceRelation && (
              <p className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                {sourceRelation}{sourceColumn ? ` · ${sourceColumn}` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => router.push('/home')}
              className="text-xs font-medium rounded-button px-3 py-2 border-[0.5px]"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
            >
              Cancel
            </button>
            {inWizard && colIndex > 0 && (
              <button
                type="button"
                onClick={goToPreviousColumn}
                disabled={exporting}
                className="text-xs font-medium rounded-button px-3 py-2 border-[0.5px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={requestAcceptStandardizations}
              disabled={exporting || loadingAliasMap || !!aliasMapError}
              className="text-xs font-medium rounded-button px-4 py-2 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {exporting
                ? 'Saving…'
                : inWizard && !isLastCol
                  ? 'Accept & continue'
                  : 'Accept Standardizations'}
            </button>
          </div>
        </div>
        {/* Column tabs (wizard mode) */}
        {inWizard && (
          <div className="mx-auto flex items-center gap-1.5 overflow-x-auto" style={{ maxWidth: 980, padding: '0 24px 12px' }}>
            {wizard!.cols.map((colName, i) => {
              const done    = i < colIndex;
              const current = i === colIndex;
              return (
                <span
                  key={i}
                  className="flex items-center gap-1.5 text-xs font-medium rounded-button px-3 py-1.5 border-[0.5px] whitespace-nowrap"
                  style={{
                    borderColor:     current ? 'var(--accent)' : 'var(--border)',
                    backgroundColor: current ? 'var(--accent-tint)' : 'var(--surface)',
                    color:           current ? 'var(--accent-strong)' : 'var(--text-secondary)',
                  }}
                >
                  <span className="font-mono">{colName}</span>
                  {done
                    ? <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2.5 7L5.5 10L11.5 4" stroke="#15803D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    : <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: current ? 'var(--accent)' : 'var(--text-hint)' }} />}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Page content ─────────────────────────────────────────────── */}
      <div className="mx-auto" style={{ maxWidth: 980, padding: '24px' }}>
        <div
          className="rounded-card border-[0.5px] p-6"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          {/* Card header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Alias groups
              </h2>
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs font-medium"
                style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--accent)' }} />
                {inWizard ? wizard!.cols[colIndex] : (sourceColumn || statusLabel)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                <span className="font-medium" style={{ color: 'var(--accent)' }}>{totalGroups}</span>
                {' '}group{totalGroups !== 1 ? 's' : ''}
              </span>
              <UndoButton onUndo={() => historyHandlersRef.current.undo()} disabled={exporting || undoStack.length === 0} />
            </div>
          </div>

          {/* Per-column scope notice */}
          <SpecScopeNotice style={{ marginBottom: 20 }} />

          <SpecChangeConfirmModal
            open={confirmAcceptOpen}
            busy={exporting}
            confirmLabel="Accept standardizations"
            body="You changed the proposed standardizations. Accepting writes them to this column's confirmed mappings, which it reuses the next time it standardizes."
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

        {/* Wizard advance error — the NEXT column's review run failed to build.
            This column is accepted; retry preparing the next one. */}
        {wizardAdvanceError && (
          <div
            className="flex items-center justify-between gap-3 rounded-button border-[0.5px] px-4 py-3 mb-5 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            <span>
              This column was accepted, but preparing <strong>{wizardAdvanceError.column}</strong> for review failed.
              It has not been skipped.
            </span>
            <button
              type="button"
              onClick={() => void retryWizardAdvance()}
              disabled={retryingAdvance}
              className="px-3 py-1.5 rounded-button border-[0.5px] text-xs font-medium flex-shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: '#FECACA', backgroundColor: 'var(--surface)', color: 'var(--confidence-low)' }}
            >
              {retryingAdvance ? 'Retrying…' : 'Retry'}
            </button>
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

        {/* Column standardization rules — the contract the reviewer is working under */}
        {(standardizationRules?.length ?? 0) > 0 && (
          <div
            className="rounded-card border-[0.5px] px-4 py-3.5 mb-5"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <div className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
              {domainName ? `${domainName} — standardization rules` : 'Standardization rules'}
            </div>
            <ul className="space-y-1">
              {standardizationRules!.map((rule, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <span aria-hidden="true" style={{ color: 'var(--text-hint)' }}>•</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Naming convention — shown for EVERY type, including the ones Prism
            cannot mechanically check. A reviewer working through hundreds of
            groups otherwise had no reminder of the naming contract they set up,
            and for `examples`/`natural` the review UI previously received
            nothing at all (SPEC-04). Labelled honestly so nobody assumes the
            non-enforceable types are being checked. */}
        {convention && (convention.value?.trim() || hasAnyRule(convention.rules)) && (
          <div
            className="rounded-card border-[0.5px] px-4 py-3.5 mb-5"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Naming convention
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-hint)' }}>
                {convention.type === 'regex' || hasAnyRule(convention.rules)
                  ? 'Enforced — renames are checked against this'
                  : 'Guidance for the AI — not checked automatically'}
              </span>
            </div>
            {convention.type === 'regex' && convention.value.trim() && (
              <p className="text-sm font-mono break-all" style={{ color: 'var(--text-secondary)' }}>
                {convention.value.trim()}
              </p>
            )}
            {convention.type === 'examples' && convention.value.trim() && (
              <ul className="space-y-1">
                {convention.value.split('\n').map(s => s.trim()).filter(Boolean).map((ex, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <span aria-hidden="true" style={{ color: 'var(--text-hint)' }}>•</span>
                    <span>{ex}</span>
                  </li>
                ))}
              </ul>
            )}
            {convention.type === 'natural' && convention.value.trim() && (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{convention.value.trim()}</p>
            )}
            {hasAnyRule(convention.rules) && (
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                {describeConventionRules(convention.rules!).join(' · ')}
              </p>
            )}
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
            className="flex items-center justify-between gap-3 rounded-button border-[0.5px] px-4 py-3 text-sm"
            style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}
          >
            <span>{aliasMapError}</span>
            <button
              type="button"
              onClick={() => setAliasMapReload((n) => n + 1)}
              className="px-3 py-1.5 rounded-button border-[0.5px] text-xs font-medium flex-shrink-0 transition-colors"
              style={{ borderColor: '#FECACA', backgroundColor: 'var(--surface)', color: 'var(--confidence-low)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#FEF2F2'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* ── Column headers ──────────────────────────────────────── */}
            <div
              className="grid items-center mb-1 pb-2 border-b-[0.5px]"
              style={{
                gridTemplateColumns: '36px 160px 1fr',
                borderColor: 'var(--border-subtle)',
              }}
            >
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
            </div>

            {/* ── Group rows ──────────────────────────────────────────── */}
            <div>
              {groupEntries.map(([aliasName, group], idx) => {
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
                        className="relative mx-3"
                        style={{ height: 0 }}
                        onMouseEnter={() => setHoveredDividerIdx(idx)}
                        onMouseLeave={() => setHoveredDividerIdx((prev) => prev === idx ? null : prev)}
                      >
                        <div
                          className="absolute left-0 right-0"
                          style={{ top: -6, height: 12, zIndex: 1, cursor: 'default' }}
                        />
                        <div
                          className="absolute left-0 right-0"
                          style={{
                            height: '0.5px',
                            top: 0,
                            backgroundColor: hoveredDividerIdx === idx ? 'var(--accent)' : 'var(--border-subtle)',
                            transition: 'background-color 0.15s',
                          }}
                        />
                        {hoveredDividerIdx === idx && (
                          <button
                            type="button"
                            onClick={() => addGroup(idx)}
                            className="absolute rounded-full"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 18,
                              height: 18,
                              left: -3,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              backgroundColor: 'var(--accent)',
                              color: '#fff',
                              fontSize: 13,
                              lineHeight: '18px',
                              textAlign: 'center',
                              padding: 0,
                              zIndex: 2,
                              border: 'none',
                              cursor: 'pointer',
                            }}
                            title="Add a group"
                          >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ display: 'block' }}>
                              <path d="M5 1v8M1 5h8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                      </div>
                    )}
                    <div
                      className="grid items-start py-[13px] rounded-row transition-colors"
                      style={{
                        gridTemplateColumns: '36px 160px 1fr',
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
                      {/* Col 1: Drag handle */}
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
                                  key={it.literal_value}
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

                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        </div>
      </div>

      {/* ── Confirmation modal ─────────────────────────────────────────── */}
      {sfExportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div
            className="w-full max-w-sm rounded-card border-[0.5px] p-6"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              Export to {warehouseLabel}
            </h3>
            <p className="text-xs mb-5" style={{ color: 'var(--text-hint)' }}>
              A view will be created in {warehouseLabel} with the standardized column appended.
            </p>

            {/* Include original column toggle */}
            <IncludeOriginalToggle
              value={includeOriginalCol}
              onChange={setIncludeOriginalCol}
            />

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
                Export
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
