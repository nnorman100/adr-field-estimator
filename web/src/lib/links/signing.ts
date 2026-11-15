import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, companies, jobEstimates, jobs, signingLinks } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { AgreementError } from '@/lib/agreements/errors';
import { agreementViewById, signableEstimate, signInTransaction, type AgreementView, type LinkClaim } from '@/lib/agreements/service';
import type { Capability } from '@/lib/access';
import type { Json } from '@/engine/estimate';
import type { Proposal } from '@/lib/estimates/proposal';
import { readStoredEstimate, readStoredProposal } from '@/lib/estimates/result';
import { currentEstimateRow } from '@/lib/estimates/service';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import type { PhotoStream, PhotosService, Receipt, ReceiveInput } from '@/lib/photos/service';
import { technicianCaller } from './caller';
import { LinkError } from './errors';
import { linkCompany, nextReadCount, nextWindowStart, overLinkLimit } from './lookup';
import { requestDigest, type CreateSigningLinkInput, type LinkSignInput } from './schema';
import { linkTokenSha256, newLinkToken } from './token';

// Homeowner signing links (docs/plans/S5.md, S5a-11b; detail in S5b-3). The technician makes a link
// for the job's current estimate from Review before signing and sends it from their own phone (copy,
// share sheet or QR; DryScope sends no email or text message). The homeowner opens /sign#token, reads
// the same documents the on-site signing page shows, and signs once. The link acts as the technician
// who made it, as they are now (caller.ts), and signs through S5a-11's one signing transaction, so
// every rule of signing on the phone holds and two simultaneous signatures make one agreement.
//
// A link works for 7 days from when it was made, while it is the job's one pending link and the
// estimate it signs is still the job's current, signable one. A new submission (Back to editing,
// then Finish) or a new estimate voids it; that is found and written when the link is next used,
// and the signing transaction checks it again under the job's row lock. A used link shows the signed
// record for 30 days after signing. Revoked, expired and ended links all answer `link_unavailable`;
// a voided one answers `link_voided`, so the page can say the estimate changed.

const SIGN: readonly Capability[] = ['sign'];
// Signing attempts one link may make: each attempt is a signature sent and a sign request, so the
// counter allows twice the attempts (docs/ACCESS.md: 10 signing attempts per link).
export const SIGN_ATTEMPTS_PER_LINK = 10;
const ATTEMPT_UNITS = SIGN_ATTEMPTS_PER_LINK * 2;
// The signature image a homeowner sends: a drawn PNG is a few tens of KiB.
export const LINK_SIGNATURE_BYTES = 1024 * 1024;

export type SigningLinkState = 'pending' | 'used' | 'revoked' | 'voided' | 'expired';

export type SigningLinkView = {
  id: string;
  estimateId: string;
  status: SigningLinkState;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  endedAt: string | null;
};

// What the homeowner reads before signing: the documents the signed record will hold, as stored with
// the estimate, and nothing else (no staff notes, quantity notes, price rows or engine checks).
export type LinkEstimate = {
  id: string;
  proposalSha256: string;
  proposal: Proposal;
  documents: { itemized_claim: Json[]; letter: string; photo_log: Json[]; claim: Json; compliance_notes: string[] };
};

export type SigningLinkPage =
  | { status: 'pending'; companyName: string; expiresAt: string; estimate: LinkEstimate }
  | { status: 'signed'; companyName: string; viewUntil: string; agreement: AgreementView };

export type SigningLinksService = {
  create(caller: JobCaller, jobId: string, input: CreateSigningLinkInput): Promise<{ created: boolean; link: SigningLinkView; token: string }>;
  current(caller: JobCaller, jobId: string): Promise<{ link: SigningLinkView | null }>;
  revoke(caller: JobCaller, jobId: string): Promise<{ link: SigningLinkView | null }>;
  view(tokenSha256: string): Promise<SigningLinkPage>;
  receiveSignature(tokenSha256: string, signatureId: string, input: ReceiveInput): Promise<{ created: boolean; receipt: Receipt }>;
  openSignature(tokenSha256: string): Promise<PhotoStream>;
  sign(tokenSha256: string, input: LinkSignInput): Promise<{ created: boolean; agreement: AgreementView }>;
};

