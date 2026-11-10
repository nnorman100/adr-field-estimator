import { accountRoute } from '@/lib/auth';
import { acceptInvitation } from '@/lib/team';

export const dynamic = 'force-dynamic';

// Accepting creates the actor and one membership, once; the session rules of the role being
// accepted apply (an owner needs an authenticator-app second step).
export const POST = accountRoute(acceptInvitation);
