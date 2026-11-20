import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FieldDoc } from '@/lib/field/canonical';
import { desired, type JobDraftSnapshot, type SyncFence, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
import type { DraftSync } from '@/lib/jobs/draft-sync';

// The behaviour every draft sync must have (src/lib/jobs/draft-sync.ts). Run against the database
// tests' stand-in in tests/unit and the real Firestore writer in tests/emu, so the stand-in cannot
// drift from Firestore.

/** A draft as a test leaves it before a sync: any of the keys the server or the phone writes. */
export type SeedDraft = {
  jobId?: string;
  state: string;
  fieldOwnerUid?: string;
  fence?: SyncFence;
  field?: unknown;
  rooms?: FieldDoc[];
  placeholder?: true;
  archiveRevision?: number;
  fieldOwnerRevision?: number;
};

export type SyncPeek = {
  jobId: string | null;
  state: string;
  fieldOwnerUid: string | null;
  fence: { submissionId: string; epoch: string; expiresAt: number } | null;
  previous: { draftId: string; submissionId: string } | null;
  archiveRevision: number | null;
  fieldOwnerRevision: number | null;
  placeholder: boolean;
  field: unknown;
  rooms: FieldDoc[];
  photos: FieldDoc[];
};

export type SyncProbe = {
  store: DraftSync;
  seed(companyId: string, draftId: string, draft: SeedDraft): Promise<void>;
  peek(companyId: string, draftId: string): Promise<SyncPeek | null>;
  marker(companyId: string, jobId: string): Promise<SyncMarker | null>;
};

const fenceOf = (): SyncFence => ({ submissionId: randomUUID(), epoch: randomUUID(), expiresAt: new Date(Date.UTC(2031, 0, 2, 3, 4, 5)) });

// A job on its first draft, at field revision `v`.
function snapshotOf(extra: Partial<JobDraftSnapshot> = {}): JobDraftSnapshot {
  const currentDraftId = extra.currentDraftId ?? randomUUID();
  return {
    jobId: randomUUID(),
    status: 'draft',
    currentDraftId,
    fieldOwnerUid: 'estimator-1',
    fieldRevision: 1,
    revision: 1,
    coordinationRevision: 0,
    draftIds: [currentDraftId],
    pending: null,
    committed: null,
    content: { kind: 'empty' },
    ...extra,
  };
}

const sorted = (docs: FieldDoc[]) => [...docs].sort((a, b) => (a.id < b.id ? -1 : 1));

export function draftSyncContract(name: string, probe: () => SyncProbe): void {
  describe(`${name} draft sync contract`, () => {
    it('makes a missing current draft from its content, writes the marker, and does nothing again at the same version', async () => {
      const { store, peek, marker } = probe();
      const company = randomUUID();
      const job = snapshotOf({ revision: 3, coordinationRevision: 2, fieldRevision: 4 });
      expect(await store.sync(company, desired(job))).toEqual({ outcome: 'synced', created: [job.currentDraftId], changed: [], conflicts: [], missing: [] });
      expect(await peek(company, job.currentDraftId)).toEqual({
        jobId: job.jobId,
        state: 'editing',
        fieldOwnerUid: 'estimator-1',
        fence: null,
        previous: null,
        archiveRevision: 3,
        fieldOwnerRevision: 2,
        placeholder: false,
        field: {},
        rooms: [],
        photos: [],
      });
      expect(await marker(company, job.jobId)).toEqual({ gen: 0, v: 4, draftIds: [job.currentDraftId] });
      // A retry, or a slower request at the same version, writes nothing.
      expect(await store.sync(company, desired({ ...job, fieldOwnerUid: 'someone-else' }))).toEqual({ outcome: 'same' });
      expect((await peek(company, job.currentDraftId))?.fieldOwnerUid).toBe('estimator-1');
    });

    it('refuses an older version before it makes or changes any draft, and takes a newer generation after a restore', async () => {
      const { store, peek, marker } = probe();
      const company = randomUUID();
      const job = snapshotOf({ fieldRevision: 5 });
      await store.sync(company, desired(job));
      const other = randomUUID();
      // A sync that read Postgres before the change synced at 5: refused, and its new draft never made.
      const late = desired({ ...job, fieldRevision: 3, fieldOwnerUid: 'old-owner', currentDraftId: other, draftIds: [job.currentDraftId, other] });
      expect(await store.sync(company, late)).toEqual({ outcome: 'stale', stored: { gen: 0, v: 5, draftIds: [job.currentDraftId] } });
      expect(await peek(company, other)).toBeNull();
      expect((await peek(company, job.currentDraftId))?.fieldOwnerUid).toBe('estimator-1');
      // After a database restore lowers the field revision, the operator raises the generation.
      expect(await store.sync(company, desired({ ...job, fieldRevision: 1, fieldOwnerUid: 'after-restore' }), 1)).toMatchObject({ outcome: 'synced' });
      expect((await peek(company, job.currentDraftId))?.fieldOwnerUid).toBe('after-restore');
      expect(await marker(company, job.jobId)).toEqual({ gen: 1, v: 1, draftIds: [job.currentDraftId] });
    });

    it('writes every draft of the job in one sync: the current one’s state and fence, every earlier one submitted with the current owner', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const [earlier, current] = [randomUUID(), randomUUID()];
      const job = snapshotOf({ currentDraftId: current, draftIds: [earlier, current], fieldRevision: 2 });
      const earlierFence = fenceOf();
      await seed(company, earlier, { jobId: job.jobId, state: 'archived', fieldOwnerUid: 'old-owner', fence: earlierFence });
      await seed(company, current, { jobId: job.jobId, state: 'editing', fieldOwnerUid: 'old-owner' });
      const pending = fenceOf();
      expect(await store.sync(company, desired({ ...job, pending }))).toEqual({ outcome: 'synced', created: [], changed: [current, earlier].sort(), conflicts: [], missing: [] });
      expect(await peek(company, current)).toMatchObject({ state: 'submitting', fieldOwnerUid: 'estimator-1', fence: { ...pending, expiresAt: pending.expiresAt.getTime() } });
      // An earlier draft keeps the fence its own Submit left.
      expect(await peek(company, earlier)).toMatchObject({
        state: 'submitted',
        fieldOwnerUid: 'estimator-1',
        fence: { ...earlierFence, expiresAt: earlierFence.expiresAt.getTime() },
      });
      // The pending row aborted: the fence goes, and the draft is editing again.
      await store.sync(company, desired({ ...job, fieldRevision: 3 }));
      expect(await peek(company, current)).toMatchObject({ state: 'editing', fence: null });
      // Archived, then nobody owns the field work: every draft is archived or submitted, and names nobody.
      await store.sync(company, desired({ ...job, fieldRevision: 4, status: 'archived', fieldOwnerUid: null }));
      expect(await peek(company, current)).toMatchObject({ state: 'archived', fieldOwnerUid: null });
      expect(await peek(company, earlier)).toMatchObject({ state: 'submitted', fieldOwnerUid: null });
    });

    it('never touches the field work of a draft that exists, and writes nothing to a draft already as Postgres says', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const job = snapshotOf({ revision: 2, coordinationRevision: 1 });
      const rooms = [{ id: 'kitchen', field: { name: 'Kitchen' } }];
      await seed(company, job.currentDraftId, {
        jobId: job.jobId,
        state: 'editing',
        fieldOwnerUid: 'estimator-1',
        field: { notes: 'wet carpet' },
        rooms,
        archiveRevision: 2,
        fieldOwnerRevision: 1,
      });
      const next = desired({ ...job, content: { kind: 'next', manifest: { draft: { notes: 'other' }, rooms: [], photos: [] }, previous: { draftId: randomUUID(), submissionId: randomUUID() } } });
      expect(await store.sync(company, next)).toEqual({ outcome: 'synced', created: [], changed: [], conflicts: [], missing: [] });
      expect(await peek(company, job.currentDraftId)).toMatchObject({ field: { notes: 'wet carpet' }, rooms, previous: null });
      await store.sync(company, desired({ ...job, fieldRevision: 2, fieldOwnerUid: 'estimator-2' }));
      expect(await peek(company, job.currentDraftId)).toMatchObject({ fieldOwnerUid: 'estimator-2', field: { notes: 'wet carpet' }, rooms });
    });

    it('makes the current draft over a placeholder from its content, whole, and leaves another job’s placeholder or draft alone', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const job = snapshotOf();
      await seed(company, job.currentDraftId, { jobId: job.jobId, state: 'archived', placeholder: true, archiveRevision: 7 });
      const previous = { draftId: randomUUID(), submissionId: randomUUID() };
      const manifest = {
        draft: { roomOrder: ['kitchen'] },
        rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }],
        photos: [{ id: randomUUID(), field: { roomId: 'kitchen' } }],
      };
      expect(await store.sync(company, desired({ ...job, revision: 8, content: { kind: 'next', manifest, previous } }))).toMatchObject({ created: [job.currentDraftId] });
      expect(await peek(company, job.currentDraftId)).toEqual({
        jobId: job.jobId,
        state: 'editing',
        fieldOwnerUid: 'estimator-1',
        fence: null,
        previous,
        archiveRevision: 8,
        fieldOwnerRevision: 0,
        placeholder: false,
        field: manifest.draft,
        rooms: manifest.rooms,
        photos: manifest.photos,
      });

      // Another job's draft and placeholder, and an earlier draft that is missing.
      const [taken, theirs, gone] = [randomUUID(), randomUUID(), randomUUID()];
      const other = randomUUID();
      await seed(company, taken, { jobId: other, state: 'editing', fieldOwnerUid: 'theirs' });
      await seed(company, theirs, { jobId: other, state: 'absent', placeholder: true, archiveRevision: 2 });
      const mixed = snapshotOf({ currentDraftId: theirs, draftIds: [taken, gone, theirs] });
      expect(await store.sync(company, desired(mixed))).toEqual({ outcome: 'synced', created: [], changed: [], conflicts: [taken, theirs].sort(), missing: [gone] });
      expect(await peek(company, taken)).toMatchObject({ jobId: other, state: 'editing', fieldOwnerUid: 'theirs' });
      expect(await peek(company, theirs)).toMatchObject({ jobId: other, placeholder: true });
      expect(await peek(company, gone)).toBeNull();
    });

    it('makes a copy’s draft from its source’s record without photos, and stamps the job on a draft made before drafts carried it', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const job = snapshotOf();
      const manifest = { draft: { yearBuilt: 1990 }, rooms: [{ id: 'bath', field: { name: 'Bath' } }] };
      await store.sync(company, desired({ ...job, content: { kind: 'copy', manifest } }));
      expect(await peek(company, job.currentDraftId)).toMatchObject({ field: manifest.draft, rooms: manifest.rooms, photos: [], previous: null });

      const old = snapshotOf();
      await seed(company, old.currentDraftId, { state: 'editing', fieldOwnerUid: 'estimator-1' });
      expect(await store.sync(company, desired(old))).toMatchObject({ outcome: 'synced', changed: [old.currentDraftId] });
      expect((await peek(company, old.currentDraftId))?.jobId).toBe(old.jobId);
      const rooms = (await peek(company, job.currentDraftId))!.rooms;
      expect(sorted(rooms)).toEqual(manifest.rooms);
    });
  });
}
