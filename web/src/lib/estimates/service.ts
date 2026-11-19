import { and, desc, eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { auditEvents, jobEstimates, jobPricePins, jobSubmissions, memberships, priceTableVersions } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { priceEstimate, type Estimate, type Json } from '@/engine/estimate';
import { contentHash, ENGINE_VERSION, parseTable, type Table } from '@/engine/table';
import type { Capability } from '@/lib/access';
import { canonicalJson } from '@/lib/field/canonical';
import { FieldMapError } from '@/lib/field/inspection';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { readCompanyDocuments, type CompanyDocuments } from '@/lib/profile/documents';
import { readJobDetails, type JobDetails } from '@/lib/submissions/details';
import type { Snapshot } from '@/lib/submissions/snapshot';
import { EstimateError } from './errors';
import { estimateInput, readSnapshot, SnapshotError, type EstimateInput } from './inputs';
import { proposalBytes, proposalOf, type Proposal } from './proposal';
import { estimateView, readStoredEstimate, type EstimateRecord, type EstimateView } from './result';
import type { RepriceInput } from './schema';

// The estimate (docs/plans/S5.md S5a-9; pricing plan S5a-2): the job's submitted record priced from
// the job's pinned price version, with the four documents built from the record and the company's
// own document inputs, stored once in job_estimates.
//
// One transaction, under the job's row lock, does it all: the job must be submitted; the record is
// the committed submission of the job's current draft; the pin is the job's newest. With no pin
// yet, the job is pinned to the company's current version here ("pin at first price", Q7), and a
// company with no published version gets "prices not set". The same record and pin always give the
// same row: a retry, or a second phone, finds the stored estimate and is answered with it, so a
// later publish, profile change or engine release never changes an estimate already made. A refusal
// rolls the whole transaction back, the pin included, so a refused request writes nothing.
//
// Only Reprice (S5b-6, the owner) moves a pin; nothing here does. Back to editing makes a new draft,
// so the old estimate no longer answers for the job (the old review is void), and the next Finish
// and review is priced from the same pin.
//
// The customer, the claim and the property address may still be saved while the job is submitted
// (J3); each save advances the job's revision but not its record, which cannot change, and one
// record and pin hold one estimate. So the stored priced result carries the job revision whose
// details it states (none when they had already changed between Finish and the first price), and a
// later save makes the estimate need review: both routes answer the stored prices with the
// documents rebuilt from the current details, never signable, and neither refuses. Only Back to
// editing and Finish make a record, and so an estimate, that can be signed at the new details.

// Making an estimate is the audit (owner, estimator); reading it is any job reader (docs/spec.md 2.3).
const MAKE: readonly Capability[] = ['audit'];
const READ: readonly Capability[] = ['jobs_read'];
// Reprice this draft (S5b-6; pricing plan S5b-1) is the owner's alone.
const REPRICE: readonly Capability[] = ['job_reprice'];

// The job's pin after a reprice: its sequence and the sequence of the price version it names.
type RepriceResult = { repriced: boolean; job: EstimateJobState; pin: { sequence: number; version: number } };

export type EstimateJobState = { id: string; status: JobRow['status']; currentDraftId: string; revision: number };

export type EstimatesService = {
  make(caller: JobCaller, jobId: string): Promise<{ created: boolean; job: EstimateJobState; estimate: EstimateView }>;
  read(caller: JobCaller, jobId: string): Promise<{ job: EstimateJobState; estimate: EstimateView | null }>;
  reprice(caller: JobCaller, jobId: string, input: RepriceInput): Promise<RepriceResult>;
};

const jobState = (row: JobRow): EstimateJobState => ({ id: row.id, status: row.status, currentDraftId: row.currentDraftId, revision: row.revision });

export type SubmissionRow = { id: string; snapshotBytes: Buffer; snapshotSha256: string; decidedAt: Date | null };
type PinRow = { id: string; sequence: number; versionId: string; reason: 'first_price' | 'owner_reprice'; pinnedAt: Date };
type VersionRow = { id: string; sequence: number; content: unknown; contentHash: string; engineVersion: string };

// The committed record of the job's current draft (one per draft, migration 0011), or none.
async function currentSubmission(tx: CompanyTransaction, companyId: string, job: JobRow): Promise<SubmissionRow | null> {
  const [row] = await tx
    .select({ id: jobSubmissions.id, snapshotBytes: jobSubmissions.snapshotBytes, snapshotSha256: jobSubmissions.snapshotSha256, decidedAt: jobSubmissions.decidedAt })
    .from(jobSubmissions)
    .where(
      and(
        eq(jobSubmissions.companyId, companyId),
        eq(jobSubmissions.jobId, job.id),
        eq(jobSubmissions.draftId, job.currentDraftId),
        eq(jobSubmissions.status, 'committed'),
      ),
    );
  if (!row || !row.snapshotBytes || !row.snapshotSha256) return null;
  return { id: row.id, snapshotBytes: Buffer.from(row.snapshotBytes), snapshotSha256: row.snapshotSha256, decidedAt: row.decidedAt };
}

// Whether the record states the job's property address, customer and claim as they are now: asked
// only at the first price, since Submit stores no revision; from then on the revision decides.
async function detailsCurrent(tx: CompanyTransaction, companyId: string, job: JobRow, snapshot: Snapshot): Promise<boolean> {
  const now = await readJobDetails(tx, companyId, job);
  return canonicalJson(now) === canonicalJson({ job: snapshot.job, customer: snapshot.customer, claim: snapshot.claim });
}

// The job's current pin: the highest sequence.
async function currentPin(tx: CompanyTransaction, companyId: string, jobId: string): Promise<PinRow | null> {
  const [row] = await tx
    .select({ id: jobPricePins.id, sequence: jobPricePins.sequence, versionId: jobPricePins.versionId, reason: jobPricePins.reason, pinnedAt: jobPricePins.pinnedAt })
    .from(jobPricePins)
    .where(and(eq(jobPricePins.companyId, companyId), eq(jobPricePins.jobId, jobId)))
    .orderBy(desc(jobPricePins.sequence))
    .limit(1);
  return row ?? null;
}

const versionColumns = {
  id: priceTableVersions.id,
  sequence: priceTableVersions.sequence,
  content: priceTableVersions.content,
  contentHash: priceTableVersions.contentHash,
  engineVersion: priceTableVersions.engineVersion,
};

async function versionById(tx: CompanyTransaction, companyId: string, id: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.id, id)));
  return row ?? null;
}

