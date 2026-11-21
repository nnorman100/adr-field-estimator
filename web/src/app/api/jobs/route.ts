import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { createJob, listJobs } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// The company's jobs (owner and office) or the caller's own, newest first, paged. An estimator
// sees only the jobs they made or own in the field.
export const GET = memberRoute(listJobs);

// Starts a job from a job id and a first draft id the phone made. Sending it again makes nothing
// more: whichever of the job and its field draft is missing is made.
export const POST = requireCurrentClient(memberRoute(createJob));
