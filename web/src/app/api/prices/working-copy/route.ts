import { requireFlag } from '@/lib/auth';
import { saveWorkingCopy } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The owner saves the whole table as the working copy; a stale revision answers 409.
export const PUT = requireFlag('price_books', saveWorkingCopy);
