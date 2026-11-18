import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { JobProjection } from '@/lib/field/job-projection';
import type { FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import type { ArchiveResult, ArchiveStore } from '@/lib/jobs/archive-store';
import { draftOfOtherJob } from '@/lib/jobs/drafts';
import type { FenceResult, FenceStore, Provenance } from '@/lib/submissions/fence';
import type { FakeDrafts } from '../db/draft-fake';
import type { FakeDraftStates } from '../db/evidence-fake';

// A stand-in for the field database's drafts as Submit sees them (src/lib/submissions/fence.ts):
// each draft's state, fence, field map and nested documents. It is held to the same contract as
// the real Firestore writer (fence-contract.ts, run against both), so the database tests cannot pass
// on a fence the real one would not keep.
//
// The data lives behind a backing: in memory for the route tests, or in a file so a separate
// process (killed mid-Submit, tests/db/submission-crash-child.ts) and the test that killed it see
// the same drafts, as two server processes see one Firestore. Linked to the jobs and photo stand-ins
// of tests/db/team-harness.ts, a draft the jobs service made is an empty `editing` draft here, and
// the photo route reads the state this fake holds.

export type FakeDraft = {
  fieldOwnerUid: string | null;
  state: string;
  fence: { submissionId: string; epoch: string; expiresAt: string } | null;
  field: unknown;
  rooms: Record<string, unknown>;
  photos: Record<string, unknown>;
  previous: Provenance | null;
  // The job revision of the last archive or restore (S5b-2), absent until one.
  archiveRevision?: number;
  // The job the draft was made for (security audit F1), absent on a draft made before that key.
  jobId?: string;
};
export type FieldData = Record<string, FakeDraft>;

export type Backing = { load(): FieldData; save(data: FieldData): void };

export const memoryBacking = (): Backing => {
  let data: FieldData = {};
  return {
    load: () => structuredClone(data),
    save: (next) => {
      data = structuredClone(next);
    },
  };
};

// Written whole and renamed into place, so a reader never sees half a file.
export const fileBacking = (path: string): Backing => ({
  load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FieldData) : {}),
  save: (next) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(next));
    renameSync(`${path}.tmp`, path);
  },
});

type Method = keyof FenceStore | keyof ArchiveStore;

// Also the archive, restore and copy writer of S5b-2 (src/lib/jobs/archive-store.ts), on the same
// drafts, so Submit and the photo route see an archived draft as the real field database holds it.
export type FakeField = FenceStore & ArchiveStore & {
  // The drafts as stored now (a copy).
  data(): FieldData;
  projected: Map<string, JobProjection>;
  draft(companyId: string, draftId: string): FakeDraft | null;
  // Writes field data as the phone would while the draft is editing (the rules are not modelled:
  // tests/emu/ checks them).
  put(companyId: string, draftId: string, manifest: Partial<FieldManifest>, fieldOwnerUid?: string | null): void;
  // Takes the job id off a draft, as on one the previous version made before drafts carried it
  // (security audit F1).
  unstamp(companyId: string, draftId: string): void;
  // Makes the next call of a method fail as if Firestore were unreachable, before it changes anything.
  failNext: Partial<Record<Method, boolean>>;
  // Awaited at the start of the next call of a method, so a test can hold one attempt mid-way.
  gate: Partial<Record<Method, () => Promise<void>>>;
  // Every call, by method name, in order.
  calls: Method[];
};

const key = (companyId: string, draftId: string) => `${companyId}/${draftId}`;

const emptyDraft = (fieldOwnerUid: string | null, jobId?: string): FakeDraft => ({
  fieldOwnerUid,
  state: 'editing',
  fence: null,
  field: {},
  rooms: {},
  photos: {},
  previous: null,
  ...(jobId === undefined ? {} : { jobId }),
});

