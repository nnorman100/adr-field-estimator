import { linkRoute } from '@/lib/auth';
import { viewDocumentLink } from '@/lib/links';

export const dynamic = 'force-dynamic';

// A read-only document link (S5a-11b), by the token in the X-Link-Token header: the homeowner's or
// the adjuster's set of one signed agreement, from its stored bytes.
export const GET = linkRoute(viewDocumentLink);
