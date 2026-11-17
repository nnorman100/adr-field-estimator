import type { Firestore } from 'firebase-admin/firestore';
import { firestoreJobProjectionStore, type JobProjectionStore } from './projection';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The job's first Firestore field draft (docs/data-ownership.md). The server makes it; a client may
// only change its `field` map, and only the field owner while `state` is `editing`
// (web/firestore.rules). The store is a seam so the route tests run without Firestore.
//
// `fieldOwnerUid` on a draft is the server's copy of the job's field owner (jobs.field_owner_actor_id
// in Postgres decides): the rules let only that person change the field work. `fieldOwnerRevision`
// is the job's coordination revision (job_coordination, 0015) at which the server last set it, so a
// slower request carrying an older owner never overwrites a newer one (S5b-1). A draft with no
// revision was made with its job or by Back to editing (revision 0).
//
// `jobId` binds the draft to the one job it was made for (security audit F1): the server writes it
// when it makes the draft and never changes it, and a client cannot (the rules let a client change
// only `field`). A draft id the phone sends is never taken as another job's draft: making a draft
// over one made for another job is refused, and so is naming a field owner on it. A draft made
// before this key has none; the server stamps the job id on it the next time it names the field
// owner, from a list of draft ids that Postgres says this job alone holds (office.ts, draftIdsOf).
export type FieldOwnerResult =
  // Set now, or the draft already named this person at this revision or later.
  | 'set'
  | 'same'
  // A newer owner is already on the draft (its revision is higher): nothing is changed.
  | 'newer'
  // No such draft (yet).
  | 'missing'
  // The draft was made for another job: nothing is changed.
  | 'taken';

export type DraftStore = JobProjectionStore & {
  // Makes the job's draft if it is not there yet. 'exists' is the answer to a retry: nothing is
  // changed. 'taken' when the draft there was made for another job: nothing is changed either.
  // `fieldOwnerUid` is the owner's sign-in uid, or null while nobody owns the field work.
  ensure(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null): Promise<'created' | 'exists' | 'taken'>;
  // In one Firestore transaction: names `fieldOwnerUid` as the draft's field owner unless the draft
  // already holds a newer one or was made for another job. Changes nothing else on the draft (its
  // state, fence and field work stay as they are), except that a draft made before `jobId` takes it.
  setFieldOwner(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string, revision: number): Promise<FieldOwnerResult>;
};

const ALREADY_EXISTS = 6;

// A draft that names a job other than this one. A draft made before `jobId` names none.
export function draftOfOtherJob(stamped: unknown, jobId: string): boolean {
  return stamped !== undefined && stamped !== jobId;
}

export function firestoreDraftStore(db: Firestore): DraftStore {
  return {
    ...firestoreJobProjectionStore(db),
    async ensure(companyId, jobId, draftId, fieldOwnerUid) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      try {
        // create() refuses an existing document, so a retry never overwrites later field work.
        await firestoreSpan('create', 'drafts', () =>
          draft.create({
            jobId,
            ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
            state: 'editing',
            field: {},
          }),
        );
        return 'created';
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== ALREADY_EXISTS) throw error;
        // A retry finds its own job's draft; one made before `jobId` is left as it is.
        const found = await firestoreSpan('get', 'drafts', () => draft.get());
        return draftOfOtherJob(found.get('jobId'), jobId) ? 'taken' : 'exists';
      }
    },

    async setFieldOwner(companyId, jobId, draftId, fieldOwnerUid, revision) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<FieldOwnerResult> => {
          const found = await tx.get(draft);
          if (!found.exists) return 'missing';
          const stamped = found.get('jobId');
          if (draftOfOtherJob(stamped, jobId)) return 'taken';
          const stored = found.get('fieldOwnerRevision');
          const storedRevision = typeof stored === 'number' ? stored : 0;
          if (storedRevision > revision) return 'newer';
          if (found.get('fieldOwnerUid') === fieldOwnerUid && storedRevision === revision) return 'same';
          tx.update(draft, { fieldOwnerUid, fieldOwnerRevision: revision, ...(stamped === undefined ? { jobId } : {}) });
          return 'set';
        }),
      );
    },
  };
}
