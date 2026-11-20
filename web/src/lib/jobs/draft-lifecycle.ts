import type { JobStatus } from '@/db/schema';
import type { FieldManifest } from '@/lib/field/canonical';
import type { Fence, Provenance } from '@/lib/submissions/fence';
import { copiedManifest } from './archive';
import { draftOfOtherJob } from './drafts';

// The draft life cycle as Postgres decides it (the draft life-cycle redesign, Design 2): one sync step
// will be the only writer of a Firestore draft's life-cycle keys. This file is its pure part, and
// nothing calls it yet (slice 2; later slices switch the writers to it):
//
// - desired(snapshot): what every draft of one job should hold, from one Postgres snapshot of the job
//   taken with its field revision (jobs.field_revision, migration 0018), the version the sync writes at;
// - versionRefusal(marker, gen, v): the job's marker document holds the version last written; a version
//   that is not newer is refused before any draft is read, so a sync that read Postgres before a later
//   change can never land after that change's sync;
// - planSync(marker, stored, orphans, desired, gen): what one sync transaction writes, given what
//   Firestore holds now, once the version is known to be newer.
//
// The sync never touches a draft's field work (its `field` map, rooms and photos) once the draft
// exists; it writes the server's keys only, and makes a missing current draft from `content`.

/** How the job's current draft is made when it is missing. Never applied to a draft that exists. */
export type DraftContent =
  // A new job's first draft: empty field work.
  | { kind: 'empty' }
  // Back to editing: from the job's latest committed record, with where it came from.
  | { kind: 'next'; manifest: FieldManifest; previous: Provenance }
  // A copy: from its source's signed record; COPY_CLEARED_KEYS are cleared from it here.
  | { kind: 'copy'; manifest: Pick<FieldManifest, 'draft' | 'rooms'> };

/** One Postgres snapshot of a job, read in one statement with its field revision. */
export type JobDraftSnapshot = {
  jobId: string;
  status: JobStatus;
  currentDraftId: string;
  // The field owner's sign-in uid (actors.uid of jobs.field_owner_actor_id), or null when nobody owns
  // the field work.
  fieldOwnerUid: string | null;
  // jobs.field_revision: the version this snapshot is synced at.
  fieldRevision: number;
  // jobs.revision and job_coordination.revision (0 without a row): written as the legacy keys
  // `archiveRevision` and `fieldOwnerRevision` while older writers may still serve, so they lose
  // against the sync as they do against each other.
  revision: number;
  coordinationRevision: number;
  // Every draft id job_drafts gives the job; it must include the current one.
  draftIds: readonly string[];
  // The current draft's pending submission (status `pending`), and its committed one.
  pending: Fence | null;
  committed: Fence | null;
  // The epochs of the current draft's aborted submissions: fences Postgres knows were released.
  abortedEpochs: readonly string[];
  content: DraftContent;
};

export type DraftState = 'editing' | 'submitting' | 'submitted' | 'archived';

/** What one draft should hold. `fence` undefined leaves the stored fence as it is. */
export type DesiredDraft = {
  state: DraftState;
  fence?: Fence | null;
  fieldOwnerUid: string | null;
  archiveRevision: number;
  fieldOwnerRevision: number;
  // Only on the current draft: how to make it when it is missing.
  content?: DraftContent;
};

export type DesiredJob = {
  jobId: string;
  v: number;
  drafts: Record<string, DesiredDraft>;
  // The epochs of the submissions the snapshot knows for the current draft (its pending, committed and
  // aborted rows): a stored fence of any other epoch was closed by a writer Postgres had not told this
  // sync about.
  knownEpochs: string[];
};

/** A snapshot whose current draft job_drafts does not give the job: it is never synced. */
export class UnclaimedDraftError extends Error {
  constructor() {
    super('the current draft is not one job_drafts gives this job');
    this.name = 'UnclaimedDraftError';
  }
}

/** A marker document that is there but not in the shape the sync writes: the sync stops. */
export class MalformedMarkerError extends Error {
  constructor() {
    super('the job’s draft sync marker is not in the shape the sync writes');
    this.name = 'MalformedMarkerError';
  }
}

// The current draft's state, from the job's status and its current draft's submissions: a pending row
// fences it (`submitting`), keyed on the row's status, never on the clock.
function currentDraft(snapshot: JobDraftSnapshot): Pick<DesiredDraft, 'state' | 'fence'> {
  switch (snapshot.status) {
    case 'archived':
      return { state: 'archived', fence: snapshot.committed };
    case 'submitted':
    case 'signed':
      return { state: 'submitted', fence: snapshot.committed };
    case 'draft':
      return snapshot.pending ? { state: 'submitting', fence: snapshot.pending } : { state: 'editing', fence: null };
  }
}

