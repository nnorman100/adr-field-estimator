import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '@/engine/estimate';
import { PROPOSAL_FORMATS, type Proposal } from '@/lib/estimates/proposal';
import { canonicalJson } from '@/lib/field/canonical';
import { SIGNER_ROLES, type SignerRole } from './screen';

// The signed record (docs/plans/S5.md, S5a-11 and the 2026-11-13 correction, part 3): the documents
// as the customer signed them, stored once as canonical JSON in agreements.documents_bytes and never
// rebuilt. The signed page is shown from these bytes alone: a later price publish, profile change or
// engine release cannot change it. They state who signed (the signer's name), when (the server's
// clock at signing) and how (on the technician's phone, with the technician who presented it; a
// signing link, S5a-11b, names its link instead), and they hold the proposal exactly as hashed, the
// company's start-work authorization and payment terms inside it, with the signature's own hash.

export const SIGNED_FORMAT = 'dryscope-signed-v1';

/** How the customer signed: on the technician's phone, or through a signing link (S5a-11b). */
export type SignedWith = { kind: 'device'; presented_by: { actor_id: string; name: string } } | { kind: 'link'; link_id: string };

export type SignedRecord = {
  format: typeof SIGNED_FORMAT;
  agreement_id: string;
  job_id: string;
  kind: 'original';
  // The server's time of signing, ISO 8601 in UTC; the same instant as agreements.signed_at.
  signed_at: string;
  // The role is the signer's own answer on a signing link's page; signing on the phone does not ask it.
  signer: { name: string; role?: SignerRole };
  signed_with: SignedWith;
  signature: { id: string; sha256: string; content_type: string };
  // The proposal exactly as stored with the estimate; its canonical text hashes to proposal_sha256.
  proposal_sha256: string;
  proposal: Proposal;
  // The other documents as the estimate stored them.
  documents: { itemized_claim: Json[]; letter: string; photo_log: Json[]; claim: Json; compliance_notes: string[] };
  basis: { estimate_id: string; submission_id: string };
};

const SHA256 = /^[0-9a-f]{64}$/;
const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]));

const signedSchema = z.strictObject({
  format: z.literal(SIGNED_FORMAT),
  agreement_id: z.string(),
  job_id: z.string(),
  kind: z.literal('original'),
  signed_at: z.iso.datetime(),
  signer: z.strictObject({ name: z.string().min(1), role: z.enum(SIGNER_ROLES).optional() }),
  signed_with: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('device'), presented_by: z.strictObject({ actor_id: z.string(), name: z.string() }) }),
    z.strictObject({ kind: z.literal('link'), link_id: z.string() }),
  ]),
  signature: z.strictObject({ id: z.string(), sha256: z.string().regex(SHA256), content_type: z.string() }),
  proposal_sha256: z.string().regex(SHA256),
  proposal: z.looseObject({ format: z.enum(PROPOSAL_FORMATS), heading: z.string() }),
  documents: z.strictObject({ itemized_claim: z.array(json), letter: z.string(), photo_log: z.array(json), claim: json, compliance_notes: z.array(z.string()) }),
  basis: z.strictObject({ estimate_id: z.string(), submission_id: z.string() }),
});

const sha256Of = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export class SignedRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignedRecordError';
  }
}

/**
 * The stored bytes of a signed record. Throws SignedRecordError when the proposal it holds does not
 * hash to the proposal hash it states, so a record can never bind a proposal other than the one the
 * estimate stored.
 */
export function signedRecordBytes(record: SignedRecord): Buffer {
  if (sha256Of(canonicalJson(record.proposal)) !== record.proposal_sha256) throw new SignedRecordError('the proposal does not match its hash');
  return Buffer.from(canonicalJson(record), 'utf8');
}

/** Stored signed-record bytes as the record they hold, the proposal's hash checked again. */
export function readSignedRecord(bytes: Uint8Array): SignedRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new SignedRecordError('a signed record is not JSON');
  }
  const parsed = signedSchema.safeParse(raw);
  if (!parsed.success) throw new SignedRecordError('a signed record does not match its format');
  const record = parsed.data as unknown as SignedRecord;
  if (sha256Of(canonicalJson(record.proposal)) !== record.proposal_sha256) throw new SignedRecordError('a signed record’s proposal does not match its hash');
  return record;
}
