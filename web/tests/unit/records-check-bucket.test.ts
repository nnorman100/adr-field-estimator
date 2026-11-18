import { describe, expect, it } from 'vitest';
import { bucketEvidenceObjects, type ListingBucket } from '@/lib/records-check/stores';

// S8-3: the records check's bucket reader against a stand-in for the @google-cloud/storage calls it
// makes. The bucket answers pages of a set size whatever maxResults asks, as a real listing may.

type Query = Parameters<ListingBucket['getFiles']>[0];

// Objects by "name#generation"; `live: false` marks a kept (noncurrent) generation. A listing
// gives one entry per generation in name and generation order when asked for versions, and only
// live generations otherwise.
type Stored = { size?: string; metadata?: Record<string, unknown>; live?: boolean };

function bucketOf(objects: Record<string, Stored>, pageSize: number) {
  const queries: Query[] = [];
  const entries = Object.entries(objects)
    .map(([key, stored]) => ({ name: key.split('#')[0]!, generation: Number(key.split('#')[1]), live: stored.live !== false }))
    .sort((a, b) => (a.name === b.name ? a.generation - b.generation : a.name < b.name ? -1 : 1));
  const bucket: ListingBucket = {
    file(name, options) {
      return {
        async getMetadata() {
          const found = objects[`${name}#${options.generation}`];
          if (!found) throw Object.assign(new Error('No such object'), { code: 404 });
          return [found];
        },
      };
    },
    async getFiles(query) {
      queries.push(query);
      const listable = entries.filter(
        (entry) => entry.name.startsWith(query.prefix) && (query.versions || entry.live),
      );
      const from = query.pageToken === undefined ? 0 : Number(query.pageToken);
      const listed = listable.slice(from, from + Math.min(pageSize, query.maxResults));
      const end = from + listed.length;
      return [listed.map(({ name }) => ({ name })), end < listable.length ? { pageToken: String(end) } : null];
    },
  };
  return { bucket, queries };
}

describe('the bucket reader', () => {
  it('stats the asked generation with its size and stored SHA-256, and a generation not held as null', async () => {
    const sha = 'a'.repeat(64);
    const { bucket } = bucketOf(
      {
        'one#1731400000000001': { size: '2048', metadata: { sha256: sha } },
        'one#1731400000000002': { size: '9', metadata: { sha256: 'b'.repeat(64) } },
        'two#5': { size: '7' },
      },
      10,
    );
    const store = bucketEvidenceObjects(bucket);
    expect(await store.stat('one', 1731400000000001n)).toEqual({ sizeBytes: 2048, sha256: sha });
    expect(await store.stat('two', 5n)).toEqual({ sizeBytes: 7, sha256: null });
    expect(await store.stat('two', 6n)).toBeNull();
    expect(await store.stat('three', 5n)).toBeNull();
  });

  it('passes on any other bucket error', async () => {
    const bucket = {
      file: () => ({
        getMetadata: async () => {
          throw Object.assign(new Error('denied'), { code: 403 });
        },
      }),
    } as unknown as ListingBucket;
    await expect(bucketEvidenceObjects(bucket).stat('one', 1n)).rejects.toThrow('denied');
  });

  it('lists each name once, kept generations included, following page tokens to a name boundary', async () => {
    const objects = {
      'p/a#1': {},
      // Only kept generations: the live object was deleted.
      'p/b#1': { live: false },
      'p/b#2': { live: false },
      'p/c#1': { live: false },
      'p/c#2': {},
      'p/d#1': {},
      'q/a#1': {},
    };
    const first = bucketOf(objects, 2);
    expect(await bucketEvidenceObjects(first.bucket).list('p/', 2, 100)).toEqual({ names: ['p/a', 'p/b'], more: true });
    // p/b's second generation sits on the next bucket page; it is listed before the name is closed.
    expect(first.queries.map((query) => [query.prefix, query.pageToken])).toEqual([
      ['p/', undefined],
      ['p/', '2'],
    ]);
    const all = bucketOf(objects, 2);
    expect(await bucketEvidenceObjects(all.bucket).list('p/', 10, 100)).toEqual({ names: ['p/a', 'p/b', 'p/c', 'p/d'], more: false });
    expect(all.queries.every((query) => query.versions === true && query.autoPaginate === false)).toBe(true);
  });

  it('stops at the cap on version entries read, whatever the names, and says more follow', async () => {
    // One name with five kept generations, then another name.
    const objects: Record<string, Stored> = { 'p/b#1': {} };
    for (let generation = 1; generation <= 5; generation += 1) objects[`p/a#${generation}`] = { live: generation === 5 };
    const { bucket, queries } = bucketOf(objects, 2);
    expect(await bucketEvidenceObjects(bucket).list('p/', 10, 4)).toEqual({ names: ['p/a'], more: true });
    // Two bucket pages of two entries: the cap of four entries, never more.
    expect(queries.map((query) => query.maxResults)).toEqual([4, 2]);
  });
});
