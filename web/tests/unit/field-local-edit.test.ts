import type { Firestore } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldClient } from '@/lib/field-db';
import { queueFieldEdit } from '@/lib/field/local-edit';
import { readUnsent } from '@/lib/field/unsent';

const sdk = vi.hoisted(() => ({ read: vi.fn(), wait: vi.fn() }));
vi.mock('firebase/firestore', async (actual) => ({
  ...(await actual<object>()),
  doc: vi.fn((_db, path) => ({ path })),
  getDocFromCache: sdk.read,
  waitForPendingWrites: sdk.wait,
}));
const client = { db: {} as Firestore, cache: 'persistent', person: { tenantId: 'tenant-a', uid: 'ana', config: {} } } as FieldClient;
const ref = { companyId: 'company-a', draftId: 'draft-a' };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  } });
  sdk.read.mockReset().mockResolvedValue({ exists: () => true });
  sdk.wait.mockReset().mockResolvedValue(undefined);
});

describe('a field screen edit', () => {
  it('returns its local receipt without waiting for the server, keeps its unsent mark, then clears after acknowledgement', async () => {
    const server = deferred();
    const local = deferred();
    sdk.read.mockReturnValue(local.promise);
    const write = vi.fn(() => {
      expect(readUnsent('tenant-a', 'ana')).toMatchObject({ unsentSince: expect.any(Number) });
      return server.promise;
    });
    let received = false;
    const result = queueFieldEdit(client, ref, write).then((value) => { received = true; return value; });
    await Promise.resolve();
    expect(received).toBe(false);
    local.resolve();
    const receipt = await result;
    expect(write).toHaveBeenCalledExactlyOnceWith(client.db);
    expect(readUnsent('tenant-a', 'ana')).toMatchObject({ unsentSince: expect.any(Number) });
    server.resolve();
    await receipt.acknowledged;
    await vi.waitFor(() => expect(readUnsent('tenant-a', 'ana')).toMatchObject({ unsentSince: null }));
  });

  it('does not write or claim local success if the unsent mark cannot be saved', async () => {
    window.localStorage.setItem = () => { throw new Error('full'); };
    const write = vi.fn(async () => undefined);
    await expect(queueFieldEdit(client, ref, write)).rejects.toThrow('could not record');
    expect(write).not.toHaveBeenCalled();
  });

  it('retains the mark and reports a server rejection separately after the local save', async () => {
    const server = deferred();
    const receipt = await queueFieldEdit(client, ref, () => server.promise);
    server.reject(new Error('permission-denied'));
    await expect(receipt.acknowledged).rejects.toThrow('permission-denied');
    expect(readUnsent('tenant-a', 'ana')).toMatchObject({ unsentSince: expect.any(Number) });
  });
});
