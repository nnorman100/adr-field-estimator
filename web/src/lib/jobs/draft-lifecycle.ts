import type { FieldManifest } from '@/lib/field/canonical';
import { draftOfOtherJob } from './drafts';

// The draft life cycle as Postgres decides it (the draft life-cycle redesign, Design 2): one sync step
// will be the only writer of a Firestore draft's life-cycle keys. This file is its pure part, and
// nothing calls it yet (slice 2; later slices switch the writers to it):
//
// - desired(snapshot): what every draft of one job should hold, from one Postgres snapshot of the job
//   taken with its field revision (jobs.field_revision, migration 0018), the version the sync writes at;
// - planSync(stored, desired, gen): what one sync transaction writes, given what Firestore holds now.
//   It refuses a version that is not newer than the job's marker document, so a sync that read
//   Postgres before a later change can never land after the sync of that change.
//
// The sync never touches a draft's field work (its `field` map, rooms and photos) once the draft
// exists; it writes the server's keys only, and makes a missing current draft from `content`.

/** A submission's fence on a draft: `{ submissionId, epoch, expiresAt }` (src/lib/submissions/fence.ts). */
export type SyncFence = { submissionId: string; epoch: string; expiresAt: Date };

/** Where Back to editing made a draft from (src/lib/submissions/fence.ts). */
export type SyncProvenance = { draftId: string; submissionId: string };

/** How the job's current draft is made when it is missing. Never applied to a draft that exists. */
export type DraftContent =
  // A new job's first draft (or one whose content no record holds): empty field work.
  | { kind: 'empty' }
  // Back to editing: from the job's latest committed record, with where it came from.
  | { kind: 'next'; manifest: FieldManifest; previous: SyncProvenance }
  // A copy: from its source's signed record, less COPY_CLEARED_KEYS (src/lib/jobs/archive.ts).
  | { kind: 'copy'; manifest: Pick<FieldManifest, 'draft' | 'rooms'> };

export type JobStatus = 'draft' | 'submitted' | 'signed' | 'archived';

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
  // Every draft id job_drafts gives the job, the current one among them.
  draftIds: readonly string[];
  // The current draft's pending submission (status `pending`), and its committed one.
  pending: SyncFence | null;
  committed: SyncFence | null;
  content: DraftContent;
};

export type DraftState = 'editing' | 'submitting' | 'submitted' | 'archived';

/** What one draft should hold. `fence` undefined leaves the stored fence as it is. */
export type DesiredDraft = {
  state: DraftState;
  fence?: SyncFence | null;
  fieldOwnerUid: string | null;
  archiveRevision: number;
  fieldOwnerRevision: number;
  // Only on the current draft: how to make it when it is missing.
  content?: DraftContent;
};

export type DesiredJob = { jobId: string; v: number; drafts: Record<string, DesiredDraft> };

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
  const common = {
    fieldOwnerUid: snapshot.fieldOwnerUid,
    archiveRevision: snapshot.revision,
    fieldOwnerRevision: snapshot.coordinationRevision,
  };
  const drafts: Record<string, DesiredDraft> = {};
  // Every earlier draft is submitted (Back to editing moves on only from a submitted one); its own
  // fence stays as its Submit left it.
  for (const draftId of new Set([...snapshot.draftIds, snapshot.currentDraftId])) {
    drafts[draftId] = { ...common, state: 'submitted' };
  }
  drafts[snapshot.currentDraftId] = { ...common, ...currentDraft(snapshot), content: snapshot.content };
  return { jobId: snapshot.jobId, v: snapshot.fieldRevision, drafts };
}

/** The sync's marker for a job: the version last written to its drafts, and which drafts. */
export type SyncMarker = { gen: number; v: number; draftIds: string[] };

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
    fence?: SyncFence;
    field: unknown;
    previous?: SyncProvenance;
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
  set: Partial<{ jobId: string; fieldOwnerUid: string; state: DraftState; fence: SyncFence; archiveRevision: number; fieldOwnerRevision: number }>;
  remove: ('fieldOwnerUid' | 'fence')[];
};

export type SyncPlan =
  // The marker holds this version already (a retry): nothing is written.
  | { outcome: 'same' }
  // The marker holds a newer version: nothing is written.
  | { outcome: 'stale'; stored: SyncMarker }
  | {
      outcome: 'synced';
      marker: SyncMarker;
      creates: DraftCreate[];
      updates: DraftUpdate[];
      // Drafts that name another job (security audit F1): left as they are.
      conflicts: string[];
      // Missing drafts the sync has no content for (an earlier draft): left missing.
      missing: string[];
    };

/** Whether (gen, v) is newer than the stored marker, the same, or older. */
export function compareVersion(stored: SyncMarker | null, gen: number, v: number): 'newer' | 'same' | 'older' {
  if (!stored) return 'newer';
  if (gen !== stored.gen) return gen > stored.gen ? 'newer' : 'older';
  if (v === stored.v) return 'same';
  return v > stored.v ? 'newer' : 'older';
}

function sameFence(stored: StoredDraft & object, fence: SyncFence): boolean {
  const held = stored.fence;
  return held !== null && held.submissionId === fence.submissionId && held.epoch === fence.epoch && held.expiresAt === fence.expiresAt.getTime();
}

function contentOf(content: DraftContent): { field: unknown; rooms: FieldManifest['rooms']; photos: FieldManifest['photos']; previous?: SyncProvenance } {
  switch (content.kind) {
    case 'empty':
      return { field: {}, rooms: [], photos: [] };
    case 'next':
      return { field: content.manifest.draft ?? {}, rooms: content.manifest.rooms, photos: content.manifest.photos, previous: content.previous };
    case 'copy':
      return { field: content.manifest.draft ?? {}, rooms: content.manifest.rooms, photos: [] };
  }
}

/**
 * What one sync transaction writes: nothing when the marker is not older than (gen, v); otherwise the
 * marker, a missing current draft made from its content, and on every other draft of the job only the
 * server keys that differ. Pure: the Firestore store and the database tests' stand-in both apply it.
 */
export function planSync(marker: SyncMarker | null, stored: Record<string, StoredDraft>, job: DesiredJob, gen: number): SyncPlan {
  const order = compareVersion(marker, gen, job.v);
  if (order === 'same') return { outcome: 'same' };
  if (order === 'older') return { outcome: 'stale', stored: marker! };
  const creates: DraftCreate[] = [];
  const updates: DraftUpdate[] = [];
  const conflicts: string[] = [];
  const missing: string[] = [];
  for (const [draftId, want] of Object.entries(job.drafts)) {
    const found = stored[draftId] ?? null;
    if (!found || found.placeholder) {
      if (!want.content) {
        missing.push(draftId);
        continue;
      }
      // A placeholder of another job is that job's record, not this draft's to replace.
      if (found && draftOfOtherJob(found.jobId, job.jobId)) {
        conflicts.push(draftId);
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
      continue;
    }
    if (draftOfOtherJob(found.jobId, job.jobId)) {
      conflicts.push(draftId);
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
  }
  return {
    outcome: 'synced',
    marker: { gen, v: job.v, draftIds: Object.keys(job.drafts).sort() },
    creates,
    updates,
    conflicts: conflicts.sort(),
    missing: missing.sort(),
  };
}
