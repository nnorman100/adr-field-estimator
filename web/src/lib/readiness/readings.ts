import type { CompanyTransaction } from '@/db/tenant';
import type { SetupReadings } from './check';

// Whether the job's drying log holds a setup reading: an affected air reading, or a material reading
// marked affected, that is active (not voided) and not taken in the future. The drying log is S5b-10
// (slice 10B, `web/src/lib/drying/` or its neighbour), which is not built yet, so this answers
// 'unavailable' and the check lists the setup reading as a check it could not run, never as missing.
//
// S5b-10B fills this seam: give `readinessService` a reader that runs its read helper in the same
// company transaction and job scope, answering 'present' or 'absent'. A read that fails answers
// 'unavailable' (inside a savepoint, so the transaction can go on), never 'absent'.
export type SetupReadingSource = {
  setupReading(tx: CompanyTransaction, companyId: string, jobId: string): Promise<SetupReadings>;
};

/** Until S5b-10's drying log exists: the setup reading is not known. */
export const noDryingLog: SetupReadingSource = {
  setupReading: async () => 'unavailable',
};
