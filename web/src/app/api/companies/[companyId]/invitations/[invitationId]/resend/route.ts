import { memberRoute } from '@/lib/auth';
import { invitationAction } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner resends one pending invitation (7 more days, the link again). A team change, so the
// sign-in must be under 15 minutes old.
export const POST = memberRoute(invitationAction('resend'), { freshSignIn: true });
