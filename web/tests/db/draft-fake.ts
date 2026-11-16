import type { JobProjection } from '@/lib/field/job-projection';
import type { DraftStore } from '@/lib/jobs/drafts';

// A stand-in for the field database's drafts: what the jobs service writes, kept in memory, with a
// switch to make the next write fail as if Firestore were unreachable. tests/emu/ checks the real
// writer (src/lib/jobs/drafts.ts) against the emulator and the field rules.
export type FakeDrafts = DraftStore & {
  // The jobs projected (#407), by "company/job".
  projected: Map<string, JobProjection>;
  // The drafts made, by "company/draft", with the field owner's uid (null while nobody owns it) and
  // the job revision at which the server last set it (absent for a draft made with its job).
  made: Map<string, { fieldOwnerUid: string | null; fieldOwnerRevision?: number }>;
  // Every call to ensure, in order, including the ones that found the draft there.
  calls: { companyId: string; draftId: string; fieldOwnerUid: string | null }[];
  // Every call to setFieldOwner, in order (S5b-1).
  ownerCalls: { companyId: string; draftId: string; fieldOwnerUid: string; revision: number }[];
  // Fails the next write; if `afterWrite`, the draft is made first and the answer is lost (the
  // response never reaches the caller).
  failNext: { on: boolean; afterWrite: boolean };
};

export function fakeDrafts(): FakeDrafts {
  const store: FakeDrafts = {
    made: new Map(),
    projected: new Map(),
    async projectJob(companyId, jobId, projection) {
      const key = `${companyId}/${jobId}`;
      if ((store.projected.get(key)?.revision ?? -1) < projection.revision) store.projected.set(key, { ...projection });
    },
    calls: [],
    ownerCalls: [],
    failNext: { on: false, afterWrite: false },
    async ensure(companyId, draftId, fieldOwnerUid) {
      store.calls.push({ companyId, draftId, fieldOwnerUid });
      const key = `${companyId}/${draftId}`;
      const fail = store.failNext;
      if (fail.on && !fail.afterWrite) {
        fail.on = false;
        throw new Error('field database unreachable');
      }
      const existed = store.made.has(key);
      if (!existed) store.made.set(key, { fieldOwnerUid });
      if (fail.on) {
        fail.on = false;
        fail.afterWrite = false;
        throw new Error('field database answer lost');
      }
      return existed ? 'exists' : 'created';
    },
    // As the real writer (src/lib/jobs/drafts.ts): a newer owner on the draft is never overwritten.
    async setFieldOwner(companyId, draftId, fieldOwnerUid, revision) {
      store.ownerCalls.push({ companyId, draftId, fieldOwnerUid, revision });
      const fail = store.failNext;
      if (fail.on && !fail.afterWrite) {
        fail.on = false;
        throw new Error('field database unreachable');
      }
      const draft = store.made.get(`${companyId}/${draftId}`);
      if (!draft) return 'missing';
      const stored = draft.fieldOwnerRevision ?? 0;
      let result: 'set' | 'same' | 'newer' = 'set';
      if (stored > revision) result = 'newer';
      else if (draft.fieldOwnerUid === fieldOwnerUid && stored === revision) result = 'same';
      else Object.assign(draft, { fieldOwnerUid, fieldOwnerRevision: revision });
      if (fail.on) {
        fail.on = false;
        fail.afterWrite = false;
        throw new Error('field database answer lost');
      }
      return result;
    },
  };
  return store;
}
