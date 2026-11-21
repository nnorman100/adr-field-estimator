import { requireFlag, requireCurrentClient } from '@/lib/auth';
import { editApproval } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

// S5b-8: edit a proposal (`scope`): it ends, approval and all, and the new one is proposed.
export const PUT = requireCurrentClient(requireFlag('priced_extras', editApproval));
