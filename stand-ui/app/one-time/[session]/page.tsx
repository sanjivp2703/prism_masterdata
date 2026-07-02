import OneTimeReviewClient from './OneTimeReviewClient';

export default async function OneTimeReviewPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return <OneTimeReviewClient session={session} />;
}
