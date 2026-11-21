import { memberRoute, requireCurrentClient } from '@/lib/auth';
import { voidReading } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// Removes a drying-log reading by voiding it once (`scope`): the reading is kept, no longer active.
export const POST = requireCurrentClient(memberRoute(voidReading));
