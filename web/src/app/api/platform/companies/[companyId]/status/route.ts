import { operatorRoute } from '@/lib/auth';
import { setCompanyStatus } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator suspends, reactivates or archives a company (archive needs a suspended company).
// Every member's field access follows the new status. It needs a sign-in under 15 minutes old
// (D7, extended by the owner on 2026-11-14).
export const POST = operatorRoute(setCompanyStatus, { freshSignIn: true });
