import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { previewReprice, repriceJob } from '@/lib/estimates';

export const dynamic = 'force-dynamic';

// S5b-6 Reprice this draft: the owner (`job_reprice`) moves the job's price pin to the company's
// current published prices; the next estimate is priced from them. Needs the company's price books.
export const POST = requireCurrentClient(requireFlag('price_books', repriceJob));
// GET is the owner's before/after preview; it writes nothing.
export const GET = requireFlag('price_books', previewReprice);
