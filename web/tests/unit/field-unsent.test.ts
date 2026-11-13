import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepAnswer, saveKeepAnswer } from '@/lib/field/keep-consent';
import {
  forgetUnsent,
  mayHaveUnsent,
  noteLocked,
  noteUnlocked,
  noteWrite,
  readUnsent,
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
    expect(noteLocked('t-a', 'ana', 1000)).toBe(1000);
    expect(noteLocked('t-a', 'ana', 5000)).toBe(1000);
    noteUnlocked('t-a', 'ana');
    expect(noteLocked('t-a', 'ana', 9000)).toBe(9000);
  });

  it('are forgotten for one person only', () => {
    noteWrite('t-a', 'ana');
    noteWrite('t-b', 'ana');
    forgetUnsent('t-a', 'ana');
    expect(mayHaveUnsent('t-a', 'ana')).toBe(false);
    expect(mayHaveUnsent('t-b', 'ana')).toBe(true);
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
