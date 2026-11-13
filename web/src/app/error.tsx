'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { reportBoundaryError } from '@/lib/client-errors';

// The error boundary for every page inside the root layout. It reports what it caught (TC-2:
// src/lib/client-errors.ts keeps only the error name, a scrubbed message and the app's own frames).
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportBoundaryError(error), [error]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <Button type="button" variant="outline" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