// "Current prices" is the highest version number (pricing plan 3.1).
async function latestVersion(tx: CompanyTransaction, companyId: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(eq(priceTableVersions.companyId, companyId))
    .orderBy(desc(priceTableVersions.sequence))
    .limit(1);
  return row ?? null;
}

// The estimate stored for a record and a pin, with the pin's and its version's sequence numbers.
export type StoredRow = EstimateRecord & { versionId: string };

async function storedEstimate(tx: CompanyTransaction, companyId: string, submissionId: string, pinId: string): Promise<StoredRow | null> {
  const [row] = await tx
    .select({
      id: jobEstimates.id,
      jobId: jobEstimates.jobId,
      submissionId: jobEstimates.submissionId,
      pinSequence: jobPricePins.sequence,
      versionSequence: priceTableVersions.sequence,
      versionId: priceTableVersions.id,
      tableHash: jobEstimates.tableHash,
      engineVersion: jobEstimates.engineVersion,
      pricedResult: jobEstimates.pricedResult,
      proposalBytes: jobEstimates.proposalBytes,
      proposalSha256: jobEstimates.proposalSha256,
      createdAt: jobEstimates.createdAt,
    })
    .from(jobEstimates)
    .innerJoin(jobPricePins, and(eq(jobPricePins.companyId, jobEstimates.companyId), eq(jobPricePins.id, jobEstimates.pinId)))
    .innerJoin(priceTableVersions, and(eq(priceTableVersions.companyId, jobPricePins.companyId), eq(priceTableVersions.id, jobPricePins.versionId)))
    .where(and(eq(jobEstimates.companyId, companyId), eq(jobEstimates.submissionId, submissionId), eq(jobEstimates.pinId, pinId)));
  return row ?? null;
}

