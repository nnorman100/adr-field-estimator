import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
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

type Method = keyof FenceStore;

export type FakeField = FenceStore & {
  // The drafts as stored now (a copy).
  data(): FieldData;
  draft(companyId: string, draftId: string): FakeDraft | null;
  // Writes field data as the phone would while the draft is editing (the rules are not modelled:
  // tests/emu/ checks them).
  put(companyId: string, draftId: string, manifest: Partial<FieldManifest>, fieldOwnerUid?: string | null): void;
  // Makes the next call of a method fail as if Firestore were unreachable, before it changes anything.
  failNext: Partial<Record<Method, boolean>>;
  // Awaited at the start of the next call of a method, so a test can hold one attempt mid-way.
  gate: Partial<Record<Method, () => Promise<void>>>;
  // Every call, by method name, in order.
  calls: Method[];
};

const key = (companyId: string, draftId: string) => `${companyId}/${draftId}`;

const emptyDraft = (fieldOwnerUid: string | null): FakeDraft => ({
  fieldOwnerUid,
  state: 'editing',
  fence: null,
  field: {},
  rooms: {},
  photos: {},
  previous: null,
});

export function fakeField(backing: Backing = memoryBacking(), linked?: { drafts: FakeDrafts; states: FakeDraftStates }): FakeField {
  function load(): FieldData {
    const data = backing.load();
    for (const [made, { fieldOwnerUid }] of linked?.drafts.made ?? []) data[made] ??= emptyDraft(fieldOwnerUid);
    return data;
  }
  function save(data: FieldData): void {
    backing.save(data);
    if (!linked) return;
    for (const [at, draft] of Object.entries(data)) {
      linked.states.set.set(at, draft.state);
      linked.states.refs.set(at, Object.keys(draft.photos).length);
      if (!linked.drafts.made.has(at)) linked.drafts.made.set(at, { fieldOwnerUid: draft.fieldOwnerUid });
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

    createFrom: (companyId, draftId, fieldOwnerUid, manifest, previous) =>
      call('createFrom', (data) => {
        if (data[key(companyId, draftId)]) return 'exists' as const;
        data[key(companyId, draftId)] = {
          ...emptyDraft(fieldOwnerUid),
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
