import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalManifest, type FieldManifest } from '@/lib/field/canonical';
import type { FenceStore } from '@/lib/submissions/fence';

// The behaviour every fence store must have (src/lib/submissions/fence.ts). Run against the
// stand-in in tests/unit and the real Firestore writer in tests/emu, so the database tests'
// stand-in cannot drift from Firestore.

export type DraftPeek = {
  state: string;
  fence: { submissionId: string; epoch: string } | null;
  previous: { draftId: string; submissionId: string } | null;
  fieldOwnerUid: string | null;
  manifest: FieldManifest;
};

export type FenceProbe = {
  store: FenceStore;
  // Makes an editing draft holding this field data, as the jobs route and the phone would.
  seed(companyId: string, draftId: string, manifest: FieldManifest, fieldOwnerUid?: string | null): Promise<void>;
  // What the draft holds now, or null when there is none.
  peek(companyId: string, draftId: string): Promise<DraftPeek | null>;
};

const MANIFEST: FieldManifest = {
  draft: { yearBuilt: 1990, roomOrder: ['kitchen'], notes: 'wet carpet' },
  rooms: [{ id: 'kitchen', field: { name: 'Kitchen', category: 2 } }],
  photos: [{ id: randomUUID(), field: { roomId: 'kitchen', shotTag: 'overview' } }],
};

const fenceOf = (submissionId = randomUUID(), epoch = randomUUID()) => ({
  submissionId,
  epoch,
  expiresAt: new Date(Date.UTC(2031, 0, 2, 3, 4, 5)),
});

const same = (a: Awaited<ReturnType<FenceStore['read']>> | undefined, b: FieldManifest) =>
  (a && a !== 'too_large' ? canonicalManifest(a) : null) === canonicalManifest(b);

