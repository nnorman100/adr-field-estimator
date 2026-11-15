// What the link routes can be refused with (S5a-11b). The codes are safe to show the caller: on the
// homeowner's side none of them says whether a job, a company or another link exists.
export const LINK_ERRORS = {
  invalid_request: 400,
  // No link for this token, or it expired, was revoked, its view time ended, or the technician who
  // made it can no longer act for the job. One message for all of them.
  link_unavailable: 404,
  // The job has a newer submission or estimate than the one the link signs: ask for a new link.
  link_voided: 410,
  // A client address or a link used its requests for this minute.
  too_many_requests: 429,
  // A link used its signing attempts.
  too_many_attempts: 429,
  // The link cannot sign right now (the company's settings or the estimate are not ready); it stays
  // as it is.
  link_not_ready: 409,
  // The job is already signed.
  already_signed: 409,
  // The id is taken by another request.
  conflict: 409,
  // The signature named was not received.
  signature_missing: 409,
  // A document link is made for a signed job only.
  not_signed: 409,
  // A retried create for a link that has already ended: make a new one.
  link_ended: 409,
  // The signature image is over its size limit, or not an image this app takes.
  too_large: 413,
  unsupported_image: 415,
  links_unavailable: 503,
} as const;
export type LinkErrorCode = keyof typeof LINK_ERRORS;

export class LinkError extends Error {
  readonly status: number;
  constructor(readonly code: LinkErrorCode) {
    super(`Link request refused: ${code}`);
    this.name = 'LinkError';
    this.status = LINK_ERRORS[code];
  }
}
