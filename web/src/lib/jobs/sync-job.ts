import { and, desc, eq, lt } from 'drizzle-orm';
import { actors, agreements, jobCoordination, jobDrafts, jobs, jobSubmissions } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { holdDraft, JobError, lockedJob, type JobRow } from './access';
import { confirmationPredatesReprice } from '@/lib/estimates/service';
import type { Fence } from '@/lib/submissions/fence';
import { snapshotManifest } from '@/lib/submissions/snapshot';
import { desired, UnclaimedDraftError, type DraftContent, type JobDraftSnapshot } from './draft-lifecycle';
import type { DraftSync, SyncResult } from './draft-sync';

// The draft life-cycle sync of one job (the draft life-cycle redesign, Design 2): read what Postgres
// holds for the job in one snapshot with its field revision (jobs.field_revision, migration 0018),
// write every one of its drafts at that version (draft-sync.ts), then record the version as synced
// (jobs.field_synced_revision, only ever raised). Archive, Restore, Start field work and Move call it
// after their Postgres commit (slice 3); no Postgres transaction is held across the Firestore call.

// The job's drafts: each draft it has been on, then its current draft last, every one of them the job's
// in job_drafts (0016) before the field database is touched (Start field work and Move in their own
// transaction, office.ts; every sync in a short one first, syncJob below), so a draft another job claimed is never
// among them (security audit F1). The drafts of the job's own submissions that no job has claimed (the
// previous version, still serving while a release migrates, submits drafts without claiming them) are
// claimed for the job here first, in Postgres, and so is a current draft no job has claimed; a
// submitted draft another job claimed is left out, and a current draft another job claimed is refused
// (409), so the field work of another job's draft is never handed on. Every one of them names the job's
// field owner, so a person who no longer owns the field work reads none of them (web/firestore.rules).
// The draft sync (draft-sync.ts) writes all of them in one transaction, and stamps the job id on a draft
// made before `jobId` only because the job holds it here.
export async function claimJobDrafts(tx: CompanyTransaction, row: JobRow): Promise<string[]> {
  const claimed = await tx
    .select({ draftId: jobDrafts.draftId })
    .from(jobDrafts)
    .where(and(eq(jobDrafts.companyId, row.companyId), eq(jobDrafts.jobId, row.id)));
  const submitted = await tx
    .selectDistinct({ draftId: jobSubmissions.draftId })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, row.companyId), eq(jobSubmissions.jobId, row.id)));
  const held = new Set(claimed.map((one) => one.draftId));
  for (const { draftId } of submitted) {
    if (!held.has(draftId) && (await holdDraft(tx, row.companyId, row.id, draftId))) held.add(draftId);
  }
  if (!held.has(row.currentDraftId) && !(await holdDraft(tx, row.companyId, row.id, row.currentDraftId))) {
    throw new JobError('conflict');
  }
  return [...[...held].filter((id) => id !== row.currentDraftId), row.currentDraftId];
}

const fenceOf = (row: { id: string; epoch: string; expiresAt: Date }): Fence => ({ submissionId: row.id, epoch: row.epoch, expiresAt: row.expiresAt });

