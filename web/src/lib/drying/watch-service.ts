import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dryingReadings } from '@/db/drying-schema';
import { actors, agreements, companyFeatureFlags, jobCoordination, jobSubmissions, type DryingWatch, type DryingWatchReceipt } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { canonicalJson } from '@/lib/field/canonical';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { flagsFromRows } from '@/lib/flags';
import { audit } from '@/lib/jobs/service';
import { snapshotManifest } from '@/lib/submissions/snapshot';
import { DryingError } from './errors';
import { currentCaller, micros, parseBody, refusedByDatabase } from './readings';
import { nonblank, noteText } from './schema';
import { factsHash, finishedDayNumber, watchState, watchSummary, type SignedRoom, type WatchReading, type WatchState } from './watch';

// The drying watch's routes (S5b-10 slice 10B; docs/drying-watch.md), behind the company's
// `drying_watch` switch (the route files' requireFlag). A signed job only. Every function runs inside
// withCompany for the company of the verified sign-in, re-reads the caller first (readings.ts,
// currentCaller) and goes through the one job-access function.
//
// - Read: `jobs_read` (the owner, office and the estimator with the job): the status worked out now
//   from the signed facts, the live drying log and the clock (watch.ts), the staff's decisions, and the
//   hash of the facts a confirmation must name.
// - Act: Mark dry with `scope` or `coordination` (the estimator with the job, the owner, office);
//   Extend plan and Close monitoring with `coordination` (the owner and office). Each carries the phone's
//   own id, the facts hash the person reviewed, an explicit confirmation and a reason. The job is locked;
//   a request sent again gets its accepted receipt first, without the facts being worked out; a new
//   request then has the facts worked out and compared, and one change of the watch and one audit row
//   are saved. A new action answers its receipt and the watch now; a request sent again, its receipt only.
// - Both re-read the company's `drying_watch` switch in their own transaction (404 when off): the action
//   after the company lock the operator's switch writer also takes (a switch turned off before it is 404,
//   one turned off after it waits for the action); the read in its snapshot, as the switch stood then.
//
// The signed facts: the drying days and the rooms (by stable id, in their signed order, with their
// signed names) of the snapshot the agreement in force was signed from; the original signing starts
// day 1. A signed record without saved drying days has no plan to watch: the read says so, and an action
// is refused.

const READ: readonly Capability[] = ['jobs_read'];
const ACT: readonly Capability[] = ['scope', 'coordination'];
const NEEDS = { mark_dry: ['scope', 'coordination'], extend: ['coordination'], close: ['coordination'] } as const satisfies Record<string, readonly Capability[]>;
const MAX_EXTENSIONS = 100;

export const watchActionBody = z.strictObject({
  id: z.uuid().transform((value) => value.toLowerCase()),
  action: z.enum(['mark_dry', 'extend', 'close']),
  factsHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
  reason: noteText(500).refine(nonblank),
});
export type WatchActionInput = z.infer<typeof watchActionBody>;

/** SHA-256 of an action request: the same id and body is the same action. */
export function actionDigest(input: WatchActionInput): string {
  return createHash('sha256').update(canonicalJson({ id: input.id, action: input.action, factsHash: input.factsHash, reason: input.reason }), 'utf8').digest('hex');
}

export type WatchDecisionView = { action: DryingWatchReceipt['action']; reason: string; at: string; by: { actorId: string; displayName: string | null } };

export type WatchView =
  | { jobId: string; status: 'unavailable'; reason: 'no_plan' }
  | ({
      jobId: string;
      agreementId: string;
      factsHash: string;
      // The watch's own revision: one per accepted action, 0 before the first.
      revision: number;
      summary: string[];
      decisions: WatchDecisionView[];
      // The day count the job close may take when monitoring has finished.
      suggestedDays: number | null;
      // What the caller's role may do now (a hint for the screen; the action route checks again).
      can: { markDry: boolean; extend: boolean; close: boolean };
    } & WatchState);

