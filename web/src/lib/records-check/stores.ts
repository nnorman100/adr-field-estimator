import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The two stores the records check reads beside Postgres (S8-3): the field drafts' marks in
// Firestore and the evidence bucket. Seams, so the route tests run against stand-ins; every call
// here only reads. Nothing here is logged.

// A draft's server keys that say whether Submit marked it (src/lib/submissions/fence.ts): its
// `state` and the submission and epoch its fence names.
export type DraftMark = { state: string | null; submissionId: string | null; epoch: string | null };

export type DraftMarks = {
  // The mark of each named draft; a draft that is not there is absent from the map.
  marksOf(companyId: string, draftIds: string[]): Promise<Map<string, DraftMark>>;
  // The company's drafts in id order after `after` (null: from the first), at most `limit` of
  // them, and whether more follow.
  page(
    companyId: string,
    after: string | null,
    limit: number,
  ): Promise<{ drafts: (DraftMark & { id: string })[]; more: boolean }>;
};

// One generation of an object: its size and the SHA-256 kept in its own metadata when it was made
// (null when there is none).
export type ObjectStat = { sizeBytes: number; sha256: string | null };

export type EvidenceObjects = {
  // That generation of the named object, live or not, or null when the bucket no longer holds it.
  // It is the generation the registry row recorded and the photo routes read (photos/store.ts), so
  // a restore that copied it back under a new live generation still finds it while it is kept.
  stat(name: string, generation: bigint): Promise<ObjectStat | null>;
  // Names under `prefix` that the bucket holds a readable generation of, live or kept (noncurrent),
  // each once, in name order after `after` (null: from the first), every generation of `after`
  // skipped; at most `count` of them, and whether more follow. The bucket's own page tokens stay
  // inside this call.
  list(
    prefix: string,
    after: string | null,
    count: number,
  ): Promise<{ names: string[]; more: boolean }>;
};

function markOf(data: Record<string, unknown> | undefined): DraftMark {
  const fence = data?.fence as Record<string, unknown> | undefined;
  return {
    state: typeof data?.state === 'string' ? data.state : null,
    submissionId: typeof fence?.submissionId === 'string' ? fence.submissionId : null,
    epoch: typeof fence?.epoch === 'string' ? fence.epoch : null,
  };
}

export function firestoreDraftMarks(db: Firestore): DraftMarks {
  const drafts = (companyId: string) =>
    db.collection('companies').doc(companyId).collection('drafts');
  return {
    async marksOf(companyId, draftIds) {
      const found = new Map<string, DraftMark>();
      if (draftIds.length === 0) return found;
      const refs = draftIds.map((id) => drafts(companyId).doc(id));
      const snapshots = await firestoreSpan('get', 'drafts', () =>
        db.getAll(...refs, { fieldMask: ['state', 'fence'] }),
      );
      for (const snapshot of snapshots)
        if (snapshot.exists) found.set(snapshot.id, markOf(snapshot.data()));
      return found;
    },

    async page(companyId, after, limit) {
      let query = drafts(companyId)
        .orderBy(FieldPath.documentId())
        .select('state', 'fence')
        .limit(limit + 1);
      if (after !== null) query = query.startAfter(after);
      const snapshot = await firestoreSpan('get', 'drafts', () => query.get());
      const docs = snapshot.docs.slice(0, limit);
      return {
        drafts: docs.map((doc) => ({ id: doc.id, ...markOf(doc.data()) })),
        more: snapshot.size > limit,
      };
    },
  };
}

// The part of a Cloud Storage bucket this uses (@google-cloud/storage, through firebase-admin).
export type ListingBucket = {
  file(
    name: string,
    options: { generation: string },
  ): {
    getMetadata(): Promise<
      [
        {
          size?: string | number;
          metadata?: Record<string, unknown>;
        },
        ...unknown[],
      ]
    >;
  };
  getFiles(query: {
    prefix: string;
    startOffset: string;
    versions: true;
    maxResults: number;
    autoPaginate: false;
    pageToken?: string;
  }): Promise<[{ name: string }[], ({ pageToken?: string } | null | undefined)?, ...unknown[]]>;
};

const NOT_FOUND = 404;

export function bucketEvidenceObjects(bucket: ListingBucket): EvidenceObjects {
  return {
    async stat(name, generation) {
      let metadata;
      try {
        [metadata] = await bucket.file(name, { generation: generation.toString() }).getMetadata();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === NOT_FOUND) return null;
        throw error;
      }
      const hash = metadata.metadata?.sha256;
      return {
        sizeBytes: Number(metadata.size ?? 0),
        sha256: typeof hash === 'string' ? hash : null,
      };
    },

    async list(prefix, after, count) {
      const names: string[] = [];
      let pageToken: string | undefined;
      // A versioned listing gives one entry per generation, in name order and then generation
      // order. This follows the bucket's page tokens until it has seen one name past the `count`
      // asked for, so every generation of the last name returned has been listed, or until the
      // listing ends.
      for (;;) {
        const [files, next] = await bucket.getFiles({
          prefix,
          startOffset: after ?? prefix,
          versions: true,
          maxResults: Math.min(1000, count + 1),
          autoPaginate: false,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        for (const { name } of files) {
          if (name !== after && names[names.length - 1] !== name) names.push(name);
        }
        if (names.length > count) return { names: names.slice(0, count), more: true };
        pageToken = next?.pageToken;
        if (pageToken === undefined) return { names, more: false };
      }
    },
  };
}
