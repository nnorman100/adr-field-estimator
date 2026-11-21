import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { auditEvents, companies, jobEstimates, jobPricePins, jobSubmissions, memberships, priceTableVersions, priceTableWorkingCopies } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { priceEstimate, type Estimate, type EstimateJob, type Json } from '@/engine/estimate';
import { contentHash, ENGINE_VERSION, parseTable, type Table } from '@/engine/table';
import type { Capability } from '@/lib/access';
import { canonicalJson } from '@/lib/field/canonical';
import { FieldMapError } from '@/lib/field/inspection';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { approvedFor, pendingCount, pricedExtrasOn, roomNamesOf, withApprovals } from '@/lib/approvals/priced';
import { advance } from '@/lib/jobs/service';
import { readCompanyDocuments, type CompanyDocuments } from '@/lib/profile/documents';
import { readJobDetails, type JobDetails } from '@/lib/submissions/details';
import type { Snapshot } from '@/lib/submissions/snapshot';
import { EstimateError } from './errors';
import { estimateInput, pricingJob, readSnapshot, SnapshotError, type EstimateInput } from './inputs';
import { proposalBytes, proposalOf, revisedLine, type Proposal } from './proposal';
import { estimateView, readStoredEstimate, readStoredProposal, type EstimateRecord, type EstimateView } from './result';
import type { RepriceInput } from './schema';
import { priceText } from './screen';

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

// What the owner's Reprice banner shows (S5b-6, pricing plan S5b-1 "before/after preview"): the
// job's pinned version and the company's newest one, and the job's last submitted record priced from
// each (the scope as last submitted, which may differ from a draft being edited now), with the job
// revision a reprice must name. Only the two totals are priced: no documents, no company profile.
// `reprice` is null when there is nothing to reprice: a signed job, a job never priced, or a job
// already on the newest prices. A version that cannot price the record has no price and carries
// the engine's refusal (its stage); it informs the owner and does not stop the reprice, which the
// server alone decides. Nothing is written.
export type PricedSide = { price: string | null; refused: { stage: string } | null };
export type RepricePreview = {
  job: { revision: number };
  reprice: null | {
    pinned: { version: number } & PricedSide;
    newest: { versionId: string; version: number } & PricedSide;
  };
};

// The job and its pin after a reprice: the pin's sequence and the sequence of the price version it names.
type RepriceResult = { job: EstimateJobState; pin: { sequence: number; version: number } };
// What the reprice's audit row keeps of its answer, so the same change id again is answered as the first time.
type RepriceAnswer = { sequence: number; version: number; job_status: JobRow['status']; job_draft: string; job_revision: number };

export type EstimateJobState = { id: string; status: JobRow['status']; currentDraftId: string; revision: number };

export type EstimatesService = {
  // With the company's `priced_extras` switch on (read in the transaction, under the job's lock), the record's approvals are priced (S5b-8, D5).
  make(caller: JobCaller, jobId: string): Promise<{ created: boolean; job: EstimateJobState; estimate: EstimateView }>;
  read(caller: JobCaller, jobId: string): Promise<{ job: EstimateJobState; estimate: EstimateView | null }>;
  reprice(caller: JobCaller, jobId: string, input: RepriceInput): Promise<RepriceResult>;
  repricePreview(caller: JobCaller, jobId: string): Promise<RepricePreview>;
};

const jobState = (row: JobRow): EstimateJobState => ({ id: row.id, status: row.status, currentDraftId: row.currentDraftId, revision: row.revision });

export type SubmissionRow = { id: string; snapshotBytes: Buffer; snapshotSha256: string };
export type PinRow = { id: string; sequence: number; versionId: string; reason: 'first_price' | 'owner_reprice' };
export type VersionRow = { id: string; sequence: number; content: unknown; contentHash: string; engineVersion: string };

// The committed record of the job's current draft (one per draft, migration 0011), or none.
export async function currentSubmission(tx: CompanyTransaction, companyId: string, job: JobRow): Promise<SubmissionRow | null> {
  const [row] = await tx
    .select({ id: jobSubmissions.id, snapshotBytes: jobSubmissions.snapshotBytes, snapshotSha256: jobSubmissions.snapshotSha256 })
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
  return { id: row.id, snapshotBytes: Buffer.from(row.snapshotBytes), snapshotSha256: row.snapshotSha256 };
}

