import type { Instrumentation } from 'next';
import { parseConfig } from '@/lib/config';

// Runs once when the server starts: a missing or invalid setting stops the process before it
// serves any request. Next.js alone would keep listening and fail every request instead.
export function register() {
  try {
    parseConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// One Error Reporting event per uncaught server error (src/lib/error-report.ts). Node only: the
// logger writes to process.stdout, so the edge runtime does nothing, and the module is loaded on
// first use so it never enters an edge bundle. Reporting must never raise a second error.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { reportServerError } = await import('@/lib/error-report');
    reportServerError(error, request, context);
  } catch {
    // Fixed text only: nothing about the failed report is safe to repeat.
    console.error('error report unavailable');
  }
};
