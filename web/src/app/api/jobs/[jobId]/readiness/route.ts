import { requireFlag } from '@/lib/auth';
import { readReadiness } from '@/lib/readiness';

export const dynamic = 'force-dynamic';

// S5b-11 "Ready to review?": the advisory gaps of the job's current editing draft, for the owner and
// the estimator with the job (scope work). Read-only; Finish and Submit never wait on it.
export const GET = requireFlag('readiness', readReadiness);
