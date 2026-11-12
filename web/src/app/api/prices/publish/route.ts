import { requireFlag } from '@/lib/auth';
import { publishPrices } from '@/lib/prices';

export const dynamic = 'force-dynamic';

// The owner publishes the working copy as the next version. The sign-in must be under 15 minutes
// old (Q10).
export const POST = requireFlag('price_books', publishPrices, { freshSignIn: true });
