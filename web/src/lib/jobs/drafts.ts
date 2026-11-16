import type { Firestore } from 'firebase-admin/firestore';
import { firestoreJobProjectionStore, type JobProjectionStore } from './projection';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The job's first Firestore field draft (docs/data-ownership.md). The server makes it; a client may
// only change its `field` map, and only the field owner while `state` is `editing`
// (web/firestore.rules). The store is a seam so the route tests run without Firestore.
export type DraftStore = JobProjectionStore & {
  // Makes the draft if it is not there yet. 'exists' is the answer to a retry: nothing is changed.
  // `fieldOwnerUid` is the owner's sign-in uid, or null while nobody owns the field work.
  ensure(companyId: string, draftId: string, fieldOwnerUid: string | null): Promise<'created' | 'exists'>;
};

const ALREADY_EXISTS = 6;

export function firestoreDraftStore(db: Firestore): DraftStore {
  return {
    ...firestoreJobProjectionStore(db),
    async ensure(companyId, draftId, fieldOwnerUid) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      try {
        // create() refuses an existing document, so a retry never overwrites later field work.
        await firestoreSpan('create', 'drafts', () =>
          draft.create({
            ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
            state: 'editing',
            field: {},
          }),
        );
        return 'created';
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === ALREADY_EXISTS) return 'exists';
        throw error;
      }
    },
  };
}
