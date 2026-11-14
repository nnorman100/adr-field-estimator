import { operatorRoute } from '@/lib/auth';
import { bindCompanyTenant } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator binds a company to the sign-in tenant the owner-run command made for it (D4), once.
// It needs a sign-in under 15 minutes old (D7, extended by the owner on 2026-11-14).
export const POST = operatorRoute(bindCompanyTenant, { freshSignIn: true });
