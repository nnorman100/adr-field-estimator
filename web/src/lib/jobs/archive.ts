import { and, desc, eq, sql } from 'drizzle-orm';
import { actors, agreements, jobs, jobSubmissions } from '@/db/schema';
import { holdAcrossOutsideCall, withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import type { FieldDoc } from '@/lib/field/canonical';
import { snapshotManifest } from '@/lib/submissions/snapshot';
import { canSeeJob, claimDraft, hasAny, holdDraft, jobAccess, JobError, lockedJob, type JobCaller, type JobRow } from './access';
import type { ArchiveStore } from './archive-store';
import type { DraftSync } from './draft-sync';
import { stillMember, syncJobDrafts } from './sync-job';
import { copiedManifest } from './copy-rule';
import { copyDigest, type ArchiveInput, type CopyInput } from './schema';
import { audit, CHECK_VIOLATION, detailOf, errorCode, type JobDetail, type JobView } from './service';

// Archive, restore and copy (S5b-2; docs/access/jobs.md). Archive files away an unsigned draft (a
// test or a duplicate): the job leaves every list but the owner's archived list, and every job route
// answers it with 410; nothing of it is deleted. Restore puts it back as it was. Copy starts a new
// draft from a signed job's scope. Each write is one Postgres transaction with one audit row (ids
// and revisions only); the field draft follows, once that transaction has ended, as the job is then
// (the job revision kept in the field database is the fence: an archive or restore that lands late
// never undoes a newer one). Any archive or restore the owner
// sends again repairs a field step that did not get through (503 `draft_unavailable` until then),
// even after the job changed since, when it is answered `archived` or `not_archived`.

// The owner archives and restores (docs/access/roles.md); every role copies a signed job.
const ARCHIVE: readonly Capability[] = ['jobs_archive'];
const COPY: readonly Capability[] = ['jobs_copy'];

// The copy rule (copy-rule.ts), shared with the draft sync.
export { COPY_CLEARED_KEYS, copiedManifest } from './copy-rule';

export type ArchiveService = {
  archive(caller: JobCaller, jobId: string, input: ArchiveInput): Promise<{ job: JobView }>;
  restore(caller: JobCaller, jobId: string, input: ArchiveInput): Promise<{ job: JobView }>;
  copy(caller: JobCaller, sourceJobId: string, input: CopyInput): Promise<{ created: boolean; detail: JobDetail }>;
};

function need(caller: JobCaller, keys: readonly Capability[]): void {
  if (!hasAny(caller, keys)) throw new JobError('not_allowed');
}

// A Submit of the job that is still deciding, or whose field marker is not written yet. Archive
// waits for it, so no fence, release or marker of a Submit ever meets an archived draft.
async function submissionUnsettled(tx: CompanyTransaction, row: JobRow): Promise<boolean> {
  const [found] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(
      and(
        eq(jobSubmissions.companyId, row.companyId),
        eq(jobSubmissions.jobId, row.id),
        // A pending row's marker is always pending too (0011, job_submissions_marker_check).
        eq(jobSubmissions.markerState, 'pending'),
      ),
    )
    .limit(1);
  return found !== undefined;
}

// What a restored job goes back to: `submitted` when its current draft has a committed submission
// (S5a-2 keeps no earlier status while a job is archived), else `draft`.
async function restoredStatus(tx: CompanyTransaction, row: JobRow): Promise<'draft' | 'submitted'> {
  const [latest] = await tx
    .select({ draftId: jobSubmissions.draftId })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, row.companyId), eq(jobSubmissions.jobId, row.id), eq(jobSubmissions.status, 'committed')))
    .orderBy(desc(jobSubmissions.createdAt))
    .limit(1);
  return latest?.draftId === row.currentDraftId ? 'submitted' : 'draft';
}

// The answers after which the job's field draft is still brought to its state: the job is already
// as asked, by this request or another.
const SETTLED = new Set(['archived', 'not_archived']);

function jobView(detail: JobDetail): { job: JobView } {
  return { job: detail.job };
}

// The same, from the signed record's snapshot bytes.
function copiedField(bytes: Buffer | Uint8Array): { draft: Record<string, unknown>; rooms: FieldDoc[] } {
  return copiedManifest(snapshotManifest(bytes));
}

