'use client';

import { useState } from 'react';

export default function ExportToSnowflakeButton({
  runId,
}: {
  runId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/run/${runId}/export-to-snowflake`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body?.error || 'Export failed');
        return;
      }

      setResult(body?.data || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? 'Exporting…' : 'Export to Snowflake'}
      </button>

      {error && (
        <span className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </span>
      )}

      {result?.view_fqn && (
        <span className="text-sm text-gray-800 bg-gray-50 border border-gray-200 px-3 py-2 rounded">
          Created view: <span className="font-mono">{result.view_fqn}</span>
        </span>
      )}
    </div>
  );
}


