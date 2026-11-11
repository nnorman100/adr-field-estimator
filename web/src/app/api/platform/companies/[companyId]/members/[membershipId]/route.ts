import { operatorRoute } from '@/lib/auth';
import { supportChangeRole } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Support action: the operator moves a member between estimator and office. A team change, so the
// sign-in must be under 15 minutes old.
export const PATCH = operatorRoute(supportChangeRole, { freshSignIn: true });
