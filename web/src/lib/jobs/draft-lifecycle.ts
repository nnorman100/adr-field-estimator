import type { JobStatus } from '@/db/schema';
import type { FieldManifest } from '@/lib/field/canonical';
import type { Fence, Provenance } from '@/lib/submissions/fence';
import { COPY_CLEARED_KEYS } from './archive';
import { draftOfOtherJob } from './drafts';

// The draft life cycle as Postgres decides it (the draft life-cycle redesign, Design 2): one sync step
// will be the only writer of a Firestore draft's life-cycle keys. This file is its pure part, and
// nothing calls it yet (slice 2; later slices switch the writers to it):
//
// - desired(snapshot): what every draft of one job should hold, from one Postgres snapshot of the job
//   taken with its field revision (jobs.field_revision, migration 0018), the version the sync writes at;
// - planSync(marker, stored, desired, gen): what one sync transaction writes, given what Firestore holds
//   now. The job's marker document holds the version last written; a version that is not newer is
//   refused, so a sync that read Postgres before a later change can never land after that change's sync.
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

export type DesiredJob = { jobId: string; v: number; drafts: Record<string, DesiredDraft> };

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
  return { jobId: snapshot.jobId, v: snapshot.fieldRevision, drafts };
}

/** The drafts one sync left as they were, and why. A retry at the same version reports them again. */
export type SyncSkips = {
  // Drafts that name another job (security audit F1).
  conflicts: string[];
  // Missing drafts the sync has no content for (an earlier draft).
  missing: string[];
  // Drafts holding a newer legacy revision (archiveRevision or fieldOwnerRevision) than this
  // snapshot: an older writer changed them after Postgres was read, so a sync at a newer version
  // handles them.
  superseded: string[];
  // Drafts an earlier sync wrote that Postgres no longer gives the job (after a database restore):
  // closed to field access (archived, nobody named), their field work kept.
  unmatched: string[];
};

/** The sync's marker for a job: the version last written, the drafts written at it, and the skips. */
export type SyncMarker = { gen: number; v: number; draftIds: string[]; skipped: SyncSkips };

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');

/** A stored marker's fields, checked. Only a missing document is "no version applied". */
export function parseMarker(data: Record<string, unknown>): SyncMarker {
  const { gen, v, draftIds, skipped } = data;
  const skips = skipped as Record<string, unknown> | undefined;
  if (
    !Number.isInteger(gen) ||
    !Number.isInteger(v) ||
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

export type SyncPlan =
  // The marker holds this version already (a retry): nothing is written; the skips are reported again.
  | ({ outcome: 'same' } & SyncSkips)
  // The marker holds a newer version: nothing is written.
  | { outcome: 'stale'; stored: SyncMarker }
  | ({ outcome: 'synced'; marker: SyncMarker; creates: DraftCreate[]; updates: DraftUpdate[] } & SyncSkips);

/** Whether (gen, v) is newer than the stored marker, the same, or older. */
export function compareVersion(stored: SyncMarker | null, gen: number, v: number): 'newer' | 'same' | 'older' {
  if (!stored) return 'newer';
  if (gen !== stored.gen) return gen > stored.gen ? 'newer' : 'older';
  if (v === stored.v) return 'same';
  return v > stored.v ? 'newer' : 'older';
}

/** What the marker alone decides, before any draft is read: refused, a retry, or to be planned. */
export function versionRefusal(marker: SyncMarker | null, gen: number, v: number): Exclude<SyncPlan, { outcome: 'synced' }> | null {
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
      // A fresh map: the copy starts with what its source's record had, less COPY_CLEARED_KEYS.
      const field = { ...((content.manifest.draft ?? {}) as Record<string, unknown>) };
      for (const key of COPY_CLEARED_KEYS) delete field[key];
      return { field, rooms: content.manifest.rooms, photos: [] };
    }
  }
}

