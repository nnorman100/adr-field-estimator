import { and, eq, isNull, ne } from 'drizzle-orm';
import { jobAssignments, jobDrafts, jobs, jobSubmissions } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import type { Identity } from '@/lib/auth';

// What the jobs routes need to know about the caller; taken from the verified sign-in.
export type JobCaller = Pick<Identity, 'companyId' | 'actorId' | 'uid' | 'role' | 'capabilities'>;

export const JOB_ERRORS = {
  invalid_request: 400,
  // The caller's role cannot do this.
  not_allowed: 403,
  // No such job in this company, or an estimator's request for a job that is not theirs.
  not_found: 404,
  // An archived job answers 410 on every job route (S5b-2 archives).
  archived: 410,
  // The id is taken by another request or another job, or the request changes nothing it may.
  conflict: 409,
  // The job changed since the copy the caller holds.
  stale_revision: 409,
  // A signed job's customer and claim change only through a correction (S5b-4).
  job_signed: 409,
  // Field work is the field owner's (docs/spec.md 6.2): an estimator who does not own this job's
  // field work cannot add to it, and another person already owns it.
  not_field_owner: 403,
  field_owner_taken: 409,
  // An assignment: the estimator is already assigned, the person is not an active estimator of the
  // company, the assignment named is not this job's, or it cannot end while that estimator owns the
  // job's field work (the owner moves the field work first).
  already_assigned: 409,
  not_assignable: 409,
  assignment_not_found: 404,
  assigned_field_owner: 409,
  // Archive and restore (S5b-2): a restore of a job that is not archived, and an archive while a
  // Submit of the job is still deciding or writing its marker (it settles within minutes).
  not_archived: 409,
  submission_in_progress: 409,
  // Copy (S5b-2) makes a new draft from a signed job only.
  not_signed: 409,
  // The job is saved but its field draft could not be made or updated; the same request again
  // makes it.
  draft_unavailable: 503,
} as const;
export type JobErrorCode = keyof typeof JOB_ERRORS;

export class JobError extends Error {
  readonly status: number;
  constructor(
    readonly code: JobErrorCode,
    // Safe to show the caller: the current revision of a job that moved on.
    readonly extra: Record<string, number> = {},
  ) {
    super(`Job request refused: ${code}`);
    this.name = 'JobError';
    this.status = JOB_ERRORS[code];
  }
}

export type JobRow = typeof jobs.$inferSelect;

// The owner and office see every job of their company; anyone else (an estimator) only their own.
// Deny by default: a role this function does not name sees only its own jobs.
export function seesEveryJob(caller: Pick<JobCaller, 'role'>): boolean {
  return caller.role === 'owner' || caller.role === 'office';
}

// A job is the caller's own when they made it or own its field work; an estimator also sees the jobs
// they are assigned (S5b-1, isAssigned below).
export function isOwnJob(caller: Pick<JobCaller, 'actorId'>, job: Pick<JobRow, 'createdByActorId' | 'fieldOwnerActorId'>): boolean {
  return job.createdByActorId === caller.actorId || job.fieldOwnerActorId === caller.actorId;
}

export function canSeeJob(caller: JobCaller, job: Pick<JobRow, 'createdByActorId' | 'fieldOwnerActorId'>): boolean {
  return seesEveryJob(caller) || isOwnJob(caller, job);
}

// Whether the caller owns the job's field work, the only person who adds to it (docs/spec.md 6.2): the
// company owner too only once the field work is theirs (the first capture, or a move to themself, J5).
export function ownsFieldWork(caller: Pick<JobCaller, 'actorId'>, job: Pick<JobRow, 'fieldOwnerActorId'>): boolean {
  return job.fieldOwnerActorId === caller.actorId;
}

export function hasAny(caller: Pick<JobCaller, 'capabilities'>, keys: readonly Capability[]): boolean {
  return keys.some((key) => caller.capabilities.includes(key));
}

// Whether the caller is actively assigned to the job (job_assignments, 0015).
export async function isAssigned(tx: CompanyTransaction, caller: Pick<JobCaller, 'companyId' | 'actorId'>, jobId: string): Promise<boolean> {
  const [found] = await tx
    .select({ id: jobAssignments.id })
    .from(jobAssignments)
    .where(
      and(
        eq(jobAssignments.companyId, caller.companyId),
        eq(jobAssignments.jobId, jobId),
        eq(jobAssignments.estimatorActorId, caller.actorId),
        isNull(jobAssignments.endedAt),
      ),
    )
    .limit(1);
  return found !== undefined;
}

