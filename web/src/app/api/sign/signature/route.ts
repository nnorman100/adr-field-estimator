import { linkRoute } from '@/lib/auth';
import { readLinkSignature } from '@/lib/links';

export const dynamic = 'force-dynamic';

// The signature image of a used signing link's signed record (S5a-11b), while the record is shown.
export const GET = linkRoute(readLinkSignature);
