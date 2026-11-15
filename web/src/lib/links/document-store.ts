import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, documentLinks } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { hasAny, JobError, type JobCaller } from '@/lib/jobs/access';
import { DOCUMENT_SETS, requestDigest, type DocumentSet } from './schema';
import { linkTokenSha256, newLinkToken } from './token';

// The document_links rows (S5a-11b, migration 0014) as the link services read and write them, and the
// two links the signing transaction makes: one for the homeowner's set and one for the adjuster's,
// made by whoever signs (the technician on the phone, or the one a signing link acts as), with their
// tokens answered once, to whoever signed, with that signature only. The same signing request again
// answers the same agreement and no token: a token is replaced only by the owner or office.

export type DocumentLinkState = 'active' | 'revoked' | 'expired';

export type DocumentLinkView = { id: string; set: DocumentSet; status: DocumentLinkState; createdAt: string; expiresAt: string; endedAt: string | null };

/** A document link with its token, answered once. */
export type IssuedDocumentLink = { link: DocumentLinkView; token: string };

export const documentLinkColumns = {
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

export type DocumentLinkRow = {
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

export const documentLinkState = (row: DocumentLinkRow): DocumentLinkState => (row.status === 'revoked' ? 'revoked' : row.expired ? 'expired' : 'active');

export const documentLinkView = (row: DocumentLinkRow): DocumentLinkView => ({
  id: row.id,
  set: row.set,
  status: documentLinkState(row),
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  endedAt: row.endedAt ? row.endedAt.toISOString() : null,
});

export async function documentLinkById(tx: CompanyTransaction, companyId: string, id: string, lock = false): Promise<DocumentLinkRow | null> {
  const query = tx.select(documentLinkColumns).from(documentLinks).where(and(eq(documentLinks.companyId, companyId), eq(documentLinks.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return (row as DocumentLinkRow | undefined) ?? null;
}

export async function auditDocumentLink(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, row: { id: string; set: DocumentSet }): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details: { documentLink: row.id, set: row.set } });
}

export async function insertDocumentLink(
  tx: CompanyTransaction,
  caller: JobCaller,
  values: { id: string; jobId: string; agreementId: string; set: DocumentSet; digest: string },
): Promise<IssuedDocumentLink> {
  const token = newLinkToken();
  await tx.insert(documentLinks).values({
    id: values.id,
    companyId: caller.companyId,
    jobId: values.jobId,
    agreementId: values.agreementId,
    documentSet: values.set,
    tokenSha256: linkTokenSha256(token),
    requestDigest: values.digest,
    createdByActorId: caller.actorId,
    expiresAt: sql`now() + interval '30 days'`,
  });
  await auditDocumentLink(tx, caller, 'document_link_created', values.jobId, values);
  return { link: documentLinkView((await documentLinkById(tx, caller.companyId, values.id))!), token };
}

// A link's token replaced: the old one stops working, and the new one is answered once. Replacing a
// token revokes the old one, so only the owner or office (`delivery_resend`) may.
export async function reissueDocumentLink(tx: CompanyTransaction, caller: JobCaller, row: DocumentLinkRow): Promise<IssuedDocumentLink> {
  if (!hasAny(caller, ['delivery_resend'])) throw new JobError('not_allowed');
  const token = newLinkToken();
  await tx
    .update(documentLinks)
    .set({ tokenSha256: linkTokenSha256(token) })
    .where(and(eq(documentLinks.companyId, caller.companyId), eq(documentLinks.id, row.id)));
  await auditDocumentLink(tx, caller, 'document_link_reissued', row.jobId, row);
  return { link: documentLinkView((await documentLinkById(tx, caller.companyId, row.id))!), token };
}

const signingDigest = (agreementId: string, set: DocumentSet) => requestDigest({ agreementId, set, madeAt: 'signing' });

/** The agreement's document links, made at signing inside the signing transaction. */
export async function documentLinksAtSigning(tx: CompanyTransaction, caller: JobCaller, jobId: string, agreementId: string): Promise<IssuedDocumentLink[]> {
  const issued: IssuedDocumentLink[] = [];
  for (const set of DOCUMENT_SETS) {
    issued.push(await insertDocumentLink(tx, caller, { id: randomUUID(), jobId, agreementId, set, digest: signingDigest(agreementId, set) }));
  }
  return issued;
}