// Only the id of that record, for a step that never reads the snapshot (the snapshot can be 8 MiB).
export async function currentSubmissionId(tx: CompanyTransaction, companyId: string, job: JobRow): Promise<string | null> {
  const [row] = await tx
    .select({ id: jobSubmissions.id })
    .from(jobSubmissions)
    .where(
      and(
        eq(jobSubmissions.companyId, companyId),
        eq(jobSubmissions.jobId, job.id),
        eq(jobSubmissions.draftId, job.currentDraftId),
        eq(jobSubmissions.status, 'committed'),
        isNotNull(jobSubmissions.snapshotBytes),
        isNotNull(jobSubmissions.snapshotSha256),
      ),
    );
  return row?.id ?? null;
}

// The job's most recently committed record, of any of its drafts, or none.
async function lastSubmission(tx: CompanyTransaction, companyId: string, jobId: string): Promise<{ id: string; snapshotBytes: Buffer } | null> {
  const [row] = await tx
    .select({ id: jobSubmissions.id, snapshotBytes: jobSubmissions.snapshotBytes })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.jobId, jobId), eq(jobSubmissions.status, 'committed')))
    .orderBy(desc(jobSubmissions.decidedAt))
    .limit(1);
  return row?.snapshotBytes ? { id: row.id, snapshotBytes: Buffer.from(row.snapshotBytes) } : null;
}

// Whether the record states the job's property address, customer and claim as they are now: asked
// only at the first price, since Submit stores no revision; from then on the revision decides.
async function detailsCurrent(tx: CompanyTransaction, companyId: string, job: JobRow, snapshot: Snapshot): Promise<boolean> {
  const now = await readJobDetails(tx, companyId, job);
  return canonicalJson(now) === canonicalJson({ job: snapshot.job, customer: snapshot.customer, claim: snapshot.claim });
}

// The job's current pin: the highest sequence.
export async function currentPin(tx: CompanyTransaction, companyId: string, jobId: string): Promise<PinRow | null> {
  const [row] = await tx
    .select({ id: jobPricePins.id, sequence: jobPricePins.sequence, versionId: jobPricePins.versionId, reason: jobPricePins.reason })
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

export async function versionById(tx: CompanyTransaction, companyId: string, id: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.id, id)));
  return row ?? null;
}

// "Current prices" is the highest version number (pricing plan 3.1).
export async function latestVersion(tx: CompanyTransaction, companyId: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(eq(priceTableVersions.companyId, companyId))
    .orderBy(desc(priceTableVersions.sequence))
    .limit(1);
  return row ?? null;
}

// The estimate stored for a record and a pin, with the pin's and its version's sequence numbers.
export type StoredRow = EstimateRecord & { versionId: string; pinId: string };

async function storedEstimate(tx: CompanyTransaction, companyId: string, submissionId: string, pinId: string): Promise<StoredRow | null> {
  const [row] = await tx
    .select({
      id: jobEstimates.id,
      jobId: jobEstimates.jobId,
      submissionId: jobEstimates.submissionId,
      pinId: jobEstimates.pinId,
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
export function versionTable(version: VersionRow): Table {
  let table: Table;
  try {
    table = parseTable(version.content);
  } catch {
    throw new EstimateError('prices_unreadable');
  }
  if (contentHash(table) !== version.contentHash) throw new EstimateError('prices_unreadable');
  return table;
}

// The job's first pin, to the version given (the company's newest published one): made by the first
// estimate, or by the first proposal on the job (S5b-8), under the job's row lock either way, with
// its audit row. Pin rules: sequence 1, reason first_price (migration 0011's trigger checks both).
export async function pinFirstPrice(tx: CompanyTransaction, caller: JobCaller, jobId: string, version: Pick<VersionRow, 'id' | 'sequence'>): Promise<PinRow> {
  const [made] = await tx
    .insert(jobPricePins)
    .values({ companyId: caller.companyId, jobId, sequence: 1, versionId: version.id, reason: 'first_price', pinnedByActorId: caller.actorId })
    .returning({ id: jobPricePins.id, sequence: jobPricePins.sequence, versionId: jobPricePins.versionId, reason: jobPricePins.reason });
  await audit(tx, caller, 'job_price_pinned', jobId, { sequence: made!.sequence, version: version.sequence });
  return made!;
}

async function audit(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, details: Record<string, number | string>): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details });
}

