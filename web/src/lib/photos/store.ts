import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

// The evidence bucket, as the photo routes see it (S5a-5). A seam so the route tests run against a
// fake at this boundary; the real precondition is checked against the real bucket in S5a-12.
export type StoredObject = {
  // The bucket's generation number of the object.
  generation: bigint;
  // The SHA-256 the object was created with, kept in its own metadata; null for an object this app
  // did not make.
  sha256: string | null;
};

export type EvidenceStore = {
  // Creates the object only if no object has that name (a create-only precondition, so bytes are
  // never overwritten). When one is there, `exists` says what it is and nothing is changed.
  create(
    name: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
  ): Promise<({ outcome: 'created' } | { outcome: 'exists' }) & StoredObject>;
  // The bytes of one generation of an object, or null when there is no such object.
  open(name: string, generation: bigint): Promise<WebReadableStream<Uint8Array> | null>;
  // Deletes that one generation of an object and nothing else: another generation of the name is
  // left as it is.
  delete(name: string, generation: bigint): Promise<void>;
};

// The part of a Cloud Storage bucket this uses (@google-cloud/storage, through firebase-admin), so a
// test can stand in for it without a network.
export type BucketFile = {
  save(
    data: Buffer,
    options: {
      contentType: string;
      resumable: boolean;
      metadata: { metadata: Record<string, string> };
      preconditionOpts: { ifGenerationMatch: number };
    },
  ): Promise<void>;
  getMetadata(): Promise<[{ generation?: string | number; metadata?: Record<string, unknown> }, ...unknown[]]>;
  createReadStream(): NodeJS.ReadableStream;
  delete(): Promise<unknown>;
};
export type Bucket = { file(name: string, options?: { generation?: string }): BucketFile };

const PRECONDITION_FAILED = 412;
const NOT_FOUND = 404;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

async function stored(file: BucketFile): Promise<StoredObject> {
  const [metadata] = await file.getMetadata();
  const hash = metadata.metadata?.sha256;
  return {
    generation: BigInt(metadata.generation ?? 0),
    sha256: typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
  };
}

export function bucketEvidenceStore(bucket: Bucket): EvidenceStore {
  return {
    async create(name, bytes, contentType, sha256) {
      const file = bucket.file(name);
      try {
        // A single request (not a resumable session), created only where nothing is: a second
        // upload of the same name is refused with 412 and the stored bytes stay as they were.
        await file.save(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
          contentType,
          resumable: false,
          metadata: { metadata: { sha256 } },
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (error) {
        if (codeOf(error) !== PRECONDITION_FAILED) throw error;
        return { outcome: 'exists', ...(await stored(file)) };
      }
      return { outcome: 'created', ...(await stored(file)) };
    },

    async open(name, generation) {
      const file = bucket.file(name, { generation: generation.toString() });
      try {
        // The existence check first, so a missing object is a null rather than a stream that fails
        // after the response has started.
        await file.getMetadata();
      } catch (error) {
        if (codeOf(error) === NOT_FOUND) return null;
        throw error;
      }
      return Readable.toWeb(Readable.from(file.createReadStream())) as WebReadableStream<Uint8Array>;
    },

    async delete(name, generation) {
      await bucket.file(name, { generation: generation.toString() }).delete();
    },
  };
}
