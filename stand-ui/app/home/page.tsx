import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import AutoExportHome from './AutoExportHome';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { serviceConnectionSource } from '@/app/api/_lib/warehouse';
import { isFreshSetupSim } from '@/app/api/_lib/env';
import { anthropicKeySource } from '@/app/api/_lib/anthropic-key';

// Setup gate: a workspace with no warehouse connection or no LLM key can't do
// anything useful on /home, so admins are sent to the onboarding flow instead.
// Non-admins are let through — the personal /setup variant can't fix a
// workspace-level gap, so bouncing them there would only confuse.
// PRISM_FRESH_SETUP (dev-only fresh-install simulation) makes the gate ignore
// env-provided credentials, same as the /setup entry check — completing the
// flow (which saves workspace rows) satisfies the gate.
async function needsWorkspaceSetup(): Promise<boolean> {
  const raw = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = raw ? await decodeSession(raw) : null;
  if (session?.role !== 'admin') return false;

  const freshSim = isFreshSetupSim();
  const sf  = serviceConnectionSource();
  const llm = anthropicKeySource();
  const sfOk  = sf  === 'workspace' || (!freshSim && sf  === 'env');
  const llmOk = llm === 'workspace' || (!freshSim && llm === 'env');
  return !(sfOk && llmOk);
}

// AutoExportHome uses useSearchParams(), which requires a Suspense boundary
// in the Next.js App Router.
export default async function HomePage() {
  if (await needsWorkspaceSetup()) redirect('/setup?next=/home');
  return (
    <Suspense>
      <AutoExportHome />
    </Suspense>
  );
}
