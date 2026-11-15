import type { SignedRecord } from './record';

// The agreements table's limit on the signer's name (migration 0011), for the name field.
export const SIGNER_NAME_LIMIT = 150;

// Who signed, as the signer says on a signing link's page (docs/spec.md 2.5; agreements.signer_role, 0014).
export const SIGNER_ROLES = ['homeowner', 'adjuster', 'other'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export const SIGNER_ROLE_NAMES: Record<SignerRole, string> = { homeowner: 'Homeowner', adjuster: 'Adjuster', other: 'Other' };

// What the signing part of Review before signing decides in the browser (S5a-11), as pure functions
// so they are unit-tested. The signed page is shown from the agreement's stored bytes as the server
// answers them; nothing here builds a document, and messages come from fixed codes only (never from
// what someone typed).

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

export type SignedAgreement = { id: string; signedAt: string; documentsSha256: string; record: SignedRecord };

// The agreement routes' answer (GET: the job's signed record or null; POST: the one just signed).
// The record's own shape is the server's (checked there against the stored format); here only
// enough is checked to know it is an answer of these routes.
export function agreementAnswerOf(body: unknown): { agreement: SignedAgreement | null } | null {
  const agreement = field(body, 'agreement');
  if (agreement === null) return { agreement: null };
  const record = field(agreement, 'record');
  if (
    typeof field(agreement, 'id') !== 'string' ||
    typeof field(agreement, 'signedAt') !== 'string' ||
    typeof field(agreement, 'documentsSha256') !== 'string' ||
    typeof field(record, 'proposal') !== 'object' ||
    typeof field(field(record, 'signer'), 'name') !== 'string'
  ) {
    return null;
  }
  return { agreement: agreement as SignedAgreement };
}

/** When it was signed, by the server's clock, in the phone's own time zone (or the one given). */
export function signedWhen(iso: string, timeZone?: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'long', ...(timeZone ? { timeZone } : {}) }).format(when);
}

/** Who signed, with the role they gave when one was asked. */
export function signedBy(signer: { name: string; role?: SignerRole }): string {
  return signer.role ? `Signed by ${signer.name}, ${SIGNER_ROLE_NAMES[signer.role].toLowerCase()}` : `Signed by ${signer.name}`;
}

/** How it was signed: on the technician's phone with who presented it, or through a signing link. */
export function signedHow(record: SignedRecord): string {
  const how = record.signed_with;
  if (how.kind === 'link') return `Signed through signing link ${how.link_id}.`;
  return how.presented_by.name
    ? `Signed on the technician's phone, presented by ${how.presented_by.name}.`
    : "Signed on the technician's phone.";
}

export type SignNext = 'retry' | 'reload' | 'redraw' | 'done';

const UNCONFIRMED = {
  message: 'We could not confirm signing with DryScope. Check your connection, then try signing again to get the result.',
  next: 'retry',
} as const;

const OUTCOMES: Record<string, { message: string; next: SignNext }> = {
  agreements_unavailable: UNCONFIRMED,
  photos_unavailable: UNCONFIRMED,
  already_signed: { message: 'This job is already signed. Its signed documents do not change.', next: 'reload' },
  estimate_superseded: { message: 'This job was priced again since these documents were shown. Reload the job and review the new documents.', next: 'reload' },
  proposal_changed: { message: 'The proposal changed since it was shown. Reload the job and review it again.', next: 'reload' },
  needs_review: { message: 'The customer, claim or property address changed after pricing. Go back to editing, then finish and review again.', next: 'reload' },
  not_submitted: { message: 'This job is not ready to sign. Reload the job.', next: 'reload' },
  not_ready_to_sign: { message: 'This job is not ready to sign. Reload the job.', next: 'reload' },
  not_signable: { message: 'These documents cannot be signed. Go back to editing, then finish and price the job again.', next: 'done' },
  signature_missing: { message: 'The signature did not arrive. Draw it again, then sign.', next: 'redraw' },
  conflict: { message: 'This was already sent with other details. Clear the signature, draw it again, then sign.', next: 'redraw' },
  photo_conflict: { message: 'This was already sent with other details. Clear the signature, draw it again, then sign.', next: 'redraw' },
  invalid_request: { message: 'Check the name, then sign again.', next: 'redraw' },
  unsupported_image: { message: 'The signature could not be read. Clear it, draw it again, then sign.', next: 'redraw' },
  not_allowed: { message: 'Only the owner or the estimator on this job can present it for signing.', next: 'done' },
  link_active: { message: 'This set already has a working link. The owner or office can replace it.', next: 'done' },
  not_found: { message: 'This job could not be found.', next: 'done' },
  archived: { message: 'This job is archived.', next: 'done' },
};

/** The message and next step for a refused signature or agreement request. */
export function signOutcomeOf(status: number, body: unknown): { message: string; next: SignNext } {
  const code = field(body, 'error');
  if (code === 'company_setup_missing') {
    const missing = field(body, 'missing');
    const labels = Array.isArray(missing) ? missing.filter((label): label is string => typeof label === 'string') : [];
    const list = labels.length ? labels.join(', ') : 'A company setting';
    return { message: `Company settings are not finished: ${list}. The owner fills them in on Company settings, then the job is finished and priced again.`, next: 'done' };
  }
  const known = typeof code === 'string' ? OUTCOMES[code] : undefined;
  if (known) return known;
  return status === 0 || status >= 500 ? UNCONFIRMED : { message: 'Something went wrong. Reload the job.', next: 'reload' };
}
