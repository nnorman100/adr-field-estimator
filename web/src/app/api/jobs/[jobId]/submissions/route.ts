import { memberRoute } from '@/lib/auth';
import { submitJob } from '@/lib/submissions';

export const dynamic = 'force-dynamic';

// Submit ("Finish and review"): fences the job's current field draft, records it once as an
// immutable submission and marks the draft submitted. Sent again with the same id and body it
// answers the same record.
export const POST = memberRoute(submitJob);
