import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { createDocumentLink, listDocumentLinks } from '@/lib/links';

export const dynamic = 'force-dynamic';

// Read-only document links of a signed job (S5a-11b): POST makes one for the homeowner's or the
// adjuster's set and answers its token once (`sign`); GET lists the job's links, never a token.
export const POST = requireCurrentClient(requireFlag('price_books', createDocumentLink));
export const GET = requireFlag('price_books', listDocumentLinks);
