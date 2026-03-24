'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type Concept = {
  CONCEPT_ID?: number;
  CONCEPT_KEY?: string;
  DESCRIPTION?: string | null;
  DATA_TYPE?: string;
  IS_ACTIVE?: boolean;
};

export default function HomePage() {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/concepts', { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to load concepts');
        if (!cancelled) setConcepts((body?.data || []) as Concept[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load concepts');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
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

  async function createConcept() {
    setCreating(true);
    setCreateError(null);
    try {
      const concept_key = newKey.trim();
      const description = newDesc.trim();
      const res = await fetch('/api/concepts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          concept_key,
          description: description.length ? description : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to create concept');

      setCreateOpen(false);
      setNewKey('');
      setNewDesc('');
      await refresh();

      const id = Number(body?.data?.CONCEPT_ID ?? body?.data?.concept_id);
      if (Number.isFinite(id)) {
        window.location.href = `/concepts/${id}`;
      }
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
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Concepts</h1>
            <p className="mt-1 text-sm text-gray-600">
              Browse available semantic concepts.
            </p>
            <p className="mt-2 text-sm text-gray-700">
              If you don&apos;t see your concept here, create a new one first, then do the
              standardization.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setCreateOpen((v) => !v);
                setCreateError(null);
              }}
              className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
            >
              Create concept
            </button>
            <Link
              href="/"
              className="px-3 py-2 rounded-md border border-gray-300 bg-white text-gray-800 text-sm font-semibold hover:bg-gray-50"
            >
              Back
            </Link>
          </div>
        </div>

        {createOpen && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-4">
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
                className="px-3 py-2 rounded-md border border-blue-200 bg-white text-blue-900 text-sm font-semibold hover:bg-blue-100"
                disabled={creating}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createConcept()}
                disabled={creating}
                className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
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
          <div className="text-gray-600 italic">Loading…</div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
            {error}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-700">
                No concepts found.
              </div>
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
                          {desc && (
                            <div className="mt-1 text-sm text-gray-600">{desc}</div>
                          )}
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
    </div>
  );
}


