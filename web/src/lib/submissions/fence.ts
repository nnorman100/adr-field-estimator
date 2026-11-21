import type { Firestore } from 'firebase-admin/firestore';
import type { FieldDoc, FieldManifest } from '@/lib/field/canonical';
import { firestoreDraftLookup, type DraftLookup } from '@/lib/jobs/drafts';
import { firestoreJobProjectionStore, type JobProjectionStore } from '@/lib/jobs/projection';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The Firestore side of Submit (docs/plans/S5.md, section 4) that is not the draft sync: the read of
// what a fenced draft holds. Every change of a draft (its fence, its marker, its release, and the next
// draft Back to editing makes) is written by the draft sync (src/lib/jobs/draft-sync.ts), in one
// Firestore transaction per job. The server SDK is not bound by the field rules; the rules refuse
// every client write unless `state` is `editing` (web/firestore.rules).
//
// The draft document's server keys (beside `fieldOwnerUid` and the client's `field`):
//   state     `editing`, `submitting` (fenced) or `submitted`; `archived` while the job is archived
//   fence     { submissionId, epoch, expiresAt } while submitting and after; removed on release
//   previous  { draftId, submissionId } on a draft Back to editing made: where it came from
//   jobId     the job the draft was made for (src/lib/jobs/drafts.ts, security audit F1)
//
// A seam, so the route tests run without Firestore; tests/emu/ checks this reader against the
// emulator with the same contract the stand-in is held to (tests/submissions/fence-contract.ts).

export type Fence = { submissionId: string; epoch: string; expiresAt: Date };

export type Provenance = { draftId: string; submissionId: string };

export type FenceStore = JobProjectionStore & DraftLookup & {
  // The draft's field map and nested documents, read in one consistent read, or null when the
  // draft is not fenced by this epoch; `too_many_rooms` or `too_many_photos` when that nested
  // collection exceeds its safety cap. A read never returns a truncated manifest for hashing or storing.
  read(companyId: string, draftId: string, epoch: string): Promise<FieldManifest | 'too_many_rooms' | 'too_many_photos' | null>;
};

type StoredFence = { submissionId: string; epoch: string };

function fenceOf(data: Record<string, unknown> | undefined): StoredFence | null {
  const fence = data?.fence as Record<string, unknown> | undefined;
  if (!fence || typeof fence.epoch !== 'string' || typeof fence.submissionId !== 'string') return null;
  return { submissionId: fence.submissionId, epoch: fence.epoch };
}

const docs = (snapshot: { docs: { id: string; get(field: string): unknown }[] }): FieldDoc[] =>
  snapshot.docs.map((doc) => ({ id: doc.id, field: doc.get('field') ?? {} }));

export function firestoreFenceStore(db: Firestore): FenceStore {
  return {
    ...firestoreJobProjectionStore(db),
    ...firestoreDraftLookup(db),
    async read(companyId, draftId, epoch) {
      const ref = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(
          async (tx) => {
            const draft = await tx.get(ref);
            const data = draft.data();
            if (!draft.exists || data?.state !== 'submitting' || fenceOf(data)?.epoch !== epoch) return null;
            // One above each cap detects overflow without reading an attacker-sized collection.
            const rooms = await tx.get(ref.collection('rooms').limit(MAX_ROOMS + 1));
            if (rooms.size > MAX_ROOMS) return 'too_many_rooms' as const;
            const photos = await tx.get(ref.collection('photos').limit(MAX_PHOTO_REFS + 1));
            if (photos.size > MAX_PHOTO_REFS) return 'too_many_photos' as const;
            return { draft: data.field ?? {}, rooms: docs(rooms), photos: docs(photos) } satisfies FieldManifest;
          },
          { readOnly: true },
        ),
      );
    },
  };
}