// The pinned version's table, read through the one schema with its hash checked, as the Prices API
// reads a version. A table that does not parse or match its hash is never priced from.
function versionTable(version: VersionRow): Table {
  let table: Table;
  try {
    table = parseTable(version.content);
  } catch {
    throw new EstimateError('prices_unreadable');
  }
  if (contentHash(table) !== version.contentHash) throw new EstimateError('prices_unreadable');
  return table;
}

async function audit(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, details: Record<string, number | string>): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details });
}

// The owner who reprices is still the company's active owner when it commits: the operator's owner
// replacement locks the same membership row, so a replacement cannot slip between the check and the write.
async function lockActiveOwner(tx: CompanyTransaction, caller: JobCaller): Promise<void> {
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.companyId, caller.companyId), eq(memberships.actorId, caller.actorId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
    .for('update');
  if (!owner) throw new JobError('not_allowed');
}

// The company's document inputs; settings that do not read through their schema are never used.
async function companyDocuments(tx: CompanyTransaction, companyId: string): Promise<CompanyDocuments> {
  let company: CompanyDocuments | null;
  try {
    company = await readCompanyDocuments(tx, companyId);
  } catch (error) {
    if (error instanceof ZodError) throw new EstimateError('settings_unreadable');
    throw error;
  }
  if (!company) throw new JobError('not_found');
  return company;
}

// The engine's input for a record and the company's document inputs.
function inputOf(snapshot: Snapshot, company: CompanyDocuments): EstimateInput {
  try {
    return estimateInput(snapshot, company);
  } catch (error) {
    if (error instanceof SnapshotError || error instanceof FieldMapError || error instanceof ZodError) throw new EstimateError('record_unreadable');
    throw error;
  }
}

// The input priced from a version with the four documents, refused as the routes answer it.
function priceInput(input: EstimateInput, version: VersionRow): { estimate: Estimate; table: Table } {
  const table = versionTable(version);
  const estimate = priceEstimate(version.content as Json, input.job);
  if (!estimate.ok) {
    if (estimate.stage === 'table') throw new EstimateError('prices_unreadable');
    throw new EstimateError('estimate_refused', { stage: estimate.stage, message: estimate.error });
  }
  // A version priced by other formulas than this server's is refused, never priced by these
  // (pricing plan 3.5: an unknown engine version is refused).
  if (estimate.engine_version !== version.engineVersion || estimate.table_sha256 !== version.contentHash) {
    throw new EstimateError('prices_unreadable');
  }
  return { estimate, table };
}

function proposalFor(estimate: Estimate, company: CompanyDocuments, table: Table, submission: SubmissionRow, version: VersionRow): Proposal {
  return proposalOf({
    estimate,
    company,
    showLineBreakdown: table.policy.show_line_breakdown,
    submission: { id: submission.id, snapshotSha256: submission.snapshotSha256 },
    version: { sequence: version.sequence },
  });
}

/**
 * The job's current estimate as stored: the one for the committed record of its current draft and
 * its newest pin, or null when there is none (a job being edited, or not priced yet). Signing binds
 * only to this one, so a new record or pin voids an older estimate for signing.
 */
export async function currentEstimateRow(tx: CompanyTransaction, companyId: string, job: JobRow): Promise<(StoredRow & { submission: SubmissionRow }) | null> {
  if (job.status !== 'submitted' && job.status !== 'signed') return null;
  const submission = await currentSubmission(tx, companyId, job);
  const pin = await currentPin(tx, companyId, job.id);
  if (!submission || !pin) return null;
  const row = await storedEstimate(tx, companyId, submission.id, pin.id);
  return row ? { ...row, submission } : null;
}

// The details the documents cannot be built without that a save after Finish can take away (the
// year built and the rooms are the record's own), in plain words.
function missingDetails(details: JobDetails): string[] {
  return details.job.propertyAddress.trim() ? [] : ['Property address is missing'];
}

