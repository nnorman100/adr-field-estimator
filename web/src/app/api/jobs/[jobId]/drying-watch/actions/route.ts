import { requireFlag } from '@/lib/auth';
import { actOnWatch } from '@/lib/drying';

export const dynamic = 'force-dynamic';

// A confirmed drying watch action (S5b-10, flag `drying_watch`): Mark dry (`scope` or `coordination`),
// Extend plan and Close monitoring (`coordination`), each with the reviewed facts hash and a reason.
export const POST = requireFlag('drying_watch', actOnWatch);
