// What the proposal and approval routes (S5b-8) can be refused with, beside the job-access refusals
// (JobError in src/lib/jobs/access.ts: not found, archived, not allowed, stale revision, conflict) and
// the price refusals they share with the estimate (EstimateError: not submitted, signed, prices not
// set or unreadable). The codes are safe to show the caller.
export const APPROVAL_ERRORS = {
  // The body did not read through its schema.
  invalid_request: 400,
  // An hourly approval needs the approver's name as they enter it (it prints on the proposal).
  approver_name_required: 400,
  // No proposal of this job has that id.
  approval_not_found: 404,
  // The estimate of this record is already made: Back to editing and Finish make a new record to
  // propose on (owner decision D1).
  estimate_made: 409,
  // The owner repriced the job since this record was made: Back to editing and Finish price it again.
  repriced: 409,
  // The named adjustment is not in the job's pinned prices.
  unknown_adjustment: 409,
  // The job's pinned prices have no rate on their additional work item.
  // A custom multiplier names an item the job's pinned prices do not have (or have off), or a room the
  // submitted record does not have.
  unknown_item: 409,
  unknown_room: 409,
  // The submitted record, priced at the job's pinned prices, has no line of that item in that room (or no
  // job-wide line of it when no room is named), so a multiplier on it would change nothing.
  no_such_line: 409,
  // A custom multiplier is already proposed for that line (one per line, owner decision D2).
  line_already_proposed: 409,
  no_hourly_rate: 409,
  // The record already has the most rows of that kind the estimate takes (30 hourly; 30 unit and flat; 3,000 custom
  // multipliers). An edit that replaces one is not a new row, so it is allowed at the limit.
  too_many_additions: 409,
  // The proposal named was already ended or approved, so it cannot change that way.
  approval_closed: 409,
} as const;
export type ApprovalErrorCode = keyof typeof APPROVAL_ERRORS;

export class ApprovalError extends Error {
  readonly status: number;
  constructor(readonly code: ApprovalErrorCode) {
    super(`Approval request refused: ${code}`);
    this.name = 'ApprovalError';
    this.status = APPROVAL_ERRORS[code];
  }
}