// A new action answers its receipt and the watch now; a request sent again answers its receipt only.
export type WatchActionResult = { created: boolean; receipt: WatchDecisionView & { id: string }; watch?: WatchView };

export type WatchService = {
  read(caller: JobCaller, jobId: string): Promise<WatchView>;
  act(caller: JobCaller, jobId: string, body: string | null): Promise<WatchActionResult>;
};

export type SignedFacts = { agreementId: string; setupAt: Date; plan: { plannedDays: number; rooms: SignedRoom[] } | null };

// The agreement in force (the latest signed; S5b-9's resolver replaces this when revisions land), the
// original signing's time, and the plan of the snapshot the agreement in force was signed from, for each
// of these jobs of the company. Day one is the original signing's; a job signs its original first, so one
// without it has no entry (no watch).
export async function signedFactsMany(tx: CompanyTransaction, companyId: string, jobIds: readonly string[]): Promise<Map<string, SignedFacts>> {
  const found = new Map<string, SignedFacts>();
  if (jobIds.length === 0) return found;
  const signed = await tx
    .select({ id: agreements.id, jobId: agreements.jobId, kind: agreements.kind, submissionId: agreements.submissionId, signedAt: agreements.signedAt })
    .from(agreements)
    .where(and(eq(agreements.companyId, companyId), inArray(agreements.jobId, [...jobIds])))
    .orderBy(asc(agreements.signedAt), asc(agreements.id));
  const byJob = new Map<string, typeof signed>();
  for (const row of signed) byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row]);
  const inForce = new Map<string, (typeof signed)[number]>();
  for (const [jobId, rows] of byJob) {
    if (rows.some((row) => row.kind === 'original')) inForce.set(jobId, rows.at(-1)!);
  }
  const submissions =
    inForce.size === 0
      ? []
      : await tx
          .select({ id: jobSubmissions.id, bytes: jobSubmissions.snapshotBytes })
          .from(jobSubmissions)
          .where(and(eq(jobSubmissions.companyId, companyId), inArray(jobSubmissions.id, [...new Set([...inForce.values()].map((row) => row.submissionId))])));
  const bytes = new Map(submissions.map((row) => [row.id, row.bytes]));
  for (const [jobId, row] of inForce) {
    const original = byJob.get(jobId)!.find((candidate) => candidate.kind === 'original')!;
    const snapshot = bytes.get(row.submissionId);
    found.set(jobId, { agreementId: row.id, setupAt: original.signedAt, plan: snapshot ? planOf(snapshot) : null });
  }
  return found;
}

export async function signedFacts(tx: CompanyTransaction, job: JobRow): Promise<SignedFacts> {
  const facts = (await signedFactsMany(tx, job.companyId, [job.id])).get(job.id);
  if (!facts) throw new JobError('not_signed');
  return facts;
}