/** What every draft of the job should hold, from one Postgres snapshot. Pure. */
export function desired(snapshot: JobDraftSnapshot): DesiredJob {
  // A draft id job_drafts does not give the job is never this job's (security audit F1): refused
  // before anything is planned, so a draft of another job is never stamped or opened to this owner.
  if (!snapshot.draftIds.includes(snapshot.currentDraftId)) throw new UnclaimedDraftError();
  const common = {
    fieldOwnerUid: snapshot.fieldOwnerUid,
    archiveRevision: snapshot.revision,
    fieldOwnerRevision: snapshot.coordinationRevision,
  };
  const drafts: Record<string, DesiredDraft> = {};
  // Every earlier draft is submitted (Back to editing moves on only from a submitted one); its own
  // fence stays as its Submit left it.
  for (const draftId of snapshot.draftIds) drafts[draftId] = { ...common, state: 'submitted' };
  drafts[snapshot.currentDraftId] = { ...common, ...currentDraft(snapshot), content: snapshot.content };
  const knownEpochs = [snapshot.pending?.epoch, snapshot.committed?.epoch, ...snapshot.abortedEpochs].filter((epoch): epoch is string => epoch !== undefined);
  return { jobId: snapshot.jobId, v: snapshot.fieldRevision, drafts, knownEpochs };
}

/** The drafts one sync left as they were, and why. A retry at the same version reports them again. */
export type SyncSkips = {
  // Drafts that name another job (security audit F1).
  conflicts: string[];
  // Missing drafts the sync has no content for (an earlier draft), or that it will not make because
  // rooms or photos are left under the id (never handed to a new owner): those are conflicts.
  missing: string[];
  // Drafts holding a newer legacy revision (archiveRevision or fieldOwnerRevision) than this
  // snapshot, or a fence of a Submit it does not know: an older writer changed them after Postgres was
  // read. The keys that change guards are left as they are (state, fence and archiveRevision; or the
  // owner and fieldOwnerRevision); every other key is written, and a sync at a newer version handles the rest.
  superseded: string[];
  // Drafts an earlier sync wrote that Postgres no longer gives the job (after a database restore):
  // closed to field access (archived, nobody named), their field work kept.
  unmatched: string[];
};

/** The sync's marker for a job: the version last written, every draft of the job it has seen, and the skips. */
export type SyncMarker = { gen: number; v: number; draftIds: string[]; skipped: SyncSkips };

// A draft id as the field rules accept one for a document (web/firestore.rules): no empty id, no path.
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string' && DRAFT_ID.test(id));

const version = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** A version a sync is asked to write at, checked before any read or write. */
export function assertVersion(gen: unknown, v: unknown): void {
  if (!version(gen) || !version(v)) throw new RangeError('a draft sync version is a non-negative integer generation and field revision');
}

/** A stored marker's fields, checked. Only a missing document is "no version applied". */
export function parseMarker(data: Record<string, unknown>): SyncMarker {
  const { gen, v, draftIds, skipped } = data;
  const skips = skipped as Record<string, unknown> | undefined;
  if (
    !version(gen) ||
    !version(v) ||
    !ids(draftIds) ||
    typeof skips !== 'object' ||
    skips === null ||
    !ids(skips.conflicts) ||
    !ids(skips.missing) ||
    !ids(skips.superseded) ||
    !ids(skips.unmatched)
  ) {
    throw new MalformedMarkerError();
  }
  return {
    gen: gen as number,
    v: v as number,
    draftIds: [...draftIds],
    skipped: { conflicts: [...skips.conflicts], missing: [...skips.missing], superseded: [...skips.superseded], unmatched: [...skips.unmatched] },
  };
}

/** A draft as Firestore holds it now, or null when there is none. */
export type StoredDraft = {
  // What an archive or restore left for a missing draft (src/lib/jobs/archive-store.ts): no draft.
  placeholder: boolean;
  jobId: unknown;
  state: unknown;
  // Whether a `fence` key is there at all, its epoch as stored (whatever else it holds), and the fence
  // it holds when it is one the sync can read.
  hasFence: boolean;
  fenceEpoch: unknown;
  fence: { submissionId: string; epoch: string; expiresAt: number } | null;
  fieldOwnerUid: unknown;
  archiveRevision: unknown;
  fieldOwnerRevision: unknown;
} | null;

