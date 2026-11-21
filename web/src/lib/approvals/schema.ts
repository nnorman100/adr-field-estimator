import { z } from 'zod';
import { oneLine, printable } from '@/engine/values';
import { uuid } from '@/lib/jobs/schema';

// The proposal and approval bodies (S5b-8). Ids are made on the phone, so a lost answer sent again is
// the same proposal. Text is kept exactly as entered (no trim): it must hold a character that is not
// whitespace, Unicode spaces included, and no control character, as migration 0019 checks.

export const PROPOSAL_KINDS = ['named_adjustment', 'line_multiplier', 'hourly', 'unit', 'flat'] as const;

const NOT_SPACE = /[^\s\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => [...value].length <= max && NOT_SPACE.test(value) && !CONTROL.test(value), { message: 'text' });

// An addition's description as the estimate reads it (web/src/engine/inspection.ts): one line, printable.
const description = text(300).refine((value) => printable(oneLine(value)), { message: 'description' });

const revision = z.int().min(1).max(2_147_483_647);
const ADJUSTMENT_ID = /^[a-z][a-z0-9_]{1,39}$/;
// Hours as decimal text: 0.25 to 200, at most two decimal places.
const hours = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) >= 0.25 && Number(value) <= 200, { message: 'hours' });

// Decimal text with at most two decimal places, inside the limits migration 0019 and the engine share.
const decimal = (above: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}(?:\.\d{1,2})?$/)
    .refine((value) => Number(value) > above && Number(value) <= max, { message: 'decimal' });
// A custom multiplier: a surcharge above 1, at most 3 (owner decision D2).
const multiplier = decimal(1, 3);
// A unit addition's quantity, and a unit or flat addition's price: above zero, at most 100,000.
const quantity = decimal(0, 100000);
const price = decimal(0, 100000);
// A room's field id, as the field draft names it (web/src/lib/field/schema.ts).
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const proposalBody = z.discriminatedUnion('kind', [
  z.strictObject({ id: uuid, revision, kind: z.literal('named_adjustment'), adjustmentId: z.string().regex(ADJUSTMENT_ID) }),
  z.strictObject({ id: uuid, revision, kind: z.literal('hourly'), description, hours }),
  // One priced item in one room, or a job-wide item (no room); bracket-derived lines are eligible (D2).
  z.strictObject({
    id: uuid,
    revision,
    kind: z.literal('line_multiplier'),
    itemId: z.string().regex(ADJUSTMENT_ID),
    roomId: z.string().regex(ROOM_ID).nullable(),
    multiplier,
  }),
  z.strictObject({ id: uuid, revision, kind: z.literal('unit'), description, quantity, unit: text(20), price, taxable: z.boolean() }),
  z.strictObject({ id: uuid, revision, kind: z.literal('flat'), description, price, taxable: z.boolean() }),
]);
export type ProposalInput = z.infer<typeof proposalBody>;

export const approveBody = z.strictObject({
  revision,
  // An hourly approval's approver name, as entered; the service requires it there and refuses it elsewhere.
  approverName: text(150).optional(),
});
export type ApproveInput = z.infer<typeof approveBody>;
