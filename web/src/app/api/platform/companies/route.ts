import { operatorRoute } from '@/lib/auth';
import { createCompany, listCompanies } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Every company, for the platform operator; and creating one (name and sign-in address). The tenant
// is bound and the owner invited afterwards. Operators only (owner decision D6).
export const GET = operatorRoute(listCompanies);
export const POST = operatorRoute(createCompany);
