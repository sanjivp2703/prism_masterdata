import { redirect } from 'next/navigation';

export default async function ConceptPage({
  params,
}: {
  params: Promise<{ concept_id: string }>;
}) {
  const { concept_id } = await params;
  redirect(`/concepts/${concept_id}`);
}


