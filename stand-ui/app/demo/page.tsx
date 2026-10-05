import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import DemoClient from './DemoClient';

export const metadata: Metadata = {
  title: 'Prism demo',
  description: 'Try Prism on sample data: group messy values, review them, and see the standardized result.',
};

/**
 * Public interactive demo — reachable without a session (see `isPublicPath` in
 * proxy.ts). Sample data only; the client component makes no network requests.
 */
export default async function DemoPage() {
  // Signed-in visitors already get the Prism mark from the root layout's fixed
  // header, so the page only draws its own for anonymous visitors.
  const sessionValue = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = sessionValue ? await decodeSession(sessionValue) : null;

  return <DemoClient showBrand={!session} />;
}
