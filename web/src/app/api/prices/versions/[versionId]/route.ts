import { requireFlag } from '@/lib/auth';
import { readVersion } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// One published version, whole.
export const GET = requireFlag('price_books', readVersion);
