import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { actors, agreements, auditEvents, evidenceObjects, jobs } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { companySetupMissing } from '@/engine/company-setup';
import type { Capability } from '@/lib/access';
import { hasSigningTexts } from '@/lib/estimates/proposal';
import { readStoredEstimate, readStoredProposal } from '@/lib/estimates/result';
import { currentEstimateRow } from '@/lib/estimates/service';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { documentLinksAtSigning, type IssuedDocumentLink } from '@/lib/links/document-store';
import { readCompanyDocuments } from '@/lib/profile/documents';
import { AgreementError } from './errors';
import { readSignedRecord, SIGNED_FORMAT, signedRecordBytes, type SignedRecord } from './record';
import { signDigest, type SignInput } from './schema';
import type { SignerRole } from './screen';

// Sign on the phone (docs/plans/S5.md, S5a-11). The customer signs the job's current estimate on the
// technician's phone: the signature image is received first through the photo receipt route
// (?kind=signature), then this one transaction, under the job's row lock, makes the agreement:
//
// 1. The same agreement id with the same body is the same agreement (a retry after a lost answer);
//    with another body, or for another job, it is refused.
// 2. The job is submitted and not signed; the company's setup check passes, the start-work
//    authorization and the payment terms included (refused with the check's own list).
// 3. The estimate named is the job's current one: the committed record of its current draft priced
//    at its current pin (so a new record or a reprice voids an older estimate for signing), the
//    proposal hash is the stored one, the estimate does not need review, and its documents are
//    signable with both texts inside the proposal bytes the hash binds.
// 4. The signature was received for this job.
// 5. The agreement row is inserted (insert-only; migration 0011's trigger checks it restates the
//    estimate and that the pin has not moved) with the signed record's bytes, and the job becomes
//    `signed`. One audit row. The agreement's two document links (the homeowner's set and the
//    adjuster's, S5a-11b) are made with it and their tokens answered once, to whoever signed, in
//    the answer that made the agreement only.
//
// Nothing here runs the engine: the prices and documents are the estimate's as stored, and the
// signed page is read from the agreement's own bytes. Who may: `sign` (owner, estimator), on a job
// they can see; there is no owner gate before signing (J2). A signing link (S5a-11b) signs through
// the same transaction as the technician who made it, with a LinkClaim (below).

const SIGN: readonly Capability[] = ['sign'];
const READ: readonly Capability[] = ['jobs_read'];

export type AgreementJobState = { id: string; status: JobRow['status']; revision: number };

export type AgreementView = {
  id: string;
  jobId: string;
  signedAt: string;
  // SHA-256 of the stored bytes the record below was read from.
  documentsSha256: string;
  record: SignedRecord;
};

export type AgreementsService = {
  sign(caller: JobCaller, jobId: string, input: SignInput): Promise<SignResult>;
  read(caller: JobCaller, jobId: string): Promise<{ job: AgreementJobState; agreement: AgreementView | null }>;
};

const jobState = (row: JobRow): AgreementJobState => ({ id: row.id, status: row.status, revision: row.revision });

type AgreementRow = { id: string; jobId: string; requestDigest: string; documentsBytes: Buffer; signedAt: Date };

const agreementColumns = {
  id: agreements.id,
  jobId: agreements.jobId,
  requestDigest: agreements.requestDigest,
  documentsBytes: agreements.documentsBytes,
  signedAt: agreements.signedAt,
};

function viewOf(row: AgreementRow): AgreementView {
  const bytes = Buffer.from(row.documentsBytes);
  return {
    id: row.id,
    jobId: row.jobId,
    signedAt: row.signedAt.toISOString(),
    documentsSha256: createHash('sha256').update(bytes).digest('hex'),
    record: readSignedRecord(bytes),
  };
}

async function agreementById(tx: CompanyTransaction, companyId: string, id: string): Promise<AgreementRow | null> {
  const [row] = await tx.select(agreementColumns).from(agreements).where(and(eq(agreements.companyId, companyId), eq(agreements.id, id)));
  return row ? { ...row, documentsBytes: Buffer.from(row.documentsBytes) } : null;
}

/** An agreement of the company by id, as its stored record, or null (a signing link's own, S5a-11b). */
export async function agreementViewById(tx: CompanyTransaction, companyId: string, id: string): Promise<{ jobId: string; requestDigest: string; view: AgreementView } | null> {
  const row = await agreementById(tx, companyId, id);
  return row ? { jobId: row.jobId, requestDigest: row.requestDigest, view: viewOf(row) } : null;
}

