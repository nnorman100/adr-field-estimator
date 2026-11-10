import { memberRoute } from '@/lib/auth';
import { memberStatusAction } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The owner re-enables one member. A team change, so the sign-in must be under 15 minutes old.
export const POST = memberRoute(memberStatusAction('enable'), { freshSignIn: true });