export function fenceStoreContract(name: string, probe: () => FenceProbe): void {
  describe(`${name} fence store contract`, () => {
    it('closes the fence on an editing draft once, and refuses another epoch', async () => {
      const { store, seed, peek } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      const first = fenceOf();
      expect(await store.fence(company, draft, first)).toEqual({ outcome: 'fenced' });
      expect(await store.fence(company, draft, first)).toEqual({ outcome: 'fenced' });
      expect(await store.fence(company, draft, fenceOf())).toEqual({ outcome: 'held', epoch: first.epoch });
      const now = await peek(company, draft);
      expect(now).toMatchObject({ state: 'submitting', fence: { submissionId: first.submissionId, epoch: first.epoch } });
      expect(same(now?.manifest, MANIFEST)).toBe(true);
    });

    it('finds no draft to fence where there is none', async () => {
      const { store } = probe();
      expect(await store.fence(randomUUID(), randomUUID(), fenceOf())).toEqual({ outcome: 'missing' });
    });

    it('reads the field data only for the epoch that holds the fence', async () => {
      const { store, seed } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      const fence = fenceOf();
      expect(await store.read(company, draft, fence.epoch)).toBeNull();
      await store.fence(company, draft, fence);
      expect(same(await store.read(company, draft, fence.epoch), MANIFEST)).toBe(true);
      expect(await store.read(company, draft, randomUUID())).toBeNull();
      expect(await store.read(company, randomUUID(), fence.epoch)).toBeNull();
    });

    it('marks the draft submitted for its own fence only, and once', async () => {
      const { store, seed, peek } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      const fence = fenceOf();
      await store.fence(company, draft, fence);
      expect(await store.markSubmitted(company, draft, randomUUID(), fence.submissionId)).toBe('conflict');
      expect(await store.markSubmitted(company, draft, fence.epoch, randomUUID())).toBe('conflict');
      expect((await peek(company, draft))?.state).toBe('submitting');
      expect(await store.markSubmitted(company, draft, fence.epoch, fence.submissionId)).toBe('marked');
      expect(await store.markSubmitted(company, draft, fence.epoch, fence.submissionId)).toBe('marked');
      expect(await peek(company, draft)).toMatchObject({ state: 'submitted', fence: { submissionId: fence.submissionId, epoch: fence.epoch } });
      // A submitted draft is neither fenced again, released nor read.
      expect(await store.fence(company, draft, fenceOf())).toEqual({ outcome: 'submitted' });
      expect(await store.release(company, draft, fence.epoch)).toBe('not_fenced');
      expect(await store.read(company, draft, fence.epoch)).toBeNull();
      expect((await peek(company, draft))?.state).toBe('submitted');
      expect(await store.markSubmitted(company, randomUUID(), fence.epoch, fence.submissionId)).toBe('missing');
    });

    it('reads drafts at the safety caps and refuses one extra room or photo', async () => {
      const { store, seed } = probe();
      const company = randomUUID();
      const rooms = Array.from({ length: 30 }, (_, i) => ({ id: `room-${i}`, field: { name: `Room ${i}` } }));
      const photos = Array.from({ length: 300 }, () => ({ id: randomUUID(), field: {} }));
      const manifest = { draft: { roomOrder: rooms.map((room) => room.id) }, rooms, photos };
      const cases: Array<[string, FieldManifest]> = [
        ['at-cap', manifest],
        ['rooms', { ...manifest, rooms: [...rooms, { id: 'extra', field: {} }] }],
        ['photos', { ...manifest, photos: [...photos, { id: randomUUID(), field: {} }] }],
      ];
      for (const [kind, data] of cases) {
        const draft = randomUUID();
        await seed(company, draft, data);
        const fence = fenceOf();
        await store.fence(company, draft, fence);
        const read = await store.read(company, draft, fence.epoch);
        if (kind === 'at-cap') expect(same(read, manifest)).toBe(true);
        else expect(read).toBe('too_large');
      }
    });

    it('releases its own fence back to editing, and nothing else', async () => {
      const { store, seed, peek } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      expect(await store.release(company, draft, randomUUID())).toBe('not_fenced');
      const fence = fenceOf();
      await store.fence(company, draft, fence);
      expect(await store.release(company, draft, randomUUID())).toBe('not_fenced');
      expect((await peek(company, draft))?.state).toBe('submitting');
      expect(await store.release(company, draft, fence.epoch)).toBe('released');
      const now = await peek(company, draft);
      expect(now).toMatchObject({ state: 'editing', fence: null });
      expect(same(now?.manifest, MANIFEST)).toBe(true);
      expect(await store.release(company, draft, fence.epoch)).toBe('not_fenced');
      expect(await store.release(company, randomUUID(), fence.epoch)).toBe('not_fenced');
    });

    it('replaces only the named epoch, and a stale release for the old epoch leaves the newer fence closed', async () => {
      const { store, seed, peek } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      const old = fenceOf();
      const newer = fenceOf();
      await store.fence(company, draft, old);
      expect(await store.fence(company, draft, newer, randomUUID())).toEqual({ outcome: 'held', epoch: old.epoch });
      expect(await store.fence(company, draft, newer, old.epoch)).toEqual({ outcome: 'fenced' });
      expect(await store.release(company, draft, old.epoch)).toBe('not_fenced');
      expect(await store.markSubmitted(company, draft, old.epoch, old.submissionId)).toBe('conflict');
      expect(await peek(company, draft)).toMatchObject({ state: 'submitting', fence: { submissionId: newer.submissionId, epoch: newer.epoch } });
      expect(await store.read(company, draft, old.epoch)).toBeNull();
    });

    it('makes the next draft version whole, with its provenance, and leaves it alone when sent again', async () => {
      const { store, seed, peek } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      const previous = { draftId: randomUUID(), submissionId: randomUUID() };
      expect(await store.createFrom(company, draft, 'uid-owner', MANIFEST, previous)).toBe('created');
      const made = await peek(company, draft);
      expect(made).toMatchObject({ state: 'editing', fence: null, previous, fieldOwnerUid: 'uid-owner' });
      expect(same(made?.manifest, MANIFEST)).toBe(true);
      expect(await store.createFrom(company, draft, 'uid-other', { draft: {}, rooms: [], photos: [] }, previous)).toBe('exists');
      const again = await peek(company, draft);
      expect(again?.fieldOwnerUid).toBe('uid-owner');
      expect(same(again?.manifest, MANIFEST)).toBe(true);
      // A draft made with nobody owning the field work has no field owner.
      const unowned = randomUUID();
      await store.createFrom(company, unowned, null, MANIFEST, previous);
      expect((await peek(company, unowned))?.fieldOwnerUid).toBeNull();
      // An existing draft is never overwritten.
      const kept = randomUUID();
      await seed(company, kept, MANIFEST);
      expect(await store.createFrom(company, kept, 'uid-owner', { draft: { notes: 'other' }, rooms: [], photos: [] }, previous)).toBe('exists');
      expect(same((await peek(company, kept))?.manifest, MANIFEST)).toBe(true);
    });
  });
}
