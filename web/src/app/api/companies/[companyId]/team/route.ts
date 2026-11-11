import { memberRoute } from '@/lib/auth';
import { listTeam } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner sees every member and every invitation not cleared; an office user sees only the
// active estimators (to assign work); an estimator is refused.
export const GET = memberRoute(listTeam);