export type DraftCreate = {
  draftId: string;
  // The draft document, less its nested rooms and photos.
  data: {
    jobId: string;
    fieldOwnerUid?: string;
    state: DraftState;
    fence?: Fence;
    field: unknown;
    previous?: Provenance;
    archiveRevision: number;
    fieldOwnerRevision: number;
  };
  rooms: FieldManifest['rooms'];
  photos: FieldManifest['photos'];
  // Over a placeholder (replaced whole), or where nothing is.
  replaces: boolean;
};

export type DraftUpdate = {
  draftId: string;
  set: Partial<{ jobId: string; fieldOwnerUid: string; state: DraftState; fence: Fence; archiveRevision: number; fieldOwnerRevision: number }>;
  remove: ('fieldOwnerUid' | 'fence')[];
};

/** What the marker alone decides: the marker holds this version already (a retry; the skips it recorded
 * are reported again), or a newer one. */
export type VersionRefusal = ({ outcome: 'same' } & SyncSkips) | { outcome: 'stale'; stored: SyncMarker };

export type SyncPlan = { outcome: 'synced'; marker: SyncMarker; creates: DraftCreate[]; updates: DraftUpdate[] } & SyncSkips;

/** Whether (gen, v) is newer than the stored marker, the same, or older. */
export function compareVersion(stored: SyncMarker | null, gen: number, v: number): 'newer' | 'same' | 'older' {
  if (!stored) return 'newer';
  if (gen !== stored.gen) return gen > stored.gen ? 'newer' : 'older';
  if (v === stored.v) return 'same';
  return v > stored.v ? 'newer' : 'older';
}

/** What the marker alone decides, before any draft is read: refused, a retry, or to be planned. */
export function versionRefusal(marker: SyncMarker | null, gen: number, v: number): VersionRefusal | null {
  const order = compareVersion(marker, gen, v);
  if (order === 'same') return { outcome: 'same', ...marker!.skipped };
  if (order === 'older') return { outcome: 'stale', stored: marker! };
  return null;
}

function sameFence(stored: StoredDraft & object, fence: Fence): boolean {
  const held = stored.fence;
  return held !== null && held.submissionId === fence.submissionId && held.epoch === fence.epoch && held.expiresAt === fence.expiresAt.getTime();
}

const revisionOf = (value: unknown) => (typeof value === 'number' ? value : 0);

function contentOf(content: DraftContent): { field: unknown; rooms: FieldManifest['rooms']; photos: FieldManifest['photos']; previous?: Provenance } {
  switch (content.kind) {
    case 'empty':
      return { field: {}, rooms: [], photos: [] };
    case 'next':
      return { field: content.manifest.draft ?? {}, rooms: content.manifest.rooms, photos: content.manifest.photos, previous: content.previous };
    case 'copy': {
      // As Copy makes it (archive.ts): a fresh map less COPY_CLEARED_KEYS, the rooms, no photos.
      const copied = copiedManifest(content.manifest);
      return { field: copied.draft, rooms: copied.rooms, photos: [] };
    }
  }
}

/**
 * What one sync transaction writes, once versionRefusal has found (gen, v) newer than the marker, from
 * the marker and every draft the job has or an earlier sync saw: the marker, a missing current draft
 * made from its content, and on every other draft only the server keys that differ. Another job's
 * draft is left as it is and reported. A newer legacy revision (unless the generation changed, the
 * reset an operator makes after a database restore) holds back only the keys it guards. `orphans`
 * are missing drafts with rooms or photos left under their id: never made. Pure: the Firestore store
 * and the database tests' stand-in both apply it.
 */
