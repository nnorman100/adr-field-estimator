import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uuid } from '@/lib/jobs/schema';

// The request bodies of Submit and Back to editing (S5a-8). Every id is made on the phone, so a
// retry after a lost answer names the same record and never makes a second one.

const SHA256 = /^[0-9a-f]{64}$/;

// POST /api/jobs/{id}/submissions: the submission's own id, the draft it submits (the job's
// current draft) and the SHA-256 of the canonical form of what the phone showed
// (src/lib/field/canonical.ts).
export const submitBody = z.strictObject({
  id: uuid,
  draftId: uuid,
  digest: z.string().regex(SHA256),
});

// POST /api/jobs/{id}/drafts: the new draft's id and the submitted draft it is made from.
export const nextDraftBody = z.strictObject({
  draftId: uuid,
  fromDraftId: uuid,
});

export type SubmitInput = z.infer<typeof submitBody>;
export type NextDraftInput = z.infer<typeof nextDraftBody>;

// SHA-256 of the submit request in a fixed key order: the same id and body is the same request, the
// same id with another body is refused (docs/plans/S5.md, section 1).
export function submitDigest(input: SubmitInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: input.id, draftId: input.draftId, digest: input.digest }))
    .digest('hex');
}
