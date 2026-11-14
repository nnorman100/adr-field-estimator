import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetMe, meKey, parseMe, readMe, restoreMe } from '../../src/lib/field/ds-me';

const ROW = {
  key: 'tenant-1/uid-1',
  tenantId: 'tenant-1',
  uid: 'uid-1',
  companyName: 'Company A',
  address: 'company-a',
  config: { apiKey: 'k'.repeat(20), authDomain: 'a.firebaseapp.com', projectId: 'dryscope-test', authEmulatorUrl: null },
  savedAt: 1,
};

describe('ds-me rows', () => {
  it('are keyed by company and person', () => {
    expect(meKey('tenant-1', 'uid-1')).toBe(ROW.key);
    expect(meKey('tenant-2', 'uid-1')).not.toBe(ROW.key);
  });

  it('are read when they have the shape the sign-in page writes', () => {
    expect(parseMe(ROW)).toEqual(ROW);
  });

  it.each([
    ['null', null],
    ['a string', 'row'],
    ['no tenant', { ...ROW, tenantId: '' }],
    ['no person', { ...ROW, uid: undefined }],
    ['no company', { ...ROW, companyName: 7 }],
    ['no time', { ...ROW, savedAt: '1' }],
    ['no settings', { ...ROW, config: null }],
    ['no api key', { ...ROW, config: { ...ROW.config, apiKey: '' } }],
  ])('are skipped when damaged: %s', (_name, value) => {
    expect(parseMe(value)).toBeNull();
  });
});

// S6-3 adds what the server said at the last online check and when the person signed in.
describe('ds-me rows with the S6-3 facts', () => {
  const FACTS = { ...ROW, companyId: 'company-a', role: 'estimator', capabilities: ['scope'], authTime: 2 };

  it('are read with them, and without them (a row saved before S6-3)', () => {
    expect(parseMe(FACTS)).toEqual(FACTS);
    expect(parseMe(ROW)).toEqual(ROW);
  });

  it.each([
    ['an empty company id', { ...FACTS, companyId: '' }],
    ['a role that is not text', { ...FACTS, role: 3 }],
    ['capabilities that are not a list of text', { ...FACTS, capabilities: ['scope', 4] }],
    ['a sign-in time that is not a number', { ...FACTS, authTime: '2' }],
  ])('are skipped when damaged: %s', (_name, value) => {
    expect(parseMe(value)).toBeNull();
  });
});

// An IndexedDB holding the ds-me store, as far as these functions use it: requests answer in turn,
// and a transaction completes once none is left.
function fakeIndexedDb(rows: Map<string, unknown>) {
  const answer = <T>(onDone: (request: { result?: T; onsuccess?: () => void }) => void) => {
    const request: { result?: T; onsuccess?: () => void } = {};
    setTimeout(() => onDone(request));
    return request;
  };
  const database = {
    close: () => undefined,
    transaction() {
      let pending = 0;
      const transaction: { oncomplete?: () => void; objectStore: () => unknown } = { objectStore: () => store };
      const run = <T>(work: () => T) => {
        pending += 1;
        return answer<T>((request) => {
          request.result = work();
          request.onsuccess?.();
          pending -= 1;
          setTimeout(() => {
            if (pending === 0) transaction.oncomplete?.();
          });
        });
      };
      const store = {
        get: (key: string) => run(() => rows.get(key)),
        delete: (key: string) => run(() => void rows.delete(key)),
        put: (value: { key: string }) => run(() => void rows.set(value.key, value)),
        count: (key: string) => run(() => (rows.has(key) ? 1 : 0)),
      };
      return transaction;
    },
  };
  return {
    open: () =>
      answer<typeof database>((request) => {
        request.result = database;
        request.onsuccess?.();
      }),
  };
}

// S6-3b: a sign-out removes the saved sign-in it found, never one a newer sign-in saved since.
describe('removing and putting back a saved sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ours = { ...ROW, savedAt: 1 };
  const newer = { ...ROW, savedAt: 2 };

  it('removes the row the sign-out found', async () => {
    const rows = new Map<string, unknown>([[ROW.key, ours]]);
    vi.stubGlobal('indexedDB', fakeIndexedDb(rows));
    expect(await forgetMe('tenant-1', 'uid-1', 1)).toEqual(ours);
    expect(rows.has(ROW.key)).toBe(false);
  });

  it('leaves a row a newer sign-in saved since, and says a row is still there', async () => {
    const rows = new Map<string, unknown>([[ROW.key, newer]]);
    vi.stubGlobal('indexedDB', fakeIndexedDb(rows));
    expect(await forgetMe('tenant-1', 'uid-1', 1)).toBe(false);
    expect(await forgetMe('tenant-1', 'uid-1', null)).toBe(false);
    expect(rows.get(ROW.key)).toEqual(newer);
  });

  it('puts the removed row back only when no newer sign-in has saved one', async () => {
    const rows = new Map<string, unknown>([[ROW.key, newer]]);
    vi.stubGlobal('indexedDB', fakeIndexedDb(rows));
    expect(await restoreMe(ours)).toBe(false);
    expect(rows.get(ROW.key)).toEqual(newer);
    rows.clear();
    expect(await restoreMe(ours)).toBe(true);
    expect(rows.get(ROW.key)).toEqual(ours);
  });
});

// A sign-out reads the saved sign-in first: within 3 seconds, or it says the row may be there.
describe('reading a saved sign-in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers the row, or null when there is none', async () => {
    const rows = new Map<string, unknown>([[ROW.key, ROW]]);
    vi.stubGlobal('indexedDB', fakeIndexedDb(rows));
    expect(await readMe('tenant-1', 'uid-1')).toEqual(ROW);
    rows.clear();
    expect(await readMe('tenant-1', 'uid-1')).toBeNull();
  });

  it('answers false, never "no row", when the phone\'s storage does not answer within 3 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    const read = readMe('tenant-1', 'uid-1');
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void read.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBe(false);
  });
});
