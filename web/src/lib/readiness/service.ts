import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { companies, companyFeatureFlags, evidenceObjects, jobDrafts, jobSubmissions, memberships } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { ENGINE_VERSION } from '@/engine/table';
import { capabilitiesFor, type Capability } from '@/lib/access';
import { accessFlags, flagsFromRows } from '@/lib/flags';
import { confirmationPredatesReprice } from '@/lib/estimates/service';
import { CanonicalFormError, manifestDigest } from '@/lib/field/canonical';
import { IdentityRefusal } from '@/lib/auth';
import { jobAccess, JobError, hasAny, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { readClaim } from '@/lib/jobs/service';
import { jobPriceTable, PricesUnreadable } from '@/lib/scope-lists/version';
import { checkReadiness, countsEquipment, parseDraft, type ParsedDraft, type PriceState, type SetupReadings } from './check';
import type { ReadinessReader } from './reader';
import { noDryingLog, type SetupReadingSource } from './readings';
import type { ReadinessAnswer, UnavailableReason } from './schema';

// GET /api/jobs/{jobId}/readiness (S5b-11, flag `readiness`): the "Ready to review?" gaps of the job's
// current editing draft. Read-only from end to end: no row, audit event, counter or field document is
// written, and nothing is saved about the answer. Advisory: Finish, Submit, the estimate and signing
// never call this, and a failure here answers "unavailable", so it can never hold any of them up.
//
// 1. Postgres, one read-only snapshot: the caller's access to the job (scope work, as Submit), its
//    state and current draft (a draft with a Submit in progress is not open for editing), its property address and claim, and its price version's area basis.
// 2. The field database: the current draft, its rooms and photo references in one read-only read
//    (reader.ts), only while the draft is this job's and open for editing. The reader is built only
//    now, so a missing field database setting cannot change what step 1 decided.
// 3. Postgres again, one read-only snapshot, after every outcome of step 2: the caller's membership,
//    role and the company's `readiness` switch read again, the access check and the draft's state again
//    (the same function as step 1) and the job
//    unchanged (state, current draft, revision, life-cycle version), the price version unchanged, so
//    the gaps are never those of another draft, other prices or for a caller who lost the job or the
//    switch meanwhile; the draft id this job's when the draft names no job; which photo references name
//    a stored photo; whether the scope confirmation predates a reprice; the drying log's setup reading.
//
// No Postgres transaction is held across the field database read.

// Scope work, the owner and the estimator with the job (docs/ACCESS.md); office is refused (403).
export const READINESS_NEEDS: readonly Capability[] = ['scope'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReadinessService = { read(caller: JobCaller, jobId: string): Promise<ReadinessAnswer> };

/** The job facts both Postgres reads compare: any change means the draft read may be another's. */
const basisOf = (job: JobRow) => ({ status: job.status, currentDraftId: job.currentDraftId, revision: job.revision, fieldRevision: job.fieldRevision });
const sameBasis = (a: JobRow, b: JobRow) => JSON.stringify(basisOf(a)) === JSON.stringify(basisOf(b));

type JobPrices = { prices: PriceState; sequence: number | null };

// The job's applicable price version (its pin, else the company's current one) and what the check needs
// of it. A version that cannot be read is "unavailable"; a database failure is not caught.
async function jobPrices(tx: CompanyTransaction, companyId: string, jobId: string): Promise<JobPrices> {
  try {
    const found = await jobPriceTable(tx, companyId, jobId);
    if (!found) return { prices: { state: 'none' }, sequence: null };
    // A version this server cannot price is as unusable as one that does not parse (the estimate refuses it).
    if (found.engineVersion !== ENGINE_VERSION) return { prices: { state: 'unavailable' }, sequence: null };
    return { prices: { state: 'published', areaBasis: found.table.policy.area_basis }, sequence: found.sequence };
  } catch (error) {
    if (error instanceof PricesUnreadable) return { prices: { state: 'unavailable' }, sequence: null };
    throw error;
  }
}

const sameJobPrices = (a: JobPrices, b: JobPrices) => JSON.stringify(a) === JSON.stringify(b);

// Both Postgres snapshots start here: the caller as they are now, then the job. In this order: the
// company still active, the company's `readiness` switch (off: 404 as the route's switch), the
// membership active (else 403), the role they hold now holding `scope` (else 403, before the job is
// looked at, so office gets 403 even for an archived or missing job), the job's access, then whether
// the job's current draft is open for editing: the job is a draft and no Submit of that draft is pending.
async function recheck(tx: CompanyTransaction, caller: JobCaller, jobId: string): Promise<{ job: JobRow; editing: boolean }> {
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, caller.companyId));
  if (company?.status !== 'active') throw new IdentityRefusal('company_inactive');
  const flags = flagsFromRows(
    await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, caller.companyId)),
  );
  if (!flags.readiness) throw new JobError('not_found');
  const [membership] = await tx
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.companyId, caller.companyId), eq(memberships.actorId, caller.actorId)))
    .orderBy(sql`${memberships.status} = 'active' DESC`, desc(memberships.updatedAt))
    .limit(1);
  if (membership?.status !== 'active') throw new JobError('not_allowed');
  const current: JobCaller = { ...caller, role: membership.role, capabilities: capabilitiesFor(membership.role, accessFlags(flags)) };
  if (!hasAny(current, READINESS_NEEDS)) throw new JobError('not_allowed');
  const job = await jobAccess(tx, current, jobId, READINESS_NEEDS);
  if (job.status !== 'draft') return { job, editing: false };
  const [pending] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, caller.companyId), eq(jobSubmissions.jobId, jobId), eq(jobSubmissions.draftId, job.currentDraftId), eq(jobSubmissions.status, 'pending')))
    .limit(1);
  return { job, editing: pending === undefined };
}

