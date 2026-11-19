import { operatorRoute, publicRoute } from '@/lib/auth';
import { supportHead, supportPhoto } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// The operator's read-only view of one photo, original or signature of a job, as the image it is
// (S5b-5); each view writes one audit row.
export const GET = operatorRoute(supportPhoto);

// HEAD is refused (405) before any sign-in check, read or audit: only the GET that sends a view
// reads it and writes its audit row.
export const HEAD = publicRoute(supportHead);
