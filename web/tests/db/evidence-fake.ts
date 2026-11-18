import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MAX_PHOTO_REFS } from '@/lib/field/schema';
import type { DraftStates } from '@/lib/photos/drafts';
import type { EvidenceStore } from '@/lib/photos/store';
import type { FakeDrafts } from './draft-fake';

// Stand-ins at the two boundaries the photo routes use (S5a-5): the evidence bucket and the field
// draft's state. The bucket keeps what the real one would, including the create-only rule (a
// second create of a name changes nothing), so the route tests can count objects. The real
// precondition is checked against the real bucket in S5a-12; the Firestore reader in tests/emu/.
export type FakeEvidence = EvidenceStore & {
  // The objects by name.
  objects: Map<string, { bytes: Uint8Array; contentType: string; sha256: string; generation: bigint }>;
  // Every call to create, in order, including the ones that found the object there.
  creates: string[];
  // Fails the next create; if `afterWrite`, the object is made first and the answer is lost.
  failNext: { on: boolean; afterWrite: boolean };
  // Fails the next open.
  failOpen: boolean;
};

export function fakeEvidence(): FakeEvidence {
  let generation = 1_700_000_000_000_000n;
  const store: FakeEvidence = {
    objects: new Map(),
    creates: [],
    failNext: { on: false, afterWrite: false },
    failOpen: false,
    async create(name, bytes, contentType, sha256) {
      store.creates.push(name);
      const fail = store.failNext;
      if (fail.on && !fail.afterWrite) {
        fail.on = false;
        throw new Error('bucket unreachable');
      }
      const there = store.objects.get(name);
      if (there) return { outcome: 'exists', generation: there.generation, sha256: there.sha256 };
      const made = { bytes: Uint8Array.from(bytes), contentType, sha256, generation: ++generation };
      store.objects.set(name, made);
      if (fail.on) {
        fail.on = false;
        fail.afterWrite = false;
        throw new Error('bucket answer lost');
      }
      return { outcome: 'created', generation: made.generation, sha256 };
    },
    async open(name, generationWanted) {
      if (store.failOpen) {
        store.failOpen = false;
        throw new Error('bucket unreachable');
      }
      const there = store.objects.get(name);
      if (!there || there.generation !== generationWanted) return null;
      return new Response(there.bytes as BodyInit).body as unknown as WebReadableStream<Uint8Array>;
    },
  };
  return store;
}

// The state of each draft the jobs service made through the fake drafts: `editing` until a test
// sets another, null for a draft nobody made. `refs` is each draft's photo-reference count (0 unless set).
export type FakeDraftStates = DraftStates & { set: Map<string, string>; refs: Map<string, number>; fail: boolean };

export function fakeDraftStates(drafts: FakeDrafts): FakeDraftStates {
  const states: FakeDraftStates = {
    set: new Map(),
    refs: new Map(),
    fail: false,
    async state(companyId, draftId) {
      if (states.fail) throw new Error('field database unreachable');
      const key = `${companyId}/${draftId}`;
      return states.set.get(key) ?? (drafts.made.has(key) ? 'editing' : null);
    },
    async photoRefs(companyId, draftId) {
      if (states.fail) throw new Error('field database unreachable');
      return Math.min(states.refs.get(`${companyId}/${draftId}`) ?? 0, MAX_PHOTO_REFS);
    },
  };
  return states;
}
