import { requireFlag } from '@/lib/auth';
import { exportPrices } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The working copy as a CSV price list.
export const GET = requireFlag('price_books', exportPrices);
