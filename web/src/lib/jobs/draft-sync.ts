import { FieldValue, Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';
import { planSync, type DesiredJob, type SyncFence, type SyncMarker, type SyncPlan, type StoredDraft } from './draft-lifecycle';
import { placeholderOf } from './drafts';

// The sync's Firestore writer (the draft life-cycle redesign, Design 2): in one transaction it reads
// the job's marker and every one of its drafts, then writes what planSync (draft-lifecycle.ts) says.
// Nothing calls it yet (slice 2); later slices switch archive, restore, Start, Move, Submit, Back to
// editing, New job and Copy to it.
//
// The marker is one server-only document per job, `companies/{c}/draftLifecycle/{jobId}` =
// `{ gen, v, draftIds }`. web/firestore.rules has no match for that collection, so every client read
// and write of it is refused by default (tests/emu/draft-sync.test.ts). The version lives beside the
// drafts, not on them, so a missing draft needs no placeholder to hold it, and a stale sync is refused
// at the marker before it makes or changes any draft.
//
// Firestore limits (firebase.google.com/docs/firestore/quotas, "Writes and transactions"): a
// transaction has no document-count cap; its request is at most 10 MiB, it has 270 seconds and a
// 60-second idle limit, and locks expire after 20 seconds. The largest sync makes one Back to editing
// draft with up to MAX_ROOMS rooms and MAX_PHOTO_REFS photo references, plus the marker and one
// update per earlier draft; tests/emu/draft-sync.test.ts makes one at those caps. The plan is worked
// out before the transaction's writes and from what it read, so a retried transaction function reads
// again and plans again; it never re-reads Postgres.

export type SyncResult =
  | { outcome: 'synced'; created: string[]; changed: string[]; conflicts: string[]; missing: string[] }
  | { outcome: 'same' }
  | { outcome: 'stale'; stored: SyncMarker };

export type DraftSync = {
  // Writes the job's desired drafts at version (gen, desired.v) unless its marker holds that version
  // or a newer one. `gen` is raised by an operator after a database restore lowers field revisions.
  sync(companyId: string, desired: DesiredJob, gen?: number): Promise<SyncResult>;
};

/** The result a plan reports once applied. */
export function resultOf(plan: SyncPlan): SyncResult {
  if (plan.outcome !== 'synced') return plan;
  return {
    outcome: 'synced',
    created: plan.creates.map((made) => made.draftId).sort(),
    changed: plan.updates.map((update) => update.draftId).sort(),
    conflicts: plan.conflicts,
    missing: plan.missing,
  };
}

function markerOf(found: DocumentSnapshot): SyncMarker | null {
  if (!found.exists) return null;
  const gen: unknown = found.get('gen');
  const v: unknown = found.get('v');
  const ids: unknown = found.get('draftIds');
  // A marker this writer did not leave is treated as the oldest version.
  if (typeof gen !== 'number' || typeof v !== 'number') return null;
  return { gen, v, draftIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [] };
}

/** A Firestore draft as planSync reads it. */
export function storedOf(found: DocumentSnapshot): StoredDraft {
  if (!found.exists) return null;
  const fence = found.get('fence') as Record<string, unknown> | undefined;
  const expiresAt = fence?.expiresAt;
  return {
    placeholder: placeholderOf(found) !== null,
    jobId: found.get('jobId'),
    state: found.get('state'),
    fence:
      fence && typeof fence.submissionId === 'string' && typeof fence.epoch === 'string' && expiresAt instanceof Timestamp
        ? { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: expiresAt.toMillis() }
        : null,
    fieldOwnerUid: found.get('fieldOwnerUid'),
    archiveRevision: found.get('archiveRevision'),
    fieldOwnerRevision: found.get('fieldOwnerRevision'),
  };
}

const stored = (fence: SyncFence) => ({ submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: Timestamp.fromDate(fence.expiresAt) });

export function firestoreDraftSync(db: Firestore): DraftSync {
  const company = (companyId: string) => db.collection('companies').doc(companyId);
  return {
    async sync(companyId, job, gen = 0) {
      const markerRef = company(companyId).collection('draftLifecycle').doc(job.jobId);
      const refs = Object.keys(job.drafts).map((draftId) => company(companyId).collection('drafts').doc(draftId));
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<SyncResult> => {
          // Reads first (a transaction reads before it writes): the marker, then every draft at once.
          const marker = markerOf(await tx.get(markerRef));
          const found = refs.length > 0 ? await tx.getAll(...refs) : [];
          const plan = planSync(marker, Object.fromEntries(found.map((doc) => [doc.id, storedOf(doc)])), job, gen);
          if (plan.outcome !== 'synced') return plan;
          for (const made of plan.creates) {
            const ref = company(companyId).collection('drafts').doc(made.draftId);
            const data = { ...made.data, ...(made.data.fence ? { fence: stored(made.data.fence) } : {}) };
            // A placeholder is replaced whole; where nothing is, the draft is created.
            if (made.replaces) tx.set(ref, data);
            else tx.create(ref, data);
            for (const room of made.rooms) tx.create(ref.collection('rooms').doc(room.id), { field: room.field ?? {} });
            for (const photo of made.photos) tx.create(ref.collection('photos').doc(photo.id), { field: photo.field ?? {} });
          }
          for (const update of plan.updates) {
            const ref = company(companyId).collection('drafts').doc(update.draftId);
            const change: Record<string, unknown> = { ...update.set, ...(update.set.fence ? { fence: stored(update.set.fence) } : {}) };
            for (const key of update.remove) change[key] = FieldValue.delete();
            tx.update(ref, change);
          }
          tx.set(markerRef, plan.marker);
          return resultOf(plan);
        }),
      );
    },
  };
}
