import { describe, expect, it } from 'vitest';
import { bucketEvidenceObjects, type ListingBucket } from '@/lib/records-check/stores';

// S8-3: the records check's bucket reader against a stand-in for the @google-cloud/storage calls it
// makes. The bucket answers pages of a set size whatever maxResults asks, as a real listing may.

type Query = Parameters<ListingBucket['getFiles']>[0];

// Objects by "name#generation"; a listing lists each name once.
function bucketOf(
  objects: Record<string, { size?: string; metadata?: Record<string, unknown> }>,
  pageSize: number,
) {
  const queries: Query[] = [];
  const names = [...new Set(Object.keys(objects).map((key) => key.split('#')[0]!))].sort();
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
      const from =
        query.pageToken === undefined
          ? names.findIndex((name) => name >= query.startOffset)
          : Number(query.pageToken);
      const listed =
        from === -1
          ? []
          : names
              .filter((name) => name.startsWith(query.prefix))
              .slice(from, from + Math.min(pageSize, query.maxResults));
      const end = from + listed.length;
      return [
        listed.map((name) => ({ name })),
        from !== -1 && end < names.length ? { pageToken: String(end) } : null,
      ];
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

  it('follows the page token inside one call until it has the names asked for, and says whether more follow', async () => {
    const objects = Object.fromEntries(
      ['p/a', 'p/b', 'p/c', 'p/d', 'p/e'].map((name) => [`${name}#1`, {}]),
    );
    const { bucket, queries } = bucketOf(objects, 2);
    const store = bucketEvidenceObjects(bucket);
    expect(await store.list('p/', 'p/b', 3)).toEqual({ names: ['p/b', 'p/c', 'p/d'], more: true });
    expect(
      queries.map((query) => [
        query.startOffset,
        query.maxResults,
        query.pageToken,
        query.autoPaginate,
      ]),
    ).toEqual([
      ['p/b', 3, undefined, false],
      ['p/b', 1, '3', false],
    ]);
    expect(await store.list('p/', 'p/d', 5)).toEqual({ names: ['p/d', 'p/e'], more: false });
  });
});