export function fakeField(backing: Backing = memoryBacking(), linked?: { drafts: FakeDrafts; states: FakeDraftStates }): FakeField {
  function load(): FieldData {
    const data = backing.load();
    for (const [made, { fieldOwnerUid }] of linked?.drafts.made ?? []) data[made] ??= emptyDraft(fieldOwnerUid, linked?.drafts.jobOf.get(made));
    return data;
  }
  function save(data: FieldData): void {
    backing.save(data);
    if (!linked) return;
    for (const [at, draft] of Object.entries(data)) {
      linked.states.set.set(at, draft.state);
      linked.states.refs.set(at, Object.keys(draft.photos).length);
      if (!linked.drafts.made.has(at)) linked.drafts.made.set(at, { fieldOwnerUid: draft.fieldOwnerUid });
      if (draft.jobId !== undefined && !linked.drafts.jobOf.has(at)) linked.drafts.jobOf.set(at, draft.jobId);
    }
  }
  // Each call reads, decides and writes with no await in between: one transaction.
  async function call<T>(method: Method, work: (data: FieldData) => T): Promise<T> {
    fake.calls.push(method);
    const gate = fake.gate[method];
    if (gate) {
      delete fake.gate[method];
      await gate();
    }
    if (fake.failNext[method]) {
      fake.failNext[method] = false;
      throw new Error('field database unreachable');
    }
    const data = load();
    const result = work(data);
    save(data);
    return result;
  }

  const fake: FakeField = {
    failNext: {},
    gate: {},
    calls: [],
    projected: new Map(),
    projectJob: (companyId, jobId, projection) => call('projectJob', () => {
      const at = key(companyId, jobId);
      if ((fake.projected.get(at)?.revision ?? -1) < projection.revision) fake.projected.set(at, { ...projection });
    }),
    findDraft: (companyId, draftId) =>
      call('findDraft', (data) => {
        const found = data[key(companyId, draftId)];
        return found ? { jobId: found.jobId } : null;
      }),
    data: () => load(),
    draft: (companyId, draftId) => load()[key(companyId, draftId)] ?? null,
    put(companyId, draftId, manifest, fieldOwnerUid = null) {
      const data = load();
      const draft = (data[key(companyId, draftId)] ??= emptyDraft(fieldOwnerUid));
      if (manifest.draft !== undefined) draft.field = manifest.draft;
      for (const room of manifest.rooms ?? []) draft.rooms[room.id] = room.field;
      for (const photo of manifest.photos ?? []) draft.photos[photo.id] = photo.field;
      save(data);
    },

    unstamp(companyId, draftId) {
      const data = load();
      delete data[key(companyId, draftId)]?.jobId;
      save(data);
      linked?.drafts.jobOf.delete(key(companyId, draftId));
    },

    fence: (companyId, draftId, fence, replacing) =>
      call('fence', (data): FenceResult => {
        const draft = data[key(companyId, draftId)];
        if (!draft) return { outcome: 'missing' };
        const close = () => {
          draft.state = 'submitting';
          draft.fence = { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: fence.expiresAt.toISOString() };
        };
        if (draft.state === 'editing') {
          close();
          return { outcome: 'fenced' };
        }
        if (draft.state === 'submitting' && draft.fence) {
          if (draft.fence.epoch === fence.epoch) return { outcome: 'fenced' };
          if (replacing !== undefined && draft.fence.epoch === replacing) {
            close();
            return { outcome: 'fenced' };
          }
          return { outcome: 'held', epoch: draft.fence.epoch };
        }
        if (draft.state === 'submitted') return { outcome: 'submitted' };
        return { outcome: 'missing' };
      }),

    read: (companyId, draftId, epoch) =>
      call('read', (data) => {
        const draft = data[key(companyId, draftId)];
        if (!draft || draft.state !== 'submitting' || draft.fence?.epoch !== epoch) return null;
        if (Object.keys(draft.rooms).length > MAX_ROOMS) return 'too_many_rooms' as const;
        if (Object.keys(draft.photos).length > MAX_PHOTO_REFS) return 'too_many_photos' as const;
        return {
          draft: draft.field ?? {},
          rooms: Object.entries(draft.rooms).map(([id, field]) => ({ id, field: field ?? {} })),
          photos: Object.entries(draft.photos).map(([id, field]) => ({ id, field: field ?? {} })),
        };
      }),

    markSubmitted: (companyId, draftId, epoch, submissionId) =>
      call('markSubmitted', (data) => {
        const draft = data[key(companyId, draftId)];
        if (!draft) return 'missing' as const;
        if (!draft.fence || draft.fence.epoch !== epoch || draft.fence.submissionId !== submissionId) return 'conflict' as const;
        if (draft.state === 'submitted') return 'marked' as const;
        if (draft.state !== 'submitting') return 'conflict' as const;
        draft.state = 'submitted';
        return 'marked' as const;
      }),

    release: (companyId, draftId, epoch) =>
      call('release', (data) => {
        const draft = data[key(companyId, draftId)];
        if (!draft || draft.state !== 'submitting' || draft.fence?.epoch !== epoch) return 'not_fenced' as const;
        draft.state = 'editing';
        draft.fence = null;
        return 'released' as const;
      }),

    // As the real writer: a draft takes an archive or restore only at a newer job revision, and a
    // restore changes the state only of a draft that is archived.
    archiveDraft: (companyId, draftId, revision) =>
      call('archiveDraft', (data): ArchiveResult => {
        const draft = data[key(companyId, draftId)];
        if (!draft) return 'missing';
        const stored = draft.archiveRevision ?? 0;
        if (stored > revision) return 'newer';
        if (stored === revision) return 'same';
        Object.assign(draft, { state: 'archived', archiveRevision: revision });
        return 'set';
      }),

    restoreDraft: (companyId, draftId, state, revision) =>
      call('restoreDraft', (data): ArchiveResult => {
        const draft = data[key(companyId, draftId)];
        if (!draft) return 'missing';
        const stored = draft.archiveRevision ?? 0;
        if (stored > revision) return 'newer';
        if (stored === revision) return 'same';
        if (draft.state === 'archived') draft.state = state;
        draft.archiveRevision = revision;
        return 'set';
      }),

    createCopy: (companyId, jobId, draftId, fieldOwnerUid, manifest) =>
      call('createCopy', (data) => {
        const found = data[key(companyId, draftId)];
        if (found) {
          if (draftOfOtherJob(found.jobId, jobId)) return 'taken' as const;
          // As the real writer: a draft made before `jobId` takes it.
          found.jobId ??= jobId;
          return 'exists' as const;
        }
        data[key(companyId, draftId)] = {
          ...emptyDraft(fieldOwnerUid, jobId),
          field: manifest.draft ?? {},
          rooms: Object.fromEntries(manifest.rooms.map((room) => [room.id, room.field ?? {}])),
        };
        return 'created' as const;
      }),

    createFrom: (companyId, jobId, draftId, fieldOwnerUid, manifest, previous) =>
      call('createFrom', (data) => {
        const found = data[key(companyId, draftId)];
        if (found) {
          const same = found.previous?.draftId === previous.draftId && found.previous?.submissionId === previous.submissionId;
          if (!same || draftOfOtherJob(found.jobId, jobId)) return 'taken' as const;
          // As the real writer: a draft made before `jobId` takes it.
          found.jobId ??= jobId;
          return 'exists' as const;
        }
        data[key(companyId, draftId)] = {
          ...emptyDraft(fieldOwnerUid, jobId),
          field: manifest.draft ?? {},
          rooms: Object.fromEntries(manifest.rooms.map((room) => [room.id, room.field ?? {}])),
          photos: Object.fromEntries(manifest.photos.map((photo) => [photo.id, photo.field ?? {}])),
          previous: { ...previous },
        };
        return 'created' as const;
      }),
  };
  return fake;
}
