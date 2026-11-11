import { memberRoute } from '@/lib/auth';
import { inviteMember } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner invites by email and role (estimator or office) and gets the link to copy. A team
// change, so the sign-in must be under 15 minutes old.
export const POST = memberRoute(inviteMember, { freshSignIn: true });
