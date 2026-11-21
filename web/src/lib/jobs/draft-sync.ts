import { FieldValue, Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';
import type { Fence } from '@/lib/submissions/fence';
import { assertVersion, parseGeneration, parseMarker, planSync, versionRefusal, type DesiredJob, type StoredDraft, type SyncMarker, type SyncPlan, type SyncSkips } from './draft-lifecycle';
import { placeholderOf } from './drafts';

// The sync's Firestore writer (the draft life-cycle redesign, Design 2): in one transaction it reads
// the job's marker and every one of its drafts, then writes what planSync (draft-lifecycle.ts) says.
// Nothing calls it yet (slice 2); later slices switch archive, restore, Start, Move, Submit, Back to
// editing, New job and Copy to it.
//
// The marker is one server-only document per job, `companies/{c}/draftLifecycle/{jobId}` =
// `{ gen, v, draftIds, skipped }`: the version last written, the drafts that hold it (and the
// unmatched ones an earlier sync wrote), and what that sync skipped. web/firestore.rules has no match for that collection, so every client read
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
  | ({ outcome: 'synced'; created: string[]; changed: string[] } & SyncSkips)
  // A retry at the version the marker holds: nothing is written, and what that sync skipped is reported again.
  | ({ outcome: 'same' } & SyncSkips)
  | { outcome: 'stale' }
  // Postgres moved on after the snapshot was read (stillCurrent said so): nothing is written, and the
  // caller syncs again at the newer version.
  | { outcome: 'moved' };

/** Asked inside the transaction, after its reads and before its writes: whether the snapshot is still Postgres's latest. */
export type SyncOptions = { stillCurrent?: () => Promise<boolean> };

/** The operator's generation (one server-only document for the whole field database, raised by
 * scripts/raise-draft-sync-generation.ts after a Postgres restore lowers field revisions). */
export const GENERATION_PATH = 'draftSyncGeneration/current';

export type DraftSync = {
  // Writes the job's desired drafts at version (gen, desired.v) unless its marker holds that version
  // or a newer one. The generation written is the higher of `gen` and the operator's stored one
  // (GENERATION_PATH), read inside the same transaction, so a raise and a sync never interleave: after
  // a raise, every job's next sync is the reset that writes over what a restore left behind.
  // Throws, before any read or write, when gen or desired.v is not a non-negative integer, and before
  // any change when the marker or the generation document is there but not in its shape
  // (MalformedMarkerError, MalformedGenerationError).
  sync(companyId: string, desired: DesiredJob, gen: number, options?: SyncOptions): Promise<SyncResult>;
  // Reads the operator's generation and the job's marker and checks their shape, writing nothing: the
  // field step calls it before any Postgres write of its own (a claim, a raised field revision), so a
  // document not in its shape stops it before it changes anything. Throws MalformedGenerationError or
  // MalformedMarkerError; the sync's own transaction checks them again.
  checkControls(companyId: string, jobId: string): Promise<void>;
};

/** The result a plan reports once applied. */
export function resultOf(plan: SyncPlan): SyncResult {
  return {
    outcome: 'synced',
    created: plan.creates.map((made) => made.draftId).sort(),
    changed: plan.updates.map((update) => update.draftId).sort(),
    conflicts: plan.conflicts,
    missing: plan.missing,
    superseded: plan.superseded,
    unmatched: plan.unmatched,
  };
}

function markerOf(found: DocumentSnapshot): SyncMarker | null {
  return found.exists ? parseMarker(found.data()!) : null;
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
    hasFence: fence !== undefined,
    fenceEpoch: fence?.epoch,
    fence:
      fence && typeof fence.submissionId === 'string' && typeof fence.epoch === 'string' && expiresAt instanceof Timestamp
        ? { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: expiresAt.toMillis() }
        : null,
    fieldOwnerUid: found.get('fieldOwnerUid'),
    archiveRevision: found.get('archiveRevision'),
    fieldOwnerRevision: found.get('fieldOwnerRevision'),
  };
}

