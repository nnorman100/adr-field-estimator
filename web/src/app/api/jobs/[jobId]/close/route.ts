import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { closeJob } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// Closes a signed job, or corrects its close (S5b-10, flag `estimate_assist`; `coordination`): the
// final invoice, compared with the job's first signed estimate.
export const POST = requireCurrentClient(requireFlag('estimate_assist', closeJob));