// The one job-access function every job route goes through, in this order (docs/plans/S5.md,
// section 3): the company (the job must be in the caller's own, which row-level security and the
// query both enforce), then the estimator's own or assigned job, then archived (410), then the
// capability. A job the caller may not see is "not found", so a refusal never says whether another
// person's job exists. `lock` takes the row lock a write needs. `fieldWork` is for a route that adds
// to the field work (photos, Submit, Back to editing): the caller must own the job's field work,
// whatever their role (docs/spec.md 6.2). `customer` is for the customer and claim saves (owner
// decision J3): the owner and office by their role, an estimator only while they own the field work,
// not only because they are assigned the job. `archived` is for archive and restore only (S5b-2):
// they reach an archived job, which every other route answers with 410.
export async function jobAccess(
  tx: CompanyTransaction,
  caller: JobCaller,
  jobId: string,
  needs: readonly Capability[],
  options: { lock?: boolean; fieldWork?: boolean; customer?: boolean; archived?: boolean } = {},
): Promise<JobRow> {
  const found = tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)))
    .limit(1);
  const [row] = await (options.lock ? found.for('update') : found);
  if (!row || !(canSeeJob(caller, row) || (await isAssigned(tx, caller, row.id)))) throw new JobError('not_found');
  if (row.status === 'archived' && !options.archived) throw new JobError('archived');
  if (!hasAny(caller, needs)) throw new JobError('not_allowed');
  if (options.fieldWork && !ownsFieldWork(caller, row)) throw new JobError('not_field_owner');
  if (options.customer && !seesEveryJob(caller) && !ownsFieldWork(caller, row)) throw new JobError('not_field_owner');
  return row;
}

// The job's row, locked, for a step that changes its field draft's state or makes one of its drafts
// (S5b-2). Archive and restore set the draft's state under this lock from the row as it is then, and
// Submit closes its fence under it, so each sees the others' field steps whole. `live` refuses an
// archived job: a draft made after its job was archived would be open to the phone.
export async function lockedJob(tx: CompanyTransaction, companyId: string, jobId: string, options: { live?: boolean } = {}): Promise<JobRow> {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)))
    .for('update');
  if (!row) throw new JobError('not_found');
  if (options.live && row.status === 'archived') throw new JobError('archived');
  return row;
}

// Claims a new draft id for a job (job_drafts, 0016; security audit F1), in the transaction that puts
// the job on it. False when the id is already claimed, by another job or by an earlier draft of this
// one, or was ever submitted: a draft id is claimed once, so no job ever takes another job's draft,
// even one that job submitted and moved on from. The submissions are read too because a release runs
// its migration while the previous version still serves, and that version puts jobs on drafts and
// submits them without claiming them. Two claims of one id at once: the second waits for the first
// and then is false.
export async function claimDraft(tx: CompanyTransaction, companyId: string, jobId: string, draftId: string): Promise<boolean> {
  const [submitted] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.draftId, draftId)))
    .limit(1);
  if (submitted !== undefined) return false;
  const claimed = await tx.insert(jobDrafts).values({ companyId, draftId, jobId }).onConflictDoNothing().returning({ draftId: jobDrafts.draftId });
  return claimed.length === 1;
}

// A draft id the job already names (the draft it was made or copied on, its current draft, or the draft
// of one of its own submissions) is the job's in job_drafts, checked in Postgres before the field
// database is touched for it: claimed by this job, or, when no job has claimed it, claimed for the job
// now. That second case is a draft the previous version (still serving while a release migrates) put
// the job on, or submitted, without claiming it. False when another job claimed it or a submission of
// another job names it: then the draft is never this job's, and the field database draft under it is
// neither stamped nor handed on. Two calls at once: the second waits for the first and reads its claim.
export async function holdDraft(tx: CompanyTransaction, companyId: string, jobId: string, draftId: string): Promise<boolean> {
  const holder = async () => {
    const [claim] = await tx
      .select({ jobId: jobDrafts.jobId })
      .from(jobDrafts)
      .where(and(eq(jobDrafts.companyId, companyId), eq(jobDrafts.draftId, draftId)));
    return claim?.jobId;
  };
  const held = await holder();
  if (held !== undefined) return held === jobId;
  const [other] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.draftId, draftId), ne(jobSubmissions.jobId, jobId)))
    .limit(1);
  if (other) return false;
  await tx.insert(jobDrafts).values({ companyId, draftId, jobId }).onConflictDoNothing();
  return (await holder()) === jobId;
}
