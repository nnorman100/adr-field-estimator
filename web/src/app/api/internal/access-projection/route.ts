import { isQueueTimeout } from '@/db/client';
import { serviceRoute } from '@/lib/auth';
import { runQueuedProjection } from '@/lib/projection/services';
import { runQueuedDraftSyncRepair } from '@/lib/jobs/services';
import { runQueuedSubmissionRepair } from '@/lib/submissions/services';

export const dynamic = 'force-dynamic';

// One worker pass across every company: writes or removes each waiting member's Firestore access
// record and retries the ones that failed earlier (S3-12), then aborts Submit attempts that stayed
// pending past their expiry and writes the draft markers a Submit could not (S5a-8), then syncs every
// job whose field drafts fell behind Postgres (the draft life-cycle redesign's repair pass). Called on a
// schedule by the scheduler service account only; the answer holds counts, never ids. A pass that
// found no free database connection in time answers 503, and the next scheduled pass runs it again.
export const POST = serviceRoute('access-projection', async () => {
  try {
    const access = await runQueuedProjection();
    const submissions = await runQueuedSubmissionRepair();
    const drafts = await runQueuedDraftSyncRepair();
    return Response.json({ ...access, submissions, drafts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!isQueueTimeout(error)) throw error;
    return Response.json({ error: 'service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
});
