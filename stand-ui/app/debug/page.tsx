import { notFound } from 'next/navigation';
import { isNativeEdition } from '@/app/api/_lib/edition';
import DebugClient from './DebugClient';

export const dynamic = 'force-dynamic';

export default function DebugPage() {
  // Operator-only tooling — hidden entirely unless explicitly enabled.
  // Hard-off in the native (Marketplace) edition regardless of env.
  if (isNativeEdition() || process.env.PRISM_DEBUG_TOOLS !== 'true') notFound();
  return <DebugClient />;
}
