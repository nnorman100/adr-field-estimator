// Why a drying log request was refused (S5b-10 slice 10B). Fixed codes only: a refused value is never
// repeated back or logged. The job's own refusals (not found, archived, the role) come from the one
// job-access function as JobError (src/lib/jobs/access.ts), with the same statuses.
export const DRYING_ERRORS = {
  invalid_request: 400,
  // No such reading on this job.
  reading_not_found: 404,
  // The id is taken by another request or another job.
  conflict: 409,
  // The room is not a named room of this job's current draft or submitted record.
  unknown_room: 409,
  // The job already has the most active readings it keeps; voiding one frees a place.
  reading_limit: 409,
  // The reading was voided by another request.
  already_voided: 409,
  // A Submit of the job's draft is deciding: its rooms are about to be the submitted record's.
  submission_in_progress: 409,
  // The drying watch (S5b-10): the signed record keeps no drying plan, so there is nothing to watch.
  no_plan: 409,
  // The facts the person reviewed changed before the action landed; read the watch again and confirm.
  stale_facts: 409,
  // The watch was marked dry or closed; it takes no more actions.
  watch_closed: 409,
  // The watch already holds its 100 plan extensions.
  extension_limit: 409,
  // The job close (S5b-10): the agreement in force is not the one the close was confirmed against, or
  // the job's close moved on since it was read; read the outcome again and confirm.
  stale_agreement: 409,
  stale_revision: 409,
  // The original agreement's signed amount cannot be proven from its signed record: nothing to compare.
  no_signed_amount: 409,
  // The job's field draft could not be read; the same request again reads it.
  draft_unavailable: 503,
} as const;
export type DryingErrorCode = keyof typeof DRYING_ERRORS;

export class DryingError extends Error {
  readonly status: number;
  constructor(readonly code: DryingErrorCode) {
    super(`Drying log request refused: ${code}`);
    this.name = 'DryingError';
    this.status = DRYING_ERRORS[code];
  }
}
