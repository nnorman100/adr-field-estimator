import type { CompanyTransaction } from '@/db/tenant';
import type { SetupReadings } from './check';

// Whether the job's drying log holds a setup reading: an affected air reading, or a material reading
// marked affected, that is active (not voided) and not taken in the future. The drying log's read
// helper (S5b-10, src/lib/drying/setup.ts) is the source the route's service uses; it runs in the
// check's own company transaction and job scope, answering 'present' or 'absent'. A read that fails
// answers 'unavailable' (inside a savepoint, so the transaction can go on), never 'absent'.
export type SetupReadingSource = {
  setupReading(tx: CompanyTransaction, companyId: string, jobId: string): Promise<SetupReadings>;
};

/** A source that knows no drying log: the setup reading is not known (the service's default). */
export const noDryingLog: SetupReadingSource = {
  setupReading: async () => 'unavailable',
};