// The job's original agreement: one per job (migration 0011). Change orders and revised estimates
// (S5b-9) add their own kinds.
async function originalOf(tx: CompanyTransaction, companyId: string, jobId: string): Promise<AgreementRow | null> {
  const [row] = await tx
    .select(agreementColumns)
    .from(agreements)
    .where(and(eq(agreements.companyId, companyId), eq(agreements.jobId, jobId), eq(agreements.kind, 'original')));
  return row ? { ...row, documentsBytes: Buffer.from(row.documentsBytes) } : null;
}

async function signatureOf(tx: CompanyTransaction, companyId: string, jobId: string, objectId: string) {
  const [row] = await tx
    .select({ id: evidenceObjects.id, sha256: evidenceObjects.sha256, contentType: evidenceObjects.contentType })
    .from(evidenceObjects)
    .where(
      and(
        eq(evidenceObjects.companyId, companyId),
        eq(evidenceObjects.jobId, jobId),
        eq(evidenceObjects.objectId, objectId),
        eq(evidenceObjects.kind, 'signature'),
      ),
    );
  return row ?? null;
}

// The technician presenting the documents, by the name their sign-in carries, or their sign-in
// email when they have set no name.
async function presenterName(tx: CompanyTransaction, companyId: string, actorId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: actors.displayName, email: actors.email })
    .from(actors)
    .where(and(eq(actors.companyId, companyId), eq(actors.id, actorId)));
  return row?.displayName?.trim() || row?.email || '';
}

// The database's clock for this transaction (now() is the transaction's start), to the millisecond
// so the record's text and the row's signed_at are the same instant.
async function serverTime(tx: CompanyTransaction): Promise<Date> {
  const rows = (await tx.execute(sql`SELECT date_trunc('milliseconds', now()) AS now`)) as unknown as Array<{ now: Date | string }>;
  return new Date(rows[0]!.now);
}

// A signing link (S5a-11b) signing through the same transaction: `check` runs under the job's row
// lock once the estimate is known to be the job's current, signable one, and refuses a link that
// cannot sign it; `consume` runs after the agreement row is inserted and marks the link used.
export type LinkClaim = {
  linkId: string;
  check(tx: CompanyTransaction, estimateId: string): Promise<void>;
  consume(tx: CompanyTransaction, agreementId: string): Promise<void>;
};

export type SignResult = { created: boolean; job: AgreementJobState; agreement: AgreementView; documentLinks: IssuedDocumentLink[] };

/**
 * Steps 2 and 3: the job is submitted and not signed, the company's setup check passes, and the
 * estimate named is the job's current one with the proposal hash shown, not needing review and
 * signable. Making a signing link (S5a-11b) applies the same checks. Run under the job's row lock.
 */
export async function signableEstimate(tx: CompanyTransaction, caller: JobCaller, job: JobRow, estimateId: string, proposalSha256: string) {
  if (job.status === 'signed') throw new AgreementError('already_signed');
  if (job.status !== 'submitted') throw new AgreementError('not_submitted');
  const company = await readCompanyDocuments(tx, caller.companyId);
  if (!company) throw new JobError('not_found');
  const missing = companySetupMissing(company.identity, company.signing);
  if (missing.length) throw new AgreementError('company_setup_missing', { missing });
  // The estimate is the current one, as shown, and signable.
  const estimate = await currentEstimateRow(tx, caller.companyId, job);
  if (!estimate) throw new AgreementError('not_submitted');
  if (estimate.id !== estimateId) throw new AgreementError('estimate_superseded');
  if (estimate.proposalSha256 !== proposalSha256) throw new AgreementError('proposal_changed');
  const stored = readStoredEstimate(estimate.pricedResult);
  if (stored.job_revision === null || stored.job_revision < job.revision) throw new AgreementError('needs_review');
  const proposal = readStoredProposal(estimate.proposalBytes);
  if (!stored.documents.signable || !hasSigningTexts(proposal)) throw new AgreementError('not_signable');
  return { estimate, stored, proposal };
}

/**
 * The one signing transaction (steps 1 to 5 above), for the phone and for a signing link alike.
 * Runs inside the caller's withCompany transaction; `caller` is the technician who signs (on a link,
 * the one who made it, as they are now).
 */
