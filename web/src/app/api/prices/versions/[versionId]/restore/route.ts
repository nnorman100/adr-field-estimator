import { requireFlag } from '@/lib/auth';
import { restoreVersion } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// Copies a published version into the working copy. Publishes nothing.
export const POST = requireFlag('price_books', restoreVersion);
