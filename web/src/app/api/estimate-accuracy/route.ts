import { requireFlag } from '@/lib/auth';
import { readAccuracy } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// The owner's estimate accuracy numbers (S5b-10, flag `estimate_assist`; price books and `prices_manage`):
// where closed jobs landed against their first signed estimates, and the suggested estimate settings.
export const GET = requireFlag('estimate_assist', readAccuracy);
