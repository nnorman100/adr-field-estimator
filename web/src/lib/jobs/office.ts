import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { actors, jobAssignments, jobCoordination, jobDrafts, jobs, jobSubmissions, memberships } from '@/db/schema';
import { holdAcrossOutsideCall, withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import type { FenceStore } from '@/lib/submissions/fence';
import { snapshotManifest } from '@/lib/submissions/snapshot';
import { hasAny, holdDraft, jobAccess, JobError, type JobCaller, type JobRow } from './access';
import type { ArchiveStore } from './archive-store';
import { draftOfOtherJob, type DraftStore } from './drafts';
import { assignDigest, type AssignInput, type CoordinationInput, type TransferInput } from './schema';
import { audit, CHECK_VIOLATION, detailOf, errorCode, findDraft, type JobDetail } from './service';

// Office jobs, assignment and the field owner (S5b-1, docs/plans/S5.md; docs/spec.md 6.2). Every
// function runs inside withCompany for the company of the verified sign-in and goes through the one
// job-access function; every write adds one audit row (ids and revisions only) in its transaction.
//
// Who owns what (docs/spec.md 6.2): the job's field owner writes the field work; office and the
// owner keep the coordination (office notes) and the assignment; the owner alone moves the field work
// (owner decision J5). Postgres decides who the field owner is (jobs.field_owner_actor_id); the
// Firestore draft's `fieldOwnerUid`, which the field rules read, is the server's copy of it, set in a
// Firestore transaction after the Postgres change commits. A request whose Firestore step did not get
// through answers 503 and, sent again, sets it.
//
// The notes and the field owner are coordination, not the document: they move the job's coordination
// revision (job_coordination, 0015), never the job revision that a reviewed estimate and a signing
// link are bound to (S5a-9), so saving notes or moving the field work never voids either.

const COORDINATION: readonly Capability[] = ['coordination'];
const VIEW_COORDINATION: readonly Capability[] = ['coordination', 'assignment'];
const ASSIGN: readonly Capability[] = ['assignment'];
// The first capture: whoever does field work (owner decision J3's `scope`).
const CLAIM: readonly Capability[] = ['scope'];
const TRANSFER: readonly Capability[] = ['field_owner_transfer'];

export type PersonView = { actorId: string; displayName: string | null; email: string };
export type AssignmentView = PersonView & { id: string; assignedAt: string };

// The coordination view: what the owner and office see of a job beside the customer view. An
// estimator never gets it (docs/spec.md 2.3: not office notes, assignment or access lists).
export type CoordinationView = {
  jobId: string;
  status: JobRow['status'];
  // The coordination revision: 0 until the first note or field owner change.
  revision: number;
  notes: string;
  // Who owns the field work now; null until the first capture.
  fieldOwner: PersonView | null;
  // The estimators assigned now, first assigned first.
  assignments: AssignmentView[];
  // The company's active estimators, to assign.
  estimators: PersonView[];
};

export type OfficeService = {
  coordination(caller: JobCaller, jobId: string): Promise<CoordinationView>;
  saveCoordination(caller: JobCaller, jobId: string, input: CoordinationInput): Promise<CoordinationView>;
  assign(caller: JobCaller, jobId: string, input: AssignInput): Promise<{ created: boolean; view: CoordinationView }>;
  unassign(caller: JobCaller, jobId: string, assignmentId: string): Promise<CoordinationView>;
  claimFieldOwner(caller: JobCaller, jobId: string): Promise<{ claimed: boolean; detail: JobDetail }>;
  transferFieldOwner(caller: JobCaller, jobId: string, input: TransferInput): Promise<CoordinationView>;
};

function need(caller: JobCaller, keys: readonly Capability[]): void {
  if (!hasAny(caller, keys)) throw new JobError('not_allowed');
}

type Coordination = { notes: string; revision: number; lastChangeId: string | null };

async function readCoordination(tx: CompanyTransaction, row: JobRow): Promise<Coordination> {
  const [found] = await tx
    .select({ notes: jobCoordination.officeNotes, revision: jobCoordination.revision, lastChangeId: jobCoordination.lastChangeId })
    .from(jobCoordination)
    .where(and(eq(jobCoordination.companyId, row.companyId), eq(jobCoordination.jobId, row.id)));
  return found ?? { notes: '', revision: 0, lastChangeId: null };
}

// Moves the coordination to its next revision under the job's row lock the caller holds, with the
// notes when they change and the change id when the change has one. Answers the new revision.
async function advanceCoordination(tx: CompanyTransaction, row: JobRow, changeId: string | null, notes?: string): Promise<number> {
  const [saved] = await tx
    .insert(jobCoordination)
    .values({ companyId: row.companyId, jobId: row.id, officeNotes: notes ?? '', revision: 1, lastChangeId: changeId })
    .onConflictDoUpdate({
      target: [jobCoordination.companyId, jobCoordination.jobId],
      set: {
        ...(notes === undefined ? {} : { officeNotes: notes }),
        ...(changeId === null ? {} : { lastChangeId: changeId }),
        revision: sql`${jobCoordination.revision} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ revision: jobCoordination.revision });
  return saved!.revision;
}

// Names the field owner on the job. Only the field owner changes: the job revision stays (0015).
async function setFieldOwner(tx: CompanyTransaction, row: JobRow, actorId: string): Promise<JobRow> {
  const [next] = await tx
    .update(jobs)
    .set({ fieldOwnerActorId: actorId })
    .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
    .returning();
  return next!;
}

async function person(tx: CompanyTransaction, companyId: string, actorId: string): Promise<PersonView | null> {
  const [found] = await tx
    .select({ actorId: actors.id, displayName: actors.displayName, email: actors.email })
    .from(actors)
    .where(and(eq(actors.companyId, companyId), eq(actors.id, actorId)));
  return found ?? null;
}

async function activeAssignments(tx: CompanyTransaction, row: JobRow): Promise<AssignmentView[]> {
  const found = await tx
    .select({
      id: jobAssignments.id,
      actorId: actors.id,
      displayName: actors.displayName,
      email: actors.email,
      assignedAt: jobAssignments.assignedAt,
    })
    .from(jobAssignments)
    .innerJoin(actors, and(eq(actors.companyId, jobAssignments.companyId), eq(actors.id, jobAssignments.estimatorActorId)))
    .where(and(eq(jobAssignments.companyId, row.companyId), eq(jobAssignments.jobId, row.id), isNull(jobAssignments.endedAt)))
    .orderBy(asc(jobAssignments.assignedAt), asc(jobAssignments.id));
  return found.map((one) => ({ ...one, assignedAt: one.assignedAt.toISOString() }));
}

// The company's active estimators (the people office may assign, docs/spec.md 2.2).
async function activeEstimators(tx: CompanyTransaction, companyId: string, only?: string): Promise<PersonView[]> {
  return tx
    .select({ actorId: actors.id, displayName: actors.displayName, email: actors.email })
    .from(memberships)
    .innerJoin(actors, and(eq(actors.companyId, memberships.companyId), eq(actors.id, memberships.actorId)))
    .where(
      and(
        eq(memberships.companyId, companyId),
        eq(memberships.role, 'estimator'),
        eq(memberships.status, 'active'),
        ...(only === undefined ? [] : [eq(actors.id, only)]),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

async function viewOf(tx: CompanyTransaction, row: JobRow): Promise<CoordinationView> {
  const coordination = await readCoordination(tx, row);
  return {
    jobId: row.id,
    status: row.status,
    revision: coordination.revision,
    notes: coordination.notes,
    fieldOwner: row.fieldOwnerActorId ? await person(tx, row.companyId, row.fieldOwnerActorId) : null,
    assignments: await activeAssignments(tx, row),
    estimators: await activeEstimators(tx, row.companyId),
  };
}

async function uidOf(tx: CompanyTransaction, companyId: string, actorId: string): Promise<string | null> {
  const [found] = await tx
    .select({ uid: actors.uid })
    .from(actors)
    .where(and(eq(actors.companyId, companyId), eq(actors.id, actorId)));
  return found?.uid ?? null;
}

// The job's drafts: each draft it has been on, then its current draft last, every one of them the job's
// in job_drafts (0016) before the field database is touched, so a draft another job claimed is never
// among them (security audit F1). The drafts of the job's own submissions that no job has claimed (the
// previous version, still serving while a release migrates, submits drafts without claiming them) are
// claimed for the job here first, in Postgres, and so is a current draft no job has claimed; a
// submitted draft another job claimed is left out, and a current draft another job claimed is refused
// (409), so the field work of another job's draft is never handed on. Every one of them names the job's
// field owner, so a person who no longer owns the field work reads none of them (web/firestore.rules).
// The current draft is set last, so while any draft does not name the owner yet, the current one does
// not either, and the job screens offer Start field work, which sets them all again. The list is also
// what lets the draft store stamp the job id on a draft made before `jobId` (drafts.ts).
async function draftIdsOf(tx: CompanyTransaction, row: JobRow): Promise<string[]> {
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

// The field-database steps of Back to editing a move or Start field work may repeat
// (remakeCurrentDraft): making the job's current draft from its latest record, and closing it when
// the job was archived while it was made.
export type DraftRemaker = Pick<FenceStore, 'createFrom'> & Pick<ArchiveStore, 'archiveDraft'>;

export function officeService(db: Database, drafts: DraftStore, remaker: DraftRemaker): OfficeService {
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) throw new JobError('invalid_request');
      throw error;
    }
  }

  // The job's drafts (draftIdsOf), read before the commit: a current draft the field database holds
  // for another job is never handed on, and the request changes nothing (security audit F1).
  async function draftsToName(tx: CompanyTransaction, row: JobRow): Promise<string[]> {
    const ids = await draftIdsOf(tx, row);
    await holdAcrossOutsideCall(tx);
    const found = await findDraft(drafts, row.companyId, row.currentDraftId);
    if (found && draftOfOtherJob(found.jobId, row.id)) throw new JobError('conflict');
    return ids;
  }

  // A Firestore call: an error is "try again" (503), never a decision.
  async function field<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      // Fixed text only: the SDK's message may quote a path.
      console.error('job field owner unavailable', error instanceof Error ? error.name : 'unknown');
      throw new JobError('draft_unavailable');
    }
  }

  // The record a missing current draft is made from: the job's latest committed submission, while the
  // job is being edited (`draft`) on this draft. Both callers hold the draft in job_drafts (0016) for
  // the job already (draftIdsOf). Back to editing put the job on this draft from that record and
  // claimed it in the same commit; nothing is submitted since, or the job would not be `draft`. Null when the draft is not one Back to editing made (a new
  // job's first draft), so the request answers 503 as before. A short transaction of its own, ended
  // before the field database is called (security audit F5: no transaction waits on Firestore here).
  async function recordOfCurrentDraft(companyId: string, jobId: string, draftId: string) {
    return inCompany(companyId, async (tx) => {
      const [row] = await tx
        .select({ status: jobs.status, currentDraftId: jobs.currentDraftId })
        .from(jobs)
        .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
      if (row?.status !== 'draft' || row.currentDraftId !== draftId) return null;
      const [latest] = await tx
        .select({ id: jobSubmissions.id, draftId: jobSubmissions.draftId, snapshotBytes: jobSubmissions.snapshotBytes })
        .from(jobSubmissions)
        .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.jobId, jobId), eq(jobSubmissions.status, 'committed')))
        .orderBy(desc(jobSubmissions.createdAt))
        .limit(1);
      if (!latest?.snapshotBytes || latest.draftId === draftId) return null;
      return { snapshotBytes: latest.snapshotBytes, previous: { draftId: latest.draftId, submissionId: latest.id } };
    });
  }

  // Back to editing commits in Postgres and only then makes its draft; when that step fails and the
  // phone that sent it is gone, nobody else knows the submitted draft id its retry needs. So the job's
  // field owner step makes the current draft itself, exactly as Back to editing's retry does
  // (submissions/service.ts backToEditing): from the latest record, never from the old draft, with
  // where it came from. A draft already there with the same provenance (Back to editing's own retry
  // won) is left as it is; one made for another job or from another record is refused (409, security
  // audit F1). False when there is no record to make it from.
  //
  // No transaction or lock is held across the field database (security audit F5), so the draft is made
  // closed, naming nobody: no phone reads or writes it until project() names the field owner, and
  // project() does that only with the owner, revision and status Postgres holds at that moment
  // (liveOwner), never with values this request read earlier. And an archive that found no
  // draft to close while this one was being made is caught here: the job is read again once the draft
  // is there, and a job archived by then has the draft closed by this request (archiveDraft, guarded by
  // the job revision, so it never undoes a later restore). An archive that commits after that read finds
  // the draft and closes it itself.
  async function remakeCurrentDraft(companyId: string, jobId: string, draftId: string): Promise<boolean> {
    const record = await recordOfCurrentDraft(companyId, jobId, draftId);
    if (!record) return false;
    const manifest = snapshotManifest(record.snapshotBytes);
    const result = await field(() => remaker.createFrom(companyId, jobId, draftId, null, manifest, record.previous));
    if (result === 'taken') throw new JobError('conflict');
    const now = await inCompany(companyId, async (tx) => {
      const [row] = await tx
        .select({ status: jobs.status, currentDraftId: jobs.currentDraftId, revision: jobs.revision })
        .from(jobs)
        .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
      return row;
    });
    if (now?.status === 'archived' && now.currentDraftId === draftId) {
      await field(() => remaker.archiveDraft(companyId, draftId, now.revision));
    }
    return true;
  }

  // The job's field owner, coordination revision and status as Postgres holds them now, read in a
  // short transaction of its own with no field-database call inside it, just before the current draft
  // is stamped. The current draft is the only one a phone can write, so it is never opened with an
  // owner or revision this request read earlier: an archive, a move or a Back to editing committed
  // since then is refused here instead of being overwritten on the draft (an ownerless remade draft
  // stays closed until the request that matches Postgres stamps it).
  async function liveOwner(companyId: string, jobId: string, draftId: string, uid: string, changed: (revision: number) => JobError) {
    const live = await inCompany(companyId, async (tx) => {
      const [row] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
      if (!row) throw new JobError('not_found');
      return {
        status: row.status,
        currentDraftId: row.currentDraftId,
        uid: row.fieldOwnerActorId ? await uidOf(tx, companyId, row.fieldOwnerActorId) : null,
        revision: (await readCoordination(tx, row)).revision,
      };
    });
    if (live.status === 'archived') throw new JobError('archived');
    if (live.currentDraftId !== draftId || live.uid !== uid) throw changed(live.revision);
    return { uid, revision: live.revision };
  }

  // The Firestore step: each of the job's drafts names its field owner as Postgres has it, at that
  // revision; the current draft last, with the owner read again just before (liveOwner). A current
  // draft that is not there yet is made first when Back to editing left it missing
  // (remakeCurrentDraft); otherwise, or when Firestore cannot be reached, the answer is 503 and the
  // same request again sets it. A newer owner already on a draft means a later change won, which is
  // the answer Postgres holds too. `changed` is the answer when the owner or the current draft
  // changed since this request read them.
  async function project(
    companyId: string,
    jobId: string,
    draftIds: readonly string[],
    uid: string | null,
    revision: number,
    changed: (revision: number) => JobError,
  ): Promise<void> {
    if (uid === null) throw new JobError('draft_unavailable');
    const stamp = async (draftId: string, last: boolean) => {
      const now = last ? await liveOwner(companyId, jobId, draftId, uid, changed) : { uid, revision };
      return field(() => drafts.setFieldOwner(companyId, jobId, draftId, now.uid, now.revision));
    };
    for (const [index, draftId] of draftIds.entries()) {
      const last = index === draftIds.length - 1;
      let result = await stamp(draftId, last);
      if (result === 'missing' && last && (await remakeCurrentDraft(companyId, jobId, draftId))) {
        result = await stamp(draftId, last);
      }
      if (result === 'missing' && last) throw new JobError('draft_unavailable');
      // A draft made for another job is left as it is (security audit F1); when it is the job's
      // current draft, the field work cannot be handed over at all.
      if (result === 'taken' && last) throw new JobError('conflict');
    }
  }

  return {
    async coordination(caller, jobId) {
      need(caller, VIEW_COORDINATION);
      return inCompany(caller.companyId, async (tx) => viewOf(tx, await jobAccess(tx, caller, jobId, VIEW_COORDINATION)));
    },

    async saveCoordination(caller, jobId, input) {
      need(caller, COORDINATION);
      return inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, COORDINATION, { lock: true });
        const current = await readCoordination(tx, row);
        // The same change again (its response was lost): nothing more to do, as long as it says what
        // was saved. Office notes are coordination, not the signed record, so a signed job keeps them.
        if (current.lastChangeId === input.changeId) {
          if (current.notes !== input.notes) throw new JobError('conflict');
          return viewOf(tx, row);
        }
        if (current.revision !== input.revision) throw new JobError('stale_revision', { revision: current.revision });
        const revision = await advanceCoordination(tx, row, input.changeId, input.notes);
        await audit(tx, caller, 'job_coordination_saved', row.id, { revision });
        return viewOf(tx, row);
      });
    },

    async assign(caller, jobId, input) {
      need(caller, ASSIGN);
      const digest = assignDigest(input);
      return inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, ASSIGN, { lock: true });
        const [existing] = await tx
          .select()
          .from(jobAssignments)
          .where(and(eq(jobAssignments.companyId, caller.companyId), eq(jobAssignments.id, input.id)));
        // Sent before: the same request is the same assignment, even after it ended.
        if (existing) {
          if (existing.jobId !== row.id || existing.requestDigest !== digest) throw new JobError('conflict');
          return { created: false, view: await viewOf(tx, row) };
        }
        if ((await activeEstimators(tx, caller.companyId, input.estimatorActorId)).length === 0) throw new JobError('not_assignable');
        const [inserted] = await tx
          .insert(jobAssignments)
          .values({
            id: input.id,
            companyId: caller.companyId,
            jobId: row.id,
            estimatorActorId: input.estimatorActorId,
            requestDigest: digest,
            assignedByActorId: caller.actorId,
          })
          // The estimator already holds an active assignment to this job (under another id).
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw new JobError('already_assigned');
        await audit(tx, caller, 'job_estimator_assigned', row.id, { assignmentId: inserted.id, estimatorActorId: inserted.estimatorActorId });
        return { created: true, view: await viewOf(tx, row) };
      });
    },

    async unassign(caller, jobId, assignmentId) {
      need(caller, ASSIGN);
      return inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, ASSIGN, { lock: true });
        const [found] = await tx
          .select()
          .from(jobAssignments)
          .where(and(eq(jobAssignments.companyId, caller.companyId), eq(jobAssignments.jobId, row.id), eq(jobAssignments.id, assignmentId)));
        if (!found) throw new JobError('assignment_not_found');
        // Ended already (a retry after a lost answer, or someone else ended it): nothing to change.
        if (found.endedAt !== null) return viewOf(tx, row);
        // The field owner keeps the job while they own its field work: the owner moves it first (J5).
        if (row.fieldOwnerActorId === found.estimatorActorId) throw new JobError('assigned_field_owner');
        await tx
          .update(jobAssignments)
          .set({ endedByActorId: caller.actorId })
          .where(and(eq(jobAssignments.companyId, caller.companyId), eq(jobAssignments.id, found.id)));
        await audit(tx, caller, 'job_estimator_unassigned', row.id, { assignmentId: found.id, estimatorActorId: found.estimatorActorId });
        return viewOf(tx, row);
      });
    },

    // "First capture makes me field owner" (docs/spec.md 6.2): on a job nobody owns in the field yet,
    // the first person with `scope` who may see it (its creator, an assigned estimator, the owner)
    // becomes its field owner, once. Asked again by the same person it changes nothing and sets the
    // drafts again if that step was lost, even on a signed job; asked by anyone else it is refused.
    async claimFieldOwner(caller, jobId) {
      need(caller, CLAIM);
      const made = await inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, CLAIM, { lock: true });
        if (row.fieldOwnerActorId !== null && row.fieldOwnerActorId !== caller.actorId) throw new JobError('field_owner_taken');
        let next = row;
        let revision: number;
        if (row.fieldOwnerActorId === null) {
          if (row.status === 'signed') throw new JobError('job_signed');
          next = await setFieldOwner(tx, row, caller.actorId);
          revision = await advanceCoordination(tx, row, null);
          await audit(tx, caller, 'job_field_owner_claimed', row.id, { revision });
        } else {
          revision = (await readCoordination(tx, row)).revision;
        }
        return { claimed: next !== row, revision, draftIds: await draftsToName(tx, next), detail: await detailOf(tx, next) };
      });
      await project(caller.companyId, jobId, made.draftIds, caller.uid, made.revision, () => new JobError('field_owner_taken'));
      return { claimed: made.claimed, detail: made.detail };
    },

    // Owner decision J5: the owner moves the field work to themself or to an estimator assigned to
    // the job, audited. The phone that held it keeps its unsent changes (the field rules refuse them
    // from now on; S6 offers Save as new draft). The same change again sets the drafts again, and so
    // does a move to the person who owns the field work already, even on a signed job: that changes
    // nothing in Postgres and only sends the field owner to every draft once more.
    async transferFieldOwner(caller, jobId, input) {
      need(caller, TRANSFER);
      const made = await inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, TRANSFER, { lock: true });
        const current = await readCoordination(tx, row);
        let next = row;
        let revision = current.revision;
        if (current.lastChangeId === input.changeId) {
          if (row.fieldOwnerActorId !== input.toActorId) throw new JobError('conflict');
        } else {
          if (current.revision !== input.revision) throw new JobError('stale_revision', { revision: current.revision });
          const moving = row.fieldOwnerActorId !== input.toActorId;
          if (moving && row.status === 'signed') throw new JobError('job_signed');
          if (moving && input.toActorId !== caller.actorId) {
            const assigned = (await activeAssignments(tx, row)).some((one) => one.actorId === input.toActorId);
            const estimator = (await activeEstimators(tx, caller.companyId, input.toActorId)).length > 0;
            if (!assigned || !estimator) throw new JobError('not_assignable');
          }
          if (moving) {
            next = await setFieldOwner(tx, row, input.toActorId);
            revision = await advanceCoordination(tx, row, input.changeId);
            await audit(tx, caller, 'job_field_owner_moved', row.id, {
              revision,
              fromActorId: row.fieldOwnerActorId ?? '',
              toActorId: input.toActorId,
            });
          }
        }
        return {
          revision,
          draftIds: await draftsToName(tx, next),
          uid: next.fieldOwnerActorId ? await uidOf(tx, caller.companyId, next.fieldOwnerActorId) : null,
          view: await viewOf(tx, next),
        };
      });
      await project(caller.companyId, jobId, made.draftIds, made.uid, made.revision, (now) => new JobError('stale_revision', { revision: now }));
      return made.view;
    },
  };
}
