import { memberRoute } from '@/lib/auth';
import { memberStatusAction } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner disables one member (their sessions are revoked before this answers). A team change, so
// the sign-in must be under 15 minutes old.
export const POST = memberRoute(memberStatusAction('disable'), { freshSignIn: true });
