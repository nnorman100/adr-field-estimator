// What Submit and Back to editing can be refused with, beside the job-access refusals (JobError in
// src/lib/jobs/access.ts: not found, archived, not allowed). The codes are safe to show the caller.
export const SUBMISSION_ERRORS = {
  invalid_request: 400,
  // The submission id is taken by another request (another body, another job), or the new draft
  // id by another draft.
  conflict: 409,
  // The draft named is not the job's current draft.
  not_current_draft: 409,
  // Another submission of this draft is still being decided: one phone's Submit is in progress.
  submission_in_progress: 409,
  // The job's draft is already submitted (or the job is signed): nothing more to submit.
  already_submitted: 409,
  // This submission was stopped (by its own failure or by the worker after it expired): start
  // again with a new submission id.
  submission_aborted: 409,
  // What the server read differs from what the phone hashed: reload the draft and submit again.
  digest_mismatch: 409,
  // A photo reference names a photo the job does not hold.
  photo_missing: 409,
  // The draft cannot be recorded as it is (a room with no name, a room order that does not list
  // the rooms, a value the field map does not allow).
  draft_invalid: 409,
  // A room names a room type or an item that is not in the job's price version (its pin, else the
  // company's current version): pick it again on Check Scope, then Finish with a new submission id.
  unknown_price_ids: 409,
  // The job's price version cannot be read, so its room types and items cannot be checked.
  prices_unreadable: 503,
  // There is no field draft for the job's current draft id.
  draft_missing: 409,
  // Back to editing on a job that is not submitted.
  not_submitted: 409,
  // A signed job changes only through a change order (S5b-9).
  job_signed: 409,
  // The field database could not be reached; the same request again is safe.
  submissions_unavailable: 503,
} as const;
export type SubmissionErrorCode = keyof typeof SUBMISSION_ERRORS;

export class SubmissionError extends Error {
  readonly status: number;
  constructor(readonly code: SubmissionErrorCode) {
    super(`Submission request refused: ${code}`);
    this.name = 'SubmissionError';
    this.status = SUBMISSION_ERRORS[code];
  }
}