export function archiveService(db: Database, store: ArchiveStore, sync: DraftSync): ArchiveService {
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) throw new JobError('invalid_request');
      throw error;
    }
  }

  // A field step: an error is "send the same request again", never a decision.
  async function field<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      // Fixed text only: the SDK's message may quote a path.
      console.error('job draft unavailable', error instanceof Error ? error.name : 'unknown');
      throw new JobError('draft_unavailable');
    }
  }

  async function ownerUid(tx: CompanyTransaction, row: JobRow): Promise<string | null> {
    if (!row.fieldOwnerActorId) return null;
    const [actor] = await tx
      .select({ uid: actors.uid })
      .from(actors)
      .where(and(eq(actors.companyId, row.companyId), eq(actors.id, row.fieldOwnerActorId)));
    return actor?.uid ?? null;
  }

  // Every draft of the job brought to the job's state as Postgres holds it now, at its field revision, in
  // one Firestore transaction (sync-job.ts): archived while the job is, else its status's state. A slower
  // archive or restore never lands after a newer change, whatever it is (the job's marker refuses it),
  // and no Postgres transaction waits on the field database.
  async function settle(companyId: string, jobId: string): Promise<void> {
    await syncJobDrafts(db, sync, store, companyId, jobId);
  }

  // The answer of an archive or restore, once the field draft is settled after it.
  async function settled(caller: JobCaller, jobId: string, decided: Promise<JobDetail>): Promise<{ job: JobView }> {
    const outcome = await decided.catch((error: unknown) => {
      if (error instanceof JobError && SETTLED.has(error.code)) return error;
      throw error;
    });
    await settle(caller.companyId, jobId);
    if (outcome instanceof JobError) throw outcome;
    // The job's details only to a caller still an active member of an active company with its role, read
    // again after the field step (a company suspended or a member disabled while it waited gets none).
    await withCompany(db, caller.companyId, (tx) => stillMember(tx, caller), { snapshot: true });
    return jobView(outcome);
  }

  return {
    async archive(caller, jobId, input) {
      need(caller, ARCHIVE);
      const decided = inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, ARCHIVE, { lock: true, archived: true });
        if (row.status === 'archived') {
          // The same archive again (its answer was lost): the same answer, and its field step again.
          if (row.lastChangeId === input.changeId) return detailOf(tx, row);
          throw new JobError('archived');
        }
        // A signed job is kept: it has no archive (docs/spec.md, "Archived drafts").
        if (row.status === 'signed') throw new JobError('job_signed');
        if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
        if (await submissionUnsettled(tx, row)) throw new JobError('submission_in_progress');
        const [next] = await tx
          .update(jobs)
          .set({
            status: 'archived',
            archivedAt: sql`now()`,
            archivedByActorId: caller.actorId,
            revision: sql`${jobs.revision} + 1`,
            lastChangeId: input.changeId,
            updatedAt: sql`now()`,
          })
          .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
          .returning();
        await audit(tx, caller, 'job_archived', row.id, { revision: next!.revision });
        return detailOf(tx, next!);
      });
      return settled(caller, jobId, decided);
    },

    async restore(caller, jobId, input) {
      need(caller, ARCHIVE);
      const decided = inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, ARCHIVE, { lock: true, archived: true });
        if (row.status !== 'archived') {
          // The same restore again: the same answer, and its field step again. Any later change to
          // the job carries another change id (or none), so this is only ever the restore's retry;
          // after one, it is answered `not_archived`, its field step still settled.
          if (row.lastChangeId === input.changeId) return detailOf(tx, row);
          throw new JobError('not_archived');
        }
        if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
        const [next] = await tx
          .update(jobs)
          .set({
            status: await restoredStatus(tx, row),
            archivedAt: null,
            archivedByActorId: null,
            revision: sql`${jobs.revision} + 1`,
            lastChangeId: input.changeId,
            updatedAt: sql`now()`,
          })
          .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
          .returning();
        await audit(tx, caller, 'job_restored', row.id, { revision: next!.revision });
        return detailOf(tx, next!);
      });
      return settled(caller, jobId, decided);
    },

    async copy(caller, sourceJobId, input) {
      need(caller, COPY);
      const digest = copyDigest(sourceJobId, input);
      const made = await inCompany(caller.companyId, async (tx) => {
        const source = await jobAccess(tx, caller, sourceJobId, COPY);
        if (source.status !== 'signed') throw new JobError('not_signed');
        // The signed record: the original agreement's submission snapshot, which never changes.
        const [signed] = await tx
          .select({ bytes: jobSubmissions.snapshotBytes })
          .from(agreements)
          .innerJoin(
            jobSubmissions,
            and(eq(jobSubmissions.companyId, agreements.companyId), eq(jobSubmissions.jobId, agreements.jobId), eq(jobSubmissions.id, agreements.submissionId)),
          )
          .where(and(eq(agreements.companyId, caller.companyId), eq(agreements.jobId, source.id), eq(agreements.kind, 'original')));
        if (!signed?.bytes) throw new JobError('not_signed');
        // The address as signed: the snapshot's, never the live job row's.
        const snapshot = JSON.parse(Buffer.from(signed.bytes).toString('utf8')) as { job?: { propertyAddress?: unknown } };
        const address = snapshot.job?.propertyAddress;
        if (typeof address !== 'string') throw new JobError('not_signed');
        // Whoever does field work owns the field work of the copy they start, as a new job.
        const owner = hasAny(caller, ['scope']) ? caller.actorId : null;
        const [inserted] = await tx
          .insert(jobs)
          .values({
            id: input.id,
            companyId: caller.companyId,
            createdByActorId: caller.actorId,
            fieldOwnerActorId: owner,
            currentDraftId: input.draftId,
            propertyAddress: address,
            requestDigest: digest,
            copiedFromJobId: source.id,
          })
          // The same id, or a draft id another job holds, makes no second row.
          .onConflictDoNothing()
          .returning();
        let row = inserted;
        if (!row) {
          const [existing] = await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, input.id)))
            .for('update');
          // A retry only when it is the same copy of the same job, by someone who may see the copy.
          if (!existing || existing.requestDigest !== digest || !canSeeJob(caller, existing)) throw new JobError('conflict');
          if (existing.status === 'archived') throw new JobError('archived');
          // A retry holds its draft id for the job in Postgres (security audit F1), in this transaction, which
          // commits before the field database is touched: a draft the previous version made is stamped only
          // once the claim is committed, so a lost answer from that stamp never leaves it unclaimed.
          if (!(await holdDraft(tx, caller.companyId, existing.id, input.draftId))) throw new JobError('conflict');
          // The same digest is the same source: a copy without it (made before 0018) gets it now.
          if (existing.copiedFromJobId === null) {
            await tx
              .update(jobs)
              .set({ copiedFromJobId: source.id })
              .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, existing.id)));
          }
          row = existing;
        } else {
          if (!(await claimDraft(tx, caller.companyId, row.id, input.draftId))) throw new JobError('conflict');
          // A draft id claimed now was never this job's: a draft already under it was made for another.
          await holdAcrossOutsideCall(tx);
          if (await field(() => store.findDraft(caller.companyId, input.draftId))) throw new JobError('conflict');
          await audit(tx, caller, 'job_copied', row.id, { revision: row.revision, copiedFrom: source.id });
        }
        return { created: inserted !== undefined, ownerUid: await ownerUid(tx, row), field: copiedField(signed.bytes), detail: await detailOf(tx, row) };
      });
      await inCompany(caller.companyId, async (tx) => {
        await lockedJob(tx, caller.companyId, input.id, { live: true });
        await holdAcrossOutsideCall(tx);
        const result = await field(() => store.createCopy(caller.companyId, input.id, input.draftId, made.ownerUid, made.field));
        // A draft made for another job is never the copy's (security audit F1).
        if (result === 'taken') throw new JobError('conflict');
        // Only an archived job's placeholder is there: no draft yet, so the same request again.
        if (result === 'archived') throw new JobError('draft_unavailable');
      });
      await field(() =>
        store.projectJob(caller.companyId, made.detail.job.id, { currentDraftId: made.detail.job.currentDraftId, revision: made.detail.job.revision }),
      );
      return { created: made.created, detail: made.detail };
    },
  };
}
