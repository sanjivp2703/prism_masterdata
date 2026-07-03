import { notFound } from 'next/navigation';
import DebugClient from './DebugClient';

export const dynamic = 'force-dynamic';

export default function DebugPage() {
  // Operator-only tooling — hidden entirely unless explicitly enabled.
  if (process.env.PRISM_DEBUG_TOOLS !== 'true') notFound();
  return <DebugClient />;
}
