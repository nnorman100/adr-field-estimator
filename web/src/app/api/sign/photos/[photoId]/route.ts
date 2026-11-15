import { linkRoute } from '@/lib/auth';
import { readLinkPhoto } from '@/lib/links';

export const dynamic = 'force-dynamic';

// One photo of the record a signing link shows (S5a-11b), by the id its photo log carries: only a
// photo of that submitted record, on the link's own job.
export const GET = linkRoute(readLinkPhoto);