const stored = (fence: Fence) => ({ submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: Timestamp.fromDate(fence.expiresAt) });

/** The drafts a sync would make (missing, or a placeholder, with content to make them from). */
export function draftsToMake(stored: Record<string, StoredDraft>, job: DesiredJob): string[] {
  return Object.entries(job.drafts)
    .filter(([draftId, want]) => want.content !== undefined && (stored[draftId] === null || stored[draftId] === undefined || stored[draftId]!.placeholder))
    .map(([draftId]) => draftId);
}

/** Every draft one sync reads: the job's desired drafts and the ones its marker lists. */
export function draftIdsToRead(marker: SyncMarker | null, job: DesiredJob): string[] {
  return [...new Set([...Object.keys(job.drafts), ...(marker?.draftIds ?? [])])].sort();
}

export function firestoreDraftSync(db: Firestore): DraftSync {
  const company = (companyId: string) => db.collection('companies').doc(companyId);
  return {
    async checkControls(companyId, jobId) {
      const [generation, marker] = await firestoreSpan('get', 'draftLifecycle', () =>
        db.getAll(db.doc(GENERATION_PATH), company(companyId).collection('draftLifecycle').doc(jobId)),
      );
      parseGeneration(generation!.data());
      markerOf(marker!);
    },
    async sync(companyId, job, gen, options = {}) {
      assertVersion(gen, job.v);
      const markerRef = company(companyId).collection('draftLifecycle').doc(job.jobId);
      const draftRef = (draftId: string) => company(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<SyncResult> => {
          // The operator's generation and the marker first: a stale sync or a retry has its answer before
          // any draft is read.
          const generation = Math.max(gen, parseGeneration((await tx.get(db.doc(GENERATION_PATH))).data()));
          const marker = markerOf(await tx.get(markerRef));
          const refused = versionRefusal(marker, generation, job.v, job.revision);
          if (refused) return refused;
          // Then every draft at once (a transaction reads before it writes).
          const refs = draftIdsToRead(marker, job).map(draftRef);
          const found = refs.length > 0 ? await tx.getAll(...refs) : [];
          const current = Object.fromEntries(found.map((doc) => [doc.id, storedOf(doc)]));
          // Rooms or photos left under a draft it would make are never handed to a new owner: one read
          // of each collection per draft to make, still before any write.
          const orphans = new Set<string>();
          for (const draftId of draftsToMake(current, job)) {
            for (const name of ['rooms', 'photos']) {
              if (!(await tx.get(draftRef(draftId).collection(name).limit(1))).empty) orphans.add(draftId);
            }
          }
          const plan = planSync(marker, current, orphans, job, generation);
          // One read of Postgres's version, recomputing nothing: a snapshot older than Postgres writes
          // nothing, so no draft is ever handed to an owner Postgres has since replaced.
          if (options.stillCurrent && !(await options.stillCurrent())) return { outcome: 'moved' };
          for (const made of plan.creates) {
            const ref = draftRef(made.draftId);
            const data = { ...made.data, ...(made.data.fence ? { fence: stored(made.data.fence) } : {}) };
            // A placeholder is replaced whole; where nothing is, the draft is created.
            if (made.replaces) tx.set(ref, data);
            else tx.create(ref, data);
            for (const room of made.rooms) tx.create(ref.collection('rooms').doc(room.id), { field: room.field ?? {} });
            for (const photo of made.photos) tx.create(ref.collection('photos').doc(photo.id), { field: photo.field ?? {} });
          }
          for (const update of plan.updates) {
            const change: Record<string, unknown> = { ...update.set, ...(update.set.fence ? { fence: stored(update.set.fence) } : {}) };
            for (const key of update.remove) change[key] = FieldValue.delete();
            tx.update(draftRef(update.draftId), change);
          }
          tx.set(markerRef, plan.marker);
          return resultOf(plan);
        }),
      );
    },
  };
}
