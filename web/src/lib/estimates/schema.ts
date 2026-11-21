import { z } from 'zod';
import { uuid } from '@/lib/jobs/schema';

// POST /api/jobs/{id}/reprice (S5b-6): the price version the owner reviewed, the job revision they
// saw, and this change's own id, made on the phone, so a lost answer sent again is the same change.
export const repriceBody = z.strictObject({
  revision: z.int().min(1).max(2_147_483_647),
  changeId: uuid,
  versionId: uuid,
  // The pinned (before) price the preview showed the owner, null when it could not be priced: a
  // confirmation is refused if it has changed since (S5b-8). Absent only on the retry of a reprice
  // the previous release made, which the service answers from its receipt and refuses otherwise.
  pinnedPrice: z.string().max(200).nullable().optional(),
});

export type RepriceInput = z.infer<typeof repriceBody>;
