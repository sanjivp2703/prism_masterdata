'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const TABLES = [
  'CLASSIFICATION_METADATA_PROFILES',
  'CONCEPTS',
  'ALIASES',
  'ALIAS_SUMMARY',
  'TOKENS_SUMMARY',
  'RAW_VALUES',
  'USERS',
  'RUNS',
  'RUN_GROUPS',
  'RUN_ITEMS',
  'RUN_APPLIED_TARGETS',
  'AUDIT_LOG',
];

export default function AdminPage() {
  const [tab, setTab] = useState<'tables' | 'validation'>('tables');

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">
          Database Admin
        </h1>

        <div className="flex items-center gap-2 mb-8">
          <button
            type="button"
            onClick={() => setTab('tables')}
            className={[
              'px-4 py-2 rounded-md text-sm font-semibold border',
              tab === 'tables'
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-900 border-gray-200 hover:bg-gray-50',
            ].join(' ')}
          >
            Tables
          </button>
          <button
            type="button"
            onClick={() => setTab('validation')}
            className={[
              'px-4 py-2 rounded-md text-sm font-semibold border',
              tab === 'validation'
                ? 'bg-purple-700 text-white border-purple-700'
                : 'bg-white text-gray-900 border-gray-200 hover:bg-gray-50',
            ].join(' ')}
          >
            Run Validation
          </button>
        </div>

        {tab === 'tables' ? (
          <div className="space-y-8">
            {TABLES.map((tableName) => (
              <TableSection key={tableName} tableName={tableName} />
            ))}
          </div>
        ) : (
          <RunValidationTab />
        )}
      </div>
    </div>
  );
}

function RunValidationTab() {
  const [runs, setRuns] = useState<
    Array<{
      run_id: number;
      source_relation: string;
      source_column: string;
      run_status: string;
      updated_at: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'validating': return 'bg-purple-100 text-purple-800';
      case 'running': return 'bg-blue-100 text-blue-800';
      case 'failed': return 'bg-red-100 text-red-800';
      case 'created': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/admin/validating-runs', { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to load validating runs');
        if (!cancelled) setRuns((body?.data || []) as any);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load validating runs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-semibold text-gray-800 mb-2">
        Run Validation
      </h2>
      <p className="text-sm text-gray-600 mb-4">
        Runs that were sent for approval (includes <span className="font-mono">completed</span>).
      </p>

      {loading ? (
        <div className="text-gray-500 italic">Loading…</div>
      ) : error ? (
        <div className="text-red-600 bg-red-50 p-4 rounded">{error}</div>
      ) : runs.length === 0 ? (
        <div className="text-gray-500 italic">No validating runs</div>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <div
              key={r.run_id}
              className="flex items-center justify-between gap-4 border border-gray-200 rounded-md px-4 py-3 hover:bg-gray-50"
            >
              <div className="min-w-0 flex items-center gap-3">
                <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase ${getStatusColor(r.run_status)}`}>
                  {r.run_status || 'unknown'}
                </span>
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900">
                    Run <span className="font-mono">{r.run_id}</span>
                  </div>
                  <div className="text-sm text-gray-600 truncate">
                    {r.source_relation} · {r.source_column}
                  </div>
                </div>
              </div>
              <Link
                href={`/admin/validating/${r.run_id}`}
                className="px-3 py-2 rounded-md bg-purple-700 text-white text-sm font-semibold hover:bg-purple-800"
              >
                {r.run_status === 'completed' ? 'View →' : 'Validate →'}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TableSection({ tableName }: { tableName: string }) {
  const [data, setData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch(`/api/admin/table/${tableName}`, {
          cache: 'no-store',
        });
        
        if (response.ok) {
          const result = await response.json();
          setData(result.data || []);
          setError(null);
        } else {
          const body = await response.json().catch(() => ({} as any));
          const msg =
            (body && (body.error || body.message)) ||
            `${response.status} ${response.statusText}`;
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
        <div className="text-red-600 bg-red-50 p-4 rounded">
          {error}
        </div>
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
                    <td
                      key={colIdx}
                      className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap"
                    >
                      {value === null
                        ? <span className="text-gray-400 italic">null</span>
                        : String(value)}
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

