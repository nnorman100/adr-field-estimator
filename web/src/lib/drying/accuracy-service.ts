import { eq, sql } from 'drizzle-orm';
import { companyFeatureFlags } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { ENGINE_VERSION, hasCushionBrackets } from '@/engine/table';
import { capabilitiesFor } from '@/lib/access';
import { EstimateError } from '@/lib/estimates/errors';
import { latestVersion, versionTable } from '@/lib/estimates/service';
import { accessFlags, flagsFromRows } from '@/lib/flags';
import { JobError, type JobCaller } from '@/lib/jobs/access';
import { accuracyOf, type Accuracy, type AccuracyPolicy, type AccuracyRow } from './accuracy';
import { currentCaller } from './readings';

// GET /api/estimate-accuracy (S5b-10 slice 10B): the owner's estimate accuracy numbers for the company
// of the sign-in, behind `estimate_assist`, with price books on and `prices_manage` (the route checks
// both before this runs, so nothing is read for anyone else). One read-only snapshot: the caller read
// again, each closed job's latest close with its baseline sample (the job's first signed estimate), the
// count of signed jobs, and the current published table's estimate settings when this server can price
// it. Answers counts, percents and suggested settings only: no job, amount, note or person.

export type AccuracyService = { read(caller: JobCaller): Promise<Accuracy> };

async function closedRows(tx: CompanyTransaction, companyId: string): Promise<AccuracyRow[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (c.job_id)
      c.landed, c.final_cents::text AS final_cents, c.baseline_low_cents::text AS low_cents, h.labor_material_low_cents::text AS labor_cents,
      h.room_categories, h.planned_days, c.actual_days
    FROM job_closes c
    JOIN estimate_history h ON h.company_id = c.company_id AND h.job_id = c.job_id AND h.agreement_id = c.baseline_agreement_id
    WHERE c.company_id = ${companyId}::uuid
    ORDER BY c.job_id, c.revision DESC
  `)) as unknown as {
    landed: AccuracyRow['landed'];
    final_cents: string;
    low_cents: string;
    labor_cents: string | null;
    room_categories: AccuracyRow['roomCategories'];
    planned_days: number | null;
    actual_days: number | null;
  }[];
  return rows.map((row) => ({
    landed: row.landed,
    finalCents: Number(row.final_cents),
    lowCents: Number(row.low_cents),
    laborMaterialLowCents: row.labor_cents === null ? null : Number(row.labor_cents),
    roomCategories: row.room_categories,
    plannedDays: row.planned_days,
    actualDays: row.actual_days,
  }));
}

// The current published table's estimate settings, or null when there is none or this server cannot
// price it (another engine version, or one that does not parse or match its hash).
async function currentPolicy(tx: CompanyTransaction, companyId: string): Promise<AccuracyPolicy | null> {
  const version = await latestVersion(tx, companyId);
  if (!version || version.engineVersion !== ENGINE_VERSION) return null;
  try {
    const { policy } = versionTable(version);
    return { estimateMode: policy.estimate_mode, rangeMethod: policy.assist.range_method, beyondPercent: policy.range.beyond_percent, customBrackets: hasCushionBrackets(policy) };
  } catch (error) {
    if (error instanceof EstimateError) return null;
    throw error;
  }
}

// The route's two checks again, in the snapshot every history read follows: `estimate_assist` and price
// books on (404, as the routes) and `prices_manage` from the caller's current role (403).
async function requireOwnerOfPrices(tx: CompanyTransaction, caller: JobCaller): Promise<void> {
  const flags = flagsFromRows(await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, caller.companyId)));
  if (!flags.estimate_assist || !flags.price_books) throw new JobError('not_found');
  if (!capabilitiesFor(caller.role, accessFlags(flags)).includes('prices_manage')) throw new JobError('not_allowed');
}

export function accuracyService(db: Database): AccuracyService {
  return {
    async read(caller) {
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await currentCaller(tx, caller, false);
          await requireOwnerOfPrices(tx, caller);
          const [signed] = (await tx.execute(sql`SELECT count(DISTINCT job_id)::int AS n FROM agreements WHERE company_id = ${caller.companyId}::uuid AND kind = 'original'`)) as unknown as { n: number }[];
          return accuracyOf(await closedRows(tx, caller.companyId), signed?.n ?? 0, await currentPolicy(tx, caller.companyId));
        },
        { snapshot: true },
      );
    },
  };
}
