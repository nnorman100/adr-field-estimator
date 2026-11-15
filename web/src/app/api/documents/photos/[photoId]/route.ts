import { linkRoute } from '@/lib/auth';
import { readDocumentPhoto } from '@/lib/links';

export const dynamic = 'force-dynamic';

// One photo of a homeowner's document set (S5a-11b), by the id its photo log carries: only a photo of
// the signed record's submitted record, on the link's own job.
export const GET = linkRoute(readDocumentPhoto);
