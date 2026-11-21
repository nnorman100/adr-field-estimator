import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { actors, jobAssignments, jobCoordination, jobs, memberships } from '@/db/schema';
import { holdAcrossOutsideCall, withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from './access';
import type { DraftSync } from './draft-sync';
import { draftOfOtherJob, type DraftStore } from './drafts';
import { assignDigest, type AssignInput, type CoordinationInput, type TransferInput } from './schema';
import { audit, CHECK_VIOLATION, detailOf, errorCode, findDraft, type JobDetail } from './service';
import { afterFieldStep, claimJobDrafts, stillMember, syncJobDrafts } from './sync-job';

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


export function officeService(db: Database, drafts: DraftStore, sync: DraftSync): OfficeService {
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) throw new JobError('invalid_request');
      throw error;
    }
  }

  // The job's drafts (claimJobDrafts, sync-job.ts), read before the commit: a current draft the field database holds
  // for another job is never handed on, and the request changes nothing (security audit F1).
  async function draftsToName(tx: CompanyTransaction, row: JobRow): Promise<void> {
    await claimJobDrafts(tx, row);
    await holdAcrossOutsideCall(tx);
    const found = await findDraft(drafts, row.companyId, row.currentDraftId);
    if (found && draftOfOtherJob(found.jobId, row.id)) throw new JobError('conflict');
  }

  // The Firestore step after the commit: every draft of the job written as Postgres holds it now, at its
  // field revision, in one transaction (sync-job.ts). A slower request never overwrites a newer state
  // (the job's marker refuses it), and the current draft, when the field database lost it, is made from
  // the job's latest record. When Firestore cannot be reached, the answer is 503 and the same request
  // again sets it; a current draft of another job is 409.
  const fieldStep = (companyId: string, jobId: string) => syncJobDrafts(db, sync, drafts, companyId, jobId);

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
        if (row.fieldOwnerActorId === null) {
          if (row.status === 'signed') throw new JobError('job_signed');
          next = await setFieldOwner(tx, row, caller.actorId);
          const revision = await advanceCoordination(tx, row, null);
          await audit(tx, caller, 'job_field_owner_claimed', row.id, { revision });
        }
        await draftsToName(tx, next);
        return { claimed: next !== row };
      });
      await afterFieldStep(db, caller, () => fieldStep(caller.companyId, jobId));
      // The job as Postgres holds it after the field step, read with the caller's access again: a change
      // committed meanwhile (an archive, a move, an unassignment) is the answer, not what this request saw.
      const detail = await withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await stillMember(tx, caller);
          return detailOf(tx, await jobAccess(tx, caller, jobId, CLAIM));
        },
        { snapshot: true },
      );
      return { claimed: made.claimed, detail };
    },

    // Owner decision J5: the owner moves the field work to themself or to an estimator assigned to
    // the job, audited. The phone that held it keeps its unsent changes (the field rules refuse them
    // from now on; S6 offers Save as new draft). The same change again sets the drafts again, and so
    // does a move to the person who owns the field work already, even on a signed job: that changes
    // nothing in Postgres and only sends the field owner to every draft once more.
    async transferFieldOwner(caller, jobId, input) {
      need(caller, TRANSFER);
      await inCompany(caller.companyId, async (tx) => {
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
        await draftsToName(tx, next);
      });
      await afterFieldStep(db, caller, () => fieldStep(caller.companyId, jobId));
      // The coordination as Postgres holds it after the field step: a later move's owner and revision,
      // when one committed meanwhile, never this request's superseded ones.
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await stillMember(tx, caller);
          return viewOf(tx, await jobAccess(tx, caller, jobId, TRANSFER));
        },
        { snapshot: true },
      );
    },
  };
}
