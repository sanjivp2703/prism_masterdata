'use client';

import { useEffect, useMemo, useState } from 'react';

type AliasMap = Record<
  string,
  {
    group_id: number;
    items: Array<{ run_item_id: number; raw_value: string }>;
  }
>;

type DragPayload = {
  fromAliasName: string;
  run_item_id: number;
  raw_value: string;
};

export default function RunReviewClient({ runId }: { runId: string }) {
  const [aliasMap, setAliasMap] = useState<AliasMap | null>(null);
  const [uiAliasMap, setUiAliasMap] = useState<AliasMap | null>(null);
  const [aliasMapError, setAliasMapError] = useState<string | null>(null);
  const [loadingAliasMap, setLoadingAliasMap] = useState(true);

  const [checkedAliases, setCheckedAliases] = useState<Set<string>>(new Set());
  // UI-only until export: run_item_id -> new group_id (overwrites on subsequent moves)
  const [pendingMoves, setPendingMoves] = useState<Record<number, number>>({});
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

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragOverAliasName, setDragOverAliasName] = useState<string | null>(
    null
  );

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
    e.sort((a, b) => (a[1]?.group_id ?? 0) - (b[1]?.group_id ?? 0));
    return e;
  }, [uiAliasMap]);

  const totalGroups = entries.length;
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
    setCheckedAliases(new Set(entries.map(([aliasName]) => aliasName)));
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
      if (typeof toGroupId !== 'number') return prev;
      return { ...prev, [run_item_id]: toGroupId };
    });

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      const next: AliasMap = structuredClone(prev);
      const from = next[fromAliasName];
      const to = next[toAliasName];
      if (!from || !to) return prev;

      from.items = (from.items || []).filter((it) => it.run_item_id !== run_item_id);
      to.items = [...(to.items || []), { run_item_id, raw_value }];
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
    const newAliasName = editingAliasValue.trim();
    if (!newAliasName || newAliasName === oldAliasName) {
      cancelRename();
      return;
    }

    setUiAliasMap((prev) => {
      if (!prev) return prev;
      if (prev[newAliasName]) {
        setRenameError('That alias name already exists in this run.');
        return prev;
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
      setPendingAliasNames((p) => ({ ...p, [group.group_id]: newAliasName }));

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

  async function doExport() {
    setExporting(true);
    setExportError(null);
    setExportResult(null);

    try {
      const res = await fetch(`/api/run/${runId}/export-to-snowflake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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

  return (
    <div>
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
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
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
          Created view: <span className="font-mono">{exportResult.view_fqn}</span>
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
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {entries.map(([aliasName, group]) => {
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
                            {(group.items || []).map((it) => (
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
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-500 italic">No items</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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


