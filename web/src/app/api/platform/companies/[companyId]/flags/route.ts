import { operatorRoute } from '@/lib/auth';
import { setCompanyFlag } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator turns one of the known features on or off for one company (owner decision D12).
// No company role can: an owner, estimator or office user gets 403 here. It needs a sign-in under
// 15 minutes old (D7, extended by the owner on 2026-11-14).
export const POST = operatorRoute(setCompanyFlag, { freshSignIn: true });
