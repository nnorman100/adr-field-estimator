import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { copyJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// S5b-2: anyone who may see a signed job (`jobs_copy`) starts a new draft from its scope. The new
// job's and draft's ids are made on the phone, so the same copy sent again makes one draft.
export const POST = requireCurrentClient(memberRoute(copyJob));
