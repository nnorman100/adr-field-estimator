import type { Firestore } from 'firebase-admin/firestore';
import { firestoreDraftLookup, type DraftLookup } from './drafts';
import { firestoreJobProjectionStore, type JobProjectionStore } from './projection';

// The field database side of archive, restore and copy (S5b-2): the draft lookup and the job's locator.
// Postgres decides; the draft sync (src/lib/jobs/draft-sync.ts) puts the job's drafts in the state it
// says (an archived job's drafts `archived`, a restored one's back as they were) and makes a copy's
// first draft. A seam, so the route tests run without Firestore.
export type ArchiveStore = JobProjectionStore & DraftLookup;

export function firestoreArchiveStore(db: Firestore): ArchiveStore {
  return { ...firestoreJobProjectionStore(db), ...firestoreDraftLookup(db) };
}
