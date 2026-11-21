import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalManifest, type FieldManifest } from '@/lib/field/canonical';
import type { FenceStore } from '@/lib/submissions/fence';

// The behaviour every fence store must have (src/lib/submissions/fence.ts): the read of a fenced
// draft. Run against the stand-in in tests/unit and the real Firestore reader in tests/emu, so the
// database tests' stand-in cannot drift from Firestore. The fence, its marker and its release are the
// draft sync's (tests/submissions/sync-contract.ts); `place` leaves a draft as the sync would.

export type FenceProbe = {
  store: FenceStore;
  // Makes an editing draft holding this field data, as the jobs route and the phone would.
  seed(companyId: string, draftId: string, manifest: FieldManifest, fieldOwnerUid?: string | null): Promise<void>;
  // Puts a seeded draft in this state with this fence, as the draft sync writes a Submit's fence and marker.
  place(companyId: string, draftId: string, state: 'submitting' | 'submitted', fence: { submissionId: string; epoch: string; expiresAt: Date }): Promise<void>;
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
  (a && typeof a !== 'string' ? canonicalManifest(a) : null) === canonicalManifest(b);

export function fenceStoreContract(name: string, probe: () => FenceProbe): void {
  describe(`${name} fence store contract`, () => {
    it('reads the field data only for the epoch that holds the fence', async () => {
      const { store, seed, place } = probe();
      const [company, draft] = [randomUUID(), randomUUID()];
      await seed(company, draft, MANIFEST);
      const fence = fenceOf();
      expect(await store.read(company, draft, fence.epoch)).toBeNull();
      await place(company, draft, 'submitting', fence);
      expect(same(await store.read(company, draft, fence.epoch), MANIFEST)).toBe(true);
      expect(await store.read(company, draft, randomUUID())).toBeNull();
      expect(await store.read(company, randomUUID(), fence.epoch)).toBeNull();
      // A submitted draft is not read, its own epoch included.
      await place(company, draft, 'submitted', fence);
      expect(await store.read(company, draft, fence.epoch)).toBeNull();
    });

    it('reads drafts at the safety caps and refuses one extra room or photo', async () => {
      const { store, seed, place } = probe();
      const company = randomUUID();
      const rooms = Array.from({ length: 30 }, (_, i) => ({ id: `room-${i}`, field: { name: `Room ${i}` } }));
      const photos = Array.from({ length: 300 }, () => ({ id: randomUUID(), field: {} }));
      const manifest = { draft: { roomOrder: rooms.map((room) => room.id) }, rooms, photos };
      const cases: Array<[string, FieldManifest]> = [
        ['at-cap', manifest],
        ['too_many_rooms', { ...manifest, rooms: [...rooms, { id: 'extra', field: {} }] }],
        ['too_many_photos', { ...manifest, photos: [...photos, { id: randomUUID(), field: {} }] }],
      ];
      for (const [kind, data] of cases) {
        const draft = randomUUID();
        await seed(company, draft, data);
        const fence = fenceOf();
        await place(company, draft, 'submitting', fence);
        const read = await store.read(company, draft, fence.epoch);
        if (kind === 'at-cap') expect(same(read, manifest)).toBe(true);
        else expect(read).toBe(kind);
      }
    });
  });
}
