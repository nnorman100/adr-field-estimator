import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalManifest, CanonicalFormError, manifestDigest } from '@/lib/field/canonical';

// The one canonical form Finish and review (the phone) and Submit (the server) both hash
// (src/lib/field/canonical.ts). The same draft in any key or document order is one text and one
// digest; any change a person could see is another digest.

const manifest = {
  draft: { yearBuilt: 1990, roomOrder: ['b', 'a'], notes: 'wet carpet', scopeConfirmed: true },
  rooms: [
    { id: 'b', field: { name: 'Hall', category: 2, floorSf: 12.5 } },
    { id: 'a', field: { name: 'Kitchen', wastePercent: 10 } },
  ],
  photos: [{ id: 'p-1', field: { roomId: 'a', shotTag: 'overview' } }],
};

describe('the canonical form of a draft', () => {
  it('sorts keys at every depth and documents by id, with no spaces', () => {
    expect(canonicalManifest(manifest)).toBe(
      '{"draft":{"notes":"wet carpet","roomOrder":["b","a"],"scopeConfirmed":true,"yearBuilt":1990},' +
        '"photos":[{"field":{"roomId":"a","shotTag":"overview"},"id":"p-1"}],' +
        '"rooms":[{"field":{"name":"Kitchen","wastePercent":10},"id":"a"},{"field":{"category":2,"floorSf":12.5,"name":"Hall"},"id":"b"}]}',
    );
  });

  it('is the same for the same draft read in another order, and its digest is the SHA-256 of the text', async () => {
    const shuffled = {
      draft: { scopeConfirmed: true, notes: 'wet carpet', yearBuilt: 1990, roomOrder: ['b', 'a'] },
      rooms: [manifest.rooms[1]!, manifest.rooms[0]!],
      photos: manifest.photos,
    };
    expect(canonicalManifest(shuffled)).toBe(canonicalManifest(manifest));
    const digest = await manifestDigest(manifest);
    expect(digest).toBe(createHash('sha256').update(canonicalManifest(manifest), 'utf8').digest('hex'));
    expect(await manifestDigest(shuffled)).toBe(digest);
  });

  it('changes with any value a person could see, the room order included', async () => {
    const digest = await manifestDigest(manifest);
    const changes = [
      { ...manifest, draft: { ...manifest.draft, notes: 'wet carpet.' } },
      { ...manifest, draft: { ...manifest.draft, roomOrder: ['a', 'b'] } },
      { ...manifest, rooms: [manifest.rooms[0]!, { id: 'a', field: { name: 'Kitchen', wastePercent: 11 } }] },
      { ...manifest, photos: [] },
      { ...manifest, photos: [{ id: 'p-1', field: { roomId: 'b', shotTag: 'overview' } }] },
      { ...manifest, draft: { ...manifest.draft, notes: 'wét carpet' } },
    ];
    for (const changed of changes) expect(await manifestDigest(changed)).not.toBe(digest);
  });

  it('reads a missing field map as an empty one, and -0 as 0', () => {
    expect(canonicalManifest({ draft: undefined, rooms: [{ id: 'a', field: undefined }], photos: [] })).toBe(
      '{"draft":{},"photos":[],"rooms":[{"field":{},"id":"a"}]}',
    );
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it('refuses what the field maps cannot hold, and a document listed twice', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, new Date(0), undefined, () => 1, 1n, new Map()]) {
      expect(() => canonicalJson({ value: bad })).toThrow(CanonicalFormError);
    }
    expect(() => canonicalManifest({ draft: {}, rooms: [{ id: 'a', field: {} }, { id: 'a', field: {} }], photos: [] })).toThrow(
      'a room is listed twice',
    );
    expect(() => canonicalManifest({ draft: {}, rooms: [], photos: [{ id: '', field: {} }] })).toThrow('has no id');
  });
});
