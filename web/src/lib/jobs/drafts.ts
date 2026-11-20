import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
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
  // No such draft (yet), or only the record an archive or restore left for it (archive-store.ts).
  | 'missing'
  // The draft was made for another job: nothing is changed.
  | 'taken'
  // The draft is archived (its job is, or its restore has not reached the field database yet): no
  // field owner is named on it, and nothing is changed.
  | 'archived';

// What a creation answers: `archived` when only the record of an archived job's missing draft is
// there, so no draft exists yet and none is made until the restore: the request is sent again.
export type DraftMade = 'created' | 'exists' | 'taken' | 'archived';

// What an archive or restore leaves under the draft id where the draft is missing (archive-store.ts):
// the job id, the job revision (`archiveRevision`) and `state`, `archived` while the job is and
// `absent` once it is restored, with no field owner and no field work. It keeps the latest revision
// where there is no draft to keep it on, so a slower archive or restore never undoes a newer one.
export type Placeholder = { jobId: unknown; state: unknown; archiveRevision: number | null };

export function placeholderOf(found: DocumentSnapshot): Placeholder | null {
  if (!found.exists || found.get('placeholder') !== true) return null;
  const revision: unknown = found.get('archiveRevision');
  return { jobId: found.get('jobId'), state: found.get('state'), archiveRevision: typeof revision === 'number' ? revision : null };
}

// Whether a creation may replace the placeholder: only a restored one (`absent`) of this very job that
// holds its revision. `archived` while the job is; anything else is not this job's to replace.
export function placeholderRefusal(left: Placeholder, jobId: string): 'taken' | 'archived' | null {
  if (left.jobId !== jobId) return 'taken';
  if (left.state === 'archived') return 'archived';
  return left.state === 'absent' && left.archiveRevision !== null ? null : 'taken';
}

// Writes the job's new draft: over a restored job's placeholder, taking the revision it kept, else
// where nothing is.
export function startDraft(tx: Transaction, ref: DocumentReference, left: Placeholder | null, data: Record<string, unknown>): void {
  if (left) tx.set(ref, { ...data, archiveRevision: left.archiveRevision });
  else tx.create(ref, data);
}

export type DraftFound = { jobId: unknown; placeholder?: true };

export type DraftLookup = {
  // The document under this id, with the job id written on it (undefined on a draft made before
  // `jobId`), and `placeholder: true` when it is a placeholder a previous-version archive or restore left
  // where a draft was missing (no draft yet); null when there is none. Read before a request commits a
  // draft id in Postgres, so a draft id the field database refuses is never committed.
  findDraft(companyId: string, draftId: string): Promise<DraftFound | null>;
};

export function firestoreDraftLookup(db: Firestore): DraftLookup {
  return {
    async findDraft(companyId, draftId) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      const found = await firestoreSpan('get', 'drafts', () => draft.get());
      if (!found.exists) return null;
      return placeholderOf(found) ? { jobId: found.get('jobId'), placeholder: true } : { jobId: found.get('jobId') };
    },
  };
}

export type DraftStore = JobProjectionStore & DraftLookup & {
  // Makes the job's draft if it is not there yet, in one Firestore transaction. 'exists' is the answer
  // to a retry, when the draft there carries this job id: nothing is changed, except that a draft made
  // before `jobId` takes it (the caller holds the draft id for this job in Postgres first). 'taken'
  // when the draft there was made for another job: nothing is changed. `archived` when only an archived
  // job's placeholder is there (archive-store.ts); a restored job's placeholder gives way to the draft,
  // which keeps its revision. `fieldOwnerUid` is the owner's sign-in uid, or null while nobody owns the
  // field work.
  ensure(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null): Promise<DraftMade>;
  // In one Firestore transaction: names `fieldOwnerUid` as the draft's field owner unless the draft
  // already holds a newer one, was made for another job or is archived. Changes nothing else on the
  // draft (its state, fence and field work stay as they are), except that a draft made before `jobId`
  // takes it, whether or not the owner changes.
  setFieldOwner(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string, revision: number): Promise<FieldOwnerResult>;
};

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
      const fresh = {
        jobId,
        ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
        state: 'editing',
        field: {},
      };
      // A missing draft, a retry that finds its own job's draft, and the placeholder an archive or
      // restore left are all settled in one transaction.
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<DraftMade> => {
          const found = await tx.get(draft);
          if (!found.exists) {
            startDraft(tx, draft, null, fresh);
            return 'created';
          }
          const left = placeholderOf(found);
          if (left) {
            const refused = placeholderRefusal(left, jobId);
            if (refused) return refused;
            startDraft(tx, draft, left, fresh);
            return 'created';
          }
          // One made before `jobId` takes it now.
          const stamped = found.get('jobId');
          if (draftOfOtherJob(stamped, jobId)) return 'taken';
          if (stamped === undefined) tx.update(draft, { jobId });
          return 'exists';
        }),
      );
    },

    async setFieldOwner(companyId, jobId, draftId, fieldOwnerUid, revision) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<FieldOwnerResult> => {
          const found = await tx.get(draft);
          // What an archive or restore left for a missing draft (archive-store.ts) is no draft: nobody is named on it.
          if (!found.exists || placeholderOf(found)) return 'missing';
          const stamped = found.get('jobId');
          if (draftOfOtherJob(stamped, jobId)) return 'taken';
          // Nobody is named on an archived draft: a stamp that was already on its way when the job was
          // archived lands here too, so the archived scope and rooms never reach that estimator.
          if (found.get('state') === 'archived') return 'archived';
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
