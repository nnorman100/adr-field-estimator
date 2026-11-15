import { and, eq } from 'drizzle-orm';
import { agreements, companies, documentLinks } from '@/db/schema';
import { withCompany, type Database } from '@/db/tenant';
import { agreementViewById } from '@/lib/agreements/service';
import { signedHow, type SignerRole } from '@/lib/agreements/screen';
import type { Capability } from '@/lib/access';
import type { Json } from '@/engine/estimate';
import type { Proposal } from '@/lib/estimates/proposal';
import { hasAny, jobAccess, JobError, type JobCaller } from '@/lib/jobs/access';
import type { PhotoStream, PhotosService } from '@/lib/photos/service';
import { technicianCaller } from './caller';
import {
  auditDocumentLink,
  documentLinkById,
  documentLinkColumns,
  documentLinksOfJob,
  documentLinkState,
  documentLinkView,
  insertDocumentLink,
  reissueDocumentLink,
  type DocumentLinkRow,
  type DocumentLinkView,
  type IssuedDocumentLink,
} from './document-store';
import { LinkError } from './errors';
import { linkCompany, nextReadCount, nextWindowStart, overLinkLimit } from './lookup';
import { requestDigest, type CreateDocumentLinkInput } from './schema';
import { requireSnapshotPhoto } from './snapshot-photos';

export type { DocumentLinkState, DocumentLinkView } from './document-store';

// Read-only document links (docs/plans/S5.md, S5a-11b; detail in S5b-3). Each is bound to one signed
// agreement and one set: the homeowner's (the signed proposal, with who signed, when and how, and the
// photos) or the adjuster's (the itemized claim, the scope defense letter and the claim). Both are
// made at signing (document-store.ts), their tokens answered once to whoever signed. Each works for
// 30 days, any number of times, until the owner or office (`delivery_resend`) revokes it. Making one
// again for a set: the owner or office, who may replace a working one; whoever may sign (`sign`) only
// once the set has no working link, so making a link never revokes one for someone who may not
// revoke. Every read acts as the person who made it, as they are now, so one who loses the job, or
// both `sign` and `delivery_resend`, disables their links. The page reads only the agreement's
// stored bytes, and photos only from the submitted record behind it.

const READ: readonly Capability[] = ['jobs_read'];
const REVOKE: readonly Capability[] = ['delivery_resend'];
// Who may make a document link, and whose links keep working.
const ISSUE: readonly Capability[] = ['sign', 'delivery_resend'];

type Signed = { name: string; role?: SignerRole; signedAt: string; how: string };

export type DocumentPage =
  | { set: 'homeowner'; companyName: string; expiresAt: string; signed: Signed; signatureSha256: string; proposalSha256: string; proposal: Proposal; photoLog: Json[] }
  | { set: 'adjuster'; companyName: string; expiresAt: string; signed: Signed; price: Proposal['price']; itemizedClaim: Json[]; letter: string; claim: Json };

export type DocumentLinksService = {
  create(caller: JobCaller, jobId: string, input: CreateDocumentLinkInput): Promise<{ created: boolean; links: DocumentLinkView[] } & IssuedDocumentLink>;
  list(caller: JobCaller, jobId: string): Promise<{ links: DocumentLinkView[] }>;
  revoke(caller: JobCaller, jobId: string, linkId: string): Promise<{ link: DocumentLinkView; links: DocumentLinkView[] }>;
  view(tokenSha256: string): Promise<DocumentPage>;
  openSignature(tokenSha256: string): Promise<PhotoStream>;
  openPhoto(tokenSha256: string, photoId: string): Promise<PhotoStream>;
};

