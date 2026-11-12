import { requireFlag } from '@/lib/auth';
import { listVersions } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The owner's list of published versions, newest first.
export const GET = requireFlag('price_books', listVersions);
