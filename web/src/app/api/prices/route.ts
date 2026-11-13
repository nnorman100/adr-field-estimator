import { requireFlag } from '@/lib/auth';
import { readPrices } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The current published prices; the owner also gets the working copy (the starter list for a
// company that has not saved yet). A reader sees the enabled items only.
export const GET = requireFlag('price_books', readPrices);
