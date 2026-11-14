import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldClient } from '@/lib/field-db';

// S6-3b: a refusal's lock and what removes the work after 30 days (O5) are saved before anything of
// the sign-in goes; when the phone cannot save either, nothing is signed out or forgotten.

const forgetMe = vi.fn(async () => null);
const fieldUser = { uid: 'ana' };
const signOutCompany = vi.fn(async () => undefined);
const enableNetwork = vi.fn(async () => undefined);

vi.mock('@/lib/field/ds-me', async (original) => ({
  ...(await original<typeof import('@/lib/field/ds-me')>()),
  forgetMe,
  saveMe: vi.fn(async () => true),
  readMe: vi.fn(async () => null),
  updateMe: vi.fn(async () => true),
}));
vi.mock('@/lib/firebase-client', () => ({
  signOutCompany,
  callApi: vi.fn(async () => ({ status: 401, body: { error: 'sign_in_revoked' } })),
}));
vi.mock('@/lib/field-db', () => ({
  stopFieldClient: vi.fn(async () => undefined),
  discardFieldWork: vi.fn(async () => 'discarded'),
  appCheckSeam: () => null,
  fieldUser: () => fieldUser,
  settle: vi.fn(async () => undefined),
}));
vi.mock('firebase/firestore', () => ({ enableNetwork, disableNetwork: vi.fn(async () => undefined) }));
vi.mock('firebase/auth', () => ({ getIdTokenResult: vi.fn(async () => ({ authTime: new Date().toISOString() })) }));

const { cleanupKey, lockWork } = await import('@/lib/field/retention');
const { signOutOnRefusal, WorkNotSecuredError } = await import('@/lib/field/sign-out');
const { runFieldSync } = await import('@/lib/field/field-sync');
const { readUnsent, unsentKey } = await import('@/lib/field/unsent');

const config: BrowserSignInConfig = { apiKey: 'key', authDomain: 'example.test', projectId: 'demo-field', authEmulatorUrl: null, firestoreDatabaseId: 'field' };
const person = { tenantId: 't-a', uid: 'ana', config };
const quota = () => new DOMException('full', 'QuotaExceededError');

function fakeStorage() {
  const items = new Map<string, string>();
  let failing: string | null = null;
  return {
    items,
    failOn(key: string | null) {
      failing = key;
    },
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      if (key === failing) throw quota();
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
  };
}

let storage: ReturnType<typeof fakeStorage>;
const auth = { currentUser: { uid: 'ana', metadata: { lastSignInTime: 'Fri, 13 Nov 2026 09:00:00 GMT' } } } as unknown as Auth;
const unsentBefore = JSON.stringify({ writes: 3, unsentSince: 100, lockedSince: null });

beforeEach(() => {
  storage = fakeStorage();
  storage.items.set(unsentKey('t-a', 'ana'), unsentBefore);
  vi.stubGlobal('window', { localStorage: storage });
  forgetMe.mockClear();
  signOutCompany.mockClear();
  enableNetwork.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a refusal on the phone', () => {
  it.each([
    ['the cleanup settings', () => cleanupKey('t-a')],
    ['the lock', () => unsentKey('t-a', 'ana')],
  ])('is not saved at all when %s cannot be written', (_name, key) => {
    storage.failOn(key());
    expect(lockWork(person, 'sign-in-again', 500)).toBeNull();
    expect(storage.items.get(unsentKey('t-a', 'ana'))).toBe(unsentBefore);
  });

  it('is saved with the settings that remove the work later', () => {
    expect(lockWork(person, 'session-revoked', 500)).toBe(500);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: 100, lockedSince: 500, lockedReason: 'session-revoked' });
    expect(JSON.parse(storage.items.get(cleanupKey('t-a'))!)).toEqual({ apiKey: 'key', authDomain: 'example.test', projectId: 'demo-field', authEmulatorUrl: null, firestoreDatabaseId: 'field' });
  });
});

describe('a sign-out the app makes on a refusal', () => {
  it.each([
    ['the cleanup settings', () => cleanupKey('t-a')],
    ['the lock', () => unsentKey('t-a', 'ana')],
  ])('keeps the saved sign-in and the work, and says so, when %s cannot be written', async (_name, key) => {
    storage.failOn(key());
    await expect(signOutOnRefusal(auth, 't-a', config, 'sign-in-again')).rejects.toBeInstanceOf(WorkNotSecuredError);
    expect(forgetMe).not.toHaveBeenCalled();
    expect(signOutCompany).not.toHaveBeenCalled();
    expect(storage.items.get(unsentKey('t-a', 'ana'))).toBe(unsentBefore);
  });

  it('saves the lock, then signs out, and a try once the phone has room succeeds', async () => {
    storage.failOn(unsentKey('t-a', 'ana'));
    await expect(signOutOnRefusal(auth, 't-a', config, 'sign-in-again')).rejects.toBeInstanceOf(WorkNotSecuredError);
    storage.failOn(null);
    await signOutOnRefusal(auth, 't-a', config, 'sign-in-again');
    expect(readUnsent('t-a', 'ana')).toMatchObject({ lockedSince: expect.any(Number), lockedReason: 'sign-in-again' });
    expect(forgetMe).toHaveBeenCalledWith('t-a', 'ana', null);
    expect(signOutCompany).toHaveBeenCalledOnce();
  });
});

describe('the field gate refused', () => {
  it.each([
    ['the cleanup settings', () => cleanupKey('t-a')],
    ['the lock', () => unsentKey('t-a', 'ana')],
  ])('keeps the saved sign-in and the network off when %s cannot be written', async (_name, key) => {
    vi.useFakeTimers();
    try {
      storage.failOn(key());
      const states: string[] = [];
      const saved = { tenantId: 't-a', uid: 'ana', companyName: 'A', address: 'a', config, savedAt: 1, role: 'estimator', authTime: Date.now() };
      const gate = runFieldSync({ db: {}, cache: 'persistent', person } as unknown as FieldClient, saved, (event) => {
        if ('state' in event) states.push(event.state.kind);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toContain('locked');
      expect(forgetMe).not.toHaveBeenCalled();
      expect(enableNetwork).not.toHaveBeenCalled();
      gate.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
