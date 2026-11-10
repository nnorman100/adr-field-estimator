import { memberRoute } from '@/lib/auth';
import { invitationAction } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner cancels one pending invitation. A team change, so the sign-in must be under 15 minutes
// old.
export const POST = memberRoute(invitationAction('cancel'), { freshSignIn: true });
