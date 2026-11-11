import { operatorRoute } from '@/lib/auth';
import { bindCompanyTenant } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator binds a company to the sign-in tenant the owner-run command made for it (D4), once.
export const POST = operatorRoute(bindCompanyTenant);
