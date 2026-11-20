import { z } from 'zod';

// The Check Scope reference copy. Suggestions point to the items in the same publication.
export const itemListResponseSchema = z.strictObject({
  current: z.strictObject({
    versionId: z.uuid(),
    publishedAt: z.iso.datetime(),
    items: z.array(z.strictObject({ itemId: z.string(), name: z.string(), unit: z.string() })),
    roomTypes: z.array(z.strictObject({ id: z.string(), name: z.string(), suggestedItemIds: z.array(z.string()) })),
  }).nullable(),
});
