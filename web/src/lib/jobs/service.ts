import { and, asc, desc, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import { actors, auditEvents, jobClaims, jobCustomers, jobs } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { canSeeJob, hasAny, isOwnJob, jobAccess, JobError, seesEveryJob, type JobCaller, type JobRow } from './access';
import type { DraftStore } from './drafts';
import { createDigest, type ClaimInput, type CreateJobInput, type CustomerInput, type ListQuery } from './schema';

// The jobs of a company (S5a-3). Every function runs inside withCompany for the company of the
// verified sign-in, and every write adds one audit row (ids and revisions only, never a name, an
// address or a number) in its own transaction. The Postgres row comes first; the Firestore field
// draft follows, and a retry of the same create makes whichever of the two is missing.

// Who may do what (docs/ACCESS.md, "Jobs routes"). Owner decision J3: the estimator who owns the
// field work, the owner and office may all set the customer and the address while the job is
// unsigned, so the key is `scope` (owner, estimator) or `coordination` (owner, office), either one.
const READ: readonly Capability[] = ['jobs_read'];
const CREATE: readonly Capability[] = ['jobs_create'];
const EDIT_CUSTOMER: readonly Capability[] = ['scope', 'coordination'];
const EDIT_CLAIM: readonly Capability[] = ['scope', 'coordination'];

export type JobView = {
  id: string;
  status: JobRow['status'];
  currentDraftId: string;
  // The actor who owns the field work; null until someone does.
  fieldOwnerActorId: string | null;
  propertyAddress: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CustomerView = { name: string; phone: string; email: string };

export type ClaimView = {
  carrier: string;
  claimNumber: string;
  policyNumber: string;
  dateOfLoss: string | null;
  lossCause: string;
  adjusterName: string;
  adjusterEmail: string;
  adjusterPhone: string;
  deductible: string;
};

export type JobDetail = { job: JobView; customer: CustomerView; claim: ClaimView };

export type JobListItem = Pick<JobView, 'id' | 'status' | 'propertyAddress' | 'revision' | 'createdAt' | 'updatedAt'> & {
  customerName: string;
  // The caller made the job or owns its field work.
  mine: boolean;
};

export type JobPage = { jobs: JobListItem[]; nextCursor: string | null };

export type JobsService = {
  create(caller: JobCaller, input: CreateJobInput): Promise<{ created: boolean; detail: JobDetail }>;
  list(caller: JobCaller, query: ListQuery): Promise<JobPage>;
  read(caller: JobCaller, jobId: string): Promise<JobDetail>;
  saveCustomer(caller: JobCaller, jobId: string, input: CustomerInput): Promise<JobDetail>;
  saveClaim(caller: JobCaller, jobId: string, input: ClaimInput): Promise<JobDetail>;
};

const EMPTY_CUSTOMER: CustomerView = { name: '', phone: '', email: '' };
const EMPTY_CLAIM: ClaimView = {
  carrier: '',
  claimNumber: '',
  policyNumber: '',
  dateOfLoss: null,
  lossCause: '',
  adjusterName: '',
  adjusterEmail: '',
  adjusterPhone: '',
  deductible: '',
};

function jobView(row: JobRow): JobView {
  return {
    id: row.id,
    status: row.status,
    currentDraftId: row.currentDraftId,
    fieldOwnerActorId: row.fieldOwnerActorId,
    propertyAddress: row.propertyAddress,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function errorCode(error: unknown): unknown {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code ?? found?.cause?.code;
}

// A value the Zod schema let through that a CHECK constraint refuses is a bad request, not a fault.
const CHECK_VIOLATION = '23514';

function need(caller: JobCaller, keys: readonly Capability[]): void {
  if (!hasAny(caller, keys)) throw new JobError('not_allowed');
}

async function audit(
  tx: CompanyTransaction,
  caller: JobCaller,
  action: string,
  jobId: string,
  details: Record<string, string | number | boolean> = {},
): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details });
}

async function readCustomer(tx: CompanyTransaction, companyId: string, jobId: string): Promise<CustomerView> {
  const [row] = await tx
    .select({ name: jobCustomers.name, phone: jobCustomers.phone, email: jobCustomers.email })
    .from(jobCustomers)
    .where(and(eq(jobCustomers.companyId, companyId), eq(jobCustomers.jobId, jobId)));
  return row ?? EMPTY_CUSTOMER;
}

async function readClaim(tx: CompanyTransaction, companyId: string, jobId: string): Promise<ClaimView> {
  const [row] = await tx
    .select({
      carrier: jobClaims.carrier,
      claimNumber: jobClaims.claimNumber,
      policyNumber: jobClaims.policyNumber,
      dateOfLoss: jobClaims.dateOfLoss,
      lossCause: jobClaims.lossCause,
      adjusterName: jobClaims.adjusterName,
      adjusterEmail: jobClaims.adjusterEmail,
      adjusterPhone: jobClaims.adjusterPhone,
      deductible: jobClaims.deductible,
    })
    .from(jobClaims)
    .where(and(eq(jobClaims.companyId, companyId), eq(jobClaims.jobId, jobId)));
  return row ?? EMPTY_CLAIM;
}

async function detailOf(tx: CompanyTransaction, row: JobRow): Promise<JobDetail> {
  return {
    job: jobView(row),
    customer: await readCustomer(tx, row.companyId, row.id),
    claim: await readClaim(tx, row.companyId, row.id),
  };
}

// Moves the job to its next revision under the row lock the caller holds, recording the change id.
async function advance(tx: CompanyTransaction, row: JobRow, changeId: string, address?: string): Promise<JobRow> {
  const [next] = await tx
    .update(jobs)
    .set({
      ...(address === undefined ? {} : { propertyAddress: address }),
      revision: sql`${jobs.revision} + 1`,
      lastChangeId: changeId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(jobs.companyId, row.companyId), eq(jobs.id, row.id)))
    .returning();
  return next!;
}

function sameValues<T extends Record<string, unknown>>(stored: T, input: Record<string, unknown>): boolean {
  return Object.keys(stored).every((key) => stored[key] === input[key]);
}

// The list's cursor is the last row's creation time as the database wrote it (microseconds, which
// a JavaScript Date would round) and its id: a keyset, so a page never repeats or skips a row that
// is added meanwhile.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(time: string, id: string): string {
  return Buffer.from(`${time}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { time: string; id: string } {
  const [time, id, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (rest.length > 0 || !time || !id || !CURSOR_TIME.test(time) || !CURSOR_ID.test(id)) throw new JobError('invalid_request');
  return { time, id };
}

export function jobsService(db: Database, drafts: DraftStore): JobsService {
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) throw new JobError('invalid_request');
      throw error;
    }
  }

  return {
    async create(caller, input) {
      need(caller, CREATE);
      const digest = createDigest(input);
      // Whoever does field work owns the field work of the job they start; an office user starts a
      // job with no owner (S5b-1 gives it one on first capture).
      const owner = hasAny(caller, ['scope']) ? caller.actorId : null;
      const made = await inCompany(caller.companyId, async (tx) => {
        const [inserted] = await tx
          .insert(jobs)
          .values({
            id: input.id,
            companyId: caller.companyId,
            createdByActorId: caller.actorId,
            fieldOwnerActorId: owner,
            currentDraftId: input.draftId,
            propertyAddress: input.propertyAddress,
            requestDigest: digest,
          })
          // The same id, or a draft id another job holds, makes no second row.
          .onConflictDoNothing()
          .returning();
        let row = inserted;
        if (!row) {
          const [existing] = await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, input.id)));
          // No such job: the draft id is another job's. Same id: it is a retry only when the body is
          // the same and the caller may see that job.
          if (!existing || existing.requestDigest !== digest || !canSeeJob(caller, existing)) throw new JobError('conflict');
          if (existing.status === 'archived') throw new JobError('archived');
          row = existing;
        } else {
          await audit(tx, caller, 'job_created', row.id, { revision: row.revision });
        }
        let ownerUid: string | null = null;
        if (row.fieldOwnerActorId) {
          const [actor] = await tx
            .select({ uid: actors.uid })
            .from(actors)
            .where(and(eq(actors.companyId, caller.companyId), eq(actors.id, row.fieldOwnerActorId)));
          ownerUid = actor?.uid ?? null;
        }
        return { created: inserted !== undefined, ownerUid, detail: await detailOf(tx, row) };
      });
      try {
        await drafts.ensure(caller.companyId, input.draftId, made.ownerUid);
        await drafts.projectJob(caller.companyId, made.detail.job.id, {
          currentDraftId: made.detail.job.currentDraftId, revision: made.detail.job.revision,
        });
      } catch (error) {
        // Fixed text only: the SDK's message may quote a path.
        console.error('job draft unavailable', error instanceof Error ? error.name : 'unknown');
        throw new JobError('draft_unavailable');
      }
      return { created: made.created, detail: made.detail };
    },

    async list(caller, query) {
      need(caller, READ);
      // An estimator lists their own jobs only; asking for the company's is refused, not narrowed.
      const everyone = seesEveryJob(caller);
      if (query.scope === 'company' && !everyone) throw new JobError('not_allowed');
      const company = query.scope === 'company' || (query.scope === null && everyone);
      const after = query.cursor === null ? null : decodeCursor(query.cursor);
      return inCompany(caller.companyId, async (tx) => {
        const where: SQL[] = [eq(jobs.companyId, caller.companyId), ne(jobs.status, 'archived')];
        if (!company) where.push(or(eq(jobs.createdByActorId, caller.actorId), eq(jobs.fieldOwnerActorId, caller.actorId))!);
        if (after) {
          where.push(
            or(
              sql`${jobs.createdAt} < ${after.time}::timestamptz`,
              and(sql`${jobs.createdAt} = ${after.time}::timestamptz`, sql`${jobs.id} > ${after.id}::uuid`),
            )!,
          );
        }
        const rows = await tx
          .select({
            job: jobs,
            // As the database wrote it, so the next page starts exactly after this row.
            createdKey: sql<string>`${jobs.createdAt}::text`,
            customerName: jobCustomers.name,
          })
          .from(jobs)
          .leftJoin(jobCustomers, and(eq(jobCustomers.companyId, jobs.companyId), eq(jobCustomers.jobId, jobs.id)))
          .where(and(...where))
          .orderBy(desc(jobs.createdAt), asc(jobs.id))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return {
          jobs: page.map(({ job, customerName }) => ({
            id: job.id,
            status: job.status,
            propertyAddress: job.propertyAddress,
            revision: job.revision,
            createdAt: job.createdAt.toISOString(),
            updatedAt: job.updatedAt.toISOString(),
            customerName: customerName ?? '',
            mine: isOwnJob(caller, job),
          })),
          nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdKey, last.job.id) : null,
        };
      });
    },

    async read(caller, jobId) {
      need(caller, READ);
      const detail = await inCompany(caller.companyId, async (tx) => detailOf(tx, await jobAccess(tx, caller, jobId, READ)));
      // Lazy population repairs existing jobs on an authorized online open; no bulk backfill.
      try {
        await drafts.projectJob(caller.companyId, jobId, {
          currentDraftId: detail.job.currentDraftId, revision: detail.job.revision,
        });
      } catch (error) {
        console.error('job projection unavailable', error instanceof Error ? error.name : 'unknown');
        throw new JobError('draft_unavailable');
      }
      return detail;
    },

    async saveCustomer(caller, jobId, input) {
      need(caller, EDIT_CUSTOMER);
      return inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, EDIT_CUSTOMER, { lock: true });
        const stored = await readCustomer(tx, row.companyId, row.id);
        // The same change again (its response was lost): nothing more to do, and no conflict, as
        // long as it says what was saved.
        if (row.lastChangeId === input.changeId) {
          if (!sameValues(stored, input) || row.propertyAddress !== input.propertyAddress) throw new JobError('conflict');
          return detailOf(tx, row);
        }
        if (row.status === 'signed') throw new JobError('job_signed');
        if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
        await tx
          .insert(jobCustomers)
          .values({ companyId: row.companyId, jobId: row.id, name: input.name, phone: input.phone, email: input.email })
          .onConflictDoUpdate({
            target: [jobCustomers.companyId, jobCustomers.jobId],
            set: { name: input.name, phone: input.phone, email: input.email, updatedAt: sql`now()` },
          });
        const next = await advance(tx, row, input.changeId, input.propertyAddress);
        await audit(tx, caller, 'job_customer_saved', row.id, { revision: next.revision });
        return detailOf(tx, next);
      });
    },

    async saveClaim(caller, jobId, input) {
      need(caller, EDIT_CLAIM);
      return inCompany(caller.companyId, async (tx) => {
        const row = await jobAccess(tx, caller, jobId, EDIT_CLAIM, { lock: true });
        const stored = await readClaim(tx, row.companyId, row.id);
        if (row.lastChangeId === input.changeId) {
          if (!sameValues(stored, input)) throw new JobError('conflict');
          return detailOf(tx, row);
        }
        if (row.status === 'signed') throw new JobError('job_signed');
        if (row.revision !== input.revision) throw new JobError('stale_revision', { revision: row.revision });
        const values = {
          carrier: input.carrier,
          claimNumber: input.claimNumber,
          policyNumber: input.policyNumber,
          dateOfLoss: input.dateOfLoss,
          lossCause: input.lossCause,
          adjusterName: input.adjusterName,
          adjusterEmail: input.adjusterEmail,
          adjusterPhone: input.adjusterPhone,
          deductible: input.deductible,
        };
        await tx
          .insert(jobClaims)
          .values({ companyId: row.companyId, jobId: row.id, ...values })
          .onConflictDoUpdate({ target: [jobClaims.companyId, jobClaims.jobId], set: { ...values, updatedAt: sql`now()` } });
        const next = await advance(tx, row, input.changeId);
        await audit(tx, caller, 'job_claim_saved', row.id, { revision: next.revision });
        return detailOf(tx, next);
      });
    },
  };
}
