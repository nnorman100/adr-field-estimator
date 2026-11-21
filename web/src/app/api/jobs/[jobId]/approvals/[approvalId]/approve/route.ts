import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { approveApproval } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

// S5b-8: the owner approves a proposal (`additions_approve`).
export const POST = requireCurrentClient(requireFlag('priced_extras', approveApproval));
