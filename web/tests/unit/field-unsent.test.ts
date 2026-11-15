import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepAnswer, saveKeepAnswer } from '@/lib/field/keep-consent';
import {
  forgetUnsent,
  LOCKED_LIMIT_MS,
  lockOutlived,
  mayHaveUnsent,
  noteLocked,
  noteUnlocked,
  noteWrite,
  readUnsent,
  savedLock,
  unsentWork,
  settled,
  unsentKey,
  writesNow,
} from '@/lib/field/unsent';

// The phone's marks of unsent field work and locked access (S6-3), per company tenant and person,
// and the "keep jobs on this phone" answer per company.

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
  };
}

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => vi.unstubAllGlobals());

describe('unsent work marks', () => {
  it('start empty, and a write marks its person in its company only', () => {
    expect(mayHaveUnsent('t-a', 'ana')).toBe(false);
    noteWrite('t-a', 'ana', 100);
    expect(readUnsent('t-a', 'ana')).toEqual({ writes: 1, unsentSince: 100, lockedSince: null });
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
    expect(mayHaveUnsent('t-b', 'ana')).toBe(false);
    expect(mayHaveUnsent('t-a', 'ben')).toBe(false);
  });

  it('are cleared once the writes are acknowledged, but not over a write made since', () => {
    noteWrite('t-a', 'ana', 100);
    const upTo = writesNow('t-a', 'ana')!;
    noteWrite('t-a', 'ana', 200);
    settled('t-a', 'ana', upTo);
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
    expect(readUnsent('t-a', 'ana')).toMatchObject({ unsentSince: 100 });
    settled('t-a', 'ana', writesNow('t-a', 'ana')!);
    expect(mayHaveUnsent('t-a', 'ana')).toBe(false);
  });

  it('count as unsent work when they cannot be read', () => {
    storage.items.set(unsentKey('t-a', 'ana'), '{not json');
    expect(readUnsent('t-a', 'ana')).toBe('unreadable');
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
    vi.stubGlobal('window', {
      localStorage: {
        getItem() {
          throw new Error('blocked');
        },
      },
    });
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
  });

  it('keep the time the refusals began, until the person gets through', () => {
    expect(noteLocked('t-a', 'ana', 'member-disabled', 1000)).toBe(1000);
    expect(noteLocked('t-a', 'ana', 'member-disabled', 5000)).toBe(1000);
    noteUnlocked('t-a', 'ana');
    expect(noteLocked('t-a', 'ana', 'member-disabled', 9000)).toBe(9000);
  });

  it('keep every kind of refusal, and count as locked when they cannot be read', () => {
    noteLocked('t-a', 'ana', 'sign-in-again', 1000);
    expect(savedLock('t-a', 'ana')).toBe('sign-in-again');
    noteLocked('t-a', 'ben', 'second-step', 1000);
    expect(savedLock('t-a', 'ben')).toBe('second-step');
    storage.items.set(unsentKey('t-a', 'cleo'), '{not json');
    expect(savedLock('t-a', 'cleo')).toBe('sign-in-again');
    storage.items.set(unsentKey('t-a', 'dee'), JSON.stringify({ writes: 0, unsentSince: null, lockedSince: 5, lockedReason: 'shrug' }));
    expect(savedLock('t-a', 'dee')).toBe('sign-in-again');
  });

  it('tell work kept on this phone from work made only in a window\'s memory', () => {
    expect(unsentWork('t-a', 'ana')).toBe('none');
    noteWrite('t-a', 'ana', 100, true);
    expect(unsentWork('t-a', 'ana')).toBe('memory');
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
    settled('t-a', 'ana', writesNow('t-a', 'ana')!);
    expect(unsentWork('t-a', 'ana')).toBe('none');

    noteWrite('t-a', 'ben', 100, false);
    noteWrite('t-a', 'ben', 200, true);
    expect(unsentWork('t-a', 'ben')).toBe('kept');
    noteWrite('t-a', 'cleo', 100, true);
    noteWrite('t-a', 'cleo', 200, false);
    expect(unsentWork('t-a', 'cleo')).toBe('kept');
    storage.items.set(unsentKey('t-a', 'dee'), '{not json');
    expect(unsentWork('t-a', 'dee')).toBe('kept');
  });

  it('keep a refusal the owner made as the reason when a plain "sign in again" follows it', () => {
    noteLocked('t-a', 'ana', 'session-revoked', 1000);
    noteLocked('t-a', 'ana', 'sign-in-again', 2000);
    expect(savedLock('t-a', 'ana')).toBe('session-revoked');
    noteLocked('t-a', 'ana', 'member-disabled', 3000);
    expect(savedLock('t-a', 'ana')).toBe('member-disabled');
    noteLocked('t-a', 'ben', 'sign-in-again', 1000);
    noteLocked('t-a', 'ben', 'second-step', 2000);
    expect(savedLock('t-a', 'ben')).toBe('second-step');
  });

  it('say when a refusal could not be saved', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem() {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        },
      },
    });
    expect(noteLocked('t-a', 'ana', 'member-disabled', 1000)).toBeNull();
  });

  it('keep the refusal for a start with no answer, for that person in that company, until they get through', () => {
    expect(savedLock('t-a', 'ana')).toBeNull();
    noteLocked('t-a', 'ana', 'company-inactive', 1000);
    expect(savedLock('t-a', 'ana')).toBe('company-inactive');
    expect(savedLock('t-b', 'ana')).toBeNull();
    expect(savedLock('t-a', 'ben')).toBeNull();
    noteWrite('t-a', 'ana', 2000);
    expect(savedLock('t-a', 'ana')).toBe('company-inactive');
    noteUnlocked('t-a', 'ana');
    expect(savedLock('t-a', 'ana')).toBeNull();
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
  });

  it('are forgotten for one person only', () => {
    noteWrite('t-a', 'ana');
    noteWrite('t-b', 'ana');
    forgetUnsent('t-a', 'ana');
    expect(mayHaveUnsent('t-a', 'ana')).toBe(false);
    expect(mayHaveUnsent('t-b', 'ana')).toBe(true);
  });

  // S6-3b: the O5 limit is judged from the mark alone, so it holds after the saved sign-in is gone.
  it('say whose lock outlived the 30 days: a refusal O5 removes work for, in that company only', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;
    noteLocked('t-a', 'ana', 'session-revoked', now - LOCKED_LIMIT_MS - 1);
    noteLocked('t-a', 'ben', 'sign-in-again', now - LOCKED_LIMIT_MS + 1);
    noteLocked('t-a', 'cleo', 'second-step', now - 40 * DAY);
    noteLocked('t-a', 'dan', 'company-inactive', now - 40 * DAY);
    noteUnlocked('t-a', 'dan');
    noteLocked('t-a', 'eve', 'sign-in-again', now - 40 * DAY);
    noteLocked('t-ab', 'fay', 'member-disabled', now - 40 * DAY);
    noteWrite('t-a', 'gus', now - 40 * DAY);
    storage.items.set(unsentKey('t-a', 'hal'), '{not json');
    storage.items.set('ds-keep/t-a', 'keep');

    expect(lockOutlived('t-a', 'ana', now)).toBe(true);
    expect(lockOutlived('t-a', 'ben', now)).toBe(false);
    expect(lockOutlived('t-a', 'ben', now + 2)).toBe(true);
    expect(lockOutlived('t-a', 'cleo', now)).toBe(false);
    expect(lockOutlived('t-a', 'dan', now)).toBe(false);
    expect(lockOutlived('t-a', 'gus', now)).toBe(false);
    // A mark that cannot be read is never taken as permission to remove anything.
    expect(lockOutlived('t-a', 'hal', now)).toBe(false);
    expect(lockOutlived('t-a', 'eve', now)).toBe(true);
    expect(lockOutlived('t-ab', 'fay', now)).toBe(true);
    expect(lockOutlived('t-a', 'fay', now)).toBe(false);
    expect(lockOutlived('t-b', 'ana', now)).toBe(false);
  });

  it('count nobody as outlived when the phone\'s storage cannot be read', () => {
    noteLocked('t-a', 'ana', 'session-revoked', Date.now() - LOCKED_LIMIT_MS - 1);
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(lockOutlived('t-a', 'ana', Date.now())).toBe(false);
  });

  it('hold counts and times only', () => {
    noteWrite('t-a', 'ana', 100);
    expect(JSON.parse(storage.items.get(unsentKey('t-a', 'ana'))!)).toEqual({ writes: 1, unsentSince: 100, lockedSince: null });
  });
});

describe('keep jobs on this phone', () => {
  it('is asked once per company', () => {
    expect(keepAnswer('t-a')).toBeNull();
    saveKeepAnswer('t-a', 'keep');
    expect(keepAnswer('t-a')).toBe('keep');
    expect(keepAnswer('t-b')).toBeNull();
    saveKeepAnswer('t-b', 'online-only');
    expect(keepAnswer('t-b')).toBe('online-only');
  });

  it('asks again when the answer cannot be read', () => {
    storage.items.set('ds-keep/t-a', 'maybe');
    expect(keepAnswer('t-a')).toBeNull();
  });
});
