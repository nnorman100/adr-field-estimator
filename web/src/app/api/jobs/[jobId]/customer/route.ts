import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { saveCustomer } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Sets the customer and the property address while the job is unsigned (owner decision J3).
export const PUT = requireCurrentClient(memberRoute(saveCustomer));
