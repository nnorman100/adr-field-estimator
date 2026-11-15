import { createHash } from 'node:crypto';
import { z } from 'zod';
import { signerName } from '@/lib/agreements/schema';
import { canonicalJson } from '@/lib/field/canonical';
import { uuid } from '@/lib/jobs/schema';

// The request bodies of the link routes (S5a-11b). Every id is made by the sender, so a retry after
// a lost answer names the same link or agreement and never makes a second one.

const SHA256 = /^[0-9a-f]{64}$/;

// POST /api/jobs/{id}/signing-link: the link's own id, and the estimate and proposal hash the
// technician's phone shows (the link signs exactly that estimate).
export const createSigningLinkBody = z.strictObject({
  id: uuid,
  estimateId: uuid,
  proposalSha256: z.string().regex(SHA256),
});
export type CreateSigningLinkInput = z.infer<typeof createSigningLinkBody>;

// POST /api/sign: the agreement's id and the signature's (made in the homeowner's browser), the
// signer's name, and the two boxes the page asks the homeowner to tick: the documents reviewed, and
// agreeing to sign and receive the record electronically. The estimate and its proposal hash come
// from the link, never from the browser.
export const linkSignBody = z.strictObject({
  id: uuid,
  signatureId: uuid,
  signerName,
  documentsConfirmed: z.literal(true),
  electronicConsent: z.literal(true),
});
export type LinkSignInput = z.infer<typeof linkSignBody>;

export const DOCUMENT_SETS = ['homeowner', 'adjuster'] as const;
export type DocumentSet = (typeof DOCUMENT_SETS)[number];

// POST /api/jobs/{id}/document-links: the link's own id and which set it opens.
export const createDocumentLinkBody = z.strictObject({
  id: uuid,
  set: z.enum(DOCUMENT_SETS),
});
export type CreateDocumentLinkInput = z.infer<typeof createDocumentLinkBody>;

/** SHA-256 of a request as checked, with what it is for (the job, or the link): the same id and body is the same request. */
export function requestDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
