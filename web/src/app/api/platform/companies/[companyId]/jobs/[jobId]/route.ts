import { operatorRoute } from '@/lib/auth';
import { supportJob } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of one job: its header, customer, claim, signed agreement and
// evidence list (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportJob);
