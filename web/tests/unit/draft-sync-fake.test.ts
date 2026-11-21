import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desired, type JobDraftSnapshot, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
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
      const record = backing.load();
      const made: FakeDraft = {
        fieldOwnerUid: seed.fieldOwnerUid ?? null,
        state: seed.state,
        fence: seed.fence ? { submissionId: seed.fence.submissionId, epoch: seed.fence.epoch, expiresAt: seed.fence.expiresAt.toISOString() } : null,
        field: seed.field ?? {},
        rooms: Object.fromEntries((seed.rooms ?? []).map((room) => [room.id, room.field])),
        photos: Object.fromEntries((seed.photos ?? []).map((photo) => [photo.id, photo.field])),
        previous: null,
        ...(seed.jobId === undefined ? {} : { jobId: seed.jobId }),
        ...(seed.placeholder ? { placeholder: true as const } : {}),
        ...(seed.archiveRevision === undefined ? {} : { archiveRevision: seed.archiveRevision }),
        ...(seed.fieldOwnerRevision === undefined ? {} : { fieldOwnerRevision: seed.fieldOwnerRevision }),
      };
      record.drafts[`${company}/${draft}`] = made;
      backing.save(record);
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
      return store.marker(company, job);
    },
    async remove(company, draft) {
      store.remove(company, draft);
    },
    async seedMarker(company, job, data) {
      const record = backing.load();
      record.markers[`${company}/${job}`] = data as unknown as SyncMarker;
      backing.save(record);
    },
    async seedGeneration(data) {
      store.setGeneration(data);
    },
  };
});

// The r11 fake split: the jobs, photo and sync stand-ins all see one record, in both directions.
describe('the draft sync stand-in', () => {
  // The jobs, photo and field stand-ins over one backing, as tests/db/team-harness.ts builds them.
  function linked() {
    const backing = memoryBacking();
    return { drafts: fakeDrafts(backing), states: fakeDraftStates(backing), backing, field: fakeField(backing) };
  }
  const snapshotOf = (job: string, draft: string, extra: Partial<JobDraftSnapshot> = {}): JobDraftSnapshot => ({
    jobId: job,
    status: 'draft',
    currentDraftId: draft,
    fieldOwnerUid: 'estimator-1',
    fieldRevision: 3,
    revision: 3,
    coordinationRevision: 0,
    draftIds: [draft],
    pending: null,
    committed: null,
    abortedEpochs: [],
    content: { kind: 'empty' },
    ...extra,
  });

  it('shows what the sync writes to the jobs and photo stand-ins: a draft made over a placeholder, and a moved owner', async () => {
    const { drafts, states, field } = linked();
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await field.restoreDraft(company, job, draft, 'editing', 2);
    expect(await states.state(company, draft)).toBe('absent');
    expect(await field.sync(company, desired(snapshotOf(job, draft)), 0)).toMatchObject({ outcome: 'synced', created: [draft] });
    expect(await states.state(company, draft)).toBe('editing');
    expect(await drafts.findDraft(company, draft)).toEqual({ jobId: job });
    // The owner moves, at a coordination revision: the jobs stand-in names the new owner with it.
    await field.sync(company, desired(snapshotOf(job, draft, { fieldRevision: 4, coordinationRevision: 2, fieldOwnerUid: 'estimator-2' })), 0);
    expect(drafts.owner(`${company}/${draft}`)).toEqual({ fieldOwnerUid: 'estimator-2', fieldOwnerRevision: 2 });
    expect(await drafts.setFieldOwner(company, job, draft, 'estimator-1', 1)).toBe('newer');
  });

  it('shows what the jobs stand-in writes to the photo state and the sync: a draft made over a restored placeholder, and a named owner', async () => {
    const { drafts, states, field } = linked();
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await field.restoreDraft(company, job, draft, 'editing', 2);
    expect(await drafts.ensure(company, job, draft, 'estimator-1')).toBe('created');
    // At once, with no other field call between: the photo route reads an editing draft.
    expect(await states.state(company, draft)).toBe('editing');
    expect(await drafts.setFieldOwner(company, job, draft, 'estimator-2', 4)).toBe('set');
    expect(field.draft(company, draft)).toMatchObject({ fieldOwnerUid: 'estimator-2', fieldOwnerRevision: 4, jobId: job });
    // The sync reads the owner the jobs stand-in named: a sync that read revision 3 leaves it.
    expect(await field.sync(company, desired(snapshotOf(job, draft, { revision: 2, coordinationRevision: 3 })), 0)).toMatchObject({ superseded: [draft] });
  });

  it('keeps the marker in the backing, so another stand-in over the same backing sees it', async () => {
    const { backing, field } = linked();
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await field.sync(company, desired(snapshotOf(job, draft)), 0);
    const again = fakeField(backing);
    expect(again.marker(company, job)).toMatchObject({ gen: 0, v: 3, draftIds: [draft] });
    expect(await again.sync(company, desired(snapshotOf(job, draft)), 0)).toMatchObject({ outcome: 'same' });
  });

  it('answers every caller alike from the one record: a placeholder is under the id for the jobs and field stand-ins', async () => {
    const { drafts, states, field } = linked();
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await field.archiveDraft(company, job, draft, 2);
    expect(await drafts.findDraft(company, draft)).toEqual({ jobId: job, placeholder: true });
    expect(await field.findDraft(company, draft)).toEqual({ jobId: job, placeholder: true });
    expect(await states.state(company, draft)).toBe('archived');
    // A placeholder is no draft to name an owner on.
    expect(drafts.owner(`${company}/${draft}`)).toBeUndefined();
    expect(await drafts.setFieldOwner(company, job, draft, 'estimator-1', 1)).toBe('missing');
  });
});
