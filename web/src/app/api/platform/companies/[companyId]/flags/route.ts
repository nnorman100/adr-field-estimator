import { operatorRoute } from '@/lib/auth';
import { setCompanyFlag } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator turns one of the known features on or off for one company (owner decision D12).
// No company role can: an owner, estimator or office user gets 403 here.
export const POST = operatorRoute(setCompanyFlag);
