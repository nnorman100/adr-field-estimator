import { serviceRoute } from '@/lib/auth';
import { runQueuedProjection } from '@/lib/projection/services';

export const dynamic = 'force-dynamic';

// One outbox pass across every company: writes or removes each waiting member's Firestore access
// record and retries the ones that failed earlier. Called on a schedule by the scheduler service
// account only; the answer holds counts, never ids.
export const POST = serviceRoute('access-projection', async () =>
  Response.json(await runQueuedProjection(), { headers: { 'Cache-Control': 'no-store' } }),
);
