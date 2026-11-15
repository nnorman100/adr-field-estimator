import { memberRoute } from '@/lib/auth';
import { transferFieldOwner } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Owner decision J5: the owner (`field_owner_transfer`) moves the job's field work to themself or an
// assigned estimator, audited.
export const POST = memberRoute(transferFieldOwner);
