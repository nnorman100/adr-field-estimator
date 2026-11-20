import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { JobProjection } from '@/lib/field/job-projection';
import type { FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import type { ArchiveResult, ArchiveStore } from '@/lib/jobs/archive-store';
import { planSync, versionRefusal, type StoredDraft, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
import { draftIdsToRead, resultOf, type DraftSync } from '@/lib/jobs/draft-sync';
import { placeholderRefusal as refusalOf, draftOfOtherJob, type DraftMade } from '@/lib/jobs/drafts';
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
  // The coordination revision the field owner was last named at (src/lib/jobs/drafts.ts), absent until one.
  fieldOwnerRevision?: number;
  // The job the draft was made for (security audit F1), absent on a draft made before that key.
  jobId?: string;
  // The record an archive or restore leaves for a missing draft (src/lib/jobs/archive-store.ts): its
  // `state` is `archived` or `absent`.
  placeholder?: true;
};
export type FieldData = Record<string, FakeDraft>;

// The draft sync's markers (src/lib/jobs/draft-sync.ts), by "company/job", kept in the same backing
// as the drafts they guard.
export type Markers = Record<string, SyncMarker>;

export type Backing = { load(): FieldData; save(data: FieldData): void; loadMarkers(): Markers; saveMarkers(markers: Markers): void };

export const memoryBacking = (): Backing => {
  let data: FieldData = {};
  let markers: Markers = {};
  return {
    load: () => structuredClone(data),
    save: (next) => {
      data = structuredClone(next);
    },
    loadMarkers: () => structuredClone(markers),
    saveMarkers: (next) => {
      markers = structuredClone(next);
    },
  };
};

// Written whole and renamed into place, so a reader never sees half a file.
function readJson<T>(path: string, empty: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : empty;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}
export const fileBacking = (path: string): Backing => ({
  load: () => readJson<FieldData>(path, {}),
  save: (next) => writeJson(path, next),
  loadMarkers: () => readJson<Markers>(`${path}.markers`, {}),
  saveMarkers: (next) => writeJson(`${path}.markers`, next),
});

type Method = keyof FenceStore | keyof ArchiveStore | keyof DraftSync;

// Also the archive, restore and copy writer of S5b-2 (src/lib/jobs/archive-store.ts), on the same
// drafts, so Submit and the photo route see an archived draft as the real field database holds it,
// and the draft life-cycle sync (src/lib/jobs/draft-sync.ts), which applies the same plan
// (planSync) to this one shared record, so the jobs and photo stand-ins linked to it see every
// draft it makes or changes (the r11 fake split).
export type FakeField = FenceStore & ArchiveStore & DraftSync & {
  // The sync's marker for a job, as the backing holds it, or null.
  marker(companyId: string, jobId: string): SyncMarker | null;
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
  // Removes a draft from the one record, as one that is not there (the jobs and photo stand-ins too).
  remove(companyId: string, draftId: string): void;
  // Makes the next call of a method fail as if Firestore were unreachable, before it changes anything.
  failNext: Partial<Record<Method, boolean>>;
  // Makes the next call of a method do its work and then fail, as if Firestore's answer were lost.
  loseNext: Partial<Record<Method, boolean>>;
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
    for (const [made, { fieldOwnerUid }] of linked?.drafts.made ?? []) {
      const left = data[made];
      // As the real writer: the jobs service made the draft over a restored job's placeholder, which keeps its revision.
      if (!left || (left.placeholder && !linked?.drafts.placeholders.has(made))) {
        data[made] = { ...emptyDraft(fieldOwnerUid, linked?.drafts.jobOf.get(made)), ...(left ? { archiveRevision: left.archiveRevision } : {}) };
      }
    }
    // What the jobs stand-in named last (setFieldOwner, or a test) is the draft's field owner here too.
    for (const [made, owner] of linked?.drafts.made ?? []) {
      const draft = data[made];
      if (!draft || draft.placeholder) continue;
      draft.fieldOwnerUid = owner.fieldOwnerUid;
      if (owner.fieldOwnerRevision === undefined) delete draft.fieldOwnerRevision;
      else draft.fieldOwnerRevision = owner.fieldOwnerRevision;
      const job = linked?.drafts.jobOf.get(made);
      if (job !== undefined) draft.jobId ??= job;
    }
    return data;
  }
  function save(data: FieldData): void {
    backing.save(data);
    if (!linked) return;
    for (const [at, draft] of Object.entries(data)) {
      linked.states.set.set(at, draft.state);
      // A placeholder is no draft to the jobs service (src/lib/jobs/drafts.ts): nobody is named on it.
      if (draft.placeholder) {
        linked.drafts.placeholders.set(at, { jobId: draft.jobId, state: draft.state, archiveRevision: draft.archiveRevision ?? null });
        continue;
      }
      linked.drafts.placeholders.delete(at);
      if (draft.state === 'archived') linked.drafts.archived.add(at);
      else linked.drafts.archived.delete(at);
      linked.states.refs.set(at, Object.keys(draft.photos).length);
      // The one record: the jobs stand-in sees the owner every writer here leaves (the sync included).
      linked.drafts.made.set(at, {
        fieldOwnerUid: draft.fieldOwnerUid,
        ...(draft.fieldOwnerRevision === undefined ? {} : { fieldOwnerRevision: draft.fieldOwnerRevision }),
      });
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
    if (fake.loseNext[method]) {
      fake.loseNext[method] = false;
      throw new Error('field database answer lost');
    }
    return result;
  }

  // The jobs stand-in's writes reach this record (and the photo route's state) at once.
  if (linked) linked.drafts.written = () => save(load());
  const fake: FakeField = {
    marker: (companyId, jobId) => backing.loadMarkers()[key(companyId, jobId)] ?? null,
    sync: (companyId, job, gen = 0) =>
      call('sync', (data) => {
        const markers = backing.loadMarkers();
        const marker = markers[key(companyId, job.jobId)] ?? null;
        // As the real writer: the marker decides first, before any draft is read.
        const refused = versionRefusal(marker, gen, job.v);
        if (refused) return refused;
        const stored = Object.fromEntries(draftIdsToRead(marker, job).map((draftId) => [draftId, storedOf(data[key(companyId, draftId)])]));
        const plan = planSync(marker, stored, job, gen);
        if (plan.outcome !== 'synced') return resultOf(plan);
        for (const made of plan.creates) {
          const { fence, previous, fieldOwnerUid, field, ...rest } = made.data;
          data[key(companyId, made.draftId)] = {
            ...emptyDraft(fieldOwnerUid ?? null, made.data.jobId),
            ...rest,
            field,
            fence: fence ? { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: fence.expiresAt.toISOString() } : null,
            previous: previous ? { ...previous } : null,
            rooms: Object.fromEntries(made.rooms.map((room) => [room.id, room.field ?? {}])),
            photos: Object.fromEntries(made.photos.map((photo) => [photo.id, photo.field ?? {}])),
          };
        }
        for (const update of plan.updates) {
          const draft = data[key(companyId, update.draftId)]!;
          const { fence, ...rest } = update.set;
          Object.assign(draft, rest);
          if (fence) draft.fence = { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: fence.expiresAt.toISOString() };
          if (update.remove.includes('fieldOwnerUid')) draft.fieldOwnerUid = null;
          if (update.remove.includes('fence')) draft.fence = null;
        }
        markers[key(companyId, job.jobId)] = plan.marker;
        backing.saveMarkers(markers);
        return resultOf(plan);
      }),
    failNext: {},
    loseNext: {},
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

    remove(companyId, draftId) {
      const at = key(companyId, draftId);
      const data = load();
      delete data[at];
      backing.save(data);
      linked?.drafts.made.delete(at);
      linked?.drafts.jobOf.delete(at);
      linked?.drafts.archived.delete(at);
      linked?.drafts.placeholders.delete(at);
      linked?.states.set.delete(at);
      linked?.states.refs.delete(at);
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
    // restore changes the state only of a draft that is archived, and an archive leaves a fenced one as it
    // is. Where the draft is missing, each leaves a placeholder holding the revision (archived, or absent
    // once restored).
    archiveDraft: (companyId, jobId, draftId, revision) =>
      call('archiveDraft', (data): ArchiveResult => lifecycle(data, companyId, jobId, draftId, revision, 'archived', (current) => (current === 'submitting' ? current : 'archived'))),

    restoreDraft: (companyId, jobId, draftId, state, revision) =>
      call('restoreDraft', (data): ArchiveResult =>
        lifecycle(data, companyId, jobId, draftId, revision, 'absent', (current) => (current === 'archived' ? state : current)),
      ),

    createCopy: (companyId, jobId, draftId, fieldOwnerUid, manifest) =>
      call('createCopy', (data): DraftMade => {
        const found = data[key(companyId, draftId)];
        if (found && !found.placeholder) {
          if (draftOfOtherJob(found.jobId, jobId)) return 'taken';
          // As the real writer: a draft made before `jobId` takes it.
          found.jobId ??= jobId;
          return 'exists';
        }
        const left = found ? placeholderRefusal(found, jobId) : null;
        if (left) return left;
        data[key(companyId, draftId)] = {
          ...emptyDraft(fieldOwnerUid, jobId),
          ...(found ? { archiveRevision: found.archiveRevision } : {}),
          field: manifest.draft ?? {},
          rooms: Object.fromEntries(manifest.rooms.map((room) => [room.id, room.field ?? {}])),
        };
        return 'created';
      }),

    createFrom: (companyId, jobId, draftId, fieldOwnerUid, manifest, previous) =>
      call('createFrom', (data): DraftMade => {
        const found = data[key(companyId, draftId)];
        if (found && !found.placeholder) {
          const same = found.previous?.draftId === previous.draftId && found.previous?.submissionId === previous.submissionId;
          if (!same || draftOfOtherJob(found.jobId, jobId)) return 'taken';
          // As the real writer: a draft made before `jobId` takes it.
          found.jobId ??= jobId;
          return 'exists';
        }
        const left = found ? placeholderRefusal(found, jobId) : null;
        if (left) return left;
        data[key(companyId, draftId)] = {
          ...emptyDraft(fieldOwnerUid, jobId),
          ...(found ? { archiveRevision: found.archiveRevision } : {}),
          field: manifest.draft ?? {},
          rooms: Object.fromEntries(manifest.rooms.map((room) => [room.id, room.field ?? {}])),
          photos: Object.fromEntries(manifest.photos.map((photo) => [photo.id, photo.field ?? {}])),
          previous: { ...previous },
        };
        return 'created';
      }),
  };
  return fake;
}

// As the real writers (src/lib/jobs/drafts.ts): only a restored placeholder of this job that holds its
// revision gives way to the draft.
function placeholderRefusal(found: FakeDraft, jobId: string): 'taken' | 'archived' | null {
  return refusalOf({ jobId: found.jobId, state: found.state, archiveRevision: found.archiveRevision ?? null }, jobId);
}

// An archive or restore of the draft at this job revision: only a newer one changes it, and a
// missing draft gets the placeholder that keeps the revision.
function lifecycle(
  data: FieldData,
  companyId: string,
  jobId: string,
  draftId: string,
  revision: number,
  placeholder: 'archived' | 'absent',
  next: (state: string) => string,
): ArchiveResult {
  const draft = data[key(companyId, draftId)];
  if (!draft) {
    data[key(companyId, draftId)] = { ...emptyDraft(null, jobId), state: placeholder, archiveRevision: revision, placeholder: true };
    return 'set';
  }
  const stored = draft.archiveRevision ?? 0;
  if (stored > revision) return 'newer';
  if (stored === revision) return 'same';
  draft.state = draft.placeholder ? placeholder : next(draft.state);
  draft.archiveRevision = revision;
  return 'set';
}

// A stand-in draft as planSync reads it (src/lib/jobs/draft-sync.ts, storedOf): a null field owner is
// no key, as on the real draft.
function storedOf(found: FakeDraft | undefined): StoredDraft {
  if (!found) return null;
  return {
    placeholder: found.placeholder === true,
    jobId: found.jobId,
    state: found.state,
    fence: found.fence ? { submissionId: found.fence.submissionId, epoch: found.fence.epoch, expiresAt: Date.parse(found.fence.expiresAt) } : null,
    fieldOwnerUid: found.fieldOwnerUid ?? undefined,
    archiveRevision: found.archiveRevision,
    fieldOwnerRevision: found.fieldOwnerRevision,
  };
}
