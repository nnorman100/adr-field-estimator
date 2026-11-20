import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FieldDoc } from '@/lib/field/canonical';
import { desired, type JobDraftSnapshot, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
import type { DraftSync } from '@/lib/jobs/draft-sync';
import type { Fence } from '@/lib/submissions/fence';

// The behaviour every draft sync must have (src/lib/jobs/draft-sync.ts). Run against the database
// tests' stand-in in tests/unit and the real Firestore writer in tests/emu, so the stand-in cannot
// drift from Firestore.

/** A draft as a test leaves it before a sync: any of the keys the server or the phone writes. */
export type SeedDraft = {
  jobId?: string;
  state: string;
  fieldOwnerUid?: string;
  fence?: Fence;
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

const fenceOf = (): Fence => ({ submissionId: randomUUID(), epoch: randomUUID(), expiresAt: new Date(Date.UTC(2031, 0, 2, 3, 4, 5)) });
const at = (fence: Fence) => ({ ...fence, expiresAt: fence.expiresAt.getTime() });

const NONE = { conflicts: [], missing: [], superseded: [], unmatched: [] };

// A job on its first draft, at field revision 1.
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
      expect(await store.sync(company, desired(job))).toEqual({ outcome: 'synced', created: [job.currentDraftId], changed: [], ...NONE });
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
      expect(await marker(company, job.jobId)).toEqual({ gen: 0, v: 4, draftIds: [job.currentDraftId], skipped: NONE });
      // A retry, or a slower request at the same version, writes nothing.
      expect(await store.sync(company, desired({ ...job, fieldOwnerUid: 'someone-else' }))).toEqual({ outcome: 'same', ...NONE });
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
      expect(await store.sync(company, late)).toEqual({ outcome: 'stale', stored: { gen: 0, v: 5, draftIds: [job.currentDraftId], skipped: NONE } });
      expect(await peek(company, other)).toBeNull();
      expect((await peek(company, job.currentDraftId))?.fieldOwnerUid).toBe('estimator-1');
      // After a database restore lowers the field revision, the operator raises the generation.
      expect(await store.sync(company, desired({ ...job, fieldRevision: 1, fieldOwnerUid: 'after-restore' }), 1)).toMatchObject({ outcome: 'synced' });
      expect((await peek(company, job.currentDraftId))?.fieldOwnerUid).toBe('after-restore');
      expect(await marker(company, job.jobId)).toEqual({ gen: 1, v: 1, draftIds: [job.currentDraftId], skipped: NONE });
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
      expect(await store.sync(company, desired({ ...job, pending }))).toEqual({ outcome: 'synced', created: [], changed: [current, earlier].sort(), ...NONE });
      expect(await peek(company, current)).toMatchObject({ state: 'submitting', fieldOwnerUid: 'estimator-1', fence: at(pending) });
      // An earlier draft keeps the fence its own Submit left.
      expect(await peek(company, earlier)).toMatchObject({ state: 'submitted', fieldOwnerUid: 'estimator-1', fence: at(earlierFence) });
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
      expect(await store.sync(company, next)).toEqual({ outcome: 'synced', created: [], changed: [], ...NONE });
      expect(await peek(company, job.currentDraftId)).toMatchObject({ field: { notes: 'wet carpet' }, rooms, previous: null });
      await store.sync(company, desired({ ...job, fieldRevision: 2, fieldOwnerUid: 'estimator-2' }));
      expect(await peek(company, job.currentDraftId)).toMatchObject({ fieldOwnerUid: 'estimator-2', field: { notes: 'wet carpet' }, rooms });
    });

    it('makes the current draft over a placeholder from its content, whole, and leaves another job’s placeholder or draft alone', async () => {
      const { store, seed, peek, marker } = probe();
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
      const skipped = { ...NONE, conflicts: [taken, theirs].sort(), missing: [gone] };
      expect(await store.sync(company, desired(mixed))).toEqual({ outcome: 'synced', created: [], changed: [], ...skipped });
      expect(await peek(company, taken)).toMatchObject({ jobId: other, state: 'editing', fieldOwnerUid: 'theirs' });
      expect(await peek(company, theirs)).toMatchObject({ jobId: other, placeholder: true });
      expect(await peek(company, gone)).toBeNull();
      // The marker records none of them as written, and a retry at the same version reports them again.
      expect(await marker(company, mixed.jobId)).toEqual({ gen: 0, v: 1, draftIds: [], skipped });
      expect(await store.sync(company, desired(mixed))).toEqual({ outcome: 'same', ...skipped });

      // Another job's placeholder under an earlier draft's id is a conflict too, not a missing draft.
      const [foreignEarlier, own] = [randomUUID(), randomUUID()];
      await seed(company, foreignEarlier, { jobId: other, state: 'archived', placeholder: true, archiveRevision: 1 });
      const later = snapshotOf({ currentDraftId: own, draftIds: [foreignEarlier, own] });
      expect(await store.sync(company, desired(later))).toMatchObject({ created: [own], conflicts: [foreignEarlier], missing: [] });
    });

    it('makes a copy’s draft from its source’s record less COPY_CLEARED_KEYS, without photos, and stamps the job on a draft made before drafts carried it', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const job = snapshotOf();
      // The signed record's scope confirmation is cleared: the copy confirms its own scope.
      const manifest = { draft: { yearBuilt: 1990, scopeConfirmed: true }, rooms: [{ id: 'bath', field: { name: 'Bath' } }] };
      await store.sync(company, desired({ ...job, content: { kind: 'copy', manifest } }));
      expect(await peek(company, job.currentDraftId)).toMatchObject({ field: { yearBuilt: 1990 }, photos: [], previous: null });
      expect(sorted((await peek(company, job.currentDraftId))!.rooms)).toEqual(manifest.rooms);
      // The record it came from is left as it was.
      expect(manifest.draft).toEqual({ yearBuilt: 1990, scopeConfirmed: true });

      const old = snapshotOf();
      await seed(company, old.currentDraftId, { state: 'editing', fieldOwnerUid: 'estimator-1' });
      expect(await store.sync(company, desired(old))).toMatchObject({ outcome: 'synced', changed: [old.currentDraftId] });
      expect((await peek(company, old.currentDraftId))?.jobId).toBe(old.jobId);
    });

    it('never lowers a newer legacy revision an older writer set: that draft is left and reported, until a generation reset', async () => {
      const { store, seed, peek } = probe();
      const company = randomUUID();
      const job = snapshotOf({ revision: 3, coordinationRevision: 4 });
      // The sync read estimator-1 at coordination revision 4; an older writer then named estimator-2 at 5.
      await seed(company, job.currentDraftId, { jobId: job.jobId, state: 'editing', fieldOwnerUid: 'estimator-2', fieldOwnerRevision: 5, archiveRevision: 3 });
      const superseded = { ...NONE, superseded: [job.currentDraftId] };
      expect(await store.sync(company, desired(job))).toEqual({ outcome: 'synced', created: [], changed: [], ...superseded });
      expect(await peek(company, job.currentDraftId)).toMatchObject({ fieldOwnerUid: 'estimator-2', fieldOwnerRevision: 5 });
      expect(await store.sync(company, desired(job))).toEqual({ outcome: 'same', ...superseded });
      // A sync at a newer version that read that revision handles the draft.
      expect(await store.sync(company, desired({ ...job, fieldRevision: 2, coordinationRevision: 5, fieldOwnerUid: 'estimator-2' }))).toEqual({
        outcome: 'synced',
        created: [],
        changed: [],
        ...NONE,
      });

      // A newer archive by an older writer is kept the same way, and only a generation reset writes over it.
      const archived = snapshotOf({ revision: 2 });
      await seed(company, archived.currentDraftId, { jobId: archived.jobId, state: 'archived', archiveRevision: 3 });
      expect(await store.sync(company, desired(archived))).toMatchObject({ changed: [], superseded: [archived.currentDraftId] });
      expect((await peek(company, archived.currentDraftId))?.state).toBe('archived');
      expect(await store.sync(company, desired({ ...archived, revision: 1 }), 1)).toMatchObject({ changed: [archived.currentDraftId], superseded: [] });
      expect(await peek(company, archived.currentDraftId)).toMatchObject({ state: 'editing', archiveRevision: 1 });
    });

    it('after a restore drops a draft from the job, keeps it on the marker, closed to field access with its field work', async () => {
      const { store, seed, peek, marker } = probe();
      const company = randomUUID();
      const [first, second] = [randomUUID(), randomUUID()];
      // Back to editing made the second draft from the first, and a sync wrote both.
      const later = snapshotOf({ currentDraftId: second, draftIds: [first, second], fieldRevision: 6 });
      await seed(company, first, { jobId: later.jobId, state: 'submitted', fieldOwnerUid: 'estimator-1', field: { notes: 'first visit' } });
      await store.sync(company, desired({ ...later, content: { kind: 'next', manifest: { draft: { notes: 'second visit' }, rooms: [], photos: [] }, previous: { draftId: first, submissionId: randomUUID() } } }));
      // The database is restored to when the first draft was current; the operator raises the generation.
      const restored = { ...later, currentDraftId: first, draftIds: [first], fieldRevision: 2 };
      expect(await store.sync(company, desired(restored), 1)).toEqual({ outcome: 'synced', created: [], changed: [first, second].sort(), ...NONE, unmatched: [second] });
      expect(await peek(company, second)).toMatchObject({ jobId: later.jobId, state: 'archived', fieldOwnerUid: null, field: { notes: 'second visit' } });
      expect(await peek(company, first)).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-1', field: { notes: 'first visit' } });
      expect(await marker(company, later.jobId)).toEqual({ gen: 1, v: 2, draftIds: [first, second].sort(), skipped: { ...NONE, unmatched: [second] } });
      // A later sync of the job (a Move) keeps it closed and still reports it.
      expect(await store.sync(company, desired({ ...restored, fieldRevision: 3, fieldOwnerUid: 'estimator-2' }), 1)).toMatchObject({ changed: [first], unmatched: [second] });
      expect(await peek(company, second)).toMatchObject({ state: 'archived', fieldOwnerUid: null });
    });
  });
}
