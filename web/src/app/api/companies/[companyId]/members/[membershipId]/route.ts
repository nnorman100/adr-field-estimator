import { memberRoute } from '@/lib/auth';
import { changeMemberRole } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner moves a member between estimator and office. A team change, so the sign-in must be
// under 15 minutes old.
export const PATCH = memberRoute(changeMemberRole, { freshSignIn: true });
