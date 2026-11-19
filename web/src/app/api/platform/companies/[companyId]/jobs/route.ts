import { operatorRoute } from '@/lib/auth';
import { supportJobs } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only support view of a company's jobs (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportJobs);