// The signed drying days and rooms, or null for a record that does not keep them.
function planOf(bytes: Buffer): SignedFacts['plan'] {
  let manifest;
  try {
    manifest = snapshotManifest(bytes);
  } catch {
    return null;
  }
  const draft = (manifest.draft ?? {}) as { dryingDays?: unknown; roomOrder?: unknown };
  if (typeof draft.dryingDays !== 'number' || !Number.isInteger(draft.dryingDays) || draft.dryingDays < 1) return null;
  const order = Array.isArray(draft.roomOrder) ? draft.roomOrder.filter((id): id is string => typeof id === 'string') : [];
  const rooms = order.flatMap((id) => {
    const name = (manifest.rooms.find((room) => room.id === id)?.field as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' ? [{ id, name }] : [];
  });
  return { plannedDays: draft.dryingDays, rooms };
}

type LogFacts = { readings: WatchReading[]; version: { readings: number; voids: number; changedAt: string | null } };

// The active readings of these jobs for the status (times as text, to keep their microseconds), by job.
// A voided reading's fields are never loaded.
async function activeReadings(tx: CompanyTransaction, companyId: string, jobIds: readonly string[]): Promise<Map<string, WatchReading[]>> {
  const found = new Map<string, WatchReading[]>(jobIds.map((id) => [id, []]));
  if (jobIds.length === 0) return found;
  const rows = await tx
    .select({
      id: dryingReadings.id,
      jobId: dryingReadings.jobId,
      kind: dryingReadings.kind,
      roomId: dryingReadings.roomId,
      takenAt: micros(dryingReadings.takenAt),
      receivedAt: micros(dryingReadings.receivedAt),
      payload: dryingReadings.payload,
      gpp: dryingReadings.gpp,
    })
    .from(dryingReadings)
    .where(and(eq(dryingReadings.companyId, companyId), inArray(dryingReadings.jobId, [...jobIds]), isNull(dryingReadings.voidedAt)));
  for (const row of rows) {
    const p = row.payload as Record<string, unknown>;
    found.get(row.jobId)!.push({
      id: row.id,
      kind: row.kind,
      roomId: row.roomId,
      takenAt: row.takenAt,
      receivedAt: row.receivedAt,
      ...(row.kind === 'air' ? { zone: p.zone as string, gpp: row.gpp! } : {}),
      ...(row.kind === 'material'
        ? { material: p.material as string, unit: p.unit as string, moisture: p.moisture as number, dryStandard: (p.dry_standard as number | null) ?? null, affected: p.affected !== false }
        : {}),
    });
  }
  return found;
}

// The job's active readings, and the log's version (every reading and void counted, with the latest
// receive or void time), so any change to the log changes the facts hash. The version is counted in the
// database.
async function logFacts(tx: CompanyTransaction, job: JobRow): Promise<LogFacts> {
  const readings = (await activeReadings(tx, job.companyId, [job.id])).get(job.id)!;
  const [counted] = await tx
    .select({
      readings: sql<number>`count(*)::int`,
      voids: sql<number>`count(${dryingReadings.voidedAt})::int`,
      // Null for an empty log.
      changedAt: micros(sql`max(greatest(${dryingReadings.receivedAt}, ${dryingReadings.voidedAt}))`),
    })
    .from(dryingReadings)
    .where(and(eq(dryingReadings.companyId, job.companyId), eq(dryingReadings.jobId, job.id)));
  // An aggregate with no GROUP BY always answers one row: zero counts and no time for an empty log.
  return { readings, version: { readings: counted!.readings, voids: counted!.voids, changedAt: counted!.changedAt } };
}

async function watchesOf(tx: CompanyTransaction, companyId: string, jobIds: readonly string[]): Promise<Map<string, DryingWatch>> {
  if (jobIds.length === 0) return new Map();
  const rows = await tx
    .select({ jobId: jobCoordination.jobId, watch: jobCoordination.dryingWatch })
    .from(jobCoordination)
    .where(and(eq(jobCoordination.companyId, companyId), inArray(jobCoordination.jobId, [...jobIds])));
  return new Map(rows.flatMap((row) => (row.watch ? [[row.jobId, row.watch] as const] : [])));
}

async function watchOf(tx: CompanyTransaction, job: JobRow): Promise<DryingWatch> {
  return (await watchesOf(tx, job.companyId, [job.id])).get(job.id) ?? { revision: 0, receipts: [] };
}

// The status worked out from one job's signed plan, its active readings, the staff's decisions and the clock.
function stateOf(facts: { setupAt: Date; plan: NonNullable<SignedFacts['plan']> }, readings: WatchReading[], watch: DryingWatch, at: string): WatchState {
  return watchState({ plannedDays: facts.plan.plannedDays, rooms: facts.plan.rooms, setupAt: facts.setupAt, readings, decisions: watch.receipts, at });
}

/**
 * The watch status of each of these signed jobs of the company, worked out in a fixed number of queries
 * (the jobs list's projection): null for a job whose signed record keeps no plan, or has no original
 * agreement. No facts hash, decision names or action hints are built.
 */
export async function watchStatesOf(tx: CompanyTransaction, companyId: string, jobIds: readonly string[], now: string): Promise<Map<string, WatchState | null>> {
  const facts = await signedFactsMany(tx, companyId, jobIds);
  const planned = jobIds.filter((id) => facts.get(id)?.plan);
  const readings = await activeReadings(tx, companyId, planned);
  const watches = await watchesOf(tx, companyId, planned);
  return new Map(
    jobIds.map((id) => {
      const found = facts.get(id);
      return [id, found?.plan ? stateOf({ setupAt: found.setupAt, plan: found.plan }, readings.get(id)!, watches.get(id) ?? { revision: 0, receipts: [] }, now) : null];
    }),
  );
}

async function decisionViews(tx: CompanyTransaction, companyId: string, receipts: DryingWatchReceipt[]): Promise<WatchDecisionView[]> {
  const ids = [...new Set(receipts.map((receipt) => receipt.actor_id))];
  const people = ids.length === 0 ? [] : await tx.select({ id: actors.id, displayName: actors.displayName }).from(actors).where(and(eq(actors.companyId, companyId), inArray(actors.id, ids)));
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  return receipts.map((receipt) => ({ action: receipt.action, reason: receipt.reason, at: receipt.at, by: { actorId: receipt.actor_id, displayName: names.get(receipt.actor_id) ?? null } }));
}

type Loaded = { facts: SignedFacts; log: LogFacts | null };

// What a status is worked out from besides the watch's receipts and the clock: the signed facts and the
// reading log (none when the signed record keeps no plan).
async function load(tx: CompanyTransaction, job: JobRow): Promise<Loaded> {
  if (job.status !== 'signed') throw new JobError('not_signed');
  const facts = await signedFacts(tx, job);
  return { facts, log: facts.plan ? await logFacts(tx, job) : null };
}

async function viewOf(tx: CompanyTransaction, caller: JobCaller, job: JobRow, now: string, { facts, log }: Loaded, watch: DryingWatch): Promise<WatchView> {
  if (!facts.plan || !log) return { jobId: job.id, status: 'unavailable', reason: 'no_plan' };
  const state = stateOf({ setupAt: facts.setupAt, plan: facts.plan }, log.readings, watch, now);
  const open = !watch.receipts.some((receipt) => receipt.action !== 'extend');
  return {
    jobId: job.id,
    agreementId: facts.agreementId,
    factsHash: factsHash({ agreementId: facts.agreementId, state, log: log.version, revision: watch.revision }),
    revision: watch.revision,
    ...state,
    summary: watchSummary(state),
    decisions: await decisionViews(tx, job.companyId, watch.receipts),
    suggestedDays: finishedDayNumber(state, watch.receipts),
    can: {
      markDry: open && hasAny(caller, NEEDS.mark_dry),
      extend: open && hasAny(caller, NEEDS.extend) && watch.receipts.length < MAX_EXTENSIONS,
      close: open && hasAny(caller, NEEDS.close),
    },
  };
}

/**
 * The watch's day count once monitoring has finished (marked dry, closed, or at its dry standard), for the
 * job close's suggested days: null while monitoring is active or when the signed record keeps no plan.
 * Works out only the watch's state, from the signed facts the caller has already read.
 */
export async function finishedDayCount(tx: CompanyTransaction, job: JobRow, facts: SignedFacts, now: string): Promise<number | null> {
  if (!facts.plan) return null;
  const log = await logFacts(tx, job);
  const watch = await watchOf(tx, job);
  const state = stateOf({ setupAt: facts.setupAt, plan: facts.plan }, log.readings, watch, now);
  return finishedDayNumber(state, watch.receipts);
}

// The database's clock (with its microseconds), so the status of a write is worked out at the time its
// receipt is stamped.
export async function databaseNow(tx: CompanyTransaction): Promise<string> {
  const [row] = (await tx.execute(sql`SELECT ${micros(sql`clock_timestamp()`)} AS now`)) as unknown as { now: string }[];
  return row!.now;
}

// The company's `drying_watch` switch as it is now, in the request's own transaction: off is 404, as the route's switch.
async function requireWatchOn(tx: CompanyTransaction, companyId: string): Promise<void> {
  const flags = flagsFromRows(await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, companyId)));
  if (!flags.drying_watch) throw new JobError('not_found');
}

