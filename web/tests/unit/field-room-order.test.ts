import type { Firestore } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoomEdit, draftDocs, draftPath, removeRoomEdit } from '@/lib/field/store';
import { heldOf, type DocWrite } from '@/lib/field/journal';
import { MAX_ROOMS } from '@/lib/field/schema';

// The phone's cached draft, changed by each local batch as the Firestore SDK would.
const cache = vi.hoisted(() => ({ order: [] as string[], rooms: new Set<string>(), read: [] as string[] }));
vi.mock('firebase/firestore', async (actual) => ({
  ...(await actual<object>()),
  doc: vi.fn((_db, path) => ({ path, kind: 'doc' })),
  collection: vi.fn((_db, path, name) => ({ path: `${path}/${name}`, kind: name })),
  getDocFromCache: () => Promise.resolve({ exists: () => true, data: () => ({ state: 'editing', field: { roomOrder: [...cache.order] } }) }),
  getDocsFromCache: (target: { kind: string }) => {
    cache.read.push(target.kind);
    return Promise.resolve({ docs: target.kind === 'rooms' ? [...cache.rooms].map((id) => ({ id, data: () => ({ field: { name: id } }) })) : [] });
  },
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
async function added(id: string) {
  const edit = await addRoomEdit(db, ref, id, id);
  if (edit === null || edit === 'full') throw new Error('expected an edit');
  applyLocally(edit.writes);
  return edit;
}

beforeEach(() => {
  cache.order = [];
  cache.rooms = new Set();
  cache.read = [];
});

// A screen that remounted before another room write's local batch still renders the old draft; the
// Add and Remove it offers are built from the cache, not from that render.
describe('a room Add or Remove after a remount', () => {
  it('keeps a room added since the screen rendered when it adds another', async () => {
    const rendered = [...cache.order];
    await added('kitchen');
    const second = await added('hall');
    expect(rendered).toEqual([]);
    expect(cache.order).toEqual(['kitchen', 'hall']);
    expect([...cache.rooms].sort()).toEqual(['hall', 'kitchen']);
    expect(second.base.field.roomOrder).toEqual(['kitchen']);
  });

  it('removes only the chosen room when the rendered order is older than the cache', async () => {
    await added('kitchen');
    await added('hall');
    const edit = await removeRoomEdit(db, ref, 'kitchen');
    applyLocally(edit!.writes);
    expect(cache.order).toEqual(['hall']);
    expect([...cache.rooms]).toEqual(['hall']);
  });

  it('journals the cached draft as the before-state, so Try again does not report a change that was this device’s own', async () => {
    await added('kitchen');
    const hall = await added('hall');
    const path = draftPath(ref);
    // What the journal holds for Bath's Add: the order with Kitchen and Hall, not a render without Hall.
    const bath = await added('bath');
    expect(heldOf(bath.writes, draftDocs(ref, bath.base))[path]).toEqual({ 'field.roomOrder': ['kitchen', 'hall'] });
    expect(heldOf(hall.writes, draftDocs(ref, hall.base))[path]).toEqual({ 'field.roomOrder': ['kitchen'] });
    const removal = await removeRoomEdit(db, ref, 'hall');
    expect(heldOf(removal!.writes, draftDocs(ref, removal!.base))[path]).toEqual({ 'field.roomOrder': ['kitchen', 'hall', 'bath'] });
  });

  it('refuses an Add when the cached order already holds the limit, whatever the screen shows', async () => {
    for (let at = 0; at < MAX_ROOMS; at += 1) await added(`room-${at}`);
    expect(await addRoomEdit(db, ref, 'one-more', 'One more')).toBe('full');
    expect(cache.order).toHaveLength(MAX_ROOMS);
  });

  it('reads no photo references', async () => {
    await added('kitchen');
    await removeRoomEdit(db, ref, 'kitchen');
    expect(cache.read).not.toContain('photos');
  });
});
