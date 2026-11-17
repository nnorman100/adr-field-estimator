import { memberRoute } from '@/lib/auth';
import { archiveJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// S5b-2: the owner (`jobs_archive`) files away an unsigned draft; a signed job has no archive.
// Every other job route then answers 410 for it.
export const POST = memberRoute(archiveJob);
