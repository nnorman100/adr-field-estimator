import { operatorRoute } from '@/lib/auth';
import { resetSecondStep } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// D9: after confirming the person by phone, the operator resets their second step; they are signed
// out and enrol again. A second-step change, so the sign-in must be under 15 minutes old.
export const POST = operatorRoute(resetSecondStep, { freshSignIn: true });
