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
  if (score >= 0 && score <= 1) return `${Math.round(score * 100)}%`;
  return String(score);
}

export default function RunValidationClient({ runId }: { runId: string }) {
  const [aliasMap, setAliasMap] = useState<AliasMap | null>(null);
  const [uiAliasMap, setUiAliasMap] = useState<AliasMap | null>(null);
  const [aliasMapError, setAliasMapError] = useState<string | null>(null);
  const [loadingAliasMap, setLoadingAliasMap] = useState(true);

  const [checkedAliases, setCheckedAliases] = useState<Set<string>>(new Set());
  const [nextTempGroupId, setNextTempGroupId] = useState(-1);
  const [userUngroupedGroupIds, setUserUngroupedGroupIds] = useState<Set<number>>(
    new Set()
  );
  const [pendingMoves, setPendingMoves] = useState<Record<number, number | null>>(
    {}
  );
  const [pendingAliasNames, setPendingAliasNames] = useState<
    Record<number, string>
  >({});
  const [editingAliasKey, setEditingAliasKey] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveSuccess, setApproveSuccess] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragOverAliasName, setDragOverAliasName] = useState<string | null>(
    null
  );
  const [openMenuForAliasName, setOpenMenuForAliasName] = useState<
    string | null
  >(null);

  function makeUniqueGroupNameForMap(
    map: AliasMap,
    base: string,
    excludeKey?: string
  ) {
    const trimmed = String(base || '').trim() || 'Unnamed Group';
    if (!map[trimmed] || trimmed === excludeKey) return trimmed;
    let i = 2;
    while (map[`${trimmed} (${i})`] && `${trimmed} (${i})` !== excludeKey) i += 1;
    return `${trimmed} (${i})`;
  }

  function applyUserUngroupedItemsTransform(data: AliasMap) {
    // Convert the "Ungrouped" bucket into one client-only group per item.
    // These groups behave exactly like user-added groups: group_id is negative and will be created on approve.
    const nextData: AliasMap = structuredClone(data || ({} as any));
    const ungroupedItems = nextData[UNGROUPED_KEY]?.items || [];
    delete nextData[UNGROUPED_KEY];

    const moves: Record<number, number | null> = {};
    const userUngroupedIds: number[] = [];
    let tempId = -1;

    for (const it of ungroupedItems) {
      const raw = String(it.raw_value ?? '').trim();
      const baseName = `${raw || 'Unnamed'} group`;
      const name = makeUniqueGroupNameForMap(nextData, baseName);

      const gid = tempId;
      tempId -= 1;
      userUngroupedIds.push(gid);
      nextData[name] = {
        group_id: gid,
        items: [
          {
            run_item_id: it.run_item_id,
            raw_value: String(it.raw_value),
            confidence_score: it.confidence_score ?? null,
          },
        ],
      };
      moves[it.run_item_id] = gid;
    }

    return { nextData, moves, nextTempGroupId: tempId, userUngroupedIds };
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingAliasMap(true);
      setAliasMapError(null);
      setApproveError(null);
      setApproveSuccess(false);

      try {
        const res = await fetch(`/api/run/${runId}/alias-mapping`, {
          cache: 'no-store',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to load alias mapping');

        if (!cancelled) {
          const data = (body?.data || {}) as AliasMap;
          setAliasMap(data);

          // Validation UX: no shared "Ungrouped" bucket.
          // Instead, each ungrouped item gets its own user-created group named "<raw_value> group".
          const { nextData, moves, nextTempGroupId, userUngroupedIds } =
            applyUserUngroupedItemsTransform(
            structuredClone(data)
          );

          setUiAliasMap(nextData);
          setPendingMoves(moves);
          setNextTempGroupId(nextTempGroupId);
          setUserUngroupedGroupIds(new Set(userUngroupedIds));
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

  const normalGroupEntries = useMemo(() => {
    return groupEntries.filter(([, group]) => {
      const gid = group?.group_id;
      return !(typeof gid === 'number' && userUngroupedGroupIds.has(gid));
    });
  }, [groupEntries, userUngroupedGroupIds]);

  const userUngroupedEntries = useMemo(() => {
    return groupEntries.filter(([, group]) => {
      const gid = group?.group_id;
      return typeof gid === 'number' && userUngroupedGroupIds.has(gid);
    });
  }, [groupEntries, userUngroupedGroupIds]);

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

    setRenameError(null);
    setEditingAliasKey(name);
    setEditingAliasValue('');
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

      const gid = group.group_id;
      if (typeof gid === 'number') {
        setPendingAliasNames((p) => ({ ...p, [gid]: newAliasName }));
      }

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

  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
  }

  function onDropOnAlias(e: React.DragEvent, toAliasName: string) {
    e.preventDefault();
    setDragOverAliasName(null);

    // No shared "Ungrouped" drop zone in validation.
    if (toAliasName === UNGROUPED_KEY) return;

    let payload: DragPayload | null = null;
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/json'));
    } catch {
      payload = null;
    }
    if (!payload) return;

    const { fromAliasName, run_item_id, raw_value } = payload;
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
        return prev;
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

    const movedToNewGroups: Array<{ run_item_id: number; group_id: number }> = [];
    let tempId = nextTempGroupId;

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      delete next[aliasName];

      // Convert moved items into their own client-only groups (same behavior as if user added them).
      for (const it of itemsToMove) {
        const raw = String(it.raw_value ?? '').trim();
        const baseName = `${raw || 'Unnamed'} group`;
        const name = makeUniqueGroupNameForMap(next, baseName);
        const gid = tempId;
        tempId -= 1;
        movedToNewGroups.push({ run_item_id: it.run_item_id, group_id: gid });
        next[name] = {
          group_id: gid,
          items: [
            {
              run_item_id: it.run_item_id,
              raw_value: String(it.raw_value),
              confidence_score: it.confidence_score ?? null,
            },
          ],
        };
      }
      return next;
    });

    setPendingMoves((prev) => {
      const next = { ...prev };
      for (const it of itemsToMove) delete next[it.run_item_id];
      for (const m of movedToNewGroups) next[m.run_item_id] = m.group_id;
      return next;
    });

    setNextTempGroupId(tempId);
    setUserUngroupedGroupIds((prev) => {
      const next = new Set(prev);
      const gid = group.group_id;
      if (typeof gid === 'number') next.delete(gid);
      for (const m of movedToNewGroups) next.add(m.group_id);
      return next;
    });

    const gid = group.group_id;
    if (typeof gid === 'number') {
      setPendingAliasNames((prev) => {
        const next = { ...prev };
        delete next[gid];
        return next;
      });
    }

    setCheckedAliases((prev) => {
      const next = new Set(prev);
      next.delete(aliasName);
      return next;
    });

    if (editingAliasKey === aliasName) cancelRename();
    if (dragOverAliasName === aliasName) setDragOverAliasName(null);
    if (openMenuForAliasName === aliasName) setOpenMenuForAliasName(null);
  }

  async function doApprove() {
    setApproving(true);
    setApproveError(null);
    setApproveSuccess(false);

    try {
      const res = await fetch(`/api/run/${runId}/approve`, {
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
      if (!res.ok) throw new Error(body?.error || 'Approve failed');

      setApproveSuccess(true);
      setPendingMoves({});
      setPendingAliasNames({});
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setApproving(false);
    }
  }

  function onApproveClick() {
    if (uncheckedCount > 0) {
      setConfirmOpen(true);
      return;
    }
    void doApprove();
  }

  function acceptAllAndApprove() {
    checkAll();
    setConfirmOpen(false);
    void doApprove();
  }

  return (
    <div onClick={() => setOpenMenuForAliasName(null)}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-semibold text-gray-800">
          Run <span className="font-mono">{runId}</span>
        </h2>

        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-600">
            Checked: <span className="font-medium text-gray-900">{checkedAliases.size}</span> /{' '}
            <span className="font-medium text-gray-900">{totalGroups}</span>
          </div>

          <button
            type="button"
            onClick={onApproveClick}
            disabled={approving || loadingAliasMap || !!aliasMapError}
            className="px-4 py-2 rounded-md bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>

      {approveError && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
          {approveError}
        </div>
      )}

      {approveSuccess && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded mb-4">
          Approved.
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
                {normalGroupEntries.map(([aliasName, group]) => {
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
                            isChecked
                              ? 'bg-green-600 hover:bg-green-700'
                              : 'bg-yellow-500 hover:bg-yellow-600',
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
              User Ungrouped Items
            </h4>
            <div className="text-sm text-gray-700">
              Each ungrouped item is automatically placed into its own user-created group named{' '}
              <span className="font-mono">&quot;&lt;raw_value&gt; group&quot;</span>. These behave
              the same as groups you add manually.
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                      ✓
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Group Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Item
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                      {/* actions */}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {userUngroupedEntries.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-3 text-sm text-gray-600 italic"
                      >
                        No ungrouped items.
                      </td>
                    </tr>
                  ) : (
                    userUngroupedEntries.map(([aliasName, group]) => {
                      const isChecked = checkedAliases.has(aliasName);
                      const item = (group.items || [])[0];
                      return (
                        <tr key={aliasName} className="hover:bg-gray-50 align-top">
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => toggle(aliasName)}
                              className={[
                                'w-8 h-8 rounded-full flex items-center justify-center text-white font-bold',
                                isChecked
                                  ? 'bg-green-600 hover:bg-green-700'
                                  : 'bg-yellow-500 hover:bg-yellow-600',
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
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {item ? (
                              <span
                                key={item.run_item_id}
                                draggable
                                onDragStart={(e) =>
                                  onDragStart(e, {
                                    fromAliasName: aliasName,
                                    run_item_id: item.run_item_id,
                                    raw_value: String(item.raw_value),
                                  })
                                }
                                className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-900 cursor-move"
                              >
                                {String(item.raw_value)}
                              </span>
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
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl border border-gray-200">
            <div className="p-5">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Unreviewed groups
              </h3>
              <p className="text-sm text-gray-700">
                You have <span className="font-semibold">{uncheckedCount}</span>{' '}
                groups unchecked.
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
                onClick={acceptAllAndApprove}
                className="px-4 py-2 rounded-md bg-green-600 text-white text-sm font-semibold hover:bg-green-700"
              >
                Accept all &amp; approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


