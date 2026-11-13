import { serviceRoute } from '@/lib/auth';
import { runQueuedProjection } from '@/lib/projection/services';
import { runQueuedSubmissionRepair } from '@/lib/submissions/services';

export const dynamic = 'force-dynamic';

// One worker pass across every company: writes or removes each waiting member's Firestore access
// record and retries the ones that failed earlier (S3-12), then aborts Submit attempts that stayed
// pending past their expiry and writes the draft markers a Submit could not (S5a-8). Called on a
// schedule by the scheduler service account only; the answer holds counts, never ids.
export const POST = serviceRoute('access-projection', async () => {
  const access = await runQueuedProjection();
  const submissions = await runQueuedSubmissionRepair();
  return Response.json({ ...access, submissions }, { headers: { 'Cache-Control': 'no-store' } });
});