const linkColumns = {
  id: signingLinks.id,
  companyId: signingLinks.companyId,
  jobId: signingLinks.jobId,
  estimateId: signingLinks.estimateId,
  status: signingLinks.status,
  requestDigest: signingLinks.requestDigest,
  createdByActorId: signingLinks.createdByActorId,
  createdAt: signingLinks.createdAt,
  expiresAt: signingLinks.expiresAt,
  usedAt: signingLinks.usedAt,
  endedAt: signingLinks.endedAt,
  agreementId: signingLinks.agreementId,
  // From the database's clock, as every time rule here is.
  expired: sql<boolean>`${signingLinks.expiresAt} <= now()`,
  viewUntil: sql<Date | null>`${signingLinks.usedAt} + interval '30 days'`,
  viewEnded: sql<boolean>`coalesce(${signingLinks.usedAt} + interval '30 days' <= now(), false)`,
};

type LinkRow = {
  id: string;
  companyId: string;
  jobId: string;
  estimateId: string;
  status: 'pending' | 'used' | 'revoked' | 'voided';
  requestDigest: string;
  createdByActorId: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  endedAt: Date | null;
  agreementId: string | null;
  expired: boolean;
  viewUntil: Date | string | null;
  viewEnded: boolean;
};

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

function viewOf(row: LinkRow, state: SigningLinkState): SigningLinkView {
  return {
    id: row.id,
    estimateId: row.estimateId,
    status: state,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: iso(row.usedAt),
    endedAt: iso(row.endedAt),
  };
}

async function linkById(tx: CompanyTransaction, companyId: string, id: string, lock = false): Promise<LinkRow | null> {
  const query = tx.select(linkColumns).from(signingLinks).where(and(eq(signingLinks.companyId, companyId), eq(signingLinks.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return (row as LinkRow | undefined) ?? null;
}

async function linkOfJob(tx: CompanyTransaction, companyId: string, jobId: string): Promise<LinkRow | null> {
  const [row] = await tx
    .select(linkColumns)
    .from(signingLinks)
    .where(and(eq(signingLinks.companyId, companyId), eq(signingLinks.jobId, jobId)))
    .orderBy(sql`${signingLinks.createdAt} DESC`, sql`${signingLinks.id} DESC`)
    .limit(1);
  return (row as LinkRow | undefined) ?? null;
}

async function jobRow(tx: CompanyTransaction, companyId: string, jobId: string): Promise<JobRow | null> {
  const [row] = await tx.select().from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
  return row ?? null;
}

/**
 * A link's state now: the stored status, or for a pending one whether it expired or was voided (the
 * job is no longer submitted, or its current estimate is another one or needs review). One function
 * for every reader, so no screen shows a dead link as pending.
 */
async function stateOf(tx: CompanyTransaction, row: LinkRow, job?: JobRow | null): Promise<SigningLinkState> {
  if (row.status !== 'pending') return row.status;
  if (row.expired) return 'expired';
  const found = job === undefined ? await jobRow(tx, row.companyId, row.jobId) : job;
  if (!found || found.status !== 'submitted') return 'voided';
  const estimate = await currentEstimateRow(tx, row.companyId, found);
  if (!estimate || estimate.id !== row.estimateId) return 'voided';
  const stored = readStoredEstimate(estimate.pricedResult);
  if (stored.job_revision === null || stored.job_revision < found.revision) return 'voided';
  return 'pending';
}

async function voidLink(tx: CompanyTransaction, companyId: string, id: string): Promise<void> {
  await tx
    .update(signingLinks)
    .set({ status: 'voided' })
    .where(and(eq(signingLinks.companyId, companyId), eq(signingLinks.id, id), eq(signingLinks.status, 'pending')));
}

async function audit(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, linkId: string): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details: { signingLink: linkId } });
}

// A signing refusal as the homeowner's page reads it. A refusal that means the estimate or the job
// moved on voids the link; one that may clear (the company's settings) leaves it as it is.
const VOIDING = new Set(['estimate_superseded', 'proposal_changed', 'needs_review', 'not_submitted']);

