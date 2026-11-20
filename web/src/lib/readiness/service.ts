import { and, eq, inArray, ne } from 'drizzle-orm';
import { evidenceObjects, jobDrafts, jobSubmissions } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { CanonicalFormError, manifestDigest } from '@/lib/field/canonical';
import { jobAccess, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { jobPriceTable, PricesUnreadable } from '@/lib/scope-lists/version';
import { readJobDetails, type JobDetails } from '@/lib/submissions/details';
import { checkReadiness, parseDraft, type PriceState } from './check';
import type { ReadinessReader } from './reader';
import { noDryingLog, type SetupReadingSource } from './readings';
import type { ReadinessAnswer, UnavailableReason } from './schema';

// GET /api/jobs/{jobId}/readiness (S5b-11, flag `readiness`): the "Ready to review?" gaps of the job's
// current editing draft. Read-only from end to end: no row, audit event, counter or field document is
// written, and nothing is saved about the answer. Advisory: Finish, Submit, the estimate and signing
// never call this, and a failure here answers "unavailable", so it can never hold any of them up.
//
// 1. Postgres, one read-only snapshot: the caller's access to the job (scope work, as Submit), its
//    state and current draft, its property address and claim, and its price version's area basis.
// 2. The field database: the current draft, its rooms and photo references in one read-only read
//    (reader.ts), only while the draft is this job's and open for editing.
// 3. Postgres again, one read-only snapshot: the access check again and the job unchanged (state,
//    current draft, revision, life-cycle version), so the gaps are never those of another draft or
//    for a caller who lost the job meanwhile; the draft id this job's when the draft names no job;
//    which photo references name a stored photo; the drying log's setup reading.
//
// No Postgres transaction is held across the field database read.

// Scope work, the owner and the estimator with the job (docs/ACCESS.md); office is refused (403).
export const READINESS_NEEDS: readonly Capability[] = ['scope'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReadinessService = { read(caller: JobCaller, jobId: string): Promise<ReadinessAnswer> };

/** The job facts both Postgres reads compare: any change means the draft read may be another's. */
const basisOf = (job: JobRow) => ({ status: job.status, currentDraftId: job.currentDraftId, revision: job.revision, fieldRevision: job.fieldRevision });
const sameBasis = (a: JobRow, b: JobRow) => JSON.stringify(basisOf(a)) === JSON.stringify(basisOf(b));

async function priceState(tx: CompanyTransaction, companyId: string, jobId: string): Promise<PriceState> {
  try {
    const found = await jobPriceTable(tx, companyId, jobId);
    return found ? { state: 'published', areaBasis: found.table.policy.area_basis } : { state: 'none' };
  } catch (error) {
    if (error instanceof PricesUnreadable) return { state: 'unavailable' };
    throw error;
  }
}

// Whether a draft id is this job's in Postgres, read only (the rule of holdDraft in jobs/access.ts,
// without its claim): held by this job in job_drafts, or held by no job and named by no other job's
// submission.
async function draftIsJobs(tx: CompanyTransaction, companyId: string, jobId: string, draftId: string): Promise<boolean> {
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

export function readinessService(db: Database, reader: ReadinessReader, readings: SetupReadingSource = noDryingLog): ReadinessService {
  return {
    async read(caller, jobId) {
      const companyId = caller.companyId;
      const unavailable = (reason: UnavailableReason): ReadinessAnswer => ({ status: 'unavailable', jobId, reason });

      const before = await withCompany(
        db,
        companyId,
        async (tx): Promise<{ job: JobRow; details: JobDetails; prices: PriceState } | { job: JobRow; details: null; prices: null }> => {
          const job = await jobAccess(tx, caller, jobId, READINESS_NEEDS);
          if (job.status !== 'draft') return { job, details: null, prices: null };
          return { job, details: await readJobDetails(tx, companyId, job), prices: await priceState(tx, companyId, jobId) };
        },
        { snapshot: true },
      );
      if (before.details === null) return unavailable('not_editing');
      const { job, details, prices } = before;
      const draftId = job.currentDraftId;

      let read;
      try {
        read = await reader.readEditing(companyId, jobId, draftId);
      } catch (error) {
        // Fixed text only: the SDK's message may quote a path.
        console.error('readiness field read unavailable', error instanceof Error ? error.name : 'unknown');
        return unavailable('field_unavailable');
      }
      if (read.outcome === 'not_editing') return unavailable('not_editing');
      if (read.outcome !== 'read') return unavailable('draft_unreadable');
      const parsed = parseDraft(read.manifest);
      if (!parsed) return unavailable('draft_unreadable');
      let fieldSha256: string;
      try {
        fieldSha256 = await manifestDigest(read.manifest);
      } catch (error) {
        if (error instanceof CanonicalFormError) return unavailable('draft_unreadable');
        throw error;
      }
      const stamped = read.stamped;
      const photoIds = parsed.photos.map((photo) => photo.id).filter((id) => UUID.test(id));

      const after = await withCompany(
        db,
        companyId,
        async (tx) => {
          const now = await jobAccess(tx, caller, jobId, READINESS_NEEDS);
          if (!sameBasis(job, now)) return 'changed' as const;
          if (!stamped && !(await draftIsJobs(tx, companyId, jobId, draftId))) return 'unreadable' as const;
          return { stored: await storedPhotoIds(tx, companyId, jobId, photoIds), setup: await readings.setupReading(tx, companyId, jobId) };
        },
        { snapshot: true },
      );
      if (after === 'changed') return unavailable('draft_changed');
      if (after === 'unreadable') return unavailable('draft_unreadable');

      const result = checkReadiness({
        propertyAddress: details.job.propertyAddress,
        claim: details.claim,
        prices,
        draft: parsed.draft,
        rooms: parsed.rooms,
        photos: parsed.photos.filter((photo) => after.stored.has(photo.id)).map((photo) => photo.field),
        setupReadings: after.setup,
      });
      return { status: 'checked', jobId, draftId, jobRevision: job.revision, fieldSha256, ready: result.gaps.length === 0, ...result };
    },
  };
}