// How the job's current draft is made when the field database does not hold it. Back to editing: from
// the job's latest committed record of an earlier draft, with where it came from, less the scope
// confirmation after an owner reprice (as submissions/service.ts backToEditing makes it). A copy that
// never submitted: from its source's signed record (as archive.ts copy makes it). Otherwise empty.
async function contentOf(tx: CompanyTransaction, companyId: string, job: { id: string; currentDraftId: string; copiedFromJobId: string | null }): Promise<DraftContent> {
  const [latest] = await tx
    .select({ id: jobSubmissions.id, draftId: jobSubmissions.draftId, snapshotBytes: jobSubmissions.snapshotBytes })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.jobId, job.id), eq(jobSubmissions.status, 'committed')))
    .orderBy(desc(jobSubmissions.createdAt))
    .limit(1);
  if (latest?.snapshotBytes && latest.draftId !== job.currentDraftId) {
    const manifest = snapshotManifest(latest.snapshotBytes);
    if (await confirmationPredatesReprice(tx, companyId, job.id, latest.draftId)) {
      manifest.draft = Object.fromEntries(Object.entries((manifest.draft ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'scopeConfirmed'));
    }
    return { kind: 'next', manifest, previous: { draftId: latest.draftId, submissionId: latest.id } };
  }
  if (job.copiedFromJobId !== null && !latest) {
    const [signed] = await tx
      .select({ bytes: jobSubmissions.snapshotBytes })
      .from(agreements)
      .innerJoin(
        jobSubmissions,
        and(eq(jobSubmissions.companyId, agreements.companyId), eq(jobSubmissions.jobId, agreements.jobId), eq(jobSubmissions.id, agreements.submissionId)),
      )
      .where(and(eq(agreements.companyId, companyId), eq(agreements.jobId, job.copiedFromJobId), eq(agreements.kind, 'original')));
    if (signed?.bytes) {
      const manifest = snapshotManifest(signed.bytes);
      return { kind: 'copy', manifest: { draft: manifest.draft, rooms: manifest.rooms } };
    }
  }
  return { kind: 'empty' };
}

/** What Postgres holds for the job's drafts, in one read-only snapshot. Null when there is no such job. */
export async function readJobDraftSnapshot(db: Database, companyId: string, jobId: string): Promise<JobDraftSnapshot | null> {
  return withCompany(
    db,
    companyId,
    async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
      if (!job) return null;
      const [owner] = job.fieldOwnerActorId
        ? await tx
            .select({ uid: actors.uid })
            .from(actors)
            .where(and(eq(actors.companyId, companyId), eq(actors.id, job.fieldOwnerActorId)))
        : [];
      const [coordination] = await tx
        .select({ revision: jobCoordination.revision })
        .from(jobCoordination)
        .where(and(eq(jobCoordination.companyId, companyId), eq(jobCoordination.jobId, jobId)));
      const claimed = await tx
        .select({ draftId: jobDrafts.draftId })
        .from(jobDrafts)
        .where(and(eq(jobDrafts.companyId, companyId), eq(jobDrafts.jobId, jobId)));
      const submissions = await tx
        .select({ id: jobSubmissions.id, epoch: jobSubmissions.epoch, expiresAt: jobSubmissions.expiresAt, status: jobSubmissions.status })
        .from(jobSubmissions)
        .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.jobId, jobId), eq(jobSubmissions.draftId, job.currentDraftId)))
        .orderBy(desc(jobSubmissions.createdAt));
      const pending = submissions.find((row) => row.status === 'pending');
      const committed = submissions.find((row) => row.status === 'committed');
      return {
        jobId,
        status: job.status,
        currentDraftId: job.currentDraftId,
        fieldOwnerUid: owner?.uid ?? null,
        fieldRevision: job.fieldRevision,
        revision: job.revision,
        coordinationRevision: coordination?.revision ?? 0,
        draftIds: claimed.map((row) => row.draftId).sort(),
        pending: pending ? fenceOf(pending) : null,
        committed: committed ? fenceOf(committed) : null,
        abortedEpochs: submissions.filter((row) => row.status === 'aborted').map((row) => row.epoch),
        content: await contentOf(tx, companyId, job),
      };
    },
    { snapshot: true },
  );
}

/**
 * Syncs every draft of the job to what Postgres holds now, then records the version as synced, unless a
 * draft is to be written again (one held back by a newer legacy write, or a current draft it could not
 * make), so the repair pass syncs the job again. Null when there is no such job. Throws
 * UnclaimedDraftError (draft-lifecycle.ts) when job_drafts does not give the job its current draft, and
 * whatever the field database throws.
 */