export function signingLinksService(db: Database, photos: PhotosService): SigningLinksService {
  // The link of a token, its per-link request counter taken (and, for a signing step, an attempt),
  // in a transaction of its own so a refused request still counts. Unknown: link_unavailable.
  async function resolve(tokenSha256: string, attempt = false): Promise<LinkRow> {
    const companyId = await linkCompany(db, 'signing', tokenSha256);
    if (!companyId) throw new LinkError('link_unavailable');
    return withCompany(db, companyId, async (tx) => {
      const [counted] = await tx
        .update(signingLinks)
        .set({
          readWindowStart: nextWindowStart(signingLinks.readWindowStart),
          readCount: nextReadCount(signingLinks.readWindowStart, signingLinks.readCount),
          // Only a pending link counts attempts; an ended one keeps its count (0014's trigger).
          ...(attempt ? { signAttempts: sql`CASE WHEN ${signingLinks.status} = 'pending' THEN ${signingLinks.signAttempts} + 1 ELSE ${signingLinks.signAttempts} END` } : {}),
        })
        .where(and(eq(signingLinks.companyId, companyId), eq(signingLinks.tokenSha256, tokenSha256)))
        .returning({ id: signingLinks.id, status: signingLinks.status, readCount: signingLinks.readCount, signAttempts: signingLinks.signAttempts });
      overLinkLimit(counted?.readCount);
      if (attempt && counted!.status === 'pending' && counted!.signAttempts > ATTEMPT_UNITS) throw new LinkError('too_many_attempts');
      return (await linkById(tx, companyId, counted!.id))!;
    });
  }

  // The technician the link acts as, with the job as they may see it now; null when they no longer
  // can (the link is then unavailable).
  async function actingFor(tx: CompanyTransaction, row: LinkRow): Promise<{ caller: JobCaller; job: JobRow } | null> {
    const caller = await technicianCaller(tx, row.companyId, row.createdByActorId);
    if (!caller) return null;
    try {
      return { caller, job: await jobAccess(tx, caller, row.jobId, SIGN) };
    } catch (error) {
      if (error instanceof JobError) return null;
      throw error;
    }
  }

  // A pending link that is still the one to sign with, or the reason it is not. Voiding is written
  // in a transaction of its own, after the refusal is known.
  async function requirePending(row: LinkRow): Promise<{ caller: JobCaller; job: JobRow }> {
    const outcome = await withCompany(db, row.companyId, async (tx) => {
      const acting = await actingFor(tx, row);
      if (!acting) return { refuse: 'link_unavailable' as const };
      const state = await stateOf(tx, row, acting.job);
      if (state === 'voided' && row.status === 'pending') await voidLink(tx, row.companyId, row.id);
      if (state === 'voided') return { refuse: 'link_voided' as const };
      if (state !== 'pending') return { refuse: 'link_unavailable' as const };
      return { acting };
    });
    if ('refuse' in outcome) throw new LinkError(outcome.refuse!);
    return outcome.acting;
  }

  async function voidAfterRefusal(row: LinkRow): Promise<void> {
    await withCompany(db, row.companyId, (tx) => voidLink(tx, row.companyId, row.id));
  }

  return {
    async create(caller, jobId, input) {
      if (!hasAny(caller, SIGN)) throw new JobError('not_allowed');
      const digest = requestDigest({ jobId, ...input });
      const token = newLinkToken();
      return withCompany(db, caller.companyId, async (tx) => {
        // The job's row lock first, then the link's, as signing takes them.
        const job = await jobAccess(tx, caller, jobId, SIGN, { lock: true });
        const existing = await linkById(tx, caller.companyId, input.id, true);
        if (existing) {
          // A retried create: the token nobody saw stops working and a new one is returned.
          if (existing.jobId !== jobId || existing.requestDigest !== digest) throw new LinkError('conflict');
          const state = await stateOf(tx, existing, job);
          if (state === 'used') throw new LinkError('already_signed');
          if (state !== 'pending') throw new LinkError('link_ended');
          await tx
            .update(signingLinks)
            .set({ tokenSha256: linkTokenSha256(token) })
            .where(and(eq(signingLinks.companyId, caller.companyId), eq(signingLinks.id, existing.id)));
          await audit(tx, caller, 'signing_link_reissued', jobId, existing.id);
          return { created: false, link: viewOf((await linkById(tx, caller.companyId, existing.id))!, 'pending'), token };
        }
        // The estimate is the job's current, signable one, by the same checks signing applies.
        await signableEstimate(tx, caller, job, input.estimateId, input.proposalSha256);
        // One pending link per job: an older one, expired or not, is revoked.
        await tx
          .update(signingLinks)
          .set({ status: 'revoked', endedByActorId: caller.actorId })
          .where(and(eq(signingLinks.companyId, caller.companyId), eq(signingLinks.jobId, jobId), eq(signingLinks.status, 'pending')));
        const [made] = (await tx.execute(sql`SELECT clock_timestamp()::text AS at`)) as unknown as { at: string }[];
        await tx.insert(signingLinks).values({
          id: input.id,
          companyId: caller.companyId,
          jobId,
          estimateId: input.estimateId,
          tokenSha256: linkTokenSha256(token),
          requestDigest: digest,
          createdByActorId: caller.actorId,
          createdAt: sql`${made!.at}::timestamptz`,
          expiresAt: sql`${made!.at}::timestamptz + interval '7 days'`,
        });
        await audit(tx, caller, 'signing_link_created', jobId, input.id);
        return { created: true, link: viewOf((await linkById(tx, caller.companyId, input.id))!, 'pending'), token };
      });
    },

    async current(caller, jobId) {
      if (!hasAny(caller, SIGN)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SIGN);
        const row = await linkOfJob(tx, caller.companyId, jobId);
        return { link: row ? viewOf(row, await stateOf(tx, row, job)) : null };
      });
    },

    async revoke(caller, jobId) {
      if (!hasAny(caller, SIGN)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SIGN, { lock: true });
        const [ended] = await tx
          .update(signingLinks)
          .set({ status: 'revoked', endedByActorId: caller.actorId })
          .where(and(eq(signingLinks.companyId, caller.companyId), eq(signingLinks.jobId, jobId), eq(signingLinks.status, 'pending')))
          .returning({ id: signingLinks.id });
        if (ended) await audit(tx, caller, 'signing_link_revoked', jobId, ended.id);
        const row = await linkOfJob(tx, caller.companyId, jobId);
        return { link: row ? viewOf(row, await stateOf(tx, row, job)) : null };
      });
    },

    async view(tokenSha256) {
      const row = await resolve(tokenSha256);
      if (row.status === 'revoked') throw new LinkError('link_unavailable');
      if (row.status === 'voided') throw new LinkError('link_voided');
      if (row.status === 'used') {
        if (row.viewEnded || !row.agreementId) throw new LinkError('link_unavailable');
        return withCompany(db, row.companyId, async (tx) => {
          if (!(await actingFor(tx, row))) throw new LinkError('link_unavailable');
          const found = await agreementViewById(tx, row.companyId, row.agreementId!);
          if (!found) throw new LinkError('link_unavailable');
          return { status: 'signed' as const, companyName: await companyName(tx, row.companyId), viewUntil: iso(row.viewUntil)!, agreement: found.view };
        });
      }
      await requirePending(row);
      return withCompany(db, row.companyId, async (tx) => {
        const [estimate] = await tx
          .select({ id: jobEstimates.id, pricedResult: jobEstimates.pricedResult, proposalBytes: jobEstimates.proposalBytes, proposalSha256: jobEstimates.proposalSha256 })
          .from(jobEstimates)
          .where(and(eq(jobEstimates.companyId, row.companyId), eq(jobEstimates.id, row.estimateId)));
        if (!estimate) throw new LinkError('link_unavailable');
        const stored = readStoredEstimate(estimate.pricedResult);
        return {
          status: 'pending' as const,
          companyName: await companyName(tx, row.companyId),
          expiresAt: row.expiresAt.toISOString(),
          estimate: {
            id: estimate.id,
            proposalSha256: estimate.proposalSha256,
            proposal: readStoredProposal(Buffer.from(estimate.proposalBytes)),
            documents: {
              itemized_claim: stored.documents.itemized_claim,
              letter: stored.documents.letter,
              photo_log: stored.documents.photo_log,
              claim: stored.documents.claim,
              compliance_notes: stored.documents.compliance_notes,
            },
          },
        };
      });
    },

    async receiveSignature(tokenSha256, signatureId, input) {
      const row = await resolve(tokenSha256, true);
      if (row.status === 'used') throw new LinkError('already_signed');
      if (row.status === 'voided') throw new LinkError('link_voided');
      if (row.status !== 'pending') throw new LinkError('link_unavailable');
      const { caller } = await requirePending(row);
      return photos.receive(caller, row.jobId, signatureId, 'signature', input);
    },

    async openSignature(tokenSha256) {
      const row = await resolve(tokenSha256);
      if (row.status !== 'used' || row.viewEnded || !row.agreementId) throw new LinkError('link_unavailable');
      const { caller, signatureId } = await withCompany(db, row.companyId, async (tx) => {
        const acting = await actingFor(tx, row);
        const found = acting ? await agreementViewById(tx, row.companyId, row.agreementId!) : null;
        if (!acting || !found) throw new LinkError('link_unavailable');
        return { caller: acting.caller, signatureId: found.view.record.signature.id };
      });
      return photos.open(caller, row.jobId, signatureId, 'signature');
    },

    async sign(tokenSha256, input) {
      let row = await resolve(tokenSha256);
      const digest = requestDigest({ ...input, signingLinkId: row.id });
      // The same request again after the link signed: its own agreement, before any attempt is
      // counted. Only the link's own agreement id is compared, so a caller cannot ask about others.
      if (row.status === 'used') {
        if (row.viewEnded || row.agreementId !== input.id) throw new LinkError(row.viewEnded ? 'link_unavailable' : 'already_signed');
        return withCompany(db, row.companyId, async (tx) => {
          if (!(await actingFor(tx, row))) throw new LinkError('link_unavailable');
          const found = await agreementViewById(tx, row.companyId, row.agreementId!);
          if (!found) throw new LinkError('link_unavailable');
          if (found.requestDigest !== digest) throw new LinkError('conflict');
          return { created: false, agreement: found.view };
        });
      }
      if (row.status === 'voided') throw new LinkError('link_voided');
      if (row.status !== 'pending') throw new LinkError('link_unavailable');
      row = await resolve(tokenSha256, true);

      try {
        return await withCompany(db, row.companyId, async (tx) => {
          const caller = await technicianCaller(tx, row.companyId, row.createdByActorId);
          if (!caller) throw new LinkError('link_unavailable');
          const [estimate] = await tx
            .select({ proposalSha256: jobEstimates.proposalSha256 })
            .from(jobEstimates)
            .where(and(eq(jobEstimates.companyId, row.companyId), eq(jobEstimates.id, row.estimateId)));
          if (!estimate) throw new LinkError('link_unavailable');
          const claim: LinkClaim = {
            linkId: row.id,
            async check(inner, estimateId) {
              const locked = await linkById(inner, row.companyId, row.id, true);
              if (!locked || locked.status === 'revoked' || locked.expired) throw new LinkError('link_unavailable');
              if (locked.status === 'used') throw new LinkError('already_signed');
              if (locked.status === 'voided' || locked.estimateId !== estimateId) throw new AgreementError('estimate_superseded');
            },
            async consume(inner, agreementId) {
              await inner
                .update(signingLinks)
                .set({ status: 'used', agreementId })
                .where(and(eq(signingLinks.companyId, row.companyId), eq(signingLinks.id, row.id)));
            },
          };
          const signed = await signInTransaction(
            tx,
            caller,
            row.jobId,
            { id: input.id, estimateId: row.estimateId, proposalSha256: estimate.proposalSha256, signatureId: input.signatureId, signerName: input.signerName, documentsConfirmed: true },
            digest,
            claim,
          );
          return { created: signed.created, agreement: signed.agreement };
        });
      } catch (error) {
        if (error instanceof AgreementError) {
          if (VOIDING.has(error.code)) {
            await voidAfterRefusal(row);
            throw new LinkError('link_voided');
          }
          if (error.code === 'already_signed') throw new LinkError('already_signed');
          if (error.code === 'conflict') throw new LinkError('conflict');
          if (error.code === 'signature_missing') throw new LinkError('signature_missing');
          if (error.code === 'company_setup_missing' || error.code === 'not_signable') throw new LinkError('link_not_ready');
          throw new LinkError('links_unavailable');
        }
        if (error instanceof JobError) throw new LinkError(error.code === 'invalid_request' ? 'invalid_request' : 'link_unavailable');
        throw error;
      }
    },
  };
}

async function companyName(tx: CompanyTransaction, companyId: string): Promise<string> {
  const [row] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  return row?.name ?? '';
}