// The owner who reprices, or reads the reprice preview, is still the company's active owner when it commits: the operator's owner
// replacement locks the company row and then the same membership row, so the company row is locked
// first here too (the pin and audit rows need it anyway), and a replacement cannot slip between the
// check and the write.
export async function lockActiveOwner(tx: CompanyTransaction, caller: JobCaller): Promise<void> {
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, caller.companyId)).for('no key update');
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.companyId, caller.companyId), eq(memberships.actorId, caller.actorId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
    .for('update');
  if (!owner) throw new JobError('not_allowed');
}

// A reprice clears the scope confirmation (pricing plan 3): a record of the draft that was the job's
// current one when its pin was last moved by the owner states a confirmation given at the old prices,
// whether the draft was already submitted or still open. Scope is confirmed again on a draft made
// after the move, through Back to editing (which starts it unconfirmed) and Finish.
export async function confirmationPredatesReprice(tx: CompanyTransaction, companyId: string, jobId: string, draftId: string): Promise<boolean> {
  const pin = await currentPin(tx, companyId, jobId);
  if (pin?.reason !== 'owner_reprice') return false;
  const [moved] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.companyId, companyId),
        eq(auditEvents.target, jobId),
        eq(auditEvents.action, 'job_repriced'),
        sql`${auditEvents.details}->>'sequence' = ${String(pin.sequence)}`,
        sql`${auditEvents.details}->>'job_draft' = ${draftId}`,
      ),
    )
    .limit(1);
  return moved !== undefined;
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

