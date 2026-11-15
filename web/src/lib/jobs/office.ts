import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { actors, jobAssignments, jobCoordination, jobs, jobSubmissions, memberships } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from './access';
import type { DraftStore } from './drafts';
import { assignDigest, type AssignInput, type CoordinationInput, type TransferInput } from './schema';
import { advance, audit, CHECK_VIOLATION, detailOf, errorCode, type JobDetail } from './service';

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

async function readNotes(tx: CompanyTransaction, row: JobRow): Promise<string> {
  const [found] = await tx
    .select({ notes: jobCoordination.officeNotes })
    .from(jobCoordination)
    .where(and(eq(jobCoordination.companyId, row.companyId), eq(jobCoordination.jobId, row.id)));
  return found?.notes ?? '';
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
  return {
    jobId: row.id,
    status: row.status,
    revision: row.revision,
    notes: await readNotes(tx, row),
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

// The job's drafts: each earlier draft a submission was made from, then its current draft last.
// Every one of them names the job's field owner, so a person who no longer owns the field work
// reads none of them (web/firestore.rules). The current draft is set last, so while any draft does
// not name the owner yet, the current one does not either, and the job screens offer Start field
// work, which sets them all again.
async function draftIdsOf(tx: CompanyTransaction, row: JobRow): Promise<string[]> {
  const found = await tx
    .selectDistinct({ draftId: jobSubmissions.draftId })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, row.companyId), eq(jobSubmissions.jobId, row.id)));
  return [...found.map((one) => one.draftId).filter((id) => id !== row.currentDraftId), row.currentDraftId];
}

export function officeService(db: Database, drafts: DraftStore): OfficeService {
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) throw new JobError('invalid_request');
      throw error;
    }
  }

  // The Firestore step: each of the job's drafts names its field owner as Postgres has it, at that
  // revision. A current draft that is not there yet (Back to editing makes its draft after its own
  // commit) or a Firestore that cannot be reached answers 503; the same request again sets it. A
  // newer owner already on a draft means a later change won, which is the answer Postgres holds too.
  async function project(companyId: string, draftIds: readonly string[], uid: string | null, revision: number): Promise<void> {
    if (uid === null) throw new JobError('draft_unavailable');
    for (const [index, draftId] of draftIds.entries()) {
      let result;
      try {
        result = await drafts.setFieldOwner(companyId, draftId, uid, revision);
      } catch (error) {
        // Fixed text only: the SDK's message may quote a path.
        console.error('job field owner unavailable', error instanceof Error ? error.name : 'unknown');
        throw new JobError('draft_unavailable');
      }
      if (result === 'missing' && index === draftIds.length - 1) throw new JobError('draft_unavailable');
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
        // The same change again (its response was lost): nothing more to do, as long as it says what
        // was saved. Office notes are coordination, not the signed record, so a signed job keeps them.
        if (row.lastChangeId === input.changeId) {
          if ((await readNotes(tx, row)) !== input.notes) throw new JobError('conflict');
          return viewOf(tx, row);
        }
        if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
        await tx
          .insert(jobCoordination)
          .values({ companyId: row.companyId, jobId: row.id, officeNotes: input.notes })
          .onConflictDoUpdate({
            target: [jobCoordination.companyId, jobCoordination.jobId],
            set: { officeNotes: input.notes, updatedAt: sql`now()` },
          });
        const next = await advance(tx, row, input.changeId);
        await audit(tx, caller, 'job_coordination_saved', row.id, { revision: next.revision });
        return viewOf(tx, next);
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
    // draft again if that step was lost; asked by anyone else it is refused.
    async claimFieldOwner(caller, jobId) {
      need(caller, CLAIM);
      const made = await inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, CLAIM, { lock: true });
        if (row.fieldOwnerActorId !== null && row.fieldOwnerActorId !== caller.actorId) throw new JobError('field_owner_taken');
        if (row.status === 'signed') throw new JobError('job_signed');
        let next = row;
        if (row.fieldOwnerActorId === null) {
          // The revision rises with the change (0010); the last change id is left as it is, so a
          // customer save whose answer was lost is still recognised when it is sent again.
          [next] = (await tx
            .update(jobs)
            .set({ fieldOwnerActorId: caller.actorId, revision: sql`${jobs.revision} + 1`, updatedAt: sql`now()` })
            .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
            .returning()) as [JobRow];
          await audit(tx, caller, 'job_field_owner_claimed', row.id, { revision: next.revision });
        }
        return { claimed: next !== row, row: next, draftIds: await draftIdsOf(tx, next), detail: await detailOf(tx, next) };
      });
      await project(caller.companyId, made.draftIds, caller.uid, made.row.revision);
      return { claimed: made.claimed, detail: made.detail };
    },

    // Owner decision J5: the owner moves the field work to themself or to an estimator assigned to
    // the job, audited. The phone that held it keeps its unsent changes (the field rules refuse them
    // from now on; S6 offers Save as new draft). The same change again sets the draft again.
    async transferFieldOwner(caller, jobId, input) {
      need(caller, TRANSFER);
      const made = await inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, TRANSFER, { lock: true });
        let next = row;
        if (row.lastChangeId === input.changeId) {
          if (row.fieldOwnerActorId !== input.toActorId) throw new JobError('conflict');
        } else {
          if (row.status === 'signed') throw new JobError('job_signed');
          if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
          if (input.toActorId !== caller.actorId) {
            const assigned = (await activeAssignments(tx, row)).some((one) => one.actorId === input.toActorId);
            const estimator = (await activeEstimators(tx, caller.companyId, input.toActorId)).length > 0;
            if (!assigned || !estimator) throw new JobError('not_assignable');
          }
          if (row.fieldOwnerActorId !== input.toActorId) {
            // One update: the revision rises by exactly one with each change (0010).
            [next] = (await tx
              .update(jobs)
              .set({ fieldOwnerActorId: input.toActorId, revision: sql`${jobs.revision} + 1`, lastChangeId: input.changeId, updatedAt: sql`now()` })
              .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
              .returning()) as [JobRow];
            await audit(tx, caller, 'job_field_owner_moved', row.id, {
              revision: next.revision,
              fromActorId: row.fieldOwnerActorId ?? '',
              toActorId: input.toActorId,
            });
          }
        }
        return {
          row: next,
          draftIds: await draftIdsOf(tx, next),
          uid: next.fieldOwnerActorId ? await uidOf(tx, caller.companyId, next.fieldOwnerActorId) : null,
          view: await viewOf(tx, next),
        };
      });
      await project(caller.companyId, made.draftIds, made.uid, made.row.revision);
      return made.view;
    },
  };
}