export function watchService(db: Database): WatchService {
  return {
    async read(caller, jobId) {
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await currentCaller(tx, caller, false);
          await requireWatchOn(tx, caller.companyId);
          const job = await jobAccess(tx, caller, jobId, READ);
          return viewOf(tx, caller, job, await databaseNow(tx), await load(tx, job), await watchOf(tx, job));
        },
        { snapshot: true },
      );
    },

    async act(caller, jobId, body) {
      return withCompany(db, caller.companyId, async (tx) => {
        await currentCaller(tx, caller, true);
        await requireWatchOn(tx, caller.companyId);
        const job = await jobAccess(tx, caller, jobId, ACT, { lock: true });
        const input = parseBody(watchActionBody, body);
        if (!hasAny(caller, NEEDS[input.action])) throw new JobError('not_allowed');
        const digest = actionDigest(input);
        const watch = await watchOf(tx, job);
        const accepted = watch.receipts.find((receipt) => receipt.request_id === input.id);
        if (accepted) {
          if (accepted.request_digest !== digest) throw new DryingError('conflict');
          const [view] = await decisionViews(tx, job.companyId, [accepted]);
          return { created: false, receipt: { id: input.id, ...view! } };
        }
        const loaded = await load(tx, job);
        const before = await viewOf(tx, caller, job, await databaseNow(tx), loaded, watch);
        if (before.status === 'unavailable') throw new DryingError('no_plan');
        if (before.factsHash !== input.factsHash) throw new DryingError('stale_facts');
        if (watch.receipts.some((receipt) => receipt.action !== 'extend')) throw new DryingError('watch_closed');
        if (input.action === 'extend' && watch.receipts.filter((receipt) => receipt.action === 'extend').length >= MAX_EXTENSIONS) throw new DryingError('extension_limit');
        const receipt: DryingWatchReceipt = {
          action: input.action,
          agreement_id: loaded.facts.agreementId,
          reason: input.reason,
          actor_id: caller.actorId,
          // Stamped again by the database's guard (0020) with its own clock.
          at: new Date().toISOString().replace('Z', '000Z'),
          request_id: input.id,
          request_digest: digest,
        };
        const next: DryingWatch = { revision: watch.revision + 1, receipts: [...watch.receipts, receipt] };
        try {
          // The first action makes the coordination row at revision 0 ("no office change yet", 0020);
          // otherwise only the watch column changes, never the office notes or their revision.
          await tx.execute(sql`
            INSERT INTO job_coordination (company_id, job_id, revision, drying_watch)
            VALUES (${job.companyId}::uuid, ${job.id}::uuid, 0, ${JSON.stringify(next)}::jsonb)
            ON CONFLICT (company_id, job_id) DO UPDATE SET drying_watch = EXCLUDED.drying_watch
          `);
        } catch (error) {
          refusedByDatabase(error);
        }
        await audit(tx, caller, 'drying_watch_action', job.id, { action: input.action, request: input.id, revision: next.revision });
        const after = await viewOf(tx, caller, job, await databaseNow(tx), loaded, await watchOf(tx, job));
        if (after.status === 'unavailable') throw new DryingError('no_plan');
        return { created: true, receipt: { id: input.id, ...after.decisions.at(-1)! }, watch: after };
      });
    },
  };
}
