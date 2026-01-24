'use client';

import { useEffect, useMemo, useState } from 'react';

const UNGROUPED_KEY = '__UNGROUPED__';

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    items: Array<{
      run_item_id: number;
      raw_value: string;
      confidence_score: number | null;
    }>;
  }
>;

type DragPayload = {
  fromAliasName: string;
  run_item_id: number;
  raw_value: string;
};

function formatConfidence(score: number) {
  if (!Number.isFinite(score)) return '';
  // Most of our pipeline uses 0..1, but be resilient.
  if (score >= 0 && score <= 1) return `${Math.round(score * 100)}%`;
  return String(score);
}

export default function RunReviewClient({ runId }: { runId: string }) {
  const [aliasMap, setAliasMap] = useState<AliasMap | null>(null);
  const [uiAliasMap, setUiAliasMap] = useState<AliasMap | null>(null);
  const [aliasMapError, setAliasMapError] = useState<string | null>(null);
  const [loadingAliasMap, setLoadingAliasMap] = useState(true);

  const [checkedAliases, setCheckedAliases] = useState<Set<string>>(new Set());
  // Client-only temporary group ids for user-created groups (negative so they never collide with DB ids).
  const [nextTempGroupId, setNextTempGroupId] = useState(-1);
  // UI-only until export: run_item_id -> new group_id (overwrites on subsequent moves)
  const [pendingMoves, setPendingMoves] = useState<
    Record<number, number | null>
  >({});
  // UI-only until export: group_id -> new alias_name (overwrites on subsequent edits)
  const [pendingAliasNames, setPendingAliasNames] = useState<
    Record<number, string>
  >({});
  const [editingAliasKey, setEditingAliasKey] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<any>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragOverAliasName, setDragOverAliasName] = useState<string | null>(
    null
  );
  const [openMenuForAliasName, setOpenMenuForAliasName] = useState<
    string | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingAliasMap(true);
      setAliasMapError(null);

      try {
        const res = await fetch(`/api/run/${runId}/alias-mapping`, {
          cache: 'no-store',
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(body?.error || 'Failed to load alias mapping');
        }

        if (!cancelled) {
          const data = (body?.data || {}) as AliasMap;
          setAliasMap(data);
          // UI copy (this is what drag/drop mutates; does NOT persist)
          setUiAliasMap(structuredClone(data));
          setPendingMoves({});
          setPendingAliasNames({});
          setCheckedAliases(new Set());
          setEditingAliasKey(null);
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

    load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const entries = useMemo(() => {
    const e = Object.entries(uiAliasMap || {}) as Array<
      [string, AliasMap[string]]
    >;
    e.sort((a, b) => {
      const ag = a[1]?.group_id;
      const bg = b[1]?.group_id;
      if (ag == null && bg == null) return 0;
      if (ag == null) return 1; // null (ungrouped) last
      if (bg == null) return -1;
      // Place client-only groups (negative ids) after DB groups (positive ids)
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

  // Snapshot of initial grouping + score from the DB load (before any UI moves).
  const initialItemMeta = useMemo(() => {
    const meta = new Map<
      number,
      { initial_group_id: number | null; confidence_score: number | null }
    >();
    for (const [, group] of Object.entries(aliasMap || {})) {
      const gid = group?.group_id ?? null;
      for (const it of group?.items || []) {
        meta.set(it.run_item_id, {
          initial_group_id: gid,
          confidence_score: it.confidence_score ?? null,
        });
      }
    }
    return meta;
  }, [aliasMap]);

  const totalGroups = groupEntries.length;
  const uncheckedCount = totalGroups - checkedAliases.size;

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
    const name = makeUniqueGroupName('Unnamed Group');
    const gid = nextTempGroupId;
    setNextTempGroupId((v) => v - 1);

    setUiAliasMap((prev) => {
      const next: AliasMap = structuredClone(prev || ({} as any));
      next[name] = { group_id: gid, items: [] };
      return next;
    });

    // Immediately open rename
    setRenameError(null);
    setEditingAliasKey(name);
    setEditingAliasValue('');
  }

  function onDragStart(
    e: React.DragEvent,
    payload: DragPayload
  ) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
  }

  function onDropOnAlias(e: React.DragEvent, toAliasName: string) {
    e.preventDefault();
    setDragOverAliasName(null);

    let payload: DragPayload | null = null;
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/json'));
    } catch {
      payload = null;
    }
    if (!payload) return;

    const { fromAliasName, run_item_id, raw_value } = payload;
    if (fromAliasName === toAliasName) return;

    // record the new group_id (overwrite if moved multiple times)
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
          to = { group_id: null, items: [] };
          next[toAliasName] = to;
        } else {
          return prev;
        }
      }

      const dragged = (from.items || []).find((it) => it.run_item_id === run_item_id);
      from.items = (from.items || []).filter((it) => it.run_item_id !== run_item_id);
      to.items = [
        ...(to.items || []),
        {
          run_item_id,
          raw_value,
          confidence_score: dragged?.confidence_score ?? null,
        },
      ];
      return next;
    });
  }

  function startRename(aliasName: string) {
    setRenameError(null);
    setEditingAliasKey(aliasName);
    setEditingAliasValue(aliasName);
  }

  function cancelRename() {
    setRenameError(null);
    setEditingAliasKey(null);
    setEditingAliasValue('');
  }

  function commitRename(oldAliasName: string) {
    const desired = editingAliasValue.trim();
    let newAliasName = desired || 'Unnamed Group';
    if (newAliasName === oldAliasName) {
      cancelRename();
      return;
    }

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      if (prev[newAliasName] && newAliasName !== oldAliasName) {
        // Auto de-dupe rather than erroring.
        newAliasName = makeUniqueGroupName(newAliasName, oldAliasName);
      }

      const group = prev[oldAliasName];
      if (!group) {
        cancelRename();
        return prev;
      }

      const next: AliasMap = structuredClone(prev);
      delete next[oldAliasName];
      next[newAliasName] = group;

      // Track pending rename by group_id
      const gid = group.group_id;
      if (typeof gid === 'number') {
        setPendingAliasNames((p) => ({ ...p, [gid]: newAliasName }));
      }

      // Preserve checked state across rename
      setCheckedAliases((p) => {
        const s = new Set(p);
        if (s.has(oldAliasName)) {
          s.delete(oldAliasName);
          s.add(newAliasName);
        }
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

    const itemsToMove = (group.items || []).map((it) => ({
      run_item_id: it.run_item_id,
      raw_value: String(it.raw_value),
      confidence_score: it.confidence_score ?? null,
    }));

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      const existingUngrouped = next[UNGROUPED_KEY]?.items || [];

      const existingIds = new Set<number>(
        existingUngrouped.map((it) => Number(it.run_item_id))
      );
      const mergedUngrouped = [
        ...existingUngrouped,
        ...itemsToMove.filter((it) => !existingIds.has(it.run_item_id)),
      ];

      // ensure ungrouped bucket exists
      next[UNGROUPED_KEY] = {
        group_id: null,
        items: mergedUngrouped,
      };

      delete next[aliasName];
      return next;
    });

    // Mark all those items as ungrouped for export
    setPendingMoves((prev) => {
      const next = { ...prev };
      for (const it of itemsToMove) next[it.run_item_id] = null;
      return next;
    });

    // If there was a pending rename for this group_id, remove it
    const gid = group.group_id;
    if (typeof gid === 'number') {
      setPendingAliasNames((prev) => {
        const next = { ...prev };
        delete next[gid];
        return next;
      });
    }

    // Remove from checked set so it doesn't count anymore
    setCheckedAliases((prev) => {
      const next = new Set(prev);
      next.delete(aliasName);
      return next;
    });

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
      const res = await fetch(`/api/run/${runId}/export-to-snowflake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_groups: Object.entries(uiAliasMap || {})
            .filter(([aliasName]) => aliasName !== UNGROUPED_KEY)
            .filter(([, g]) => typeof g?.group_id === 'number' && g.group_id < 0)
            .map(([alias_name, g]) => ({
              temp_group_id: g.group_id,
              alias_name,
            })),
          moves: Object.entries(pendingMoves).map(([run_item_id, group_id]) => ({
            run_item_id: Number(run_item_id),
            group_id,
          })),
          alias_name_changes: Object.entries(pendingAliasNames).map(
            ([group_id, alias_name]) => ({
              group_id: Number(group_id),
              alias_name,
            })
          ),
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(body?.error || 'Export failed');
      }

      setExportResult(body?.data || null);

      // Moves are now persisted (we applied them just before export); clear the pending map
      setPendingMoves({});
      setPendingAliasNames({});

      // Reload mapping so the UI reflects the DB after updates
      const refreshed = await fetch(`/api/run/${runId}/alias-mapping`, {
        cache: 'no-store',
      });
      const refreshedBody = await refreshed.json().catch(() => ({}));
      if (refreshed.ok) {
        const data = (refreshedBody?.data || {}) as AliasMap;
        setAliasMap(data);
        setUiAliasMap(structuredClone(data));
      }
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  function onExportClick() {
    if (uncheckedCount > 0) {
      setConfirmOpen(true);
      return;
    }
    void doExport();
  }

  function acceptAllAndExport() {
    checkAll();
    setConfirmOpen(false);
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
      // Fallback for older browsers / restricted clipboard contexts
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
      } catch {
        // ignore
      }
    }
  }

  return (
    <div onClick={() => setOpenMenuForAliasName(null)}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-semibold text-gray-800">Run Review Interface</h2>

        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-600">
            Checked: <span className="font-medium text-gray-900">{checkedAliases.size}</span> /{' '}
            <span className="font-medium text-gray-900">{totalGroups}</span>
          </div>

          <button
            type="button"
            onClick={onExportClick}
            disabled={exporting || loadingAliasMap || !!aliasMapError}
            className={[
              'px-4 py-2 rounded-md text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed',
              uncheckedCount === 0 ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700',
            ].join(' ')}
          >
            {exporting ? 'Exporting…' : 'Export to Snowflake'}
          </button>
        </div>
      </div>

      {exportError && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
          {exportError}
        </div>
      )}

      {exportResult?.view_fqn && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span>Created view:</span>
            <span className="font-mono text-sm bg-white/60 border border-green-200 rounded px-2 py-1">
              {viewSql}
            </span>
            <button
              type="button"
              onClick={() => void copyViewSql()}
              className="px-3 py-1.5 rounded-md border border-green-300 bg-white text-green-900 text-sm font-semibold hover:bg-green-50"
            >
              {copiedSql ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {loadingAliasMap ? (
        <div className="text-gray-500 italic">Loading groups…</div>
      ) : aliasMapError ? (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {aliasMapError}
        </div>
      ) : (
        <div>
          <h3 className="text-lg font-semibold mb-3 text-gray-800">Alias Groups</h3>

          {renameError && (
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-900 px-4 py-3 rounded mb-4">
              {renameError}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                    ✓
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Alias Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Raw Values
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                    {/* actions */}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {groupEntries.map(([aliasName, group]) => {
                  const isChecked = checkedAliases.has(aliasName);

                  const seen = new Set<string>();
                  const rawValues: string[] = [];
                  for (const item of group.items || []) {
                    const v = String(item.raw_value);
                    if (!seen.has(v)) {
                      seen.add(v);
                      rawValues.push(v);
                    }
                  }

                  return (
                    <tr
                      key={aliasName}
                      className={[
                        'hover:bg-gray-50 align-top',
                        dragOverAliasName === aliasName ? 'bg-blue-50' : '',
                      ].join(' ')}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggle(aliasName)}
                          className={[
                            'w-8 h-8 rounded-full flex items-center justify-center text-white font-bold',
                            isChecked ? 'bg-green-600 hover:bg-green-700' : 'bg-yellow-500 hover:bg-yellow-600',
                          ].join(' ')}
                          aria-label={isChecked ? 'Checked' : 'Unchecked'}
                          title={isChecked ? 'Checked' : 'Unchecked'}
                        >
                          ✓
                        </button>
                      </td>
                      <td
                        className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap"
                        onDoubleClick={() => startRename(aliasName)}
                        title="Double-click to rename"
                      >
                        {editingAliasKey === aliasName ? (
                          <input
                            autoFocus
                            value={editingAliasValue}
                            onChange={(e) => setEditingAliasValue(e.target.value)}
                            onBlur={() => commitRename(aliasName)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(aliasName);
                              if (e.key === 'Escape') cancelRename();
                            }}
                            className="w-full max-w-xs px-2 py-1 border border-gray-300 rounded text-sm text-gray-900"
                          />
                        ) : (
                          aliasName
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-sm text-gray-900"
                        onDragOver={(e) => onDragOverAlias(e, aliasName)}
                        onDrop={(e) => onDropOnAlias(e, aliasName)}
                        onDragLeave={(e) => onDragLeaveAlias(e, aliasName)}
                      >
                        {rawValues.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
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
                                    fromAliasName: aliasName,
                                    run_item_id: it.run_item_id,
                                    raw_value: String(it.raw_value),
                                  })
                                }
                                className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-900 cursor-move"
                              >
                                {String(it.raw_value)}
                                {showScore && (
                                  <span className="ml-1 text-[10px] font-semibold text-gray-500">
                                    {formatConfidence(initialScore)}
                                  </span>
                                )}
                              </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-gray-500 italic">No items</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right align-top">
                        {editingAliasKey !== aliasName && (
                          <div className="relative inline-block text-left">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuForAliasName((prev) =>
                                  prev === aliasName ? null : aliasName
                                );
                              }}
                              className="w-8 h-8 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                              title="Group actions"
                              aria-label="Group actions"
                            >
                              ⋯
                            </button>

                            {openMenuForAliasName === aliasName && (
                              <div
                                className="absolute right-0 mt-1 w-36 rounded-md bg-white shadow-lg border border-gray-200 z-10"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => deleteGroup(aliasName)}
                                  className="w-full text-left px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-center">
            <button
              type="button"
              onClick={addGroup}
              className="inline-flex items-center justify-center w-10 h-10 rounded-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
              title="Add group"
              aria-label="Add group"
            >
              +
            </button>
          </div>

          <div className="mt-6">
            <h4 className="text-md font-semibold text-gray-800 mb-2">
              Ungrouped items
            </h4>
            <div
              className={[
                'rounded-md border border-dashed px-3 py-3',
                dragOverAliasName === UNGROUPED_KEY
                  ? 'bg-blue-50 border-blue-300'
                  : 'bg-gray-50 border-gray-300',
              ].join(' ')}
              onDragOver={(e) => onDragOverAlias(e, UNGROUPED_KEY)}
              onDrop={(e) => onDropOnAlias(e, UNGROUPED_KEY)}
              onDragLeave={(e) => onDragLeaveAlias(e, UNGROUPED_KEY)}
            >
              {(ungrouped?.items || []).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {(ungrouped?.items || []).map((it) => {
                    const meta = initialItemMeta.get(it.run_item_id);
                    const initialGroupId = meta?.initial_group_id ?? null;
                    const initialScore = meta?.confidence_score ?? null;
                    const pending = pendingMoves[it.run_item_id];

                    // Only show score in Ungrouped if the item started ungrouped (i.e. it wasn't moved here).
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
                          fromAliasName: UNGROUPED_KEY,
                          run_item_id: it.run_item_id,
                          raw_value: String(it.raw_value),
                        })
                      }
                      className="inline-flex items-center rounded-md bg-white px-2 py-1 text-xs font-medium text-gray-900 cursor-move border border-gray-200"
                    >
                      {String(it.raw_value)}
                      {showScore && (
                        <span className="ml-1 text-[10px] font-semibold text-gray-500">
                          {formatConfidence(initialScore)}
                        </span>
                      )}
                    </span>
                    );
                  })}
                </div>
              ) : (
                <div className="text-sm text-gray-600">
                  Drag items here to leave them ungrouped (export will set{' '}
                  <span className="font-mono">group_id</span> to{' '}
                  <span className="font-mono">NULL</span>).
                </div>
              )}
            </div>
          </div>

          <div className="mt-6">
            <h2 className="text-2xl font-semibold mb-4 text-gray-800">
              Alias → Raw Values Map (JSON)
            </h2>
            <pre className="text-xs text-black bg-gray-50 border border-gray-200 rounded p-4 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(uiAliasMap, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl border border-gray-200">
            <div className="p-5">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Unreviewed groups</h3>
              <p className="text-sm text-gray-700">
                You have <span className="font-semibold">{uncheckedCount}</span> groups unchecked.
              </p>
            </div>
            <div className="px-5 pb-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 rounded-md border border-gray-300 text-gray-800 text-sm font-semibold hover:bg-gray-50"
              >
                Go back and review
              </button>
              <button
                type="button"
                onClick={acceptAllAndExport}
                className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
              >
                Accept all &amp; export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


