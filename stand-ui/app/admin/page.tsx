'use client';

import { useEffect, useState } from 'react';

const TABLES = [
  'SEMANTIC_CONCEPTS',
  'CONCEPT_ALIASES',
  'NORMALIZED_VALUES_ALIAS_VARIANTS',
  'RAW_VALUE_NORMALIZED_VARIANTS',
  'USERS',
  'RUNS',
  'RUN_GROUPS',
  'RUN_ITEMS',
  'RUN_APPLIED_TARGETS',
  'AUDIT_LOG',
];

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">
          Database Admin
        </h1>

        <div className="space-y-8">
          {TABLES.map((tableName) => (
            <TableSection key={tableName} tableName={tableName} />
          ))}
        </div>
      </div>
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
          setError(`Failed to fetch: ${response.statusText}`);
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

