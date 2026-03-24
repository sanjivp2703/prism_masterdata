'use client';

import { useEffect, useMemo, useState } from 'react';

type ApiConcept = {
  CONCEPT_ID?: number;
  CONCEPT_KEY?: string;
  DESCRIPTION?: string | null;
  DATA_TYPE?: string;
};

type Groupings = Record<
  string,
  {
    alias_id: number;
    items: Array<{ raw_value: string; confidence: number | null }>;
  }
>;

function formatConfidence(score: number | null) {
  if (score === null || score === undefined) return '';
  if (!Number.isFinite(score)) return '';
  if (score >= 0 && score <= 1) return `${Math.round(score * 100)}%`;
  return `${Math.round(score)}%`;
}

export default function ConceptGroupingsClient({
  conceptId,
}: {
  conceptId: string;
}) {
  const [concept, setConcept] = useState<ApiConcept | null>(null);
  const [groupings, setGroupings] = useState<Groupings>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/concepts/${conceptId}/groupings`, {
          cache: 'no-store',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to load groupings');
        if (!cancelled) {
          setConcept((body?.data?.concept || null) as ApiConcept | null);
          setGroupings((body?.data?.groupings || {}) as Groupings);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load groupings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [conceptId]);

  const entries = useMemo(() => {
    const e = Object.entries(groupings || {});
    e.sort((a, b) => a[0].localeCompare(b[0]));
    return e;
  }, [groupings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(([aliasName, g]) => {
      if (aliasName.toLowerCase().includes(q)) return true;
      return (g.items || []).some((it) => String(it.raw_value).toLowerCase().includes(q));
    });
  }, [entries, query]);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm text-gray-600">Concept</div>
          <div className="text-xl font-semibold text-gray-900">
            {concept?.CONCEPT_KEY ? String(concept.CONCEPT_KEY) : `#${conceptId}`}
          </div>
          {concept?.DESCRIPTION && (
            <div className="mt-1 text-sm text-gray-600">{String(concept.DESCRIPTION)}</div>
          )}
        </div>
        <div className="w-full sm:w-80">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search aliases / raw values…"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-gray-600 italic">Loading groupings…</div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 bg-white border border-gray-200 rounded-lg">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Alias Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Raw Values
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-sm text-gray-700">
                    No groupings found.
                  </td>
                </tr>
              ) : (
                filtered.map(([aliasName, group]) => {
                  const seen = new Set<string>();
                  const items = (group.items || []).filter((it) => {
                    const key = String(it.raw_value);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });

                  return (
                    <tr key={aliasName} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                        {aliasName}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {items.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {items.map((it) => (
                              <span
                                key={`${aliasName}:${it.raw_value}`}
                                className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-900"
                              >
                                {String(it.raw_value)}
                                {typeof it.confidence === 'number' &&
                                  Number.isFinite(it.confidence) && (
                                    <span className="ml-1 text-[10px] font-semibold text-gray-500">
                                      {formatConfidence(it.confidence)}
                                    </span>
                                  )}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-500 italic">No items</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


