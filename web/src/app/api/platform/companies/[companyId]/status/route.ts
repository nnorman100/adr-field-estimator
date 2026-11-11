import { operatorRoute } from '@/lib/auth';
import { setCompanyStatus } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator suspends, reactivates or archives a company (archive needs a suspended company).
// Every member's field access follows the new status.
export const POST = operatorRoute(setCompanyStatus);