export function planSync(
  marker: SyncMarker | null,
  stored: Record<string, StoredDraft>,
  orphans: ReadonlySet<string>,
  job: DesiredJob,
  gen: number,
): SyncPlan {
  // A generation above the stored one (or above 0 on a job's first sync) is the operator's reset.
  const reset = gen > (marker?.gen ?? 0);
  const creates: DraftCreate[] = [];
  const updates: DraftUpdate[] = [];
  const skips: SyncSkips = { conflicts: [], missing: [], superseded: [], unmatched: [] };
  // Every draft of this job the sync has seen: kept on the marker (not another job's, not missing).
  const seen: string[] = [];
  for (const [draftId, want] of Object.entries(job.drafts)) {
    const found = stored[draftId] ?? null;
    // Another job's draft or placeholder is that job's, whatever this job wants of it.
    if (found && draftOfOtherJob(found.jobId, job.jobId)) {
      skips.conflicts.push(draftId);
      continue;
    }
    // Never lower a legacy revision an older writer set after Postgres was read, and never open or
    // re-fence a draft a Submit this snapshot does not know about has fenced (a writer that serves
    // during the rollout and guards its fence with no revision).
    const unknownFence =
      found !== null &&
      !found.placeholder &&
      want.fence !== undefined &&
      found.hasFence &&
      !(typeof found.fenceEpoch === 'string' && job.knownEpochs.includes(found.fenceEpoch));
    const holdState = found !== null && !reset && (revisionOf(found.archiveRevision) > want.archiveRevision || unknownFence);
    const holdOwner = found !== null && !reset && revisionOf(found.fieldOwnerRevision) > want.fieldOwnerRevision;
    if (!found || found.placeholder) {
      // Rooms or photos left under the id are never handed to an owner, whatever else holds.
      if (orphans.has(draftId)) {
        skips.conflicts.push(draftId);
        continue;
      }
      if (holdState) {
        // A newer archive or restore left this placeholder: not made over now.
        skips.superseded.push(draftId);
        seen.push(draftId);
        continue;
      }
      if (!want.content) {
        skips.missing.push(draftId);
        continue;
      }
      const made = contentOf(want.content);
      creates.push({
        draftId,
        data: {
          jobId: job.jobId,
          ...(want.fieldOwnerUid === null ? {} : { fieldOwnerUid: want.fieldOwnerUid }),
          state: want.state,
          ...(want.fence ? { fence: want.fence } : {}),
          field: made.field,
          ...(made.previous ? { previous: made.previous } : {}),
          archiveRevision: want.archiveRevision,
          fieldOwnerRevision: want.fieldOwnerRevision,
        },
        rooms: made.rooms,
        photos: made.photos,
        replaces: found !== null,
      });
      seen.push(draftId);
      continue;
    }
    const update: DraftUpdate = { draftId, set: {}, remove: [] };
    // A draft made before `jobId` takes it (the job holds the draft id in Postgres, job_drafts).
    if (found.jobId === undefined) update.set.jobId = job.jobId;
    if (!holdState) {
      if (found.state !== want.state) update.set.state = want.state;
      if (want.fence === null) {
        if (found.hasFence) update.remove.push('fence');
      } else if (want.fence !== undefined && !sameFence(found, want.fence)) update.set.fence = want.fence;
      if (found.archiveRevision !== want.archiveRevision) update.set.archiveRevision = want.archiveRevision;
    }
    if (!holdOwner) {
      if (want.fieldOwnerUid === null) {
        if (found.fieldOwnerUid !== undefined) update.remove.push('fieldOwnerUid');
      } else if (found.fieldOwnerUid !== want.fieldOwnerUid) update.set.fieldOwnerUid = want.fieldOwnerUid;
      if (found.fieldOwnerRevision !== want.fieldOwnerRevision) update.set.fieldOwnerRevision = want.fieldOwnerRevision;
    }
    if (holdState || holdOwner) skips.superseded.push(draftId);
    if (Object.keys(update.set).length > 0 || update.remove.length > 0) updates.push(update);
    seen.push(draftId);
  }
  // Drafts an earlier sync saw that this snapshot no longer gives the job: kept on the marker, and
  // closed to field access (archived, nobody named), never deleted. What becomes of their field work
  // is not the sync's to decide. Another job's draft there is a conflict, and leaves the marker.
  for (const draftId of marker?.draftIds ?? []) {
    if (draftId in job.drafts) continue;
    const found = stored[draftId] ?? null;
    if (found && draftOfOtherJob(found.jobId, job.jobId)) {
      skips.conflicts.push(draftId);
      continue;
    }
    skips.unmatched.push(draftId);
    seen.push(draftId);
    if (!found || found.placeholder) continue;
    const update: DraftUpdate = { draftId, set: {}, remove: [] };
    if (found.state !== 'archived') update.set.state = 'archived';
    if (found.fieldOwnerUid !== undefined) update.remove.push('fieldOwnerUid');
    if (Object.keys(update.set).length > 0 || update.remove.length > 0) updates.push(update);
  }
  // A draft the marker tracked stays on it while Postgres still gives it to the job, even when it is
  // missing now or another job's or leftover data sits under its id: a later restore must still find it.
  for (const draftId of marker?.draftIds ?? []) if (draftId in job.drafts && !seen.includes(draftId)) seen.push(draftId);
  for (const list of Object.values(skips)) list.sort();
  return {
    outcome: 'synced',
    // Every draft of this job the sync has seen; the skips, so a retry at the same version reports them again.
    marker: { gen, v: job.v, draftIds: seen.sort(), skipped: skips },
    creates,
    updates,
    ...skips,
  };
}
