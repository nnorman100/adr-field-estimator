import type { Firestore } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftReads, IncompleteFieldData, loadDraft, SUPERSEDED } from '@/lib/field/store';

type Snapshot = { draft: Record<string, unknown>; rooms: string[] };
const sdk = vi.hoisted(() => ({ server: vi.fn(), cache: vi.fn() }));

function docs(ids: string[]) {
  return { docs: ids.map((id) => ({ id, data: () => ({ field: { name: id } }) })) };
}
function reader(source: 'server' | 'cache') {
  return (target: { path: string; kind: 'doc' | 'rooms' | 'photos' }) =>
    Promise.resolve(sdk[source]()).then((snapshot: Snapshot) =>
      target.kind === 'doc'
        ? { exists: () => true, data: () => snapshot.draft }
        : docs(target.kind === 'rooms' ? snapshot.rooms : []),
    );
}

vi.mock('firebase/firestore', async (actual) => ({
  ...(await actual<object>()),
  doc: vi.fn((_db, path) => ({ path, kind: 'doc' })),
  collection: vi.fn((_db, path, name) => ({ path: `${path}/${name}`, kind: name })),
  getDoc: (target: never) => reader('server')(target),
  getDocs: (target: never) => reader('server')(target),
  getDocFromCache: (target: never) => reader('cache')(target),
  getDocsFromCache: (target: never) => reader('cache')(target),
}));

const db = {} as Firestore;
const ref = { companyId: 'company-a', draftId: 'draft-a' };
const editing = (roomOrder: string[]) => ({ state: 'editing', fieldOwnerUid: 'ana', field: { roomOrder } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(() => {
  sdk.server.mockReset();
  sdk.cache.mockReset();
});

describe('reading a field draft', () => {
  it('a slow read started before a local edit never replaces the newer read', async () => {
    const slow = deferred<Snapshot>();
    sdk.server.mockReturnValue(slow.promise);
    sdk.cache.mockReturnValue({ draft: editing(['a', 'b']), rooms: ['a', 'b'] });
    const read = draftReads();
    const answers: string[] = [];
    const older = read(db, ref).then((found) => {
      answers.push('older');
      return found;
    });
    const newer = read(db, ref, 'cache').then((found) => {
      answers.push('newer');
      return found;
    });
    slow.resolve({ draft: editing(['a']), rooms: ['a'] });
    expect(await older).toBe(SUPERSEDED);
    expect(await newer).toMatchObject({ rooms: [{ id: 'a' }, { id: 'b' }] });
    expect(answers).toEqual(['newer', 'older']);
  });

  it('a superseded read that failed does not report its failure', async () => {
    const slow = deferred<Snapshot>();
    sdk.server.mockReturnValueOnce(slow.promise.then(() => Promise.reject(new Error('no signal'))));
    sdk.cache.mockReturnValue({ draft: editing([]), rooms: [] });
    const read = draftReads();
    const older = read(db, ref);
    const newer = read(db, ref, 'cache');
    slow.resolve({ draft: editing([]), rooms: [] });
    await expect(older).resolves.toBe(SUPERSEDED);
    await expect(newer).resolves.toMatchObject({ rooms: [] });
  });

  it.each([undefined, 'cache'] as const)('refuses a draft whose room order lists a room it did not get (%s)', async (source) => {
    const partial = { draft: editing(['a', 'b']), rooms: ['a'] };
    sdk.server.mockReturnValue(partial);
    sdk.cache.mockReturnValue(partial);
    await expect(loadDraft(db, ref, source)).rejects.toBeInstanceOf(IncompleteFieldData);
  });
});
