import { createHash } from 'node:crypto';
import { and, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { jobCloses } from '@/db/drying-schema';
import { companyFeatureFlags } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { canonicalJson } from '@/lib/field/canonical';
import { flagsFromRows, type CompanyFlags } from '@/lib/flags';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { audit } from '@/lib/jobs/service';
import { DryingError } from './errors';
import { storedSample, writeSample, type HistorySample } from './history';
import { currentCaller, parseBody, refusedByDatabase } from './readings';
import { noteText } from './schema';
import { databaseNow, finishedDayCount, signedFacts, type SignedFacts } from './watch-service';

// The job close (S5b-10 slice 10B; docs/estimate-assist.md "Job close and estimate accuracy"), behind
// the company's `estimate_assist` switch (the route files' requireFlag). A signed job only. Every
// function runs inside withCompany for the company of the verified sign-in, re-reads the caller first
// (readings.ts, currentCaller) and goes through the one job-access function.
//
// - GET outcome: `jobs_read`. `coordination` (the owner and office) gets the close with its amounts and
//   note (the latest close; an earlier version answers its own request again), the agreement in force,
//   the close revision a new close must name, the baseline and the suggested drying days. Anyone else with the job (the estimator) gets only whether
//   it closed and when, from a query that reads nothing more.
// - POST close: `coordination`. Each close or correction is a new row with the next close revision. The
//   job is locked; a request sent again gets its original receipt first, even after a correction; then
//   the agreement in force and the close revision must be the ones the request names, or it is stale.
//   The final invoice is compared with the job's first signed estimate (the owner's Q1, option A): the
//   original agreement's history sample, written now from its signed record when it is missing. An
//   agreement whose signed amount cannot be proven cannot be closed. One audit row, ids and revisions.

const READ: readonly Capability[] = ['jobs_read'];
const CLOSE: readonly Capability[] = ['coordination'];

const MAX_FINAL_CENTS = 200_000_000;
const AMOUNT = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

// Dollars and cents as typed, $0.01 to $2,000,000.00, held as whole cents.
const finalAmount = z
  .string()
  .regex(AMOUNT)
  .transform((value) => {
    const [, dollars, fraction = ''] = AMOUNT.exec(value)!;
    return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .pipe(z.int().min(1).max(MAX_FINAL_CENTS));

export const closeBody = z.strictObject({
  id: z.uuid().transform((value) => value.toLowerCase()),
  expectedAgreementId: z.uuid().transform((value) => value.toLowerCase()),
  // The close revision the request was confirmed against: 0 for a first close.
  expectedRevision: z.int().min(0).max(1_000_000),
  finalAmount,
  // Blank is none; zero is zero.
  actualDays: z
    .union([z.int().min(0).max(365), z.null(), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .default(null),
  note: noteText(300).default(''),
});
export type CloseInput = z.infer<typeof closeBody>;

/** SHA-256 of a close request as parsed: the same id and body is the same close. */
export function closeDigest(input: CloseInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({ id: input.id, expectedAgreementId: input.expectedAgreementId, expectedRevision: input.expectedRevision, finalCents: input.finalAmount, actualDays: input.actualDays, note: input.note }),
      'utf8',
    )
    .digest('hex');
}

export type Landed = 'inside' | 'above' | 'below';

/** Where a final invoice landed (docs/estimate-assist.md): a range inside from low to high, both included; one price inside at or under it. */
export function landedOf(finalCents: number, baseline: Pick<HistorySample, 'priceMode' | 'lowCents' | 'highCents'>): Landed {
  if (baseline.priceMode === 'single') return finalCents <= baseline.lowCents ? 'inside' : 'above';
  if (finalCents < baseline.lowCents) return 'below';
  return finalCents > baseline.highCents! ? 'above' : 'inside';
}

const dollars = (cents: number | null) => (cents === null ? null : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`);

export type CloseView = {
  id: string;
  revision: number;
  agreementId: string;
  finalAmount: string;
  actualDays: number | null;
  note: string;
  baseline: { agreementId: string; priceMode: 'range' | 'single'; low: string; high: string | null };
  landed: Landed;
  closedAt: string;
  closedBy: string;
};

export type OutcomeView =
  // The owner and office.
  | {
      jobId: string;
      access: 'full';
      closed: boolean;
      closedAt: string | null;
      agreementId: string;
      // The close revision a new close or correction names: 0 before the first.
      revision: number;
      close: CloseView | null;
      // The drying days to preset: the watch's day count once monitoring has finished (with the
      // drying_watch switch on), otherwise the signed plan's days; null when neither is known.
      suggestedDays: { days: number; source: 'watch' | 'plan' } | null;
    }
  // Anyone else with the job.
  | { jobId: string; access: 'status'; closed: boolean; closedAt: string | null };

export type CloseResult = { created: boolean; close: CloseView };

export type OutcomeService = {
  read(caller: JobCaller, jobId: string): Promise<OutcomeView>;
  close(caller: JobCaller, jobId: string, body: string | null): Promise<CloseResult>;
};

const closeColumns = {
  id: jobCloses.id,
  jobId: jobCloses.jobId,
  revision: jobCloses.revision,
  requestDigest: jobCloses.requestDigest,
  agreementId: jobCloses.agreementId,
  finalCents: jobCloses.finalCents,
  actualDays: jobCloses.actualDays,
  note: jobCloses.note,
  baselineAgreementId: jobCloses.baselineAgreementId,
  priceMode: jobCloses.priceMode,
  baselineLowCents: jobCloses.baselineLowCents,
  baselineHighCents: jobCloses.baselineHighCents,
  landed: jobCloses.landed,
  closedAt: sql<string>`to_char(${jobCloses.closedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  closedBy: jobCloses.closedByActorId,
};

type CloseRow = {
  id: string;
  jobId: string;
  revision: number;
  requestDigest: string;
  agreementId: string;
  finalCents: number;
  actualDays: number | null;
  note: string;
  baselineAgreementId: string;
  priceMode: 'range' | 'single';
  baselineLowCents: number;
  baselineHighCents: number | null;
  landed: Landed;
  closedAt: string;
  closedBy: string;
};

function closeView(row: CloseRow): CloseView {
  return {
    id: row.id,
    revision: row.revision,
    agreementId: row.agreementId,
    finalAmount: dollars(row.finalCents)!,
    actualDays: row.actualDays,
    note: row.note,
    baseline: { agreementId: row.baselineAgreementId, priceMode: row.priceMode, low: dollars(row.baselineLowCents)!, high: dollars(row.baselineHighCents) },
    landed: row.landed,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
  };
}

// The job's latest close (each earlier version stays stored and answers its own request again).
async function closesOf(tx: CompanyTransaction, job: JobRow): Promise<CloseRow[]> {
  return (await tx
    .select(closeColumns)
    .from(jobCloses)
    .where(and(eq(jobCloses.companyId, job.companyId), eq(jobCloses.jobId, job.id)))
    .orderBy(desc(jobCloses.revision))
    .limit(1)) as CloseRow[];
}

async function closeRevision(tx: CompanyTransaction, job: JobRow): Promise<number> {
  const [row] = await tx
    .select({ revision: max(jobCloses.revision) })
    .from(jobCloses)
    .where(and(eq(jobCloses.companyId, job.companyId), eq(jobCloses.jobId, job.id)));
  return row?.revision ?? 0;
}

// The days to preset (docs/estimate-assist.md): a finished watch's day count when drying_watch is on,
// otherwise the signed plan's drying days.
async function suggestedDays(tx: CompanyTransaction, job: JobRow, facts: SignedFacts, flags: CompanyFlags): Promise<{ days: number; source: 'watch' | 'plan' } | null> {
  if (flags.drying_watch) {
    const days = await finishedDayCount(tx, job, facts, await databaseNow(tx));
    if (days !== null) return { days, source: 'watch' };
  }
  return facts.plan ? { days: facts.plan.plannedDays, source: 'plan' } : null;
}

// The company's switches as they are now, in the request's own transaction; `estimate_assist` off is 404,
// as the route's switch (a switch turned off while the request waited).
async function switchesOn(tx: CompanyTransaction, companyId: string): Promise<CompanyFlags> {
  const flags = flagsFromRows(await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, companyId)));
  if (!flags.estimate_assist) throw new JobError('not_found');
  return flags;
}

// The original agreement's sample: stored, or written now from its signed record. Null when its signed
// amount cannot be proven.
async function baselineOf(tx: CompanyTransaction, job: JobRow): Promise<HistorySample | null> {
  const [original] = (await tx.execute(sql`
    SELECT id::text AS id FROM agreements WHERE company_id = ${job.companyId}::uuid AND job_id = ${job.id}::uuid AND kind = 'original'
  `)) as unknown as { id: string }[];
  if (!original) throw new JobError('not_signed');
  return (await storedSample(tx, job.companyId, job.id, original.id)) ?? (await writeSample(tx, job.companyId, job.id, original.id));
}

export function outcomeService(db: Database): OutcomeService {
  return {
    async read(caller, jobId) {
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await currentCaller(tx, caller, false);
          const flags = await switchesOn(tx, caller.companyId);
          const job = await jobAccess(tx, caller, jobId, READ);
          if (job.status !== 'signed') throw new JobError('not_signed');
          if (!hasAny(caller, CLOSE)) {
            // Whether it closed and when, and nothing else of the close.
            const [latest] = await tx
              .select({ closedAt: sql<string>`to_char(${jobCloses.closedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
              .from(jobCloses)
              .where(and(eq(jobCloses.companyId, job.companyId), eq(jobCloses.jobId, job.id)))
              .orderBy(desc(jobCloses.revision))
              .limit(1);
            return { jobId, access: 'status' as const, closed: latest !== undefined, closedAt: latest?.closedAt ?? null };
          }
          const [latest] = (await closesOf(tx, job)).map(closeView);
          const facts = await signedFacts(tx, job);
          return {
            jobId,
            access: 'full' as const,
            closed: latest !== undefined,
            closedAt: latest?.closedAt ?? null,
            agreementId: facts.agreementId,
            revision: latest?.revision ?? 0,
            close: latest ?? null,
            suggestedDays: await suggestedDays(tx, job, facts, flags),
          };
        },
        { snapshot: true },
      );
    },

    async close(caller, jobId, body) {
      return withCompany(db, caller.companyId, async (tx) => {
        await currentCaller(tx, caller, true);
        // After the company lock the operator's switch writer also takes.
        await switchesOn(tx, caller.companyId);
        const job = await jobAccess(tx, caller, jobId, CLOSE, { lock: true });
        const input = parseBody(closeBody, body);
        const digest = closeDigest(input);
        const [stored] = (await tx
          .select(closeColumns)
          .from(jobCloses)
          .where(and(eq(jobCloses.companyId, caller.companyId), eq(jobCloses.id, input.id)))) as CloseRow[];
        if (stored) {
          if (stored.jobId !== job.id || stored.requestDigest !== digest) throw new DryingError('conflict');
          return { created: false, close: closeView(stored) };
        }
        if (job.status !== 'signed') throw new JobError('not_signed');
        const { agreementId } = await signedFacts(tx, job);
        if (agreementId !== input.expectedAgreementId) throw new DryingError('stale_agreement');
        const revision = await closeRevision(tx, job);
        if (revision !== input.expectedRevision) throw new DryingError('stale_revision');
        const baseline = await baselineOf(tx, job);
        if (!baseline) throw new DryingError('no_signed_amount');
        const landed = landedOf(input.finalAmount, baseline);
        try {
          // Named one by one: the runtime may insert only these columns (0020); the close time is the guard's.
          await tx.execute(sql`
            INSERT INTO job_closes (id, company_id, job_id, agreement_id, revision, request_digest, final_cents, actual_days, note, baseline_agreement_id,
                                    price_mode, baseline_low_cents, baseline_high_cents, landed, closed_by_actor_id)
            VALUES (${input.id}::uuid, ${job.companyId}::uuid, ${job.id}::uuid, ${agreementId}::uuid, ${revision + 1}, ${digest}, ${input.finalAmount},
                    ${input.actualDays}, ${input.note}, ${baseline.agreementId}::uuid, ${baseline.priceMode}, ${baseline.lowCents}, ${baseline.highCents},
                    ${landed}, ${caller.actorId}::uuid)
          `);
        } catch (error) {
          refusedByDatabase(error);
        }
        await audit(tx, caller, 'job_closed', job.id, { close: input.id, revision: revision + 1 });
        const [made] = (await tx
          .select(closeColumns)
          .from(jobCloses)
          .where(and(eq(jobCloses.companyId, caller.companyId), eq(jobCloses.id, input.id)))) as CloseRow[];
        return { created: true, close: closeView(made!) };
      });
    },
  };
}
