import type { JobProjection } from '@/lib/field/job-projection';
import { draftOfOtherJob, type DraftStore } from '@/lib/jobs/drafts';
import { placeholderRefusal, type PreviousDraftWriters } from '../submissions/previous-writers';
import { emptyDraft, type Backing } from '../submissions/field-fake';

// A stand-in for the field database's drafts as the jobs service writes them (src/lib/jobs/drafts.ts),
// over the one record every field stand-in shares (`Backing`, tests/submissions/field-fake.ts): the
// drafts it makes or names an owner on are the drafts Submit, archive, the photo route and the draft
// sync see, and the other way round. A switch makes the next write fail as if Firestore were
// unreachable. tests/emu/ checks the real writer against the emulator and the field rules.

/** A draft's field owner as the record holds it. */
export type DraftOwner = { fieldOwnerUid: string | null; fieldOwnerRevision?: number };

export type FakeDrafts = DraftStore & PreviousDraftWriters & {
  // The jobs projected (#407), by "company/job".
  projected: Map<string, JobProjection>;
  // Readers over the record, by "company/draft". A placeholder an archive or restore left is no
  // draft here (src/lib/jobs/drafts.ts).
  owner(at: string): DraftOwner | undefined;
  // Every draft and its owner, in the order they were made.
  owners(): [string, DraftOwner][];
  // The job a draft was made for (`jobId`, security audit F1); undefined on one made before that key.
  jobOf(at: string): string | undefined;
  // Writers a test uses to leave the record as another version or another job would.
  plant(at: string, draft: { fieldOwnerUid: string | null; jobId?: string }): void;
  stamp(at: string, jobId: string): void;
  unstamp(at: string): void;
  remove(at: string): void;
  // Every call to ensure, in order, including the ones that found the draft there.
  calls: { companyId: string; draftId: string; fieldOwnerUid: string | null }[];
  // Every call to setFieldOwner, in order (S5b-1).
  ownerCalls: { companyId: string; draftId: string; fieldOwnerUid: string; revision: number }[];
  // Fails the next write; if `afterWrite`, the draft is made first and the answer is lost (the
  // response never reaches the caller).
  failNext: { on: boolean; afterWrite: boolean };
};

export function fakeDrafts(backing: Backing): FakeDrafts {
  const draftOf = (at: string) => {
    const found = backing.load().drafts[at];
    return found && !found.placeholder ? found : undefined;
  };
  // Changes one draft in the record, whole or not at all.
  function change(at: string, work: (draft: NonNullable<ReturnType<typeof draftOf>>) => void): void {
    const record = backing.load();
    const found = record.drafts[at];
    if (!found || found.placeholder) return;
    work(found);
    backing.save(record);
  }
  // A failure before the write, or (afterWrite) the write done and its answer lost.
  function before(): void {
    const fail = store.failNext;
    if (fail.on && !fail.afterWrite) {
      fail.on = false;
      throw new Error('field database unreachable');
    }
  }
  function after(): void {
    const fail = store.failNext;
    if (fail.on) {
      fail.on = false;
      fail.afterWrite = false;
      throw new Error('field database answer lost');
    }
  }

  const store: FakeDrafts = {
    projected: new Map(),
    async projectJob(companyId, jobId, projection) {
      const key = `${companyId}/${jobId}`;
      if ((store.projected.get(key)?.revision ?? -1) < projection.revision) store.projected.set(key, { ...projection });
    },
    // As the real reader: whatever document is under the id, a placeholder too.
    async findDraft(companyId, draftId) {
      const found = backing.load().drafts[`${companyId}/${draftId}`];
      if (!found) return null;
      return found.placeholder ? { jobId: found.jobId, placeholder: true as const } : { jobId: found.jobId };
    },
    owner(at) {
      const found = draftOf(at);
      if (!found) return undefined;
      return { fieldOwnerUid: found.fieldOwnerUid, ...(found.fieldOwnerRevision === undefined ? {} : { fieldOwnerRevision: found.fieldOwnerRevision }) };
    },
    owners() {
      return Object.keys(backing.load().drafts)
        .map((at): [string, DraftOwner | undefined] => [at, store.owner(at)])
        .filter((entry): entry is [string, DraftOwner] => entry[1] !== undefined);
    },
    jobOf: (at) => draftOf(at)?.jobId,
    plant(at, draft) {
      const record = backing.load();
      record.drafts[at] = emptyDraft(draft.fieldOwnerUid, draft.jobId);
      backing.save(record);
    },
    stamp: (at, jobId) =>
      change(at, (draft) => {
        draft.jobId = jobId;
      }),
    unstamp: (at) =>
      change(at, (draft) => {
        delete draft.jobId;
      }),
    remove(at) {
      const record = backing.load();
      delete record.drafts[at];
      backing.save(record);
    },
    calls: [],
    ownerCalls: [],
    failNext: { on: false, afterWrite: false },
    async ensure(companyId, jobId, draftId, fieldOwnerUid) {
      store.calls.push({ companyId, draftId, fieldOwnerUid });
      before();
      const at = `${companyId}/${draftId}`;
      const record = backing.load();
      const found = record.drafts[at];
      let made: 'created' | 'exists' = 'created';
      if (found?.placeholder) {
        const refused = placeholderRefusal({ jobId: found.jobId, state: found.state, archiveRevision: found.archiveRevision ?? null }, jobId);
        if (refused) return refused;
        // As the real writer: a restored job's placeholder gives way to the draft, which keeps its revision.
        record.drafts[at] = { ...emptyDraft(fieldOwnerUid, jobId), archiveRevision: found.archiveRevision };
      } else if (found) {
        if (draftOfOtherJob(found.jobId, jobId)) return 'taken';
        // As the real writer: one made before `jobId` takes it.
        found.jobId ??= jobId;
        made = 'exists';
      } else {
        record.drafts[at] = emptyDraft(fieldOwnerUid, jobId);
      }
      backing.save(record);
      after();
      return made;
    },
    // As the real writer (src/lib/jobs/drafts.ts): a newer owner on the draft is never overwritten,
    // nor is a draft made for another job, nor is anyone named on an archived one.
    async setFieldOwner(companyId, jobId, draftId, fieldOwnerUid, revision) {
      store.ownerCalls.push({ companyId, draftId, fieldOwnerUid, revision });
      before();
      const at = `${companyId}/${draftId}`;
      const record = backing.load();
      const draft = record.drafts[at];
      if (!draft || draft.placeholder) return 'missing';
      if (draftOfOtherJob(draft.jobId, jobId)) return 'taken';
      if (draft.state === 'archived') return 'archived';
      const stored = draft.fieldOwnerRevision ?? 0;
      let result: 'set' | 'same' | 'newer' = 'set';
      if (stored > revision) result = 'newer';
      else if (draft.fieldOwnerUid === fieldOwnerUid && stored === revision) result = 'same';
      else Object.assign(draft, { fieldOwnerUid, fieldOwnerRevision: revision });
      // A draft made before `jobId` takes it, whatever the owner answer is.
      draft.jobId ??= jobId;
      backing.save(record);
      after();
      return result;
    },
  };
  return store;
}
