import { operatorRoute, publicRoute } from '@/lib/auth';
import { supportHead, supportJobs } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of a company's jobs (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportJobs);

// HEAD is refused (405) before any sign-in check, read or audit: only the GET that sends a view
// reads it and writes its audit row.
export const HEAD = publicRoute(supportHead);
