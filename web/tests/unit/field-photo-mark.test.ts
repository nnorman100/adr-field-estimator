import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notePhoto, noteWrite, photoSent, readUnsent, settled, unsentWork } from '@/lib/field/unsent';

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  } });
});
afterEach(() => vi.unstubAllGlobals());

it('a field acknowledgement cannot clear an in-memory photo awaiting its receipt', () => {
  const write = noteWrite('tenant-a', 'ana')!;
  expect(notePhoto('tenant-a', 'ana', 'photo-a')).toBe(true);
  settled('tenant-a', 'ana', write);
  expect(unsentWork('tenant-a', 'ana')).toBe('memory');
  expect(readUnsent('tenant-a', 'ana')).toMatchObject({ photosInMemory: ['photo-a'] });
  expect(unsentWork('tenant-b', 'ana')).toBe('none');
  expect(unsentWork('tenant-a', 'ben')).toBe('none');
  photoSent('tenant-a', 'ana', 'photo-a');
  settled('tenant-a', 'ana', write);
  expect(unsentWork('tenant-a', 'ana')).toBe('none');
});

it('retries count the same photo once, and one receipt leaves the other photo unsent', () => {
  notePhoto('tenant-a', 'ana', 'photo-a');
  notePhoto('tenant-a', 'ana', 'photo-a');
  notePhoto('tenant-a', 'ana', 'photo-b');
  photoSent('tenant-a', 'ana', 'photo-a');
  settled('tenant-a', 'ana', 0);
  expect(readUnsent('tenant-a', 'ana')).toMatchObject({ photosInMemory: ['photo-b'], unsentSince: expect.any(Number) });
});

it('refuses capture when its unsent mark cannot be saved', () => {
  window.localStorage.setItem = () => { throw new Error('full'); };
  expect(notePhoto('tenant-a', 'ana', 'photo-a')).toBe(false);
});
