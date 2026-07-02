'use client';

import { Suspense } from 'react';
import AutoExportHome from './AutoExportHome';

// AutoExportHome uses useSearchParams(), which requires a Suspense boundary
// in the Next.js App Router.
export default function HomePage() {
  return (
    <Suspense>
      <AutoExportHome />
    </Suspense>
  );
}
