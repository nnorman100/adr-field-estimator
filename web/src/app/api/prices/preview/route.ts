import { requireFlag } from '@/lib/auth';
import { previewPrices } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// Prices the built-in sample jobs from the working copy (or a table in the body). Writes nothing.
export const POST = requireFlag('price_books', previewPrices);
