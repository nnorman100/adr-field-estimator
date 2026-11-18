import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES, readBody, sha256Of, sniffImageType, TooLarge } from '@/lib/photos/image';
import { bucketEvidenceStore, type Bucket, type BucketFile } from '@/lib/photos/store';

describe('what the bytes are', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  it('knows a JPEG, a PNG and a WebP by their first bytes and nothing else', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]))).toBe('image/jpeg');
    expect(sniffImageType(Uint8Array.from([...PNG, 0, 0]))).toBe('image/png');
    expect(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1]))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    // Another RIFF file is not a WebP, and a prefix of a signature is not the signature.
    expect(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(sniffImageType(Uint8Array.from(PNG.slice(0, 7)))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('hashes with SHA-256 as 64 lowercase hex characters', () => {
    expect(sha256Of(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('reading a request body', () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'PUT', body, headers });

  it('returns the bytes, and an empty body as no bytes', async () => {
    expect(Buffer.from(await readBody(post(Buffer.from('hello')))).toString()).toBe('hello');
    expect((await readBody(post(null))).byteLength).toBe(0);
  });

  it('refuses a body over the limit from its declared length, before reading a byte', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 });
    const request = new Request('http://localhost/x', { method: 'PUT', body: stream, duplex: 'half', headers: { 'Content-Length': '11' } } as RequestInit);
    await expect(readBody(request, 10)).rejects.toBeInstanceOf(TooLarge);
    expect(pulled).toBe(false);
  });

  it('refuses a body over the limit by its running total when no length was declared, and takes one exactly at it', async () => {
    await expect(readBody(post(new Uint8Array(11)), 10)).rejects.toBeInstanceOf(TooLarge);
    expect((await readBody(post(new Uint8Array(10)), 10)).byteLength).toBe(10);
    expect(MAX_PHOTO_BYTES).toBeLessThan(32 * 1024 * 1024);
  });
});

// The Cloud Storage calls, against a stand-in for the bucket: the create-only precondition is
// sent on every create, a 412 is read back as "exists" with the stored hash, and nothing else is
// swallowed. The real precondition is checked against the real bucket in S5a-12.
describe('the bucket adapter', () => {
  type Call = { name: string; options?: { generation?: string }; saved?: Parameters<BucketFile['save']>; deleted?: boolean };
  function bucketOf(behaviour: Partial<Pick<BucketFile, 'save' | 'getMetadata' | 'createReadStream' | 'delete'>>) {
    const calls: Call[] = [];
    const bucket: Bucket = {
      file(name, options) {
        const call: Call = { name, options };
        calls.push(call);
        return {
          save: async (data, saveOptions) => {
            call.saved = [data, saveOptions];
            return behaviour.save?.(data, saveOptions);
          },
          getMetadata: async () => behaviour.getMetadata?.() ?? [{}],
          createReadStream: () => behaviour.createReadStream?.() ?? Readable.from([]),
          delete: async () => {
            call.deleted = true;
            return behaviour.delete?.();
          },
        };
      },
    };
    return { bucket, calls };
  }
  const HASH = 'a'.repeat(64);

  it('creates with ifGenerationMatch=0 in one request, with the hash in the object’s metadata', async () => {
    const { bucket, calls } = bucketOf({ getMetadata: async () => [{ generation: '1700000000000001', metadata: { sha256: HASH } }] });
    const made = await bucketEvidenceStore(bucket).create('companies/c/jobs/j/photos/p', Buffer.from('bytes'), 'image/png', HASH);
    expect(made).toEqual({ outcome: 'created', generation: 1700000000000001n, sha256: HASH });
    expect(calls[0]!.saved![1]).toEqual({
      contentType: 'image/png',
      resumable: false,
      metadata: { metadata: { sha256: HASH } },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  });

  it('reads a 412 as an object already there, with its stored hash and generation', async () => {
    const { bucket } = bucketOf({
      save: async () => {
        throw Object.assign(new Error('conditionNotMet'), { code: 412 });
      },
      getMetadata: async () => [{ generation: 1700000000000009, metadata: { sha256: HASH } }],
    });
    expect(await bucketEvidenceStore(bucket).create('n', Buffer.from('b'), 'image/png', 'b'.repeat(64))).toEqual({
      outcome: 'exists',
      generation: 1700000000000009n,
      sha256: HASH,
    });
  });

  it('gives an object this app did not make no hash, so it is never taken for the caller’s bytes', async () => {
    const { bucket } = bucketOf({
      save: async () => {
        throw Object.assign(new Error('conditionNotMet'), { code: 412 });
      },
      getMetadata: async () => [{ generation: '5', metadata: { sha256: 'not-a-hash' } }],
    });
    expect(await bucketEvidenceStore(bucket).create('n', Buffer.from('b'), 'image/png', HASH)).toMatchObject({ outcome: 'exists', sha256: null });
  });

  it('passes every other failure on, as the bucket gave it', async () => {
    for (const code of [403, 500, undefined]) {
      const failure = Object.assign(new Error('boom'), { code });
      const { bucket } = bucketOf({
        save: async () => {
          throw failure;
        },
      });
      await expect(bucketEvidenceStore(bucket).create('n', Buffer.from('b'), 'image/png', HASH)).rejects.toBe(failure);
    }
  });

  it('opens one generation of an object, and answers null for one that is not there', async () => {
    const { bucket, calls } = bucketOf({ createReadStream: () => Readable.from([Buffer.from('he'), Buffer.from('llo')]) });
    const stream = await bucketEvidenceStore(bucket).open('companies/c/jobs/j/photos/p', 42n);
    expect(calls[0]!.options).toEqual({ generation: '42' });
    expect(Buffer.from(await new Response(stream as unknown as ReadableStream).arrayBuffer()).toString()).toBe('hello');
    const missing = bucketOf({
      getMetadata: async () => {
        throw Object.assign(new Error('No such object'), { code: 404 });
      },
    });
    expect(await bucketEvidenceStore(missing.bucket).open('n', 1n)).toBeNull();
    const broken = bucketOf({
      getMetadata: async () => {
        throw Object.assign(new Error('denied'), { code: 403 });
      },
    });
    await expect(bucketEvidenceStore(broken.bucket).open('n', 1n)).rejects.toThrow('denied');
  });

  it('deletes only the one generation it is given, and passes a failure on', async () => {
    const { bucket, calls } = bucketOf({});
    await bucketEvidenceStore(bucket).delete('companies/c/jobs/j/photos/p', 42n);
    expect(calls).toEqual([{ name: 'companies/c/jobs/j/photos/p', options: { generation: '42' }, deleted: true }]);
    const denied = Object.assign(new Error('denied'), { code: 403 });
    const broken = bucketOf({
      delete: async () => {
        throw denied;
      },
    });
    await expect(bucketEvidenceStore(broken.bucket).delete('n', 1n)).rejects.toBe(denied);
  });
});
