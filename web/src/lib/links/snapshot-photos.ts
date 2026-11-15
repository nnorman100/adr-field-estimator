import { and, eq } from 'drizzle-orm';
import { jobSubmissions } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { readSnapshot } from '@/lib/estimates/inputs';
import { LinkError } from './errors';

// The photos a link may show (S5a-11b): only the ones the submitted record behind its documents holds,
// on the link's own job. Any other photo id, of this job, another job or another company, is the same
// unavailable answer. Nothing lists them; the page names each by the id its photo log carries.
export async function requireSnapshotPhoto(tx: CompanyTransaction, companyId: string, jobId: string, submissionId: string, photoId: string): Promise<void> {
  const [submission] = await tx
    .select({ snapshotBytes: jobSubmissions.snapshotBytes })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.jobId, jobId), eq(jobSubmissions.id, submissionId), eq(jobSubmissions.status, 'committed')));
  if (!submission?.snapshotBytes) throw new LinkError('link_unavailable');
  const snapshot = readSnapshot(Buffer.from(submission.snapshotBytes));
  if (snapshot.jobId !== jobId || !snapshot.photos.some((photo) => photo.id === photoId)) throw new LinkError('link_unavailable');
}
