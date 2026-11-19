import type { Firestore } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { heldOf, type Docs, type DocWrite } from '@/lib/field/journal';
import { pending } from '@/lib/field/pending';
import { addRoom, removeRoom, type RoomSave } from '@/lib/field/room-actions';
import { MAX_ROOMS } from '@/lib/field/schema';
import { draftPath } from '@/lib/field/store';

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

const ref = { companyId: 'company-a', draftId: 'draft-a' };
const jobId = 'job-a';
const path = draftPath(ref);
type Saved = { writes: DocWrite[]; held: Docs };

// The screen's local save: records what it was given and applies the batch to the cache. A screen
// that remounted before the last batch landed still renders the older order; none of these actions
// is given it.
const saved: Saved[] = [];
const errors: string[] = [];
const save: RoomSave = (writes, _notice, _locally, acknowledgedBy, held) => {
  saved.push({ writes, held: held! });
  for (const write of writes) {
    if (write.op === 'set') cache.rooms.add(write.path.split('/').pop()!);
    else if (write.op === 'delete') cache.rooms.delete(write.path.split('/').pop()!);
    else if (write.op === 'update') cache.order = [...(write.fields['field.roomOrder'] as string[])];
  }
  acknowledgedBy?.();
  return Promise.resolve(true);
};
const actions = (over: Partial<Parameters<typeof addRoom>[0]> = {}) => ({ db: {} as Firestore, ref, jobId, save, setError: (message: string) => void errors.push(message), ...over });
const add = (id: string, over?: Partial<Parameters<typeof addRoom>[0]>) => addRoom(actions(over), id, id, 0);

beforeEach(() => {
  cache.order = [];
  cache.rooms = new Set();
  cache.read = [];
  saved.length = 0;
  errors.length = 0;
  if (pending.roomWriting(jobId, ref.draftId)) pending.endRoomWrite(jobId, ref.draftId);
});

describe('a room Add or Remove after a remount', () => {
  it('keeps a room added since the screen rendered when it adds another', async () => {
    await add('kitchen');
    await add('hall');
    expect(cache.order).toEqual(['kitchen', 'hall']);
    expect([...cache.rooms].sort()).toEqual(['hall', 'kitchen']);
  });

  it('removes only the chosen room when the screen still shows an older order', async () => {
    await add('kitchen');
    await add('hall');
    await removeRoom(actions(), 'kitchen', 'Kitchen', 0);
    expect(cache.order).toEqual(['hall']);
    expect([...cache.rooms]).toEqual(['hall']);
  });

  it('journals the cached draft as the before-state, not the order the screen rendered', async () => {
    await add('kitchen');
    await add('hall');
    await add('bath');
    await removeRoom(actions(), 'hall', 'Hall', 0);
    expect(saved.map((one) => heldOf(one.writes, one.held)[path])).toEqual([
      { 'field.roomOrder': [] },
      { 'field.roomOrder': ['kitchen'] },
      { 'field.roomOrder': ['kitchen', 'hall'] },
      { 'field.roomOrder': ['kitchen', 'hall', 'bath'] },
    ]);
  });

  it('writes nothing for an Add when the cached order already holds the limit, whatever the screen shows', async () => {
    for (let at = 0; at < MAX_ROOMS; at += 1) await add(`room-${at}`);
    saved.length = 0;
    const changes = pending.draftChanges(jobId);
    await add('one-more');
    expect(saved).toEqual([]);
    expect(cache.order).toHaveLength(MAX_ROOMS);
    expect(errors).toEqual([`A job holds at most ${MAX_ROOMS} rooms.`]);
    expect(pending.roomWriting(jobId, ref.draftId)).toBe(false);
    expect(pending.draftChanges(jobId)).toBe(changes);
  });

  it('lets only one room write run for a draft', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = add('kitchen', { save: async (...args) => { await gate; return save(...args); } });
    await vi.waitFor(() => expect(pending.roomWriting(jobId, ref.draftId)).toBe(true));
    await add('hall');
    expect(saved).toEqual([]);
    release();
    await first;
    expect(cache.order).toEqual(['kitchen']);
  });

  it('tells the open screen to read the draft after a local write, and not after one that did not land', async () => {
    const before = pending.draftChanges(jobId);
    await add('kitchen');
    expect(pending.draftChanges(jobId)).toBe(before + 1);
    expect(pending.roomWriting(jobId, ref.draftId)).toBe(false);
    await add('hall', { save: () => Promise.resolve(false) });
    expect(pending.draftChanges(jobId)).toBe(before + 1);
    expect(pending.roomWriting(jobId, ref.draftId)).toBe(false);
  });

  it('reads no photo references', async () => {
    await add('kitchen');
    await removeRoom(actions(), 'kitchen', 'Kitchen', 0);
    expect(cache.read).not.toContain('photos');
  });
});
