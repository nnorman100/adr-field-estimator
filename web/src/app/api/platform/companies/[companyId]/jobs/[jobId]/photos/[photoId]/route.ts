import { operatorRoute } from '@/lib/auth';
import { supportPhoto } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only view of one photo, original or signature of a job, as the image it is
// (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportPhoto);
