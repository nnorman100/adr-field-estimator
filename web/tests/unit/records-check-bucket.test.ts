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
        (entry) => entry.name.startsWith(query.prefix) && entry.name >= query.startOffset && (query.versions || entry.live),
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

  it('lists each name once, kept generations included, after the given name, following page tokens to a name boundary', async () => {
    const { bucket, queries } = bucketOf(
      {
        'p/a#1': {},
        // Only kept generations: the live object was deleted.
        'p/b#1': { live: false },
        'p/b#2': { live: false },
        'p/c#1': { live: false },
        'p/c#2': {},
        'p/d#1': {},
        'p/e#1': {},
      },
      2,
    );
    const store = bucketEvidenceObjects(bucket);
    expect(await store.list('p/', null, 2)).toEqual({ names: ['p/a', 'p/b'], more: true });
    // Every generation of the name given is skipped, wherever the bucket's pages fall.
    expect(await store.list('p/', 'p/b', 2)).toEqual({ names: ['p/c', 'p/d'], more: true });
    expect(await store.list('p/', 'p/d', 5)).toEqual({ names: ['p/e'], more: false });
    expect(await store.list('p/', 'p/e', 5)).toEqual({ names: [], more: false });
    expect(queries.every((query) => query.versions === true && query.autoPaginate === false)).toBe(true);
    expect(queries.map((query) => [query.startOffset, query.pageToken])).toEqual([
      ['p/', undefined],
      ['p/', '2'],
      ['p/b', undefined],
      ['p/b', '2'],
      ['p/b', '4'],
      ['p/d', undefined],
      ['p/e', undefined],
    ]);
  });
});
