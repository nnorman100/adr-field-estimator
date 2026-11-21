import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { addReading, listReadings } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// The drying log (S5b-10): air, material and thermal readings beside the job. Job readers read the
// active readings (`jobs_read`); the owner and the estimator with the job add them (`scope`), on a job
// being edited, submitted or signed. The air values are the server's.
export const GET = memberRoute(listReadings);
export const POST = requireCurrentClient(memberRoute(addReading));
