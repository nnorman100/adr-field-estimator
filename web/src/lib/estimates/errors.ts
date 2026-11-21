// What the estimate routes can be refused with, beside the job-access refusals (JobError in
// src/lib/jobs/access.ts: not found, archived, not allowed). The codes are safe to show the caller.
export const ESTIMATE_ERRORS = {
  // Reprice (S5b-6) takes a body; it did not read through its schema.
  invalid_request: 400,
  // The job is still being edited: Finish and review records it first.
  not_submitted: 409,
  // A signed job keeps its signed documents (S5a-11); a change goes through S5b-9.
  job_signed: 409,
  // Reprice (S5b-6) on a job never priced: it has no pin to move; the first estimate pins it.
  not_priced: 409,
  // Reprice (S5b-6): the version the owner reviewed is no longer the company's newest.
  prices_superseded: 409,
  // Reprice (S5b-6): the job is already priced from the company's newest version.
  prices_unchanged: 409,
  // Reprice: the pinned price the owner saw has changed since the preview (an approval was proposed,
  // edited or approved meanwhile): review the preview again.
  preview_stale: 409,
  // The company has no published price version, so nothing can be priced (pricing plan 3.2).
  prices_not_set: 409,
  // The submitted record's scope was not confirmed (docs/spec.md 2.3, Review before signing).
  scope_not_confirmed: 409,
  // The submitted record has no written summary of findings (owner decision J1).
  summary_missing: 409,
  // The engine refused the record or the documents; the answer names the stage and the engine's own
  // sentence (fixed wording, never a price).
  estimate_refused: 409,
  // The submitted record cannot be read as a draft of the field map: back to editing, then finish again.
  record_unreadable: 409,
  // The pinned price version cannot be read (its content, hash or engine version is not one this
  // server prices): nothing is stored, and the answer says only that.
  prices_unreadable: 503,
  // The company's document settings do not read through their schema (S5a-4b); nothing is stored.
  settings_unreadable: 503,
  // The database could not be reached; the same request again is safe.
  estimates_unavailable: 503,
} as const;
export type EstimateErrorCode = keyof typeof ESTIMATE_ERRORS;

export class EstimateError extends Error {
  readonly status: number;
  constructor(
    readonly code: EstimateErrorCode,
    readonly extra: Record<string, string> = {},
  ) {
    super(`Estimate request refused: ${code}`);
    this.name = 'EstimateError';
    this.status = ESTIMATE_ERRORS[code];
  }
}
