import { memberRoute } from '@/lib/auth';
import { readScopeLists } from '@/lib/scope-lists';

export const dynamic = 'force-dynamic';

// What Check Scope picks from for one job (S5a-10): the room types and the items a room may list
// from the job's price version, and the company's prep-task templates. Names only, never a price.
export const GET = memberRoute(readScopeLists);