// What a caller is shown of a stored estimate. On a submitted job whose revision is past the one the
// estimate states, the documents are rebuilt from the record with the current details and the
// stored version, so the prices are the stored ones, and they need review and cannot be signed.
// The record was already priced, so nothing about the details refuses: with a detail missing the
// answer is the stored prices and what is missing, with no documents.
async function present(tx: CompanyTransaction, caller: JobCaller, job: JobRow, row: StoredRow, submission: SubmissionRow): Promise<EstimateView> {
  const revision = readStoredEstimate(row.pricedResult).job_revision;
  if (job.status !== 'submitted' || (revision !== null && revision >= job.revision)) return estimateView(row, caller.capabilities);
  const details = await readJobDetails(tx, caller.companyId, job);
  const missing = missingDetails(details);
  if (missing.length) return estimateView(row, caller.capabilities, { missing });
  const version = await versionById(tx, caller.companyId, row.versionId);
  if (!version) throw new EstimateError('prices_unreadable');
  const company = await companyDocuments(tx, caller.companyId);
  const { estimate, table } = priceInput(inputOf({ ...readSnapshot(submission.snapshotBytes), ...details }, company), version);
  const proposal = proposalFor(estimate, company, table, submission, version);
  return estimateView(row, caller.capabilities, { documents: estimate.documents!, proposal, proposalSha256: proposalBytes(proposal).sha256 });
}

