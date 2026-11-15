import { and, eq, sql } from 'drizzle-orm';
import { agreements, auditEvents, companies, documentLinks } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { agreementViewById } from '@/lib/agreements/service';
import { signedHow } from '@/lib/agreements/screen';
import type { Capability } from '@/lib/access';
import type { Json } from '@/engine/estimate';
import type { Proposal } from '@/lib/estimates/proposal';
import { hasAny, jobAccess, JobError, type JobCaller } from '@/lib/jobs/access';
import type { PhotoStream, PhotosService } from '@/lib/photos/service';
import { technicianCaller } from './caller';
import { LinkError } from './errors';
import { linkCompany, nextReadCount, nextWindowStart, overLinkLimit } from './lookup';
import { requestDigest, type CreateDocumentLinkInput, type DocumentSet } from './schema';
import { linkTokenSha256, newLinkToken } from './token';

// Read-only document links (docs/plans/S5.md, S5a-11b; detail in S5b-3). Each is bound to one signed
// agreement and one set: the homeowner's (the signed proposal, with who signed, when and how, and the
// photo log) or the adjuster's (the itemized claim, the scope defense letter and the claim). A link is
// made by someone who may present the job for signing (`sign`: owner, estimator) once the job is
// signed, shown once, and sent from their own phone; it works for 30 days, any number of times, until
// it is revoked by the owner or office (`delivery_resend`), or a newer link for the same set replaces
// it. Every read acts as the technician who made it, as they are now, so one who loses the job or
// `sign` disables their links. The page reads only the agreement's stored bytes.

const SIGN: readonly Capability[] = ['sign'];
const READ: readonly Capability[] = ['jobs_read'];
const REVOKE: readonly Capability[] = ['delivery_resend'];

export type DocumentLinkState = 'active' | 'revoked' | 'expired';

export type DocumentLinkView = { id: string; set: DocumentSet; status: DocumentLinkState; createdAt: string; expiresAt: string; endedAt: string | null };

type Signed = { name: string; signedAt: string; how: string };

export type DocumentPage =
  | { set: 'homeowner'; companyName: string; expiresAt: string; signed: Signed; signatureSha256: string; proposalSha256: string; proposal: Proposal; photoLog: Json[] }
  | { set: 'adjuster'; companyName: string; expiresAt: string; signed: Signed; price: Proposal['price']; itemizedClaim: Json[]; letter: string; claim: Json };

export type DocumentLinksService = {
  create(caller: JobCaller, jobId: string, input: CreateDocumentLinkInput): Promise<{ created: boolean; link: DocumentLinkView; token: string }>;
  list(caller: JobCaller, jobId: string): Promise<{ links: DocumentLinkView[] }>;
  revoke(caller: JobCaller, jobId: string, linkId: string): Promise<{ link: DocumentLinkView }>;
  view(tokenSha256: string): Promise<DocumentPage>;
  openSignature(tokenSha256: string): Promise<PhotoStream>;
};

const columns = {
  id: documentLinks.id,
  companyId: documentLinks.companyId,
  jobId: documentLinks.jobId,
  agreementId: documentLinks.agreementId,
  set: documentLinks.documentSet,
  status: documentLinks.status,
  requestDigest: documentLinks.requestDigest,
  createdByActorId: documentLinks.createdByActorId,
  createdAt: documentLinks.createdAt,
  expiresAt: documentLinks.expiresAt,
  endedAt: documentLinks.endedAt,
  expired: sql<boolean>`${documentLinks.expiresAt} <= now()`,
};

type Row = {
  id: string;
  companyId: string;
  jobId: string;
  agreementId: string;
  set: DocumentSet;
  status: 'active' | 'revoked';
  requestDigest: string;
  createdByActorId: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  expired: boolean;
};

const stateOf = (row: Row): DocumentLinkState => (row.status === 'revoked' ? 'revoked' : row.expired ? 'expired' : 'active');

const viewOf = (row: Row): DocumentLinkView => ({
  id: row.id,
  set: row.set,
  status: stateOf(row),
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  endedAt: row.endedAt ? row.endedAt.toISOString() : null,
});

async function rowById(tx: CompanyTransaction, companyId: string, id: string, lock = false): Promise<Row | null> {
  const query = tx.select(columns).from(documentLinks).where(and(eq(documentLinks.companyId, companyId), eq(documentLinks.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return (row as Row | undefined) ?? null;
}

async function audit(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, row: { id: string; set: DocumentSet }): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details: { documentLink: row.id, set: row.set } });
}

