'use client';

import { useEffect } from 'react';
import './globals.css';
import { reportBoundaryError } from '@/lib/client-errors';

// The error boundary for the root layout itself. It replaces the layout, so it draws its own page
// and starts the reports itself (reportBoundaryError installs the hooks).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportBoundaryError(error), [error]);
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <button
            type="button"
            className="rounded-md border border-input px-4 py-2 text-base font-medium"
            onClick={reset}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
