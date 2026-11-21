import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, readAll, phone, noted } = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  readAll: vi.fn(() => {
    const request = { result: [...rows.values()], onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  }),
  phone: { answer: 'keep' as 'keep' | 'online-only' | null, failReads: false },
  noted: { ids: [] as string[], succeed: true },
}));
vi.mock('@/lib/field/keep-consent', () => ({ keepAnswer: () => phone.answer }));
vi.mock('@/lib/field/platform', () => ({ offlineCaptureAllowed: () => true, readFieldSurface: () => 'other' }));
vi.mock('@/lib/field/unsent', () => ({
  notePhoto: (_tenant: string, _uid: string, id: string) => {
    noted.ids.push(id);
    return noted.succeed;
  },
}));
vi.mock('@/lib/field/idb', () => {
  const store = {
    put: (row: { owner: string }) => rows.set(row.owner, row),
    delete: (owner: string) => rows.delete(owner),
    get: (owner: string) => {
      if (phone.failReads) throw new Error('the read failed');
      return { result: rows.get(owner) };
    },
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

const photo = (id: string, text: string) => ({ id, bytes: new Blob([text]), field: {}, step: 'send-failed' as const, draftId: 'd1', updateRefused: true as const });

// One page of the app: its own memory of unsent work and of what it has put back. Loading it again
// is the reload an update makes; the phone's storage (the mocked rows) stays.
async function page() {
  vi.resetModules();
  const { pending } = await import('@/lib/field/pending');
  return { pending, ...(await import('@/lib/field/update-keep')) };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', {});
  rows.clear();
  phone.answer = 'keep';
  phone.failReads = false;
  noted.ids = [];
  noted.succeed = true;
});
afterEach(() => vi.unstubAllGlobals());

describe('what an app update carries', () => {
  it('restores only the exact tenant and user, and leaves another tenant’s queued photo available', async () => {
    const owner = 'tenant-a/same-user';
    const old = await page();
    old.pending.openFor(owner);
    old.pending.addPhoto('job-a', photo('photo-a', 'a'));
    expect(await old.keepForUpdate()).toBe(true);

    const next = await page();
    next.pending.openFor('tenant-b/same-user');
    expect(await next.restoreKept('tenant-b/same-user')).toBe(true);
    expect(next.pending.photos('job-a')).toEqual([]);
    expect(rows.has(owner)).toBe(true);
    next.pending.openFor(owner);
    expect(await next.restoreKept(owner)).toBe(true);
    const [back] = next.pending.photos('job-a');
    expect(await back?.bytes.text()).toBe('a');
    expect(back).toMatchObject({ id: 'photo-a', draftId: 'd1', resumed: true });
    expect(rows.has(owner)).toBe(true);
    expect(readAll).not.toHaveBeenCalled();
  });

  it('marks each restored photo unsent before the row is consumed, and keeps the row when it cannot', async () => {
    const owner = 'tenant-a/marked-user';
    const old = await page();
    old.pending.openFor(owner);
    old.pending.addPhoto('job-a', photo('photo-m', 'm'));
    expect(await old.keepForUpdate()).toBe(true);

    const next = await page();
    next.pending.openFor(owner);
    noted.succeed = false;
    expect(await next.restoreKept(owner)).toBe(false);
    expect(rows.has(owner)).toBe(true);
    expect(next.pending.photos('job-a')).toEqual([]);
    noted.succeed = true;
    expect(await next.restoreKept(owner)).toBe(true);
    expect(noted.ids).toContain('photo-m');
    expect(rows.has(owner)).toBe(true);
  });

  it('never writes private work on a phone set to Online only, or with no answer', async () => {
    const now = await page();
    now.pending.openFor('tenant-a/online-user');
    now.pending.addPhoto('job-a', photo('photo-o', 'o'));
    for (const answer of ['online-only', null] as const) {
      phone.answer = answer;
      expect(now.keepBlock()).toMatch(/Send or discard/);
      expect(await now.keepForUpdate()).toBe(false);
      expect(rows.size).toBe(0);
    }
    phone.answer = 'keep';
    expect(now.keepBlock()).toBeNull();
  });

  it('leaves a row it could not read alone instead of writing over it', async () => {
    const owner = 'tenant-a/unread-user';
    const old = await page();
    old.pending.openFor(owner);
    old.pending.addPhoto('job-a', photo('photo-u', 'u'));
    expect(await old.keepForUpdate()).toBe(true);
    const before = rows.get(owner);

    const next = await page();
    next.pending.openFor(owner);
    next.pending.addPhoto('job-b', photo('photo-v', 'v'));
    phone.failReads = true;
    expect(await next.keepForUpdate()).toBe(false);
    expect(rows.get(owner)).toBe(before);
    phone.failReads = false;
    expect(await next.keepForUpdate()).toBe(true);
    expect(next.pending.photos('job-a')).toHaveLength(1);
    expect(next.pending.photos('job-b')).toHaveLength(1);
  });

  it('removes what a write under way wrote when the work is discarded meanwhile', async () => {
    const owner = 'tenant-a/discarding-user';
    const now = await page();
    now.pending.openFor(owner);
    now.pending.addPhoto('job-a', photo('photo-d', 'd'));
    const writing = now.keepForUpdate();
    await now.discardKept(owner);
    expect(await writing).toBe(false);
    expect(rows.has(owner)).toBe(false);
    expect(now.pending.kept()).toBeNull();
    expect(await now.keepForUpdate()).toBe(true);
    expect(rows.has(owner)).toBe(false);
  });

  it('keeps every photo on the phone with its id and bytes until its reference is saved, whichever job is open', async () => {
    const owner = 'tenant-a/photo-user';
    const old = await page();
    old.pending.openFor(owner);
    old.pending.addPhoto('job-a', photo('photo-a', 'a'));
    expect(await old.keepForUpdate()).toBe(true);

    const opened = await page();
    opened.pending.openFor(owner);
    opened.pending.addPhoto('job-b', photo('photo-b', 'b'));
    // A subsequent update carries the photo already on disk and the one just captured.
    expect(await opened.keepForUpdate()).toBe(true);
    expect(opened.pending.photos('job-a')).toHaveLength(1);
    expect(opened.pending.photos('job-b')).toHaveLength(1);

    const closedWithoutOpeningA = await page();
    closedWithoutOpeningA.pending.openFor(owner);
    expect(await closedWithoutOpeningA.restoreKept(owner)).toBe(true);
    const [kept] = closedWithoutOpeningA.pending.photos('job-a');
    expect(kept).toMatchObject({ id: 'photo-a', draftId: 'd1', resumed: true });
    expect(await kept?.bytes.text()).toBe('a');
    closedWithoutOpeningA.pending.removePhoto('job-b', 'photo-b');
    await vi.waitFor(() => expect(Object.keys((rows.get(owner) as { work: { photos: object } }).work.photos)).toEqual(['job-a']));

    const last = await page();
    last.pending.openFor(owner);
    expect(await last.restoreKept(owner)).toBe(true);
    expect(last.pending.photos('job-b')).toEqual([]);
    expect(await last.pending.photos('job-a')[0]?.bytes.text()).toBe('a');
    last.pending.removePhoto('job-a', 'photo-a');
    await vi.waitFor(() => expect(rows.has(owner)).toBe(false));
  });

  it('keeps the photos put back when an update does not go through', async () => {
    const owner = 'tenant-a/abandoning-user';
    const old = await page();
    old.pending.openFor(owner);
    old.pending.addPhoto('job-a', photo('photo-a', 'a'));
    expect(await old.keepForUpdate()).toBe(true);

    const next = await page();
    next.pending.openFor(owner);
    expect(await next.restoreKept(owner)).toBe(true);
    next.pending.setJob({ id: 'job-new', draftId: 'd2', propertyAddress: '1 Main St', sending: false });
    expect(await next.keepForUpdate()).toBe(true);
    expect((rows.get(owner) as { work: { job: unknown } }).work.job).not.toBeNull();
    await next.releaseKept(owner);
    expect(rows.get(owner)).toMatchObject({ work: { job: null, photos: { 'job-a': [{ id: 'photo-a' }] } } });
  });

  it('never writes a customer or claim record, and waits while its save has no answer', async () => {
    const owner = 'tenant-a/record-user';
    const now = await page();
    now.pending.openFor(owner);
    const values = { name: 'Ann Lee', phone: '555-0101', email: 'ann@example.test' };
    now.pending.setRecord('job-a', { kind: 'customer', changeId: 'c1', revision: 3, values, edits: { name: 'Ann Lee' }, sending: false });
    expect(now.keepBlock()).toBe(now.RECORD_BLOCKED);
    expect(await now.keepForUpdate()).toBe(false);
    expect(rows.size).toBe(0);

    now.pending.settleRecord('job-a', 'c1', { refused: 'Update needed' });
    expect(now.keepBlock()).toBeNull();
    expect(await now.keepForUpdate()).toBe(true);
    const text = JSON.stringify(rows.get(owner));
    expect(text).toContain('Ann Lee');
    expect(text).not.toContain('555-0101');
    expect(text).not.toContain('ann@example.test');
  });
});