// The job priced from a version (with the four documents when the job carries their inputs), refused as the routes answer it.
function priceInput(job: EstimateJob, version: VersionRow): { estimate: Estimate; table: Table } {
  const table = versionTable(version);
  const estimate = priceEstimate(version.content as Json, job);
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

function proposalFor(estimate: Estimate, company: CompanyDocuments, table: Table, submission: SubmissionRow, version: VersionRow, revised: string | null = null): Proposal {
  return proposalOf({
    estimate,
    company,
    showLineBreakdown: table.policy.show_line_breakdown,
    submission: { id: submission.id, snapshotSha256: submission.snapshotSha256 },
    version: { sequence: version.sequence },
    revised,
  });
}

// The revised line of a new estimate (S5b-6, D6), made once, here, and kept in the proposal's bytes:
// a job that already had an estimate (before a reprice, or for an earlier record before Back to
// editing) gets "Revised {date}", with the previous estimate's price when the company's setting, read
// now, shows it. A job's first estimate gets none. (`make` refuses a signed job, so a signed parent's
// price, which `revisedLine` always names, is supplied by the signed-job workflow, S5b-9.)
async function revisedFor(tx: CompanyTransaction, companyId: string, jobId: string, company: CompanyDocuments): Promise<string | null> {
  const [previous] = await tx
    .select({ pricedResult: jobEstimates.pricedResult })
    .from(jobEstimates)
    .where(and(eq(jobEstimates.companyId, companyId), eq(jobEstimates.jobId, jobId)))
    .orderBy(desc(jobEstimates.createdAt), desc(jobEstimates.id))
    .limit(1);
  if (!previous) return null;
  return revisedLine(new Date(), {
    previous: priceText(readStoredEstimate(previous.pricedResult).totals),
    signed: null,
    showPrevious: company.showPreviousPrice === true,
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

// The approvals a stored estimate was priced with (S5b-8): the rows in force on its record and pin
// at the job revision its `estimate_created` audit row names, which cannot change once it exists;
// none when it was priced without any, so a rebuilt copy prices the same work and the same total.
async function pricedWith(tx: CompanyTransaction, companyId: string, row: Pick<StoredRow, 'id' | 'jobId' | 'submissionId' | 'pinId'>) {
  const [made] = await tx
    .select({ revision: sql<string | null>`${auditEvents.details}->>'approvals_revision'` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.companyId, companyId),
        eq(auditEvents.target, row.jobId),
        eq(auditEvents.action, 'estimate_created'),
        sql`${auditEvents.details}->>'estimate' = ${row.id}`,
      ),
    )
    .limit(1);
  const revision = made?.revision == null ? null : Number(made.revision);
  return revision === null ? null : approvedFor(tx, companyId, { submissionId: row.submissionId, jobRevision: revision, pinId: row.pinId });
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
  const approved = await pricedWith(tx, caller.companyId, row);
  const waiting = (await pricedExtrasOn(tx, caller.companyId)) ? pendingCount(approved) : 0;
  if (job.status !== 'submitted' || (revision !== null && revision >= job.revision)) return estimateView(row, caller.capabilities, undefined, waiting);
  const details = await readJobDetails(tx, caller.companyId, job);
  const missing = missingDetails(details);
  if (missing.length) return estimateView(row, caller.capabilities, { missing }, waiting);
  const version = await versionById(tx, caller.companyId, row.versionId);
  if (!version) throw new EstimateError('prices_unreadable');
  const company = await companyDocuments(tx, caller.companyId);
  const record = readSnapshot(submission.snapshotBytes);
  const rebuilt = inputOf({ ...record, ...details }, company).job;
  const { estimate, table } = priceInput(approved ? withApprovals(rebuilt, approved, roomNamesOf(record)) : rebuilt, version);
  const proposal = proposalFor(estimate, company, table, submission, version, readStoredProposal(row.proposalBytes).revised ?? null);
  return estimateView(row, caller.capabilities, { documents: estimate.documents!, proposal, proposalSha256: proposalBytes(proposal).sha256 }, waiting);
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
        if (await confirmationPredatesReprice(tx, caller.companyId, jobId, job.currentDraftId)) throw new EstimateError('scope_not_confirmed');
        if (!input.summary.trim()) throw new EstimateError('summary_missing');
        // The owner's approvals on this record, at the job's revision and pin (S5b-8); none without a pin yet.
        const approved = pin && (await pricedExtrasOn(tx, caller.companyId)) ? await approvedFor(tx, caller.companyId, { submissionId: submission.id, jobRevision: job.revision, pinId: pin.id }) : null;
        const { estimate, table } = priceInput(approved ? withApprovals(input.job, approved, roomNamesOf(snapshot)) : input.job, version);

        const pinned = pin ?? (await pinFirstPrice(tx, caller, jobId, version));

        const revised = await revisedFor(tx, caller.companyId, jobId, company);
        const pricedResult = {
          ...estimate,
          job_revision: (await detailsCurrent(tx, caller.companyId, job, snapshot)) ? job.revision : null,
        };
        const { bytes, sha256 } = proposalBytes(proposalFor(estimate, company, table, submission, version, revised));
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
        await audit(tx, caller, 'estimate_created', jobId, {
          estimate: stored!.id,
          pin: pinned.sequence,
          version: version.sequence,
          lines: estimate.lines.length,
          ...(approved ? { approvals_revision: job.revision } : {}),
        });
        const row: StoredRow = {
          id: stored!.id,
          jobId,
          submissionId: submission.id,
          pinSequence: pinned.sequence,
          versionSequence: version.sequence,
          versionId: version.id,
          pinId: pinned.id,
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
    // published one and the job's revision the one they saw: one new pin row, reason owner_reprice, the
    // job's next revision, and one audit row carrying the change id, the request and the answer, under
    // the job's row lock and the lock Publish takes, so the check and the write cannot interleave with
    // a publish. The estimate of the old pin is no longer the job's current one, so it cannot be
    // signed, and the next estimate is priced from the new pin once scope is confirmed again on a new
    // draft; a job back in editing may be repriced too. The same change id again is answered as the
    // first time with nothing written, and with another body is refused. A refusal writes nothing.
    async reprice(caller, jobId, input) {
      if (!hasAny(caller, REPRICE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await lockActiveOwner(tx, caller);
        const job = await jobAccess(tx, caller, jobId, REPRICE, { lock: true });
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
          const first = done.details as RepriceAnswer & { request_revision: number; request_version_id: string };
          if (first.request_revision !== input.revision || first.request_version_id !== input.versionId) throw new JobError('conflict');
          return { job: { id: jobId, status: first.job_status, currentDraftId: first.job_draft, revision: first.job_revision }, pin: { sequence: first.sequence, version: first.version } };
        }
        if (job.status === 'signed') throw new EstimateError('job_signed');
        if (job.revision !== input.revision) throw new JobError('stale_revision');
        const pin = await currentPin(tx, caller.companyId, jobId);
        if (!pin) throw new EstimateError('not_priced');
        await tx.select({ id: priceTableWorkingCopies.companyId }).from(priceTableWorkingCopies).where(eq(priceTableWorkingCopies.companyId, caller.companyId)).for('update');
        const version = (await latestVersion(tx, caller.companyId))!;
        if (version.id !== input.versionId) throw new EstimateError('prices_superseded');
        if (version.id === pin.versionId) throw new EstimateError('prices_unchanged');
        // A version this server cannot price is never pinned.
        versionTable(version);
        if (version.engineVersion !== ENGINE_VERSION) throw new EstimateError('prices_unreadable');
        const previous = (await versionById(tx, caller.companyId, pin.versionId))!;
        const [made] = await tx
          .insert(jobPricePins)
          .values({ companyId: caller.companyId, jobId, sequence: pin.sequence + 1, versionId: version.id, reason: 'owner_reprice', pinnedByActorId: caller.actorId })
          .returning({ sequence: jobPricePins.sequence });
        const next = await advance(tx, job, input.changeId);
        await audit(tx, caller, 'job_repriced', jobId, {
          sequence: made!.sequence,
          from_version: previous.sequence,
          version: version.sequence,
          change_id: input.changeId,
          request_revision: input.revision,
          request_version_id: input.versionId,
          job_status: next.status,
          job_draft: next.currentDraftId,
          job_revision: next.revision,
        });
        return { job: jobState(next), pin: { sequence: made!.sequence, version: version.sequence } };
      });
    },

    // The job row is locked, so the revision and the last committed record are read as one: Finish
    // commits a record under the same lock, and the revision the owner confirms is the one whose
    // record was priced.
    async repricePreview(caller, jobId) {
      if (!hasAny(caller, REPRICE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await lockActiveOwner(tx, caller);
        const job = await jobAccess(tx, caller, jobId, REPRICE, { lock: true });
        const none: RepricePreview = { job: { revision: job.revision }, reprice: null };
        if (job.status === 'signed') return none;
        const pin = await currentPin(tx, caller.companyId, jobId);
        if (!pin) return none;
        const newest = (await latestVersion(tx, caller.companyId))!;
        if (newest.id === pin.versionId) return none;
        const pinned = (await versionById(tx, caller.companyId, pin.versionId))!;
        // A pinned job always has a committed record: its first price is made with one. It is the
        // current draft's while submitted, the one before Back to editing while a new draft is open.
        const record = (await lastSubmission(tx, caller.companyId, jobId))!;
        let pricing: EstimateJob;
        let rooms: ReadonlyMap<string, string>;
        try {
          const snapshot = readSnapshot(record.snapshotBytes);
          pricing = pricingJob(snapshot);
          rooms = roomNamesOf(snapshot);
        } catch (error) {
          if (error instanceof SnapshotError || error instanceof FieldMapError || error instanceof ZodError) throw new EstimateError('record_unreadable');
          throw error;
        }
        // The pinned side is the pin's stored estimate's own total, approvals and all, never priced
        // again; with no estimate yet, the submitted record's current approvals, as the estimate would
        // take them.
        const [stored] = await tx
          .select({ pricedResult: jobEstimates.pricedResult })
          .from(jobEstimates)
          .where(and(eq(jobEstimates.companyId, caller.companyId), eq(jobEstimates.submissionId, record.id), eq(jobEstimates.pinId, pin.id)));
        const approved =
          !stored && job.status === 'submitted' && (await pricedExtrasOn(tx, caller.companyId))
            ? await approvedFor(tx, caller.companyId, { submissionId: record.id, jobRevision: job.revision, pinId: pin.id })
            : null;
        const priced = (version: VersionRow, withApproved: boolean): PricedSide => {
          try {
            return { price: priceText(priceInput(approved && withApproved ? withApprovals(pricing, approved, rooms) : pricing, version).estimate.totals), refused: null };
          } catch (error) {
            if (error instanceof EstimateError && error.code === 'estimate_refused') return { price: null, refused: { stage: error.extra.stage ?? '' } };
            throw error;
          }
        };
        const pinnedSide: PricedSide = stored ? { price: priceText(readStoredEstimate(stored.pricedResult).totals), refused: null } : priced(pinned, true);
        return {
          job: { revision: job.revision },
          reprice: {
            pinned: { version: pinned.sequence, ...pinnedSide },
            newest: { versionId: newest.id, version: newest.sequence, ...priced(newest, false) },
          },
        };
      });
    },

    // One snapshot reads the job, the stored estimate and its approvals, so a reprice that commits
    // meanwhile (it ends the approvals) cannot change what the rebuilt documents price.
    async read(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          const job = await jobAccess(tx, caller, jobId, READ);
          const none = { job: jobState(job), estimate: null };
          // A job being edited has no current estimate: the review of its last record is void (J4).
          const row = await currentEstimateRow(tx, caller.companyId, job);
          return row ? { job: jobState(job), estimate: await present(tx, caller, job, row, row.submission) } : none;
        },
        { snapshot: true },
      );
    },
  };
}
