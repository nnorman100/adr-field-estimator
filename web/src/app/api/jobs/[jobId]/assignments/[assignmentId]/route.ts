import { memberRoute } from '@/lib/auth';
import { unassignEstimator } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Ends an assignment (`assignment`). The row is kept, ended; the job's field owner cannot be
// unassigned until the owner moves the field work.
export const DELETE = memberRoute(unassignEstimator);
