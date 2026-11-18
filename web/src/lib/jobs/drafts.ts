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
// before this key has none, so it proves nothing on its own: the server stamps the job id on it only
// once Postgres holds the draft id for the job (job_drafts, 0016; holdDraft in access.ts), on a retry
// that finds it (ensure, createFrom, createCopy) or when it names the field owner (office.ts,
// draftIdsOf).
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

export type DraftLookup = {
  // The draft under this id, with the job id written on it (undefined on a draft made before
  // `jobId`), or null when there is none. Read before a request commits a draft id in Postgres, so a
  // draft id the field database refuses is never committed.
  findDraft(companyId: string, draftId: string): Promise<{ jobId: unknown } | null>;
};

export function firestoreDraftLookup(db: Firestore): DraftLookup {
  return {
    async findDraft(companyId, draftId) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      const found = await firestoreSpan('get', 'drafts', () => draft.get());
      return found.exists ? { jobId: found.get('jobId') } : null;
    },
  };
}

export type DraftStore = JobProjectionStore & DraftLookup & {
  // Makes the job's draft if it is not there yet. 'exists' is the answer to a retry, when the draft
  // there carries this job id: nothing is changed, except that a draft made before `jobId` takes it
  // (the caller holds the draft id for this job in Postgres first). 'taken' when the draft there was
  // made for another job: nothing is changed. `fieldOwnerUid` is the owner's sign-in uid, or null
  // while nobody owns the field work.
  ensure(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null): Promise<'created' | 'exists' | 'taken'>;
  // In one Firestore transaction: names `fieldOwnerUid` as the draft's field owner unless the draft
  // already holds a newer one or was made for another job. Changes nothing else on the draft (its
  // state, fence and field work stay as they are), except that a draft made before `jobId` takes it,
  // whether or not the owner changes.
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
    ...firestoreDraftLookup(db),
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
        // A retry finds its own job's draft; one made before `jobId` takes it now, in one transaction.
        return firestoreSpan('runTransaction', 'drafts', () =>
          db.runTransaction(async (tx): Promise<'exists' | 'taken'> => {
            const found = await tx.get(draft);
            const stamped = found.get('jobId');
            if (draftOfOtherJob(stamped, jobId)) return 'taken';
            if (stamped === undefined) tx.update(draft, { jobId });
            return 'exists';
          }),
        );
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
          // A draft made before `jobId` takes it, whatever the owner answer is.
          const stamp = stamped === undefined ? { jobId } : {};
          const stored = found.get('fieldOwnerRevision');
          const storedRevision = typeof stored === 'number' ? stored : 0;
          let result: FieldOwnerResult = 'set';
          if (storedRevision > revision) result = 'newer';
          else if (found.get('fieldOwnerUid') === fieldOwnerUid && storedRevision === revision) result = 'same';
          if (result === 'set') tx.update(draft, { fieldOwnerUid, fieldOwnerRevision: revision, ...stamp });
          else if (stamped === undefined) tx.update(draft, stamp);
          return result;
        }),
      );
    },
  };
}
