import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { readAgreement, signJob } from '@/lib/agreements';

export const dynamic = 'force-dynamic';

// Signing on the phone (S5a-11). POST signs the job's current estimate with a signature already
// received through the photo route (?kind=signature): one transaction makes the agreement and marks
// the job signed; sent again it answers the same agreement. GET reads the signed record from its
// stored bytes. Both need the company's price books, as the estimate does.
export const POST = requireCurrentClient(requireFlag('price_books', signJob));
export const GET = requireFlag('price_books', readAgreement);
