import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The two stores the records check reads beside Postgres (S8-3): the field drafts' marks in
// Firestore and the evidence bucket. Seams, so the route tests run against stand-ins; every call
// here only reads. Nothing here is logged.

// A draft's server keys that say whether Submit marked it (src/lib/submissions/fence.ts): its
// `state` and the submission its fence names.
export type DraftMark = { state: string | null; submissionId: string | null };

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

// One object as the bucket holds it now: its generation, its size and the SHA-256 kept in its own
// metadata when it was made (null when there is none).
export type ObjectStat = { generation: bigint; sizeBytes: number; sha256: string | null };

export type EvidenceObjects = {
  // The live object of that name, or null when there is none.
  stat(name: string): Promise<ObjectStat | null>;
  // Names under `prefix` from `startOffset` (inclusive) in name order, at most `count` of them, and
  // whether more follow. The bucket's own page tokens stay inside this call.
  list(
    prefix: string,
    startOffset: string,
    count: number,
  ): Promise<{ names: string[]; more: boolean }>;
};

function markOf(data: Record<string, unknown> | undefined): DraftMark {
  const fence = data?.fence as Record<string, unknown> | undefined;
  return {
    state: typeof data?.state === 'string' ? data.state : null,
    submissionId: typeof fence?.submissionId === 'string' ? fence.submissionId : null,
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
  file(name: string): {
    getMetadata(): Promise<
      [
        {
          generation?: string | number;
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
    maxResults: number;
    autoPaginate: false;
    pageToken?: string;
  }): Promise<[{ name: string }[], ({ pageToken?: string } | null | undefined)?, ...unknown[]]>;
};

const NOT_FOUND = 404;

export function bucketEvidenceObjects(bucket: ListingBucket): EvidenceObjects {
  return {
    async stat(name) {
      let metadata;
      try {
        [metadata] = await bucket.file(name).getMetadata();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === NOT_FOUND) return null;
        throw error;
      }
      const hash = metadata.metadata?.sha256;
      return {
        generation: BigInt(metadata.generation ?? 0),
        sizeBytes: Number(metadata.size ?? 0),
        sha256: typeof hash === 'string' ? hash : null,
      };
    },

    async list(prefix, startOffset, count) {
      const names: string[] = [];
      let pageToken: string | undefined;
      // The bucket may answer a page short of maxResults with more to come, so this follows its
      // page token until it has `count` names or the listing ends.
      for (;;) {
        const [files, next] = await bucket.getFiles({
          prefix,
          startOffset,
          maxResults: count - names.length,
          autoPaginate: false,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        names.push(...files.map((file) => file.name));
        pageToken = next?.pageToken;
        if (pageToken === undefined) return { names, more: false };
        if (names.length >= count) return { names: names.slice(0, count), more: true };
      }
    },
  };
}
