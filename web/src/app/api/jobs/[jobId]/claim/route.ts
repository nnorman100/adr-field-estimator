import { memberRoute } from '@/lib/auth';
import { saveClaim } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Sets the claim details the documents print, while the job is unsigned.
export const PUT = memberRoute(saveClaim);
