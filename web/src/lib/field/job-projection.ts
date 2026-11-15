import { doc, getDoc, getDocFromCache, type Firestore } from 'firebase/firestore';

import { jobProjectionPath, jobProjectionSchema, type JobProjection } from '@/lib/jobs/projection-schema';
export type { JobProjection } from '@/lib/jobs/projection-schema';

export async function loadJobProjection(db: Firestore, companyId: string, jobId: string, source?: 'cache'): Promise<JobProjection | null> {
  const ref = doc(db, jobProjectionPath(companyId, jobId));
  const snapshot = await (source === 'cache' ? getDocFromCache(ref) : getDoc(ref));
  return snapshot.exists() ? jobProjectionSchema.parse(snapshot.data()) : null;
}
