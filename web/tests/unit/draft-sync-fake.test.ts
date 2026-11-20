import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desired } from '@/lib/jobs/draft-lifecycle';
import { fakeDraftStates } from '../db/evidence-fake';
import { fakeDrafts } from '../db/draft-fake';
import { fakeField, memoryBacking, type FakeDraft } from '../submissions/field-fake';
import { draftSyncContract } from '../submissions/sync-contract';

// The database tests' stand-in for the draft sync (tests/submissions/field-fake.ts, `sync`) holds to
// the same contract as the real Firestore writer (tests/emu/draft-sync.test.ts).
draftSyncContract('in-memory', () => {
  const backing = memoryBacking();
  const store = fakeField(backing);
  return {
    store,
    async seed(company, draft, seed) {
      const data = backing.load();
      const made: FakeDraft = {
        fieldOwnerUid: seed.fieldOwnerUid ?? null,
        state: seed.state,
        fence: seed.fence ? { submissionId: seed.fence.submissionId, epoch: seed.fence.epoch, expiresAt: seed.fence.expiresAt.toISOString() } : null,
        field: seed.field ?? {},
        rooms: Object.fromEntries((seed.rooms ?? []).map((room) => [room.id, room.field])),
        photos: {},
        previous: null,
        ...(seed.jobId === undefined ? {} : { jobId: seed.jobId }),
        ...(seed.placeholder ? { placeholder: true as const } : {}),
        ...(seed.archiveRevision === undefined ? {} : { archiveRevision: seed.archiveRevision }),
        ...(seed.fieldOwnerRevision === undefined ? {} : { fieldOwnerRevision: seed.fieldOwnerRevision }),
      };
      data[`${company}/${draft}`] = made;
      backing.save(data);
    },
    async peek(company, draft) {
      const found = store.draft(company, draft);
      if (!found) return null;
      return {
        jobId: found.jobId ?? null,
        state: found.state,
        fieldOwnerUid: found.fieldOwnerUid,
        fence: found.fence ? { submissionId: found.fence.submissionId, epoch: found.fence.epoch, expiresAt: Date.parse(found.fence.expiresAt) } : null,
        previous: found.previous,
        archiveRevision: found.archiveRevision ?? null,
        fieldOwnerRevision: found.fieldOwnerRevision ?? null,
        placeholder: found.placeholder === true,
        field: found.field,
        rooms: Object.entries(found.rooms).map(([id, field]) => ({ id, field })),
        photos: Object.entries(found.photos).map(([id, field]) => ({ id, field })),
      };
    },
    async marker(company, job) {
      return store.markers.get(`${company}/${job}`) ?? null;
    },
  };
});

// The r11 fake split: what the sync writes is the one record the jobs and photo stand-ins read.
describe('the draft sync stand-in', () => {
  it('shows a draft it makes over a placeholder to the photo route’s state as the real field database would', async () => {
    const drafts = fakeDrafts();
    const states = fakeDraftStates(drafts);
    const store = fakeField(memoryBacking(), { drafts, states });
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await store.restoreDraft(company, job, draft, 'editing', 2);
    expect(await states.state(company, draft)).toBe('absent');
    const snapshot = {
      jobId: job,
      status: 'draft' as const,
      currentDraftId: draft,
      fieldOwnerUid: 'estimator-1',
      fieldRevision: 3,
      revision: 3,
      coordinationRevision: 0,
      draftIds: [draft],
      pending: null,
      committed: null,
      content: { kind: 'empty' as const },
    };
    expect(await store.sync(company, desired(snapshot))).toMatchObject({ outcome: 'synced', created: [draft] });
    expect(await states.state(company, draft)).toBe('editing');
    expect(await drafts.findDraft(company, draft)).toEqual({ jobId: job });
  });
});
