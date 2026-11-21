import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { listApprovals, proposeApproval } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

// S5b-8 proposals and approvals on a job (priced_extras). GET: the submitted record's open proposals
// and approvals (any job reader). POST: propose a named adjustment or an hourly addition (`scope`).
export const GET = requireFlag('priced_extras', listApprovals);
export const POST = requireCurrentClient(requireFlag('priced_extras', proposeApproval));