export async function signInTransaction(
  tx: CompanyTransaction,
  caller: JobCaller,
  jobId: string,
  input: SignInput & { signerRole?: SignerRole },
  digest: string,
  link?: LinkClaim,
): Promise<SignResult> {
  const job = await jobAccess(tx, caller, jobId, SIGN, { lock: true });

  // 1. Sent before: the same agreement. Its document links' tokens were answered with the first
  //    answer only; the owner or office replaces one.
  const existing = await agreementById(tx, caller.companyId, input.id);
  if (existing) {
    if (existing.jobId !== jobId || existing.requestDigest !== digest) throw new AgreementError('conflict');
    return { created: false, job: jobState(job), agreement: viewOf(existing), documentLinks: [] };
  }

  // 2 and 3.
  const { estimate, stored, proposal } = await signableEstimate(tx, caller, job, input.estimateId, input.proposalSha256);
  if (link) await link.check(tx, estimate.id);

  // 4. The signature.
  const signature = await signatureOf(tx, caller.companyId, jobId, input.signatureId);
  if (!signature) throw new AgreementError('signature_missing');

  // 5. The agreement, and the job signed.
  const signedAt = await serverTime(tx);
  const record: SignedRecord = {
    format: SIGNED_FORMAT,
    agreement_id: input.id,
    job_id: jobId,
    kind: 'original',
    signed_at: signedAt.toISOString(),
    signer: input.signerRole ? { name: input.signerName, role: input.signerRole } : { name: input.signerName },
    signed_with: link
      ? { kind: 'link', link_id: link.linkId }
      : { kind: 'device', presented_by: { actor_id: caller.actorId, name: await presenterName(tx, caller.companyId, caller.actorId) } },
    signature: { id: input.signatureId, sha256: signature.sha256, content_type: signature.contentType },
    proposal_sha256: estimate.proposalSha256,
    proposal,
    documents: {
      itemized_claim: stored.documents.itemized_claim,
      letter: stored.documents.letter,
      photo_log: stored.documents.photo_log,
      claim: stored.documents.claim,
      compliance_notes: stored.documents.compliance_notes,
    },
    basis: { estimate_id: estimate.id, submission_id: estimate.submissionId },
  };
  const bytes = signedRecordBytes(record);
  const [made] = await tx
    .insert(agreements)
    .values({
      id: input.id,
      companyId: caller.companyId,
      jobId,
      submissionId: estimate.submissionId,
      estimateId: estimate.id,
      kind: 'original',
      signerKind: link ? 'link' : 'device',
      signingLinkId: link ? link.linkId : null,
      signerName: input.signerName,
      signerRole: input.signerRole ?? null,
      signatureEvidenceId: signature.id,
      proposalSha256: estimate.proposalSha256,
      pricedResult: estimate.pricedResult as Record<string, unknown>,
      versionId: estimate.versionId,
      contentHash: estimate.tableHash,
      engineVersion: estimate.engineVersion,
      documentsBytes: bytes,
      requestDigest: digest,
      createdByActorId: caller.actorId,
      signedAt,
    })
    .returning(agreementColumns);
  if (link) await link.consume(tx, input.id);
  const [signed] = await tx
    .update(jobs)
    .set({ status: 'signed', revision: sql`${jobs.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)))
    .returning();
  await tx.insert(auditEvents).values({
    companyId: caller.companyId,
    actorId: caller.actorId,
    action: 'agreement_signed',
    target: jobId,
    details: { pin: estimate.pinSequence, version: estimate.versionSequence, ...(link ? { signingLink: link.linkId } : {}) },
  });
  const documentLinks = await documentLinksAtSigning(tx, caller, jobId, input.id);
  return { created: true, job: jobState(signed!), agreement: viewOf({ ...made!, documentsBytes: Buffer.from(made!.documentsBytes) }), documentLinks };
}

export function agreementsService(db: Database): AgreementsService {
  return {
    async sign(caller, jobId, input) {
      // Refused before anything is read when the role cannot sign.
      if (!hasAny(caller, SIGN)) throw new JobError('not_allowed');
      const digest = signDigest(input);
      return withCompany(db, caller.companyId, (tx) => signInTransaction(tx, caller, jobId, input, digest));
    },

    async read(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, READ);
        const row = await originalOf(tx, caller.companyId, jobId);
        return { job: jobState(job), agreement: row ? viewOf(row) : null };
      });
    },
  };
}
