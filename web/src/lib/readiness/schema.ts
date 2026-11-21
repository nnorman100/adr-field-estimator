import { z } from 'zod';
import { isReadinessCode, type ReadinessGap, type UnavailableCheck } from './check';

// The contract of GET /api/jobs/{jobId}/readiness (S5b-11): the request takes no query and no body,
// and the answer is one of two closed shapes. The screens (S5b-11B) parse the answer with
// `readinessAnswerSchema`, so an answer of any other shape is treated as no answer.

/** The request's query: nothing is accepted. */
export const readinessQuery = z.strictObject({});

/** Why the check gave no gaps for the job's current draft. */
export const UNAVAILABLE_REASONS = Object.freeze([
  // The job is submitted or signed, or its draft is not open for editing (fenced, submitted).
  'not_editing',
  // The job, its current draft or the caller's access changed while the check read it: ask again.
  'draft_changed',
  // The draft is missing, made for another job, over a safety cap, or does not match the field map.
  'draft_unreadable',
  // The field database could not be read.
  'field_unavailable',
] as const);
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type ReadinessAnswer =
  | {
      status: 'checked';
      jobId: string;
      /** The draft the gaps are for: the job's current draft. */
      draftId: string;
      /** The job's revision when the check read it. */
      jobRevision: number;
      /** The canonical digest (src/lib/field/canonical.ts) of the draft the gaps were worked out from. */
      fieldSha256: string;
      /** True only with no gap and no unavailable check other than the meter reading (`ocr`, never stored yet). */
      ready: boolean;
      gaps: ReadinessGap[];
      unavailable: UnavailableCheck[];
    }
  | { status: 'unavailable'; jobId: string; reason: UnavailableReason };

const id = z.string().min(1).max(64);
// A job or draft id as the jobs API takes one (src/lib/jobs/http.ts): any uuid-shaped id, lowercased.
const jobUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const gap = z.strictObject({
  code: z.string().max(64).refine(isReadinessCode),
  roomId: id.optional(),
  count: z.int().min(1).max(1000).optional(),
});

export const readinessAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('checked'),
    jobId: jobUuid,
    draftId: jobUuid,
    jobRevision: z.int().min(1),
    fieldSha256: z.string().regex(/^[0-9a-f]{64}$/),
    ready: z.boolean(),
    gaps: z.array(gap).max(2000),
    unavailable: z.array(z.enum(['roomArea', 'setupReadings', 'ocr', 'prices'])).max(4),
  }),
  z.strictObject({ status: z.literal('unavailable'), jobId: jobUuid, reason: z.enum(UNAVAILABLE_REASONS) }),
]);
