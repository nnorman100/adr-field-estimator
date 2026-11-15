import { createHash } from 'node:crypto';
import { z } from 'zod';

// The request bodies and query of the jobs routes (S5a-3). The limits are migration 0010's CHECK
// constraints, so a value that passes here is one the database accepts; the database refuses the
// rest as a last line (the service maps that refusal to 400).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every control character, and the two line separators (Postgres counts them as control too).
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST_LOSS = '1900-01-01';

export const uuid = z
  .string()
  .regex(UUID)
  .transform((value) => value.toLowerCase());

const line = (max: number) => z.string().trim().max(max).regex(ONE_LINE);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => value === '' || EMAIL.test(value));

// A real calendar date, from 1900 to today (UTC, which is never earlier than a date in the US);
// null when the date is not known.
const dateOfLoss = z
  .string()
  .nullable()
  .refine((value) => {
    if (value === null) return true;
    const parts = DATE.exec(value);
    if (!parts) return false;
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const made = new Date(Date.UTC(year, month - 1, day));
    const real = made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === day;
    return real && value >= EARLIEST_LOSS && value <= new Date().toISOString().slice(0, 10);
  });

const revision = z.int().min(1).max(2_147_483_647);

// POST /api/jobs: both ids are made on the phone. An omitted address is an empty one, so the two
// spellings are one request.
export const createBody = z.strictObject({
  id: uuid,
  draftId: uuid,
  propertyAddress: line(500).default(''),
});

// PUT /api/jobs/{id}/customer: the whole customer and the property address (owner decision J3).
// `revision` is the job's revision the phone last saw; `changeId` is this change's own id, made on
// the phone, so a retry of a change the server already made is the same change and not a conflict.
export const customerBody = z.strictObject({
  revision,
  changeId: uuid,
  name: line(150),
  phone: line(80),
  email,
  propertyAddress: line(500),
});

// PUT /api/jobs/{id}/claim: the whole claim, the fields the documents print.
export const claimBody = z.strictObject({
  revision,
  changeId: uuid,
  carrier: line(150),
  claimNumber: line(80),
  policyNumber: line(80),
  dateOfLoss,
  lossCause: line(500),
  adjusterName: line(150),
  adjusterEmail: email,
  adjusterPhone: line(80),
  deductible: line(40),
});

// Office notes (S5b-1, job_coordination in 0015): several lines (tab, line feed and carriage return
// allowed, no other control character), at most 4,000 characters, kept as typed.
const NOTES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

// PUT /api/jobs/{id}/coordination: the office notes, with the job revision the screen last saw and
// this change's own id, as the customer save.
export const coordinationBody = z.strictObject({
  revision,
  changeId: uuid,
  notes: z.string().max(4000).regex(NOTES),
});

// POST /api/jobs/{id}/assignments: the assignment's id is made on the phone, so a retry is the same
// assignment.
export const assignBody = z.strictObject({
  id: uuid,
  estimatorActorId: uuid,
});

// POST /api/jobs/{id}/field-owner/transfer (owner decision J5): who gets the field work, with the
// job revision the screen last saw and this change's own id.
export const transferBody = z.strictObject({
  revision,
  changeId: uuid,
  toActorId: uuid,
});

export type CoordinationInput = z.infer<typeof coordinationBody>;
export type AssignInput = z.infer<typeof assignBody>;
export type TransferInput = z.infer<typeof transferBody>;

// SHA-256 of an assign request in a fixed key order.
export function assignDigest(input: AssignInput): string {
  return createHash('sha256').update(JSON.stringify({ id: input.id, estimatorActorId: input.estimatorActorId })).digest('hex');
}

export type CreateJobInput = z.infer<typeof createBody>;
export type CustomerInput = z.infer<typeof customerBody>;
export type ClaimInput = z.infer<typeof claimBody>;

export const LIST_SCOPES = ['company', 'mine'] as const;
export type ListScope = (typeof LIST_SCOPES)[number];
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 50;

export type ListQuery = { scope: ListScope | null; limit: number; cursor: string | null };

// GET /api/jobs?scope=company|mine&limit=1..50&cursor=... Anything else is a bad request.
export function parseListQuery(params: URLSearchParams): ListQuery | null {
  const scope = params.get('scope');
  if (scope !== null && !(LIST_SCOPES as readonly string[]).includes(scope)) return null;
  const rawLimit = params.get('limit');
  let limit = DEFAULT_PAGE;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_PAGE) return null;
  }
  return { scope: scope as ListScope | null, limit, cursor: params.get('cursor') };
}

// SHA-256 of the create request in a fixed key order, so the same request always has the same digest.
export function createDigest(input: CreateJobInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: input.id, draftId: input.draftId, propertyAddress: input.propertyAddress }))
    .digest('hex');
}
