// What signing can be refused with, beside the job-access refusals (JobError in
// src/lib/jobs/access.ts: not found, archived, not allowed). The codes are safe to show the caller.
export const AGREEMENT_ERRORS = {
  invalid_request: 400,
  // The agreement id is taken by another request (another body, another job).
  conflict: 409,
  // The job is already signed: one original agreement per job. A change after signing is a revised
  // estimate or a change order (S5b-9).
  already_signed: 409,
  // The job is still being edited, or its record has not been priced: nothing to sign yet.
  not_submitted: 409,
  // The estimate named is not the job's current one (a new record or a new pin since), so it can no
  // longer be signed. The phone reads the job again.
  estimate_superseded: 409,
  // The proposal the phone showed is not the stored one the estimate holds.
  proposal_changed: 409,
  // The customer, claim or property address changed after pricing: review it again first.
  needs_review: 409,
  // The company setup check: a required company field, the start-work authorization or the payment
  // terms is empty. The answer lists them (`missing`).
  company_setup_missing: 409,
  // The documents of this estimate cannot be signed (unpriced work, no priced work, a field the
  // setup check needed was empty when it was priced, or a proposal made before the signed page's
  // texts existed): go back to editing, then finish and price again.
  not_signable: 409,
  // The signature named was not received for this job (send it through the receipt route first).
  signature_missing: 409,
  // The database could not be reached; the same request again is safe.
  agreements_unavailable: 503,
} as const;
export type AgreementErrorCode = keyof typeof AGREEMENT_ERRORS;

export class AgreementError extends Error {
  readonly status: number;
  constructor(
    readonly code: AgreementErrorCode,
    // Safe to show the caller: the setup check's labels.
    readonly extra: { missing?: string[] } = {},
  ) {
    super(`Signing refused: ${code}`);
    this.name = 'AgreementError';
    this.status = AGREEMENT_ERRORS[code];
  }
}
