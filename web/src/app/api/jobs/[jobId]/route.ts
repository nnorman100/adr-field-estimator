import { memberRoute } from '@/lib/auth';
import { readJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// One job with its customer and claim. A job of another company, or another estimator's, is 404.
export const GET = memberRoute(readJob);
