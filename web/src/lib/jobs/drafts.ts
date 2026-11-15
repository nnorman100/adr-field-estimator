import type { Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The job's first Firestore field draft (docs/data-ownership.md). The server makes it; a client may
// only change its `field` map, and only the field owner while `state` is `editing`
// (web/firestore.rules). The store is a seam so the route tests run without Firestore.
//
// `fieldOwnerUid` on a draft is the server's copy of the job's field owner (jobs.field_owner_actor_id
// in Postgres decides): the rules let only that person change the field work. `fieldOwnerRevision`
// is the job revision at which the server last set it, so a slower request carrying an older owner
// never overwrites a newer one (S5b-1). A draft with no revision was made with the job (revision 0).
export type FieldOwnerResult =
  // Set now, or the draft already named this person at this revision or later.
  | 'set'
  | 'same'
  // A newer owner is already on the draft (its revision is higher): nothing is changed.
  | 'newer'
  // No such draft (yet).
  | 'missing';

export type DraftStore = {
  // Makes the draft if it is not there yet. 'exists' is the answer to a retry: nothing is changed.
  // `fieldOwnerUid` is the owner's sign-in uid, or null while nobody owns the field work.
  ensure(companyId: string, draftId: string, fieldOwnerUid: string | null): Promise<'created' | 'exists'>;
  // In one Firestore transaction: names `fieldOwnerUid` as the draft's field owner unless the draft
  // already holds a newer one. Changes nothing else on the draft (its state, fence and field work
  // stay as they are).
  setFieldOwner(companyId: string, draftId: string, fieldOwnerUid: string, revision: number): Promise<FieldOwnerResult>;
};

const ALREADY_EXISTS = 6;

export function firestoreDraftStore(db: Firestore): DraftStore {
  return {
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

    async setFieldOwner(companyId, draftId, fieldOwnerUid, revision) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<FieldOwnerResult> => {
          const found = await tx.get(draft);
          if (!found.exists) return 'missing';
          const stored = found.get('fieldOwnerRevision');
          const storedRevision = typeof stored === 'number' ? stored : 0;
          if (storedRevision > revision) return 'newer';
          if (found.get('fieldOwnerUid') === fieldOwnerUid && storedRevision === revision) return 'same';
          tx.update(draft, { fieldOwnerUid, fieldOwnerRevision: revision });
          return 'set';
        }),
      );
    },
  };
}
