import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { createSigningLink, readSigningLink, revokeSigningLink } from '@/lib/links';

export const dynamic = 'force-dynamic';

// The homeowner signing link of a job (S5a-11b): POST makes one for the job's current estimate and
// answers its token once; GET reads the job's newest link and its state, never a token; DELETE
// revokes the pending one. All need `sign` and the company's price books, as signing does.
export const POST = requireCurrentClient(requireFlag('price_books', createSigningLink));
export const GET = requireFlag('price_books', readSigningLink);
export const DELETE = requireCurrentClient(requireFlag('price_books', revokeSigningLink));
