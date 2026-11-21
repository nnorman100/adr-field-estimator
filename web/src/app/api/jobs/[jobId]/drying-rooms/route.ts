import { memberRoute } from '@/lib/auth';
import { listRooms } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// The rooms a drying-log reading of the job may name (S5b-10): stable field id and label, by the same
// rule the reading write checks a room against. Job readers (`jobs_read`), an assigned estimator who
// does not own the field work included.
export const GET = memberRoute(listRooms);
