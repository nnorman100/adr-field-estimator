import type { Firestore } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fieldWrite, UnsentMarkNotSaved, type FieldClient } from '@/lib/field-db';
import { mayHaveUnsent } from '@/lib/field/unsent';

// Every field edit is marked as unsent before it is made (S6-3), so the sign-out question and the
// start-up watchdog know about it. An edit whose mark cannot be saved is not made at all.

function storage({ full }: { full: boolean }) {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

const client = { db: {} as Firestore, cache: 'persistent', person: { tenantId: 't-a', uid: 'ana', config: {} } } as unknown as FieldClient;

afterEach(() => vi.unstubAllGlobals());

describe('a field edit', () => {
  beforeEach(() => vi.stubGlobal('window', { localStorage: storage({ full: false }) }));

  it('is marked as unsent, then made', async () => {
    const write = vi.fn(async () => 'written');
    await expect(fieldWrite(client, write)).resolves.toBe('written');
    expect(write).toHaveBeenCalledOnce();
    expect(mayHaveUnsent('t-a', 'ana')).toBe(true);
  });

  it('is not made when the phone cannot save its mark', async () => {
    vi.stubGlobal('window', { localStorage: storage({ full: true }) });
    const write = vi.fn(async () => 'written');
    await expect(fieldWrite(client, write)).rejects.toBeInstanceOf(UnsentMarkNotSaved);
    expect(write).not.toHaveBeenCalled();
    expect(mayHaveUnsent('t-a', 'ana')).toBe(false);
  });
});
