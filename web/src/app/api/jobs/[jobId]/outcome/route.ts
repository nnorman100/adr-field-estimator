import { requireFlag } from '@/lib/auth';
import { readOutcome } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// The close of a signed job (S5b-10, flag `estimate_assist`): the owner and office read its amounts,
// note and earlier versions; anyone else with the job reads only whether and when it closed.
export const GET = requireFlag('estimate_assist', readOutcome);
