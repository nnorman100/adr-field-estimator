import { desc, eq, sql } from 'drizzle-orm';
import { priceTableVersions } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { contentHash, ENGINE_VERSION, parseTable } from '@/engine/table';
import type { JobCaller } from '@/lib/jobs/access';
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
  const [version] = await tx
    .select({ content: priceTableVersions.content, contentHash: priceTableVersions.contentHash, engineVersion: priceTableVersions.engineVersion })
    .from(priceTableVersions)
    .where(eq(priceTableVersions.companyId, companyId))
    .orderBy(desc(priceTableVersions.sequence))
    .limit(1);
  if (!version || version.engineVersion !== ENGINE_VERSION) return null;
  let table;
  try {
    table = parseTable(version.content);
  } catch {
    return null;
  }
  if (contentHash(table) !== version.contentHash) return null;
  const { policy } = table;
  return {
    estimateMode: policy.estimate_mode,
    rangeMethod: policy.assist.range_method,
    beyondPercent: policy.range.beyond_percent,
    customBrackets: (policy.range.brackets?.length ?? 0) > 0,
  };
}

export function accuracyService(db: Database): AccuracyService {
  return {
    async read(caller) {
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await currentCaller(tx, caller, false);
          const [signed] = (await tx.execute(sql`SELECT count(DISTINCT job_id)::int AS n FROM estimate_history WHERE company_id = ${caller.companyId}::uuid`)) as unknown as { n: number }[];
          return accuracyOf(await closedRows(tx, caller.companyId), signed?.n ?? 0, await currentPolicy(tx, caller.companyId));
        },
        { snapshot: true },
      );
    },
  };
}
