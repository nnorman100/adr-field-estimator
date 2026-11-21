import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { draftSummary } from '@/lib/summary-draft/http';

export const dynamic = 'force-dynamic';

// The AI draft of the job's findings summary (S7-6), behind the company's `ai_summary` switch:
// a proposal stored in ai_results, never written to the field draft. Sent again with the same call
// id it answers the same proposal.
export const POST = requireCurrentClient(memberRoute(draftSummary));