export function documentLinksService(db: Database, photos: PhotosService): DocumentLinksService {
  // The link of a token that may still be read, its per-link counter taken in a transaction of its
  // own, and the technician it reads as. Anything else is link_unavailable.
  async function resolve(tokenSha256: string): Promise<{ row: Row; caller: JobCaller }> {
    const companyId = await linkCompany(db, 'document', tokenSha256);
    if (!companyId) throw new LinkError('link_unavailable');
    const row = await withCompany(db, companyId, async (tx) => {
      const [counted] = await tx
        .update(documentLinks)
        .set({ readWindowStart: nextWindowStart(documentLinks.readWindowStart), readCount: nextReadCount(documentLinks.readWindowStart, documentLinks.readCount) })
        .where(and(eq(documentLinks.companyId, companyId), eq(documentLinks.tokenSha256, tokenSha256)))
        .returning({ id: documentLinks.id, readCount: documentLinks.readCount });
      overLinkLimit(counted?.readCount);
      return (await rowById(tx, companyId, counted!.id))!;
    });
    if (stateOf(row) !== 'active') throw new LinkError('link_unavailable');
    const caller = await withCompany(db, companyId, async (tx) => {
      const found = await technicianCaller(tx, companyId, row.createdByActorId);
      if (!found) return null;
      try {
        await jobAccess(tx, found, row.jobId, SIGN);
        return found;
      } catch (error) {
        if (error instanceof JobError) return null;
        throw error;
      }
    });
    if (!caller) throw new LinkError('link_unavailable');
    return { row, caller };
  }

  async function signedRecord(row: Row) {
    return withCompany(db, row.companyId, async (tx) => {
      const found = await agreementViewById(tx, row.companyId, row.agreementId);
      if (!found) throw new LinkError('link_unavailable');
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, row.companyId));
      return { record: found.view.record, companyName: company?.name ?? '' };
    });
  }

  return {
    async create(caller, jobId, input) {
      if (!hasAny(caller, SIGN)) throw new JobError('not_allowed');
      const digest = requestDigest({ jobId, ...input });
      const token = newLinkToken();
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SIGN, { lock: true });
        const existing = await rowById(tx, caller.companyId, input.id, true);
        if (existing) {
          // A retried create: the token nobody saw stops working and a new one is returned.
          if (existing.jobId !== jobId || existing.requestDigest !== digest) throw new LinkError('conflict');
          if (stateOf(existing) !== 'active') throw new LinkError('link_ended');
          await tx
            .update(documentLinks)
            .set({ tokenSha256: linkTokenSha256(token) })
            .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.id, existing.id)));
          await audit(tx, caller, 'document_link_reissued', jobId, existing);
          return { created: false, link: viewOf((await rowById(tx, caller.companyId, existing.id))!), token };
        }
        if (job.status !== 'signed') throw new LinkError('not_signed');
        const [agreement] = await tx
          .select({ id: agreements.id })
          .from(agreements)
          .where(and(eq(agreements.companyId, caller.companyId), eq(agreements.jobId, jobId), eq(agreements.kind, 'original')));
        if (!agreement) throw new LinkError('not_signed');
        // One active link per agreement and set: an older one is revoked.
        await tx
          .update(documentLinks)
          .set({ status: 'revoked', endedByActorId: caller.actorId })
          .where(
            and(
              eq(documentLinks.companyId, caller.companyId),
              eq(documentLinks.agreementId, agreement.id),
              eq(documentLinks.documentSet, input.set),
              eq(documentLinks.status, 'active'),
            ),
          );
        await tx.insert(documentLinks).values({
          id: input.id,
          companyId: caller.companyId,
          jobId,
          agreementId: agreement.id,
          documentSet: input.set,
          tokenSha256: linkTokenSha256(token),
          requestDigest: digest,
          createdByActorId: caller.actorId,
          expiresAt: sql`now() + interval '30 days'`,
        });
        await audit(tx, caller, 'document_link_created', jobId, { id: input.id, set: input.set });
        return { created: true, link: viewOf((await rowById(tx, caller.companyId, input.id))!), token };
      });
    },

    async list(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, READ);
        const rows = await tx
          .select(columns)
          .from(documentLinks)
          .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.jobId, jobId)))
          .orderBy(sql`${documentLinks.createdAt} DESC`, sql`${documentLinks.id} DESC`);
        return { links: (rows as Row[]).map(viewOf) };
      });
    },

    async revoke(caller, jobId, linkId) {
      if (!hasAny(caller, REVOKE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, REVOKE, { lock: true });
        const row = await rowById(tx, caller.companyId, linkId, true);
        if (!row || row.jobId !== jobId) throw new JobError('not_found');
        if (row.status === 'active') {
          await tx
            .update(documentLinks)
            .set({ status: 'revoked', endedByActorId: caller.actorId })
            .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.id, linkId)));
          await audit(tx, caller, 'document_link_revoked', jobId, row);
        }
        return { link: viewOf((await rowById(tx, caller.companyId, linkId))!) };
      });
    },

    async view(tokenSha256) {
      const { row } = await resolve(tokenSha256);
      const { record, companyName } = await signedRecord(row);
      const signed = { name: record.signer.name, signedAt: record.signed_at, how: signedHow(record) };
      const expiresAt = row.expiresAt.toISOString();
      if (row.set === 'homeowner') {
        return {
          set: 'homeowner',
          companyName,
          expiresAt,
          signed,
          signatureSha256: record.signature.sha256,
          proposalSha256: record.proposal_sha256,
          proposal: record.proposal,
          photoLog: record.documents.photo_log,
        };
      }
      return {
        set: 'adjuster',
        companyName,
        expiresAt,
        signed,
        price: record.proposal.price,
        itemizedClaim: record.documents.itemized_claim,
        letter: record.documents.letter,
        claim: record.documents.claim,
      };
    },

    async openSignature(tokenSha256) {
      const { row, caller } = await resolve(tokenSha256);
      // The signature is part of the homeowner's set (the signed proposal) only.
      if (row.set !== 'homeowner') throw new LinkError('link_unavailable');
      const { record } = await signedRecord(row);
      return photos.open(caller, row.jobId, record.signature.id, 'signature');
    },
  };
}