export function documentLinksService(db: Database, photos: PhotosService): DocumentLinksService {
  // The link of a token that may still be read, its per-link counter taken in a transaction of its
  // own, and the technician it reads as. Anything else is link_unavailable.
  async function resolve(tokenSha256: string): Promise<{ row: DocumentLinkRow; caller: JobCaller }> {
    const companyId = await linkCompany(db, 'document', tokenSha256);
    if (!companyId) throw new LinkError('link_unavailable');
    const row = await withCompany(db, companyId, async (tx) => {
      const [counted] = await tx
        .update(documentLinks)
        .set({ readWindowStart: nextWindowStart(documentLinks.readWindowStart), readCount: nextReadCount(documentLinks.readWindowStart, documentLinks.readCount) })
        .where(and(eq(documentLinks.companyId, companyId), eq(documentLinks.tokenSha256, tokenSha256)))
        .returning({ id: documentLinks.id, readCount: documentLinks.readCount });
      overLinkLimit(counted?.readCount);
      return (await documentLinkById(tx, companyId, counted!.id))!;
    });
    if (documentLinkState(row) !== 'active') throw new LinkError('link_unavailable');
    const caller = await withCompany(db, companyId, async (tx) => {
      const found = await technicianCaller(tx, companyId, row.createdByActorId, ISSUE);
      if (!found) return null;
      try {
        await jobAccess(tx, found, row.jobId, ISSUE);
        return found;
      } catch (error) {
        if (error instanceof JobError) return null;
        throw error;
      }
    });
    if (!caller) throw new LinkError('link_unavailable');
    return { row, caller };
  }

  async function signedRecord(row: DocumentLinkRow) {
    return withCompany(db, row.companyId, async (tx) => {
      const found = await agreementViewById(tx, row.companyId, row.agreementId);
      if (!found) throw new LinkError('link_unavailable');
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, row.companyId));
      return { record: found.view.record, companyName: company?.name ?? '' };
    });
  }

  return {
    async create(caller, jobId, input) {
      if (!hasAny(caller, ISSUE)) throw new JobError('not_allowed');
      const replaces = hasAny(caller, REVOKE);
      const digest = requestDigest({ jobId, ...input });
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, ISSUE, { lock: true });
        const existing = await documentLinkById(tx, caller.companyId, input.id, true);
        if (existing) {
          // A retried create: a new token, and the old one stops working; only for the owner or office.
          if (existing.jobId !== jobId || existing.requestDigest !== digest) throw new LinkError('conflict');
          if (documentLinkState(existing) !== 'active') throw new LinkError('link_ended');
          const reissued = await reissueDocumentLink(tx, caller, existing);
          return { created: false, ...reissued, links: await documentLinksOfJob(tx, caller.companyId, jobId) };
        }
        if (job.status !== 'signed') throw new LinkError('not_signed');
        const [agreement] = await tx
          .select({ id: agreements.id })
          .from(agreements)
          .where(and(eq(agreements.companyId, caller.companyId), eq(agreements.jobId, jobId), eq(agreements.kind, 'original')));
        if (!agreement) throw new LinkError('not_signed');
        // One active link per agreement and set: a working one is replaced only by someone who may
        // revoke it; one past its 30 days is closed for anyone.
        const active = (await tx
          .select(documentLinkColumns)
          .from(documentLinks)
          .where(
            and(
              eq(documentLinks.companyId, caller.companyId),
              eq(documentLinks.agreementId, agreement.id),
              eq(documentLinks.documentSet, input.set),
              eq(documentLinks.status, 'active'),
            ),
          )
          .for('update')) as DocumentLinkRow[];
        if (!replaces && active.some((row) => documentLinkState(row) === 'active')) throw new LinkError('link_active');
        for (const row of active) {
          await tx
            .update(documentLinks)
            .set({ status: 'revoked', endedByActorId: caller.actorId })
            .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.id, row.id)));
        }
        const made = await insertDocumentLink(tx, caller, { id: input.id, jobId, agreementId: agreement.id, set: input.set, digest });
        return { created: true, ...made, links: await documentLinksOfJob(tx, caller.companyId, jobId) };
      });
    },

    async list(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, READ);
        return { links: await documentLinksOfJob(tx, caller.companyId, jobId) };
      });
    },

    async revoke(caller, jobId, linkId) {
      if (!hasAny(caller, REVOKE)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, REVOKE, { lock: true });
        const row = await documentLinkById(tx, caller.companyId, linkId, true);
        if (!row || row.jobId !== jobId) throw new JobError('not_found');
        if (row.status === 'active') {
          await tx
            .update(documentLinks)
            .set({ status: 'revoked', endedByActorId: caller.actorId })
            .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.id, linkId)));
          await auditDocumentLink(tx, caller, 'document_link_revoked', jobId, row);
        }
        return { link: documentLinkView((await documentLinkById(tx, caller.companyId, linkId))!), links: await documentLinksOfJob(tx, caller.companyId, jobId) };
      });
    },

    async view(tokenSha256) {
      const { row } = await resolve(tokenSha256);
      const { record, companyName } = await signedRecord(row);
      const signed = { name: record.signer.name, ...(record.signer.role ? { role: record.signer.role } : {}), signedAt: record.signed_at, how: signedHow(record) };
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

    async openPhoto(tokenSha256, photoId) {
      const { row, caller } = await resolve(tokenSha256);
      // Photos are part of the homeowner's set only.
      if (row.set !== 'homeowner') throw new LinkError('link_unavailable');
      await withCompany(db, row.companyId, async (tx) => {
        const found = await agreementViewById(tx, row.companyId, row.agreementId);
        if (!found) throw new LinkError('link_unavailable');
        await requireSnapshotPhoto(tx, row.companyId, row.jobId, found.view.record.basis.submission_id, photoId);
      });
      return photos.open(caller, row.jobId, photoId, 'photo');
    },
  };
}