export function estimatesService(db: Database): EstimatesService {
  return {
    async make(caller, jobId) {
      if (!hasAny(caller, MAKE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, MAKE, { lock: true });
        if (job.status === 'signed') throw new EstimateError('job_signed');
        if (job.status !== 'submitted') throw new EstimateError('not_submitted');
        const submission = await currentSubmission(tx, caller.companyId, job);
        if (!submission) throw new EstimateError('not_submitted');
        let snapshot: Snapshot;
        try {
          snapshot = readSnapshot(submission.snapshotBytes);
        } catch (error) {
          if (error instanceof SnapshotError) throw new EstimateError('record_unreadable');
          throw error;
        }

        const pin = await currentPin(tx, caller.companyId, jobId);
        if (pin) {
          const existing = await storedEstimate(tx, caller.companyId, submission.id, pin.id);
          if (existing) return { created: false, job: jobState(job), estimate: await present(tx, caller, job, existing, submission) };
        }
        const version = pin ? await versionById(tx, caller.companyId, pin.versionId) : await latestVersion(tx, caller.companyId);
        if (!version) throw new EstimateError('prices_not_set');
        const company = await companyDocuments(tx, caller.companyId);
        const input = inputOf(snapshot, company);
        if (!input.scopeConfirmed) throw new EstimateError('scope_not_confirmed');
        // A reprice clears the scope confirmation (pricing plan 3): a record made before the pin was
        // last moved states a confirmation given at the old prices, so scope is confirmed again on a
        // record made after it, through Back to editing and Finish.
        if (pin?.reason === 'owner_reprice' && !(submission.decidedAt && submission.decidedAt > pin.pinnedAt)) throw new EstimateError('scope_not_confirmed');
        if (!input.summary.trim()) throw new EstimateError('summary_missing');
        const { estimate, table } = priceInput(input, version);

        let pinned = pin;
        if (!pinned) {
          const [made] = await tx
            .insert(jobPricePins)
            .values({ companyId: caller.companyId, jobId, sequence: 1, versionId: version.id, reason: 'first_price', pinnedByActorId: caller.actorId })
            .returning({ id: jobPricePins.id, sequence: jobPricePins.sequence, versionId: jobPricePins.versionId, reason: jobPricePins.reason, pinnedAt: jobPricePins.pinnedAt });
          pinned = made!;
          await audit(tx, caller, 'job_price_pinned', jobId, { sequence: pinned.sequence, version: version.sequence });
        }

        const pricedResult = { ...estimate, job_revision: (await detailsCurrent(tx, caller.companyId, job, snapshot)) ? job.revision : null };
        const { bytes, sha256 } = proposalBytes(proposalFor(estimate, company, table, submission, version));
        const [stored] = await tx
          .insert(jobEstimates)
          .values({
            companyId: caller.companyId,
            jobId,
            submissionId: submission.id,
            pinId: pinned.id,
            tableHash: version.contentHash,
            engineVersion: version.engineVersion,
            pricedResult: pricedResult as unknown as Record<string, unknown>,
            proposalBytes: bytes,
            proposalSha256: sha256,
            createdByActorId: caller.actorId,
          })
          .returning({ id: jobEstimates.id, createdAt: jobEstimates.createdAt });
        await audit(tx, caller, 'estimate_created', jobId, { pin: pinned.sequence, version: version.sequence, lines: estimate.lines.length });
        const row: StoredRow = {
          id: stored!.id,
          jobId,
          submissionId: submission.id,
          pinSequence: pinned.sequence,
          versionSequence: version.sequence,
          versionId: version.id,
          tableHash: version.contentHash,
          engineVersion: version.engineVersion,
          pricedResult,
          proposalBytes: bytes,
          proposalSha256: sha256,
          createdAt: stored!.createdAt,
        };
        return { created: true, job: jobState(job), estimate: await present(tx, caller, job, row, submission) };
      });
    },

    // Moves the job's pin to the version the owner reviewed, which must still be the company's newest
    // published one and the job's revision the one they saw: one new pin row, reason owner_reprice,
    // and one audit row carrying the change id, under the job's row lock. The estimate of the old pin
    // is no longer the job's current one, so it cannot be signed, and the next estimate is priced from
    // the new pin once scope is confirmed again on a new record. The same change id again is answered
    // as the first time with nothing written; a job already on the reviewed version is answered as it
    // is. A refusal writes nothing.
    async reprice(caller, jobId, input) {
      if (!hasAny(caller, REPRICE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, REPRICE, { lock: true });
        await lockActiveOwner(tx, caller);
        const [done] = await tx
          .select({ details: auditEvents.details })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.companyId, caller.companyId),
              eq(auditEvents.target, jobId),
              eq(auditEvents.action, 'job_repriced'),
              sql`${auditEvents.details}->>'change_id' = ${input.changeId}`,
            ),
          );
        if (done) {
          const details = done.details as { sequence: number; version: number };
          return { repriced: true, job: jobState(job), pin: { sequence: details.sequence, version: details.version } };
        }
        if (job.status === 'signed') throw new EstimateError('job_signed');
        if (job.revision !== input.revision) throw new JobError('stale_revision');
        const pin = await currentPin(tx, caller.companyId, jobId);
        if (!pin) throw new EstimateError('not_priced');
        const version = (await latestVersion(tx, caller.companyId))!;
        if (version.id !== input.versionId) throw new EstimateError('prices_superseded');
        if (version.id === pin.versionId) return { repriced: false, job: jobState(job), pin: { sequence: pin.sequence, version: version.sequence } };
        // A version this server cannot price is never pinned.
        versionTable(version);
        if (version.engineVersion !== ENGINE_VERSION) throw new EstimateError('prices_unreadable');
        const previous = (await versionById(tx, caller.companyId, pin.versionId))!;
        const [made] = await tx
          .insert(jobPricePins)
          .values({ companyId: caller.companyId, jobId, sequence: pin.sequence + 1, versionId: version.id, reason: 'owner_reprice', pinnedByActorId: caller.actorId })
          .returning({ sequence: jobPricePins.sequence });
        await audit(tx, caller, 'job_repriced', jobId, { sequence: made!.sequence, from_version: previous.sequence, version: version.sequence, change_id: input.changeId });
        return { repriced: true, job: jobState(job), pin: { sequence: made!.sequence, version: version.sequence } };
      });
    },

    async read(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, READ);
        const none = { job: jobState(job), estimate: null };
        // A job being edited has no current estimate: the review of its last record is void (J4).
        const row = await currentEstimateRow(tx, caller.companyId, job);
        return row ? { job: jobState(job), estimate: await present(tx, caller, job, row, row.submission) } : none;
      });
    },
  };
}
