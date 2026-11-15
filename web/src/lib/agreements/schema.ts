import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/field/canonical';
import { uuid } from '@/lib/jobs/schema';
import { SIGNER_NAME_LIMIT } from './screen';

// The request body of signing on the phone (S5a-11). Every id is made on the phone, so a retry after
// a lost answer names the same agreement and never makes a second one.

const SHA256 = /^[0-9a-f]{64}$/;
// The agreements table's own rule (migration 0011): trimmed, 1 to 150 characters, no control character.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const signerName = z
  .string()
  .trim()
  .refine((value) => [...value].length >= 1 && [...value].length <= SIGNER_NAME_LIMIT)
  .refine((value) => !CONTROL.test(value));

// POST /api/jobs/{id}/agreements: the agreement's own id; the estimate and the proposal hash the
// phone showed (signing binds to exactly that); the signature already received through the receipt
// route (?kind=signature) by its id; the customer's name as they wrote it; and the documents-confirmed
// box (S5a-9), which must be ticked.
export const signBody = z.strictObject({
  id: uuid,
  estimateId: uuid,
  proposalSha256: z.string().regex(SHA256),
  signatureId: uuid,
  signerName,
  documentsConfirmed: z.literal(true),
});

export type SignInput = z.infer<typeof signBody>;

// SHA-256 of the sign request as checked (the name trimmed): the same id and body is the same
// agreement, the same id with another body is refused (docs/plans/S5.md, section 1).
export function signDigest(input: SignInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
