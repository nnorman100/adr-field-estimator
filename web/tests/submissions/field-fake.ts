import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { JobProjection } from '@/lib/field/job-projection';
import type { FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import type { ArchiveResult, ArchiveStore } from '@/lib/jobs/archive-store';
import { assertVersion, parseGeneration, parseMarker, planSync, versionRefusal, type StoredDraft, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
import { draftIdsToRead, draftsToMake, resultOf, type DraftSync, type SyncResult } from '@/lib/jobs/draft-sync';
import { placeholderRefusal as refusalOf, draftOfOtherJob, type DraftMade } from '@/lib/jobs/drafts';
import type { FenceResult, FenceStore, Provenance } from '@/lib/submissions/fence';

// A stand-in for the field database's drafts as Submit sees them (src/lib/submissions/fence.ts):
// each draft's state, fence, field map and nested documents. It is held to the same contract as
// the real Firestore writer (fence-contract.ts, run against both), so the database tests cannot pass
// on a fence the real one would not keep.
//
// The drafts and the draft sync's markers live in one record behind a backing, in memory for the route
// tests, or in one file so a separate process (killed mid-Submit, tests/db/submission-crash-child.ts)
// and the test that killed it see the same drafts, as two server processes see one Firestore. The jobs
// and photo stand-ins of tests/db/team-harness.ts (draft-fake.ts, evidence-fake.ts) are built over the
// same backing: what any of them writes, every one of them reads, with nothing copied between them.

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

// The draft sync's markers (src/lib/jobs/draft-sync.ts), by "company/job".
export type Markers = Record<string, SyncMarker>;

/** The one record: every draft, by "company/draft", and every marker, by "company/job". */
// The operator's draft sync generation document (src/lib/jobs/draft-sync.ts GENERATION_PATH), when there is one.
export type FieldRecord = { drafts: FieldData; markers: Markers; generation?: Record<string, unknown> };

export type Backing = { load(): FieldRecord; save(record: FieldRecord): void };

const emptyRecord = (): FieldRecord => ({ drafts: {}, markers: {} });

export const memoryBacking = (): Backing => {
  let record = emptyRecord();
  return {
    load: () => structuredClone(record),
    save: (next) => {
      record = structuredClone(next);
    },
  };
};

// The drafts and the markers in one file, written whole and renamed into place in one step, so a reader
// never sees half a file, nor a marker without the drafts it was written with.
export const fileBacking = (path: string): Backing => ({
  load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FieldRecord) : emptyRecord()),
  save: (next) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(next));
    renameSync(`${path}.tmp`, path);
  },
});

type Method = keyof FenceStore | keyof ArchiveStore | keyof DraftSync;

// Also the archive, restore and copy writer of S5b-2 (src/lib/jobs/archive-store.ts) and the draft
// life-cycle sync (src/lib/jobs/draft-sync.ts, the same plan as the real writer, planSync), on the one
// record, so Submit, the jobs routes and the photo route see every draft as the real field database holds it.
export type FakeField = FenceStore & ArchiveStore & DraftSync & {
  // The sync's marker for a job, as the record holds it, or null.
  marker(companyId: string, jobId: string): SyncMarker | null;
  // Every field owner the sync wrote on a draft, by "company/draft", in order.
  ownerWrites: { at: string; fieldOwnerUid: string | null }[];
  // Every state the sync writes, in order: on a draft it makes, and each change of a draft's state.
  stateWrites: { at: string; state: string }[];
  // The drafts as stored now (a copy).
  data(): FieldData;
  projected: Map<string, JobProjection>;
  draft(companyId: string, draftId: string): FakeDraft | null;
  // Writes field data as the phone would while the draft is editing (the rules are not modelled:
  // tests/emu/ checks them).
  put(companyId: string, draftId: string, manifest: Partial<FieldManifest>, fieldOwnerUid?: string | null): void;
  // Puts a draft in a state, as another step (a Submit, an archive) would leave it.
  lock(companyId: string, draftId: string, state: string): void;
  // Gives a draft exactly this many photo references, as the phone would have written them.
  setPhotoRefs(companyId: string, draftId: string, count: number): void;
  // Takes the job id off a draft, as on one the previous version made before drafts carried it
  // (security audit F1).
  unstamp(companyId: string, draftId: string): void;
  // Removes a draft from the record, as one that is not there.
  remove(companyId: string, draftId: string): void;
  // Leaves the operator's draft sync generation document as given, as scripts/raise-draft-sync-generation.ts would.
  setGeneration(data: Record<string, unknown> | null): void;
  // Makes the next call of a method fail as if Firestore were unreachable, before it changes anything;
  // a number makes that many calls in a row fail (a request that tries again meets it again).
  failNext: Partial<Record<Method, boolean | number>>;
  // Makes the next call of a method do its work and then fail, as if Firestore's answer were lost.
  loseNext: Partial<Record<Method, boolean>>;
  // Awaited at the start of the next call of a method, so a test can hold one attempt mid-way.
  gate: Partial<Record<Method, () => Promise<void>>>;
  // Every call, by method name, in order.
  calls: Method[];
};

