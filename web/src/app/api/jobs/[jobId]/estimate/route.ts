import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { makeEstimate, readEstimate } from '@/lib/estimates';

export const dynamic = 'force-dynamic';

// The estimate and the four documents of a job's submitted record (S5a-9). POST prices the record
// from the job's pinned prices (pinning it at first price) and stores the estimate once; sent again
// it answers the same estimate. GET reads the current one. Both need the company's price books.
export const POST = requireCurrentClient(requireFlag('price_books', makeEstimate));
export const GET = requireFlag('price_books', readEstimate);
