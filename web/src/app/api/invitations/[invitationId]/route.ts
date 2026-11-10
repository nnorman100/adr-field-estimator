import { accountRoute } from '@/lib/auth';
import { readInvitation } from '@/lib/team';

export const dynamic = 'force-dynamic';

// The invitation addressed to the signed-in account's verified email; any other reads as not found.
export const GET = accountRoute(readInvitation);