const key = (companyId: string, draftId: string) => `${companyId}/${draftId}`;

/** A new, empty `editing` draft, as the server makes one. */
export const emptyDraft = (fieldOwnerUid: string | null, jobId?: string): FakeDraft => ({
  fieldOwnerUid,
  state: 'editing',
  fence: null,
  field: {},
  rooms: {},
  photos: {},
  previous: null,
  ...(jobId === undefined ? {} : { jobId }),
});

// Whether a value holds a list directly inside a list, which Firestore refuses to store.
function holdsNestedList(value: unknown, inList = false): boolean {
  if (Array.isArray(value)) return inList || value.some((item) => holdsNestedList(item, true));
  if (typeof value === 'object' && value !== null) return Object.values(value).some((item) => holdsNestedList(item));
  return false;
}

export function fakeField(backing: Backing = memoryBacking()): FakeField {
  // Changes the record outside a method call, as a test sets it up.
  function edit(work: (record: FieldRecord) => void): void {
    const record = backing.load();
    work(record);
    backing.save(record);
  }
  // Each call reads, decides and writes the record with no await in between: one transaction.
  // `ready`, when given, runs after the gate and before the record is read and written: an answer it
  // returns ends the call there, writing nothing (the draft sync's check of Postgres's version).
  async function call<T>(method: Method, work: (record: FieldRecord) => T, ready?: () => Promise<T | undefined>): Promise<T> {
    fake.calls.push(method);
    const gate = fake.gate[method];
    if (gate) {
      delete fake.gate[method];
      await gate();
    }
    const failing = fake.failNext[method];
    if (failing) {
      fake.failNext[method] = typeof failing === 'number' && failing > 1 ? failing - 1 : false;
      throw new Error('field database unreachable');
    }
    const early = ready ? await ready() : undefined;
    if (early !== undefined) return early;
    const record = backing.load();
    const result = work(record);
    backing.save(record);
    if (fake.loseNext[method]) {
      fake.loseNext[method] = false;
      throw new Error('field database answer lost');
    }
    return result;
  }

  const fake: FakeField = {
    marker: (companyId, jobId) => backing.load().markers[key(companyId, jobId)] ?? null,
    ownerWrites: [],
    stateWrites: [],
    sync: async (companyId, job, gen, options = {}) => {
      // As the real writer: refused before any read or write, as a rejected promise.
      assertVersion(gen, job.v);
      // As the real writer: once the marker lets the version through, Postgres's version is checked
      // before anything is written, and a snapshot Postgres moved on from writes nothing.
      const ready = async (): Promise<SyncResult | undefined> => {
        const record = backing.load();
        const left = record.markers[key(companyId, job.jobId)];
        const marker = left === undefined ? null : parseMarker(left as unknown as Record<string, unknown>);
        if (versionRefusal(marker, Math.max(gen, parseGeneration(record.generation)), job.v)) return undefined;
        return options.stillCurrent && !(await options.stillCurrent()) ? { outcome: 'moved' } : undefined;
      };
      return call('sync', ({ drafts: data, markers, generation: raised }) => {
        // As the real writer: the operator's generation and a marker there are read in their shape or
        // the sync stops (MalformedGenerationError, MalformedMarkerError), and they decide first, before
        // any draft is read; the higher of the caller's generation and the stored one is written.
        const generation = Math.max(gen, parseGeneration(raised));
        const left = markers[key(companyId, job.jobId)];
        const marker = left === undefined ? null : parseMarker(left as unknown as Record<string, unknown>);
        const refused = versionRefusal(marker, generation, job.v);
        if (refused) return refused;
        const stored = Object.fromEntries(draftIdsToRead(marker, job).map((draftId) => [draftId, storedOf(data[key(companyId, draftId)])]));
        // Rooms or photos left under a draft to make (only a placeholder can hold them here).
        const orphans = new Set(
          draftsToMake(stored, job).filter((draftId) => {
            const left = data[key(companyId, draftId)];
            return left !== undefined && (Object.keys(left.rooms).length > 0 || Object.keys(left.photos).length > 0);
          }),
        );
        const plan = planSync(marker, stored, orphans, job, generation);
        // As Firestore's commit: a create of a room or photo the same write already creates fails the
        // whole write, and nothing (no draft, no marker) is saved.
        // And Firestore stores no list directly inside a list: a value holding one fails the write.
        for (const made of plan.creates) {
          for (const docs of [made.rooms, made.photos]) {
            if (new Set(docs.map((doc) => doc.id)).size !== docs.length) throw new Error('a document is created twice in one write');
          }
          for (const value of [made.data.field, ...made.rooms.map((doc) => doc.field), ...made.photos.map((doc) => doc.field)]) {
            if (holdsNestedList(value)) throw new Error('Cannot convert an array value in an array value');
          }
        }
        for (const made of plan.creates) fake.ownerWrites.push({ at: key(companyId, made.draftId), fieldOwnerUid: made.data.fieldOwnerUid ?? null });
        for (const update of plan.updates) {
          if (update.set.fieldOwnerUid !== undefined) fake.ownerWrites.push({ at: key(companyId, update.draftId), fieldOwnerUid: update.set.fieldOwnerUid });
        }
        for (const made of plan.creates) fake.stateWrites.push({ at: key(companyId, made.draftId), state: made.data.state });
        for (const update of plan.updates) {
          if (update.set.state !== undefined) fake.stateWrites.push({ at: key(companyId, update.draftId), state: update.set.state });
        }
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
        // The marker with the drafts it guards, in the same write.
        markers[key(companyId, job.jobId)] = plan.marker;
        return resultOf(plan);
      }, ready);
    },
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
      call('findDraft', ({ drafts: data }) => {
        const found = data[key(companyId, draftId)];
        if (!found) return null;
        return found.placeholder ? { jobId: found.jobId, placeholder: true as const } : { jobId: found.jobId };
      }),
    data: () => backing.load().drafts,
    draft: (companyId, draftId) => backing.load().drafts[key(companyId, draftId)] ?? null,
    put(companyId, draftId, manifest, fieldOwnerUid = null) {
      edit(({ drafts: data }) => {
        const draft = (data[key(companyId, draftId)] ??= emptyDraft(fieldOwnerUid));
        if (manifest.draft !== undefined) draft.field = manifest.draft;
        for (const room of manifest.rooms ?? []) draft.rooms[room.id] = room.field;
        for (const photo of manifest.photos ?? []) draft.photos[photo.id] = photo.field;
      });
    },
    lock(companyId, draftId, state) {
      edit(({ drafts: data }) => {
        const draft = data[key(companyId, draftId)];
        if (draft) draft.state = state;
      });
    },
    setPhotoRefs(companyId, draftId, count) {
      edit(({ drafts: data }) => {
        const draft = data[key(companyId, draftId)];
        if (draft) draft.photos = Object.fromEntries(Array.from({ length: count }, (_, n) => [`ref-${n}`, {}]));
      });
    },
    remove(companyId, draftId) {
      edit(({ drafts: data }) => {
        delete data[key(companyId, draftId)];
      });
    },
    setGeneration(data) {
      edit((record) => {
        if (data === null) delete record.generation;
        else record.generation = { ...data };
      });
    },
    unstamp(companyId, draftId) {
      edit(({ drafts: data }) => {
        delete data[key(companyId, draftId)]?.jobId;
      });
    },

    fence: (companyId, draftId, fence, replacing) =>
      call('fence', ({ drafts: data }): FenceResult => {
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
      call('read', ({ drafts: data }) => {
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
      call('markSubmitted', ({ drafts: data }) => {
        const draft = data[key(companyId, draftId)];
        if (!draft) return 'missing' as const;
        if (!draft.fence || draft.fence.epoch !== epoch || draft.fence.submissionId !== submissionId) return 'conflict' as const;
        if (draft.state === 'submitted') return 'marked' as const;
        if (draft.state !== 'submitting') return 'conflict' as const;
        draft.state = 'submitted';
        return 'marked' as const;
      }),

    release: (companyId, draftId, epoch) =>
      call('release', ({ drafts: data }) => {
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
      call('archiveDraft', ({ drafts: data }): ArchiveResult => lifecycle(data, companyId, jobId, draftId, revision, 'archived', (current) => (current === 'submitting' ? current : 'archived'))),

    restoreDraft: (companyId, jobId, draftId, state, revision) =>
      call('restoreDraft', ({ drafts: data }): ArchiveResult =>
        lifecycle(data, companyId, jobId, draftId, revision, 'absent', (current) => (current === 'archived' ? state : current)),
      ),

    createCopy: (companyId, jobId, draftId, fieldOwnerUid, manifest) =>
      call('createCopy', ({ drafts: data }): DraftMade => {
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
      call('createFrom', ({ drafts: data }): DraftMade => {
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
    hasFence: found.fence !== null,
    fenceEpoch: found.fence?.epoch,
    fence: found.fence ? { submissionId: found.fence.submissionId, epoch: found.fence.epoch, expiresAt: Date.parse(found.fence.expiresAt) } : null,
    fieldOwnerUid: found.fieldOwnerUid ?? undefined,
    archiveRevision: found.archiveRevision,
    fieldOwnerRevision: found.fieldOwnerRevision,
  };
}
