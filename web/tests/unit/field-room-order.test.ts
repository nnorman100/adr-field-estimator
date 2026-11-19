import type { Firestore } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoomWrites, cachedRoomOrder, removeRoomWrites } from '@/lib/field/store';
import type { DocWrite } from '@/lib/field/journal';

// The phone's cached draft, changed by each local batch as the Firestore SDK would.
const cache = vi.hoisted(() => ({ order: [] as string[], rooms: new Set<string>() }));
vi.mock('firebase/firestore', async (actual) => ({
  ...(await actual<object>()),
  doc: vi.fn((_db, path) => ({ path, kind: 'doc' })),
  collection: vi.fn((_db, path, name) => ({ path: `${path}/${name}`, kind: name })),
  getDocFromCache: () => Promise.resolve({ exists: () => true, data: () => ({ state: 'editing', field: { roomOrder: [...cache.order] } }) }),
  getDocsFromCache: (target: { kind: string }) =>
    Promise.resolve({ docs: target.kind === 'rooms' ? [...cache.rooms].map((id) => ({ id, data: () => ({ field: { name: id } }) })) : [] }),
}));

const db = {} as Firestore;
const ref = { companyId: 'company-a', draftId: 'draft-a' };
function applyLocally(writes: DocWrite[]) {
  for (const write of writes) {
    if (write.op === 'set') cache.rooms.add(write.path.split('/').pop()!);
    else if (write.op === 'delete') cache.rooms.delete(write.path.split('/').pop()!);
    else if (write.op === 'update') cache.order = [...(write.fields['field.roomOrder'] as string[])];
  }
}

beforeEach(() => {
  cache.order = [];
  cache.rooms = new Set();
});

describe('a room-order batch after a remount', () => {
  it('keeps a room added between the journal record and the local batch when the remounted screen adds another', async () => {
    // The first screen journals and batches Kitchen; the screen remounts in between and renders the
    // draft as read before the batch: no rooms.
    const renderedAfterRemount: string[] = [...cache.order];
    applyLocally(addRoomWrites(ref, 'kitchen', 'Kitchen', (await cachedRoomOrder(db, ref))!));
    // The guard is released; the remounted screen adds Hall. Its order is read again under the guard.
    const order = await cachedRoomOrder(db, ref);
    expect(renderedAfterRemount).toEqual([]);
    applyLocally(addRoomWrites(ref, 'hall', 'Hall', order!));
    expect(cache.order).toEqual(['kitchen', 'hall']);
    expect([...cache.rooms].sort()).toEqual(['hall', 'kitchen']);
  });

  it('removes only the chosen room when the rendered order is older than the cache', async () => {
    applyLocally(addRoomWrites(ref, 'kitchen', 'Kitchen', []));
    const rendered = [...cache.order];
    applyLocally(addRoomWrites(ref, 'hall', 'Hall', (await cachedRoomOrder(db, ref))!));
    applyLocally(removeRoomWrites(ref, 'kitchen', (await cachedRoomOrder(db, ref))!));
    expect(rendered).toEqual(['kitchen']);
    expect(cache.order).toEqual(['hall']);
  });

});
