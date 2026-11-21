import { expect, it, vi } from 'vitest';
import { pending } from '@/lib/field/pending';
import { keepForUpdate, restoreKept } from '@/lib/field/update-keep';

const { rows, readAll } = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  readAll: vi.fn(() => {
    const request = { result: [...rows.values()], onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  }),
}));
vi.mock('@/lib/field/idb', () => {
  const store = {
    put: (row: { owner: string }) => rows.set(row.owner, row),
    delete: (owner: string) => rows.delete(owner),
    get: (owner: string) => ({ result: rows.get(owner) }),
    getAll: readAll,
  };
  const transaction = { objectStore: () => store };
  const database = { close() {}, transaction: () => transaction };
  return {
    openDatabase: async () => database,
    withDatabase: async (_spec: unknown, work: (db: unknown) => unknown) => work(database),
    transact: async (_db: unknown, _store: unknown, _mode: unknown, change: (tx: unknown) => () => unknown) =>
      change(transaction)(),
  };
});

it('restores only the exact tenant and user, and leaves another tenant’s queued photo available', async () => {
  vi.stubGlobal('indexedDB', {});
  try {
    const owner = 'tenant-a/same-user';
    const peer = 'tenant-b/same-user';
    pending.openFor(owner);
    pending.addPhoto('job-a', { id: 'photo-a', bytes: new Blob(['a']), field: {}, step: 'send-failed' });
    expect(await keepForUpdate()).toBe(true);
    pending.openFor(peer);
    await restoreKept(peer);
    expect(pending.photos('job-a')).toEqual([]);
    pending.openFor(owner);
    await restoreKept(owner);
    expect(await pending.photos('job-a')[0]?.bytes.text()).toBe('a');
    expect(readAll).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
