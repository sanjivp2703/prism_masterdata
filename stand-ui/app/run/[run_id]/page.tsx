import RunReviewClient from './RunReviewClient';

export default async function RunPage({
  params,
}: {
  params: Promise<{ run_id: string }>;
}) {
  const { run_id } = await params;

  let runData = null;
  let error = null;

  try {
    const response = await fetch(
      `http://localhost:8000/api/run/${run_id}`,
      { cache: 'no-store' }
    );
    
    if (response.ok) {
      const result = await response.json();
      runData = result.data;
    } else {
      error = 'Run not found';
    }
  } catch (e) {
    error = 'Failed to load run data';
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'running': return 'bg-blue-100 text-blue-800';
      case 'failed': return 'bg-red-100 text-red-800';
      case 'created': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="min-h-screen p-8 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-4xl font-bold text-gray-900">
              Run #{run_id}
            </h1>
            {runData && (
              <span className={`px-4 py-2 rounded-full text-sm font-semibold uppercase ${getStatusColor(runData.RUN_STATUS)}`}>
                {runData.RUN_STATUS}
              </span>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {runData && (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-600">Concept:</span>{' '}
                <span className="font-medium text-gray-900">{runData.CONCEPT_KEY}</span>
              </div>
              <div>
                <span className="text-gray-600">Mode:</span>{' '}
                <span className="font-medium text-gray-900">{runData.MODE}</span>
              </div>
              <div>
                <span className="text-gray-600">Source:</span>{' '}
                <span className="font-medium text-gray-900">{runData.SOURCE_RELATION}</span>
              </div>
              <div>
                <span className="text-gray-600">Column:</span>{' '}
                <span className="font-medium text-gray-900">{runData.SOURCE_COLUMN}</span>
              </div>
              <div>
                <span className="text-gray-600">Created By:</span>{' '}
                <span className="font-medium text-gray-900">{runData.CREATED_BY_NAME}</span>
              </div>
              <div>
                <span className="text-gray-600">Created:</span>{' '}
                <span className="font-medium text-gray-900">
                  {new Date(runData.CREATED_AT).toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow-lg p-6">
          <RunReviewClient runId={run_id} />
        </div>
      </div>
    </div>
  );
}

