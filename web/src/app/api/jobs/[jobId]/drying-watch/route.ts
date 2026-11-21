import { requireFlag } from '@/lib/auth';
import { readWatch } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// The drying watch of a signed job (S5b-10, flag `drying_watch`): job readers read its status, worked
// out from the signed plan, the drying log and the clock, with the staff's decisions.
export const GET = requireFlag('drying_watch', readWatch);
