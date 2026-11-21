import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { claimFieldOwner } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// "First capture makes me field owner" (S5b-1, docs/spec.md 6.2): on a job nobody owns in the field
// yet, the caller (with `scope`) becomes its field owner, once; the server sets the draft's
// fieldOwnerUid in a Firestore transaction.
export const POST = requireCurrentClient(memberRoute(claimFieldOwner));
