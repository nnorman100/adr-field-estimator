import { and, eq } from 'drizzle-orm';
import { jobClaims, jobCustomers } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import type { JobRow } from '@/lib/jobs/access';
import type { Snapshot } from './snapshot';

export type JobDetails = Pick<Snapshot, 'job' | 'customer' | 'claim'>;

/** The job's property address, customer and claim as they stand now, in the snapshot's form. */
export async function readJobDetails(tx: CompanyTransaction, companyId: string, job: Pick<JobRow, 'id' | 'propertyAddress'>): Promise<JobDetails> {
  const [customer] = await tx
    .select({ name: jobCustomers.name, phone: jobCustomers.phone, email: jobCustomers.email })
    .from(jobCustomers)
    .where(and(eq(jobCustomers.companyId, companyId), eq(jobCustomers.jobId, job.id)));
  const [claim] = await tx
    .select({
      carrier: jobClaims.carrier,
      claimNumber: jobClaims.claimNumber,
      policyNumber: jobClaims.policyNumber,
      dateOfLoss: jobClaims.dateOfLoss,
      lossCause: jobClaims.lossCause,
      adjusterName: jobClaims.adjusterName,
      adjusterEmail: jobClaims.adjusterEmail,
      adjusterPhone: jobClaims.adjusterPhone,
      deductible: jobClaims.deductible,
    })
    .from(jobClaims)
    .where(and(eq(jobClaims.companyId, companyId), eq(jobClaims.jobId, job.id)));
  return {
    job: { propertyAddress: job.propertyAddress },
    customer: customer ?? { name: '', phone: '', email: '' },
    claim: claim ?? {},
  };
}
