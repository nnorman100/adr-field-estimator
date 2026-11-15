import { linkRoute } from '@/lib/auth';
import { readDocumentSignature } from '@/lib/links';

export const dynamic = 'force-dynamic';

// The signature on a homeowner's document set (S5a-11b).
export const GET = linkRoute(readDocumentSignature);
