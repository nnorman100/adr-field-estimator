import { operatorRoute, publicRoute } from '@/lib/auth';
import { supportHead, supportJob } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of one job: its header, customer, claim, signed agreement and
// evidence list (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportJob);

// HEAD is refused (405) before any sign-in check, read or audit: only the GET that sends a view
// reads it and writes its audit row.
export const HEAD = publicRoute(supportHead);
