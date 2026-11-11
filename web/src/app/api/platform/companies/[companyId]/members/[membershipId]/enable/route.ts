import { operatorRoute } from '@/lib/auth';
import { supportEnableMember } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Support action: the operator re-enables a disabled member (never the owner). A team change, so the
// sign-in must be under 15 minutes old.
export const POST = operatorRoute(supportEnableMember, { freshSignIn: true });
