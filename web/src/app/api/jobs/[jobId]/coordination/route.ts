import { memberRoute } from '@/lib/auth';
import { readCoordination, saveCoordination } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Job coordination (S5b-1): the office notes, the assigned estimators and the field owner. Owner and
// office read it (`coordination` or `assignment`); only `coordination` saves the notes. An estimator
// is refused: they see the customer view only.
export const GET = memberRoute(readCoordination);
export const PUT = memberRoute(saveCoordination);
