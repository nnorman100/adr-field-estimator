import { memberRoute } from '@/lib/auth';
import { restoreJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// S5b-2: the owner (`jobs_archive`) puts an archived draft back as it was.
export const POST = memberRoute(restoreJob);
