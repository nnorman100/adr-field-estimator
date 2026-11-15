import { FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type { FieldDoc, FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The Firestore side of Submit (docs/plans/S5.md, section 4): the fence on a field draft, the read
// of what it holds once fenced, the two markers that end a fence, and the next draft version Back to
// editing makes. Every call that changes a draft is one Firestore transaction that first reads the
// draft's state and fence, so a writer acts only on the fence it was told about: a release or a
// marker for an old epoch never touches a newer fence. The server SDK is not bound by the field
// rules; the rules refuse every client write unless `state` is `editing` (web/firestore.rules).
//
// The draft document's server keys (beside `fieldOwnerUid` and the client's `field`):
//   state     `editing`, `submitting` (fenced) or `submitted`
//   fence     { submissionId, epoch, expiresAt } while submitting and after; removed on release
//   previous  { draftId, submissionId } on a draft Back to editing made: where it came from
//
// A seam, so the route tests run without Firestore; tests/emu/ checks this writer against the
// emulator with the same contract the stand-in is held to (tests/submissions/fence-contract.ts).

export type Fence = { submissionId: string; epoch: string; expiresAt: Date };

export type FenceResult =
  // Fenced now, or already fenced by this epoch.
  | { outcome: 'fenced' }
  // No such draft, or one with no state a fence can start from.
  | { outcome: 'missing' }
  // Fenced by another epoch, which the caller may only replace once it knows that epoch's
  // submission was aborted.
  | { outcome: 'held'; epoch: string }
  // Already submitted.
  | { outcome: 'submitted' };

export type Provenance = { draftId: string; submissionId: string };

export type FenceStore = {
  // Closes the fence: `editing` becomes `submitting` with this fence. `replacing` names an epoch
  // whose submission is known to be aborted; a fence of exactly that epoch is replaced.
  fence(companyId: string, draftId: string, fence: Fence, replacing?: string): Promise<FenceResult>;
  // The draft's field map and nested documents, read in one consistent read, or null when the
  // draft is not fenced by this epoch; `too_many_rooms` or `too_many_photos` when that nested
  // collection exceeds its safety cap. A read never returns a truncated manifest for hashing or storing.
  read(companyId: string, draftId: string, epoch: string): Promise<FieldManifest | 'too_many_rooms' | 'too_many_photos' | null>;
  // After a commit: `submitting` with this epoch becomes `submitted`. `marked` also when it is
  // already submitted by this submission; `missing` when there is no draft; `conflict` otherwise.
  markSubmitted(companyId: string, draftId: string, epoch: string, submissionId: string): Promise<'marked' | 'missing' | 'conflict'>;
  // After an abort: `submitting` with this epoch goes back to `editing`. Anything else (another
  // epoch's fence, already editing or submitted, no draft) is left as it is.
  release(companyId: string, draftId: string, epoch: string): Promise<'released' | 'not_fenced'>;
  // Back to editing: a new `editing` draft holding the given field data, with its provenance.
  // Made whole or not at all; `exists` when the draft is already there (a retry), and nothing is
  // changed then.
  createFrom(
    companyId: string,
    draftId: string,
    fieldOwnerUid: string | null,
    manifest: FieldManifest,
    previous: Provenance,
  ): Promise<'created' | 'exists'>;
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
  const draftRef = (companyId: string, draftId: string): DocumentReference =>
    db.collection('companies').doc(companyId).collection('drafts').doc(draftId);

  const inTransaction = <T>(work: Parameters<Firestore['runTransaction']>[0]) =>
    firestoreSpan('runTransaction', 'drafts', () => db.runTransaction(work)) as Promise<T>;

  return {
    async fence(companyId, draftId, fence, replacing) {
      const ref = draftRef(companyId, draftId);
      return inTransaction<FenceResult>(async (tx) => {
        const draft = await tx.get(ref);
        if (!draft.exists) return { outcome: 'missing' };
        const data = draft.data();
        const state = data?.state;
        const held = fenceOf(data);
        const close = () =>
          tx.update(ref, {
            state: 'submitting',
            fence: { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: Timestamp.fromDate(fence.expiresAt) },
          });
        if (state === 'editing') {
          close();
          return { outcome: 'fenced' };
        }
        if (state === 'submitting' && held) {
          if (held.epoch === fence.epoch) return { outcome: 'fenced' };
          if (replacing !== undefined && held.epoch === replacing) {
            close();
            return { outcome: 'fenced' };
          }
          return { outcome: 'held', epoch: held.epoch };
        }
        if (state === 'submitted') return { outcome: 'submitted' };
        return { outcome: 'missing' };
      });
    },

    async read(companyId, draftId, epoch) {
      const ref = draftRef(companyId, draftId);
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

    async markSubmitted(companyId, draftId, epoch, submissionId) {
      const ref = draftRef(companyId, draftId);
      return inTransaction<'marked' | 'missing' | 'conflict'>(async (tx) => {
        const draft = await tx.get(ref);
        if (!draft.exists) return 'missing';
        const data = draft.data();
        const held = fenceOf(data);
        if (!held || held.epoch !== epoch || held.submissionId !== submissionId) return 'conflict';
        if (data?.state === 'submitted') return 'marked';
        if (data?.state !== 'submitting') return 'conflict';
        tx.update(ref, { state: 'submitted' });
        return 'marked';
      });
    },

    async release(companyId, draftId, epoch) {
      const ref = draftRef(companyId, draftId);
      return inTransaction<'released' | 'not_fenced'>(async (tx) => {
        const draft = await tx.get(ref);
        const data = draft.data();
        if (!draft.exists || data?.state !== 'submitting' || fenceOf(data)?.epoch !== epoch) return 'not_fenced';
        tx.update(ref, { state: 'editing', fence: FieldValue.delete() });
        return 'released';
      });
    },

    async createFrom(companyId, draftId, fieldOwnerUid, manifest, previous) {
      const ref = draftRef(companyId, draftId);
      return inTransaction<'created' | 'exists'>(async (tx) => {
        if ((await tx.get(ref)).exists) return 'exists';
        tx.create(ref, {
          ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
          state: 'editing',
          field: manifest.draft ?? {},
          previous: { draftId: previous.draftId, submissionId: previous.submissionId },
        });
        for (const room of manifest.rooms) tx.create(ref.collection('rooms').doc(room.id), { field: room.field ?? {} });
        for (const photo of manifest.photos) tx.create(ref.collection('photos').doc(photo.id), { field: photo.field ?? {} });
        return 'created';
      });
    },
  };
}
