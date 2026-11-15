import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { firestoreFenceStore } from '@/lib/submissions/fence';

// The SDK boundary records how many documents each requested query actually reads. A collection
// without a limit returns every document, so rejecting only after an unbounded read fails here.
function database(counts: { rooms: number; photos: number }) {
  type Query = { name: keyof typeof counts; cap?: number };
  const reads: { name: string; count: number }[] = [];
  const ref = {
    collection(name: keyof typeof counts) {
      return { name, limit: (cap: number): Query => ({ name, cap }) };
    },
  };
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      get: async (query: Query | typeof ref) => {
        if (query === ref) return { exists: true, data: () => ({ state: 'submitting', fence: { submissionId: 's', epoch: 'e' }, field: {} }) };
        const { name, cap } = query as Query;
        const count = Math.min(counts[name], cap ?? Infinity);
        reads.push({ name, count });
        return { size: count, docs: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}`, get: () => ({}) })) };
      },
    }),
  } as unknown as Firestore;
  return { store: firestoreFenceStore(db), reads };
}

describe('fenced draft read budgets', () => {
  it('reads no more than 31 rooms from an overfilled draft, and refuses it', async () => {
    const { store, reads } = database({ rooms: 1000, photos: 0 });
    expect(await store.read('c', 'd', 'e')).toBe('too_many_rooms');
    expect(reads.find((read) => read.name === 'rooms')).toEqual({ name: 'rooms', count: 31 });
  });

  it('reads no more than 301 photos from an overfilled draft, and refuses it', async () => {
    const { store, reads } = database({ rooms: 1, photos: 1000 });
    expect(await store.read('c', 'd', 'e')).toBe('too_many_photos');
    expect(reads).toEqual([{ name: 'rooms', count: 1 }, { name: 'photos', count: 301 }]);
  });
});
