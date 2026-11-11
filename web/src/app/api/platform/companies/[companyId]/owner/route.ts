import { operatorRoute } from '@/lib/auth';
import { inviteOwner } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator invites the company's owner by link (D11), or replaces the owner: the old owner is
// disabled and signed out before this answers. A team change, so the sign-in must be under 15 minutes old.
export const POST = operatorRoute(inviteOwner, { freshSignIn: true });
