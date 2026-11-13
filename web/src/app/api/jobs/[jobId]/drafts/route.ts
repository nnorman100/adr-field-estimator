import { memberRoute } from '@/lib/auth';
import { nextDraft } from '@/lib/submissions';

export const dynamic = 'force-dynamic';

// Back to editing: makes the next draft version of a submitted job from its submitted record. Sent
// again with the same new draft id it answers the same draft.
export const POST = memberRoute(nextDraft);
