import { firestoreDraftStore, type DraftStore } from './drafts';

// The field database side of archive, restore and copy (S5b-2): the draft lookup and the job's locator,
// the same as the jobs service's (drafts.ts). Postgres decides; the draft sync (src/lib/jobs/draft-sync.ts)
// puts the job's current draft `archived` while the job is (an earlier submitted draft stays
// `submitted`), back as Postgres says on a restore, and makes a copy's first draft. A seam, so the route
// tests run without Firestore.
export type ArchiveStore = DraftStore;

export const firestoreArchiveStore = firestoreDraftStore;
