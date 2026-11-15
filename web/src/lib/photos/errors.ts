// What a photo request can be refused with, beside the job-access refusals (JobError in
// src/lib/jobs/access.ts: not found, archived, not allowed). The codes are safe to show the caller.
export const PHOTO_ERRORS = {
  invalid_request: 400,
  // The same photo id already holds other bytes, or an original that is not the registered
  // photo's: the phone stops retrying and says why.
  photo_conflict: 409,
  // An original arrived before its photo, or names a photo hash the job does not hold.
  photo_missing: 409,
  // The job's draft is not being edited (it is being submitted or was submitted), or the job is no
  // longer a draft: no new photo.
  draft_locked: 409,
  // The draft already holds the most photo references a job may (MAX_PHOTO_REFS): no new photo.
  photo_limit: 409,
  // A signature arrived for a job with no current unsigned estimate: it is not submitted and priced,
  // or it is already signed.
  not_ready_to_sign: 409,
  // No such photo, or no original of it yet.
  not_found: 404,
  too_large: 413,
  // The bytes are not a JPEG, PNG or WebP.
  unsupported_image: 415,
  // The field draft or the evidence bucket could not be reached; the same request again is safe.
  photos_unavailable: 503,
} as const;
export type PhotoErrorCode = keyof typeof PHOTO_ERRORS;

export class PhotoError extends Error {
  readonly status: number;
  constructor(readonly code: PhotoErrorCode) {
    super(`Photo request refused: ${code}`);
    this.name = 'PhotoError';
    this.status = PHOTO_ERRORS[code];
  }
}
