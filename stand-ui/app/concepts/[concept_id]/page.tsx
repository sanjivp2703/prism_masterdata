import Link from 'next/link';
import ConceptGroupingsClient from './ConceptGroupingsClient';

export default async function Page({
  params,
}: {
  params: Promise<{ concept_id: string }>;
}) {
  const { concept_id } = await params;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold tracking-wider text-blue-800 uppercase">
              Concept
            </div>
            <h1 className="text-3xl font-bold text-gray-900">
              Concept Groupings
            </h1>
          </div>
          <Link
            href="/home"
            className="px-3 py-2 rounded-md border border-gray-300 bg-white text-gray-800 text-sm font-semibold hover:bg-gray-50"
          >
            Back to Concepts
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-6">
          <ConceptGroupingsClient conceptId={concept_id} />
        </div>
      </div>
    </div>
  );
}


