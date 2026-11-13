import { requireFlag } from '@/lib/auth';
import { importPrices } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The owner applies a CSV price list to the working copy; nothing is published and a stale
// revision answers 409.
export const POST = requireFlag('price_books', importPrices);
