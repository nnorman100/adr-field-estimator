import { and, eq, isNull } from 'drizzle-orm';
import { jobAssignments, jobs } from '@/db/schema';
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
// not only because they are assigned the job.
export async function jobAccess(
  tx: CompanyTransaction,
  caller: JobCaller,
  jobId: string,
  needs: readonly Capability[],
  options: { lock?: boolean; fieldWork?: boolean; customer?: boolean } = {},
): Promise<JobRow> {
  const found = tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)))
    .limit(1);
  const [row] = await (options.lock ? found.for('update') : found);
  if (!row || !(canSeeJob(caller, row) || (await isAssigned(tx, caller, row.id)))) throw new JobError('not_found');
  if (row.status === 'archived') throw new JobError('archived');
  if (!hasAny(caller, needs)) throw new JobError('not_allowed');
  if (options.fieldWork && !ownsFieldWork(caller, row)) throw new JobError('not_field_owner');
  if (options.customer && !seesEveryJob(caller) && !ownsFieldWork(caller, row)) throw new JobError('not_field_owner');
  return row;
}
