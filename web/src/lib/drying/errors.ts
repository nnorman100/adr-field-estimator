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
