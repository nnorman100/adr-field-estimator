import type { Firestore } from 'firebase-admin/firestore';
import { jobProjectionPath, jobProjectionSchema, type JobProjection } from './projection-schema';
import { firestoreSpan } from '@/lib/telemetry/spans';

export type JobProjectionStore = {
  // Only facts read from the authorized SQL row after commit. A delayed older request cannot
  // regress the locator when another request has already projected a newer SQL revision.
  projectJob(companyId: string, jobId: string, projection: JobProjection): Promise<void>;
};

export function firestoreJobProjectionStore(db: Firestore): JobProjectionStore {
  return {
    async projectJob(companyId, jobId, projection) {
      const next = jobProjectionSchema.parse(projection);
      const ref = db.doc(jobProjectionPath(companyId, jobId));
      await firestoreSpan('runTransaction', 'jobs', () => db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (snapshot.exists) {
          const previous = jobProjectionSchema.parse(snapshot.data());
          if (previous.revision > next.revision) return;
          if (previous.revision === next.revision) {
            if (previous.currentDraftId !== next.currentDraftId) throw new Error('Job projection revision conflict');
            return;
          }
        }
        tx.set(ref, next);
      }));
    },
  };
}
