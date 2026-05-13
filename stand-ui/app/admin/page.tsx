'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

// ── Tables tab ────────────────────────────────────────────────────────────────

const TABLES: { name: string; section?: string }[] = [
  { name: 'CLASSIFICATION_METADATA_PROFILES' },
  { name: 'CONCEPTS' },
  { name: 'ALIASES' },
  { name: 'ALIAS_SUMMARY' },
  { name: 'TOKENS_SUMMARY' },
  { name: 'ALIAS_ITEMS' },
  { name: 'USERS' },
  { name: 'RUNS' },
  { name: 'RUN_GROUPS' },
  { name: 'RUN_ITEMS' },
  { name: 'RUN_APPLIED_TARGETS' },
  { name: 'AUDIT_LOG' },
  { name: 'ONE_PROMPT_RUN_STATE',             section: 'One-Prompt' },
  { name: 'ONE_PROMPT_LITERAL_ALIAS_MATCHES', section: 'One-Prompt' },
  { name: 'ONE_PROMPT_APPROVED_ALIAS_NAMES',  section: 'One-Prompt' },
  { name: 'ONE_PROMPT_VALIDATION_LOG',        section: 'One-Prompt' },
];

function TableSection({ tableName }: { tableName: string }) {
  const [data, setData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch(`/api/admin/table/${tableName}`, { cache: 'no-store' });
        if (response.ok) {
          const result = await response.json();
          setData(result.data || []);
          setError(null);
        } else {
          const body = await response.json().catch(() => ({} as any));
          const msg = (body && (body.error || body.message)) || `${response.status} ${response.statusText}`;
          const details = body?.details ? ` (${String(body.details)})` : '';
          setError(`Failed to fetch: ${msg}${details}`);
        }
      } catch (e) {
        setError(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [tableName]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">
        {tableName}
        <span className="ml-3 text-sm font-normal text-gray-500">
          ({loading ? '...' : `${data.length} rows`})
        </span>
      </h2>
      {loading ? (
        <div className="text-gray-500 italic">Loading...</div>
      ) : error ? (
        <div className="text-red-600 bg-red-50 p-4 rounded">{error}</div>
      ) : data.length === 0 ? (
        <div className="text-gray-500 italic">No data</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {Object.keys(data[0]).map((key) => (
                  <th
                    key={key}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((row, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  {Object.values(row).map((value, colIdx) => (
                    <td key={colIdx} className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">
                      {value === null ? (
                        <span className="text-gray-400 italic">null</span>
                      ) : (
                        String(value)
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
  );
}

// ── Concepts tab ──────────────────────────────────────────────────────────────

type Concept = {
  CONCEPT_ID?: number;
  CONCEPT_KEY?: string;
  DESCRIPTION?: string | null;
  DATA_TYPE?: string;
  IS_ACTIVE?: boolean;
};

function ConceptsTab() {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/concepts', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to load concepts');
      setConcepts((body?.data || []) as Concept[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load concepts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createConcept() {
    setCreating(true);
    setCreateError(null);
    try {
      const concept_key = newKey.trim();
      const description = newDesc.trim();
      const res = await fetch('/api/concepts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept_key, description: description.length ? description : null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to create concept');

      setCreateOpen(false);
      setNewKey('');
      setNewDesc('');
      await load();

      const id = Number(body?.data?.CONCEPT_ID ?? body?.data?.concept_id);
      if (Number.isFinite(id)) window.location.href = `/concepts/${id}`;
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create concept');
    } finally {
      setCreating(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return concepts;
    return concepts.filter((c) => {
      const key = String(c.CONCEPT_KEY ?? '').toLowerCase();
      const desc = String(c.DESCRIPTION ?? '').toLowerCase();
      return key.includes(q) || desc.includes(q);
    });
  }, [concepts, query]);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-gray-800">Concepts</h2>
          <p className="mt-1 text-sm text-gray-600">
            Browse and manage semantic concepts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setCreateOpen((v) => !v); setCreateError(null); }}
          className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
        >
          Create concept
        </button>
      </div>

      {createOpen && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <div className="text-xs font-bold tracking-wider text-blue-800 uppercase mb-1">
                Name (concept_key)
              </div>
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="e.g. mobile_carrier"
                className="w-full rounded-md border border-blue-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <div className="mt-1 text-xs text-blue-900/70">
                Use lowercase letters, numbers, underscores.
              </div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs font-bold tracking-wider text-blue-800 uppercase mb-1">
                Short description (optional)
              </div>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Optional short description…"
                className="w-full rounded-md border border-blue-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>
          {createError && (
            <div className="mt-3 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
              {createError}
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
              className="px-3 py-2 rounded-md border border-blue-200 bg-white text-blue-900 text-sm font-semibold hover:bg-blue-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void createConcept()}
              disabled={creating || !newKey.trim()}
              className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      <div className="mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search concepts…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
      </div>

      {loading ? (
        <div className="text-gray-500 italic">Loading…</div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">{error}</div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-gray-700">No concepts found.</div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {filtered.map((c) => {
                const id = Number(c.CONCEPT_ID);
                const key = String(c.CONCEPT_KEY ?? '');
                const desc = c.DESCRIPTION ? String(c.DESCRIPTION) : '';
                const href = Number.isFinite(id) ? `/concepts/${id}` : '#';
                return (
                  <li key={`${id}-${key}`} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">
                          {key || 'Unnamed concept'}
                        </div>
                        {desc && <div className="mt-1 text-sm text-gray-600">{desc}</div>}
                      </div>
                      {Number.isFinite(id) ? (
                        <Link
                          href={href}
                          className="shrink-0 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
                        >
                          Open
                        </Link>
                      ) : (
                        <span className="shrink-0 px-3 py-2 rounded-md bg-gray-100 text-gray-500 text-sm font-semibold">
                          N/A
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = 'tables' | 'concepts';

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<Tab>('concepts');

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-6">Admin</h1>

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-gray-200 mb-8">
          {([['concepts', 'Concepts'], ['tables', 'Database tables']] as [Tab, string][]).map(
            ([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={[
                  'px-4 py-2.5 text-sm font-medium rounded-t-md border-b-2 -mb-px transition-colors',
                  activeTab === id
                    ? 'border-blue-600 text-blue-700 bg-white'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                ].join(' ')}
              >
                {label}
              </button>
            )
          )}
        </div>

        {activeTab === 'concepts' && <ConceptsTab />}

        {activeTab === 'tables' && (
          <div className="space-y-8">
            {TABLES.map((entry, i) => (
              <div key={entry.name}>
                {entry.section && (i === 0 || TABLES[i - 1].section !== entry.section) && (
                  <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4 mt-2">
                    {entry.section}
                  </h2>
                )}
                <TableSection tableName={entry.name} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
