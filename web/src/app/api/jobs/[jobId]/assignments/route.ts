import { memberRoute } from '@/lib/auth';
import { assignEstimator } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Assigns an active estimator to the job (`assignment`: owner and office), from an id the phone made.
export const POST = memberRoute(assignEstimator);
