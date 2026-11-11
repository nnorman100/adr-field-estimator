import { operatorRoute } from '@/lib/auth';
import { supportInvitationAction } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Support action: the operator resends a pending invitation. A team change, so the sign-in must be
// under 15 minutes old.
export const POST = operatorRoute(supportInvitationAction('resend'), { freshSignIn: true });
