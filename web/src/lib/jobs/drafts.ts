import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { firestoreJobProjectionStore, type JobProjectionStore } from './projection';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The server's reads of the job's Firestore field drafts (docs/data-ownership.md). Every draft is made
// and changed by the draft sync (src/lib/jobs/draft-sync.ts), in one Firestore transaction per job; a
// client may only change a draft's `field` map, and only the field owner while `state` is `editing`
// (web/firestore.rules). The store is a seam so the route tests run without Firestore.
//
// `jobId` binds the draft to the one job it was made for (security audit F1): the sync writes it when
// it makes the draft and a client cannot change it. A draft made before this key has none, so it proves
// nothing on its own: Postgres holds the draft id for the job (job_drafts, 0016; holdDraft in access.ts).

// What an earlier version's archive or restore left under the draft id where the draft was missing: the
// job id, the job revision (`archiveRevision`) and `state`, `archived` while the job was and `absent`
// once it was restored, with no field owner and no field work. Nothing writes one any more; one still
// in the field database is no draft, and the draft sync replaces it (draft-lifecycle.ts).
export type Placeholder = { jobId: unknown; state: unknown; archiveRevision: number | null };

export function placeholderOf(found: DocumentSnapshot): Placeholder | null {
  if (!found.exists || found.get('placeholder') !== true) return null;
  const revision: unknown = found.get('archiveRevision');
  return { jobId: found.get('jobId'), state: found.get('state'), archiveRevision: typeof revision === 'number' ? revision : null };
}

// `leftover`: no draft document, but rooms or photos left under its id (a draft lost without its nested
// documents): the id is taken, and no draft is made over them.
export type DraftFound = { jobId: unknown; placeholder?: true; leftover?: true };

/** Whether what the lookup found holds no draft: nothing, a placeholder, or leftovers with no draft. */
export const noDraft = (found: DraftFound | null): boolean => !found || found.placeholder === true || found.leftover === true;

export type DraftLookup = {
  // The document under this id, with the job id written on it (undefined on a draft made before
  // `jobId`), and `placeholder: true` when it is a placeholder a previous-version archive or restore left
  // where a draft was missing (no draft yet), or `leftover: true` when there is no draft document but rooms
  // or photos are left under the id; null when there is nothing. Read before a request commits a draft id
  // in Postgres, so a draft id the field database refuses (leftovers included) is never committed.
  findDraft(companyId: string, draftId: string): Promise<DraftFound | null>;
};

export function firestoreDraftLookup(db: Firestore): DraftLookup {
  return {
    async findDraft(companyId, draftId) {
      const draft = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      const found = await firestoreSpan('get', 'drafts', () => draft.get());
      if (!found.exists) {
        // Rooms or photos left under the id with no draft: one of each collection is enough to tell.
        for (const name of ['rooms', 'photos']) {
          const left = await firestoreSpan('get', 'drafts', () => draft.collection(name).limit(1).get());
          if (!left.empty) return { jobId: undefined, leftover: true };
        }
        return null;
      }
      return placeholderOf(found) ? { jobId: found.get('jobId'), placeholder: true } : { jobId: found.get('jobId') };
    },
  };
}

export type DraftStore = JobProjectionStore & DraftLookup;

// A draft that names a job other than this one. A draft made before `jobId` names none.
export function draftOfOtherJob(stamped: unknown, jobId: string): boolean {
  return stamped !== undefined && stamped !== jobId;
}

export function firestoreDraftStore(db: Firestore): DraftStore {
  return { ...firestoreJobProjectionStore(db), ...firestoreDraftLookup(db) };
}
