import { z } from 'zod';

// What the local prices stand-in (src/lib/prices/local-prices.ts) keeps for a company in the
// LOCAL_SIGN_IN_FIXTURE file, in place of migration 0009's two tables: the working copy and the
// published versions. Tables are stored as the schema parsed them and parsed again on every read.
export const localPricesSchema = z.object({
  workingCopy: z
    .object({
      revision: z.number().int().min(1),
      baseSequence: z.number().int().min(1).nullable(),
      updatedAt: z.iso.datetime(),
      content: z.unknown(),
      // The revision the last price-list import wrote (the database keeps this in its audit row).
      importedRevision: z.number().int().min(1).nullable().default(null),
    })
    .nullable()
    .default(null),
  versions: z
    .array(
      z.object({
        id: z.uuid(),
        sequence: z.number().int().min(1),
        content: z.unknown(),
        contentHash: z.string(),
        engineVersion: z.string(),
        reason: z.string(),
        source: z.enum(['blank', 'import', 'restore']),
        publishedBy: z.uuid(),
        publishedAt: z.iso.datetime(),
        publishKey: z.string(),
      }),
    )
    .default([]),
});
