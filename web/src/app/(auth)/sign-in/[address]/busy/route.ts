import { publicRoute } from '@/lib/auth';
import { isSignInAddress } from '@/lib/sign-in';

export const dynamic = 'force-dynamic';

const RETRY_SECONDS = 10;

// Where a company sign-in page goes when its lookup found no free database connection in time
// (security audit F5, load.ts): a plain 503 that tells the visitor to try again shortly, and has the
// browser open the company's sign-in page again after a few seconds.
export const GET = publicRoute(
  async (_request: Request, context: { params: Promise<Record<string, string | string[] | undefined>> }) => {
    const { address } = await context.params;
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(RETRY_SECONDS),
    };
    if (isSignInAddress(address)) headers.Refresh = `${RETRY_SECONDS}; url=/sign-in/${address}`;
    return new Response('DryScope is busy. Try again shortly.\n', { status: 503, headers });
  },
);