/**
 * What one sync transaction writes, from the marker and every draft the job has or an earlier sync
 * wrote. Nothing when the marker is not older than (gen, v); otherwise the marker, a missing current
 * draft made from its content, and on every other draft only the server keys that differ. A draft of
 * another job, or one holding a newer legacy revision (unless the generation changed, the reset an
 * operator makes after a database restore), is left as it is and reported. Pure: the Firestore store
 * and the database tests' stand-in both apply it.
 */
export function planSync(marker: SyncMarker | null, stored: Record<string, StoredDraft>, job: DesiredJob, gen: number): SyncPlan {
  const refused = versionRefusal(marker, gen, job.v);
  if (refused) return refused;
  const reset = marker !== null && gen > marker.gen;
  const creates: DraftCreate[] = [];
  const updates: DraftUpdate[] = [];
  const skips: SyncSkips = { conflicts: [], missing: [], superseded: [], unmatched: [] };
  const synced: string[] = [];
  for (const [draftId, want] of Object.entries(job.drafts)) {
    const found = stored[draftId] ?? null;
    // Another job's draft or placeholder is that job's, whatever this job wants of it.
    if (found && draftOfOtherJob(found.jobId, job.jobId)) {
      skips.conflicts.push(draftId);
      continue;
    }
    // Never lower a legacy revision an older writer set after Postgres was read.
    if (found && !reset && (revisionOf(found.archiveRevision) > want.archiveRevision || revisionOf(found.fieldOwnerRevision) > want.fieldOwnerRevision)) {
      skips.superseded.push(draftId);
      continue;
    }
    if (!found || found.placeholder) {
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
      synced.push(draftId);
      continue;
    }
    const update: DraftUpdate = { draftId, set: {}, remove: [] };
    // A draft made before `jobId` takes it (the job holds the draft id in Postgres, job_drafts).
    if (found.jobId === undefined) update.set.jobId = job.jobId;
    if (found.state !== want.state) update.set.state = want.state;
    if (want.fieldOwnerUid === null) {
      if (found.fieldOwnerUid !== undefined) update.remove.push('fieldOwnerUid');
    } else if (found.fieldOwnerUid !== want.fieldOwnerUid) update.set.fieldOwnerUid = want.fieldOwnerUid;
    if (want.fence === null) {
      if (found.fence !== null) update.remove.push('fence');
    } else if (want.fence !== undefined && !sameFence(found, want.fence)) update.set.fence = want.fence;
    if (found.archiveRevision !== want.archiveRevision) update.set.archiveRevision = want.archiveRevision;
    if (found.fieldOwnerRevision !== want.fieldOwnerRevision) update.set.fieldOwnerRevision = want.fieldOwnerRevision;
    if (Object.keys(update.set).length > 0 || update.remove.length > 0) updates.push(update);
    synced.push(draftId);
  }
  // Drafts an earlier sync wrote that this snapshot no longer gives the job: kept on the marker, and
  // closed to field access (archived, nobody named), never deleted. What becomes of their field work
  // is not the sync's to decide.
  for (const draftId of marker?.draftIds ?? []) {
    if (draftId in job.drafts) continue;
    skips.unmatched.push(draftId);
    const found = stored[draftId] ?? null;
    if (!found || found.placeholder || draftOfOtherJob(found.jobId, job.jobId)) continue;
    const update: DraftUpdate = { draftId, set: {}, remove: [] };
    if (found.state !== 'archived') update.set.state = 'archived';
    if (found.fieldOwnerUid !== undefined) update.remove.push('fieldOwnerUid');
    if (Object.keys(update.set).length > 0 || update.remove.length > 0) updates.push(update);
  }
  for (const list of Object.values(skips)) list.sort();
  return {
    outcome: 'synced',
    // The drafts this sync left as Postgres says, and the unmatched ones; the skips, so a retry at the
    // same version reports them again.
    marker: { gen, v: job.v, draftIds: [...synced, ...skips.unmatched].sort(), skipped: skips },
    creates,
    updates,
    ...skips,
  };
}