// The drying log's setup reading, only when equipment is counted. A read that fails is not known.
async function setupReading(tx: CompanyTransaction, readings: SetupReadingSource, draft: ParsedDraft['draft'], companyId: string, jobId: string): Promise<SetupReadings> {
  if (!countsEquipment(draft)) return 'unavailable';
  try {
    return await tx.transaction((savepoint) => readings.setupReading(savepoint, companyId, jobId));
  } catch {
    return 'unavailable';
  }
}

// Whether a draft id is this job's in Postgres, read only (the rule of holdDraft in jobs/access.ts,
// without its claim): held by this job in job_drafts, or held by no job and named by no other job's
// submission.
export async function draftIsJobs(tx: CompanyTransaction, companyId: string, jobId: string, draftId: string): Promise<boolean> {
  const [claim] = await tx
    .select({ jobId: jobDrafts.jobId })
    .from(jobDrafts)
    .where(and(eq(jobDrafts.companyId, companyId), eq(jobDrafts.draftId, draftId)));
  if (claim) return claim.jobId === jobId;
  const [other] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.draftId, draftId), ne(jobSubmissions.jobId, jobId)))
    .limit(1);
  return other === undefined;
}

async function storedPhotoIds(tx: CompanyTransaction, companyId: string, jobId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ objectId: evidenceObjects.objectId })
    .from(evidenceObjects)
    .where(and(eq(evidenceObjects.companyId, companyId), eq(evidenceObjects.jobId, jobId), eq(evidenceObjects.kind, 'photo'), inArray(evidenceObjects.objectId, ids)));
  return new Set(rows.map((row) => row.objectId));
}

// What the field read gave: the draft, an answer without gaps, or a failure the route answers 503 for.
// Each is held until the second Postgres snapshot has checked the caller and the job again.
type FieldOutcome = { answer: ReadinessAnswer } | { failed: unknown } | { parsed: ParsedDraft; fieldSha256: string; stamped: boolean };

export function readinessService(db: Database, reader: () => ReadinessReader, readings: SetupReadingSource = noDryingLog): ReadinessService {
  return {
    async read(caller, jobId) {
      const companyId = caller.companyId;
      const unavailable = (reason: UnavailableReason): ReadinessAnswer => ({ status: 'unavailable', jobId, reason });

      const before = await withCompany(
        db,
        companyId,
        async (tx) => {
          const { job, editing } = await recheck(tx, caller, jobId);
          if (!editing) return { job, facts: null };
          return {
            job,
            facts: { propertyAddress: job.propertyAddress, claim: await readClaim(tx, companyId, jobId), price: await jobPrices(tx, companyId, jobId) },
          };
        },
        { snapshot: true },
      );
      if (before.facts === null) return unavailable('not_editing');
      const { job, facts } = before;
      const draftId = job.currentDraftId;

      const field = await (async (): Promise<FieldOutcome> => {
        let read;
        try {
          read = await reader().readEditing(companyId, jobId, draftId);
        } catch (error) {
          // Fixed text only: the SDK's message may quote a path.
          console.error('readiness field read unavailable', error instanceof Error ? error.name : 'unknown');
          return { answer: unavailable('field_unavailable') };
        }
        if (read.outcome === 'not_editing') return { answer: unavailable('not_editing') };
        if (read.outcome !== 'read') return { answer: unavailable('draft_unreadable') };
        const parsed = parseDraft(read.manifest);
        if (!parsed) return { answer: unavailable('draft_unreadable') };
        try {
          return { parsed, fieldSha256: await manifestDigest(read.manifest), stamped: read.stamped };
        } catch (error) {
          if (error instanceof CanonicalFormError) return { answer: unavailable('draft_unreadable') };
          return { failed: error };
        }
      })();

      const after = await withCompany(
        db,
        companyId,
        async (tx) => {
          const { job: now, editing } = await recheck(tx, caller, jobId);
          if (!editing) return unavailable('not_editing');
          if (!sameBasis(job, now) || !sameJobPrices(facts.price, await jobPrices(tx, companyId, jobId))) return unavailable('draft_changed');
          if ('failed' in field) throw field.failed;
          if ('answer' in field) return field.answer;
          const { parsed, fieldSha256, stamped } = field;
          if (!stamped && !(await draftIsJobs(tx, companyId, jobId, draftId))) return unavailable('draft_unreadable');
          const photoIds = parsed.photos.map((photo) => photo.id).filter((id) => UUID.test(id));
          return {
            parsed,
            fieldSha256,
            stored: await storedPhotoIds(tx, companyId, jobId, photoIds),
            scopeStale: await confirmationPredatesReprice(tx, companyId, jobId, draftId),
            setup: await setupReading(tx, readings, parsed.draft, companyId, jobId),
          };
        },
        { snapshot: true },
      );
      if ('status' in after) return after;

      const { parsed, fieldSha256 } = after;
      const result = checkReadiness({
        propertyAddress: facts.propertyAddress,
        claim: facts.claim,
        prices: facts.price.prices,
        draft: after.scopeStale ? { ...parsed.draft, scopeConfirmed: false } : parsed.draft,
        rooms: parsed.rooms,
        photos: parsed.photos.filter((photo) => after.stored.has(photo.id)).map((photo) => photo.field),
        setupReadings: after.setup,
      });
      const ready = result.gaps.length === 0 && result.unavailable.every((check) => check === 'ocr');
      return { status: 'checked', jobId, draftId, jobRevision: job.revision, fieldSha256, ready, ...result };
    },
  };
}
