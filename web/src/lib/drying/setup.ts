import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { dryingReadings } from '@/db/drying-schema';
import type { SetupReadingSource } from '@/lib/readiness/readings';

// The drying log's read helper for "Ready to review?" (S5b-11; the seam src/lib/readiness/readings.ts
// left for S5b-10): whether the job has a setup reading, an affected air reading or a material reading
// marked affected, that is active (not voided) and not taken after now. A voided or future reading is
// no setup reading. It runs in the readiness check's own read-only transaction (and savepoint), for the
// job it has already checked the caller's access to; it says nothing of a distinct setup date.
export const dryingSetupReadings: SetupReadingSource = {
  async setupReading(tx, companyId, jobId) {
    const [found] = await tx
      .select({ id: dryingReadings.id })
      .from(dryingReadings)
      .where(
        and(
          eq(dryingReadings.companyId, companyId),
          eq(dryingReadings.jobId, jobId),
          isNull(dryingReadings.voidedAt),
          lte(dryingReadings.takenAt, sql`now()`),
          or(
            and(eq(dryingReadings.kind, 'air'), sql`${dryingReadings.payload}->>'zone' = 'affected'`),
            and(eq(dryingReadings.kind, 'material'), sql`${dryingReadings.payload}->'affected' = 'true'::jsonb`),
          ),
        ),
      )
      .limit(1);
    return found ? 'present' : 'absent';
  },
};