// How many times one call syncs again when Postgres moved on while it was syncing.
const CATCH_UP = 3;

export async function syncJob(db: Database, store: DraftSync, companyId: string, jobId: string, round = 0): Promise<{ result: SyncResult; currentDraftId: string } | null> {
  const snapshot = await readJobDraftSnapshot(db, companyId, jobId);
  if (!snapshot) return null;
  const result = await store.sync(companyId, desired(snapshot), 0);
  // Postgres moved on while this sync ran (a later change whose own sync has not landed, or failed):
  // what this one wrote may be older than Postgres, so the job is synced again at once, at its newer
  // version, rather than left to that change's retry or the repair pass.
  if (round < CATCH_UP) {
    const [now] = await withCompany(db, companyId, (tx) =>
      tx
        .select({ fieldRevision: jobs.fieldRevision })
        .from(jobs)
        .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId))),
    );
    if (now && now.fieldRevision > snapshot.fieldRevision) return syncJob(db, store, companyId, jobId, round + 1);
  }
  const synced = { result, currentDraftId: snapshot.currentDraftId };
  if (result.outcome === 'stale' || result.superseded.length > 0 || result.missing.includes(snapshot.currentDraftId)) return synced;
  // The watermark: only ever raised, and only by the version this sync wrote or found written.
  await withCompany(db, companyId, (tx) =>
    tx
      .update(jobs)
      .set({ fieldSyncedRevision: snapshot.fieldRevision })
      .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId), lt(jobs.fieldSyncedRevision, snapshot.fieldRevision))),
  );
  return synced;
}

/**
 * The field step of a job route, after its Postgres commit: the job's drafts are claimed for it (a short
 * transaction of its own), then synced. Answers nothing when the drafts hold Postgres's state, or a newer
 * write holds part of it back (that write's own sync, or the repair pass, finishes it); 409 `conflict`
 * when the job's current draft is another job's (or rooms or photos are left under its id, which no owner
 * is handed); and 503 `draft_unavailable`, the same request again, when the field database cannot be
 * reached or the current draft could not be made. `conflictOk` leaves a current draft of another job
 * unanswered (archive and restore, whose answer is Postgres's alone).
 */
export async function syncJobDrafts(db: Database, store: DraftSync, companyId: string, jobId: string, options: { conflictOk?: boolean } = {}): Promise<void> {
  const claimed = await withCompany(db, companyId, async (tx) => {
    const row = await lockedJob(tx, companyId, jobId);
    try {
      await claimJobDrafts(tx, row);
      return true;
    } catch (error) {
      // A current draft another job holds in Postgres: the sync would refuse it; nothing is the job's to write.
      if (error instanceof JobError && error.code === 'conflict') return false;
      throw error;
    }
  });
  if (!claimed) {
    if (options.conflictOk) return;
    throw new JobError('conflict');
  }
  let synced: Awaited<ReturnType<typeof syncJob>>;
  try {
    synced = await syncJob(db, store, companyId, jobId);
  } catch (error) {
    if (error instanceof UnclaimedDraftError) throw new JobError('conflict');
    // Fixed text only: the SDK's message may quote a path.
    console.error('job draft sync unavailable', error instanceof Error ? error.name : 'unknown');
    throw new JobError('draft_unavailable');
  }
  if (!synced) throw new JobError('not_found');
  const { result, currentDraftId: current } = synced;
  // A newer version is already written: that sync answered for the current state.
  if (result.outcome === 'stale') return;
  // A retry at the same version reports what that sync skipped, so it answers the same.
  if (result.conflicts.includes(current) && !options.conflictOk) throw new JobError('conflict');
  // A current draft it could not make: the same request again. One a newer write held back in part is
  // no failure of this request: that newer change, or the repair pass, writes the rest (the version is
  // not recorded as synced, syncJob).
  if (result.missing.includes(current)) throw new JobError('draft_unavailable');
}
