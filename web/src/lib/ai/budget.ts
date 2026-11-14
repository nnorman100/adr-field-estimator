import { sql } from 'drizzle-orm';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { AiBudgetPort, AiQuotaPort, AiRefusal, AiReservation } from './call';
import { effectiveCeilings, type AiCeilings } from './ceilings';
import { AI_REGISTRY, isAiFeature, type AiRegistry } from './registry';
import { secondsUntilNextUtcDay, secondsUntilNextUtcMonth, utcDay, utcMonth } from './utc';

// The AI spend ledger (S7-4, docs/plans/S7.md section 3 "Budgets are reserved before work"): the
// Postgres store behind the AI boundary's budget and quota ports, over the S7-3 tables (migration
// 0012: ai_ledger and company_ai_settings). Money is whole micro-USD of Google's bill.
//
// - Reserve before work. A reservation is one ledger row per call id. Every company's reservations
//   run one after another (a transaction-scoped advisory lock on the company), so the sums each one
//   reads are the sums it commits against: parallel calls cannot pass a ceiling together.
// - Ceilings per company, per UTC day and per UTC month, both counting all AI. A row counts its
//   settled cost once settled, and its whole reservation until then. With nothing stored the V5 B
//   defaults apply (ceilings.ts); the operator's stored ceilings replace them (settings.ts).
// - Per-person, per-feature quotas per UTC day (the registry's dailyQuotaPerUser) are counted from
//   the same rows in the same transaction: every reserved call counts, whatever its outcome.
// - Refusals are retryable later, never "stop": the route answers 429 with Retry-After and says that
//   field work can continue (aiRefusalResponse).
// - Settlement is idempotent by call id: the first settlement fixes the cost, and a repeat changes
//   nothing. A call whose outcome is unknown (a timeout, a crash) keeps its whole reservation as a
//   hold. Holds never expire and never refund on their own (as the old docs/ai-spending.md): only a
//   settlement with a known cost (the sweeper, S8) releases one, and it stays in its own day and month.
//
// The reservation id the boundary carries is "<company id>:<call id>". It names the row without a
// second lookup and keeps every query inside that company (withCompany).

export const HELD_RETRY_AFTER_SECONDS = 60;
const MAX_MICRO_USD = Number.MAX_SAFE_INTEGER;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A request the ledger cannot take: a malformed id or amount, a reservation id that names no row, or
// a call id already used by another call. Fixed codes only; no value is repeated.
export class BudgetError extends Error {
  constructor(readonly code: 'invalid_request' | 'unknown_reservation' | 'call_reused') {
    super(`AI budget refused: ${code}`);
    this.name = 'BudgetError';
  }
}

export type UsagePeriod = {
  // UTC day (YYYY-MM-DD) or month (YYYY-MM).
  period: string;
  ceilingMicroUsd: number;
  // Whether the ceiling is the company's stored one rather than the default.
  ceilingSet: boolean;
  // Settled cost plus every reservation still open or held: what counts against the ceiling.
  usedMicroUsd: number;
  // The part of usedMicroUsd that is reservations not settled yet (calls in progress or held).
  heldMicroUsd: number;
  // When the period ends and the ceiling starts again, as an ISO time.
  resetsAt: string;
};

// The owner's view: AI spending only, never a price of the company's work.
export type AiUsage = { today: UsagePeriod; thisMonth: UsagePeriod };

export type AiBudget = AiBudgetPort &
  AiQuotaPort & {
    usage(companyId: string, at: Date): Promise<AiUsage>;
  };

type Totals = {
  daySettled: number;
  dayCommitted: number;
  monthSettled: number;
  monthCommitted: number;
};

const rows = <T>(result: unknown) => result as unknown as T[];

function amount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_MICRO_USD) {
    throw new BudgetError('invalid_request');
  }
  return value as number;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BudgetError('invalid_request');
  return value.toLowerCase();
}

export function reservationIdOf(companyId: string, callId: string): string {
  return `${uuid(companyId)}:${uuid(callId)}`;
}

function parseReservationId(value: unknown): { companyId: string; callId: string } {
  if (typeof value !== 'string') throw new BudgetError('invalid_request');
  const [companyId, callId, extra] = value.split(':');
  if (extra !== undefined) throw new BudgetError('invalid_request');
  return { companyId: uuid(companyId), callId: uuid(callId) };
}

// One company's reservations, one at a time, until the transaction ends. Two companies whose keys
// collide only wait for each other; neither can see the other's rows.
async function lockCompany(tx: CompanyTransaction, companyId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_ledger:${companyId}`}, 0))`);
}

export async function readCeilings(tx: CompanyTransaction, companyId: string): Promise<AiCeilings & { dailySet: boolean; monthlySet: boolean }> {
  const [row] = rows<{ daily: string | null; monthly: string | null }>(
    await tx.execute(sql`
      SELECT daily_ceiling_micro_usd::text AS daily, monthly_ceiling_micro_usd::text AS monthly
      FROM company_ai_settings WHERE company_id = ${companyId}::uuid
    `),
  );
  const stored = {
    dailyCeilingMicroUsd: row?.daily == null ? null : Number(row.daily),
    monthlyCeilingMicroUsd: row?.monthly == null ? null : Number(row.monthly),
  };
  return {
    ...effectiveCeilings(stored),
    dailySet: stored.dailyCeilingMicroUsd !== null,
    monthlySet: stored.monthlyCeilingMicroUsd !== null,
  };
}

// What counts against the day's and the month's ceilings: a settled row its cost, any other row its
// whole reservation (a hold is never refunded by waiting).
async function readTotals(tx: CompanyTransaction, companyId: string, day: string, month: string): Promise<Totals> {
  const [row] = rows<Record<keyof Totals, string>>(
    await tx.execute(sql`
      SELECT
        coalesce(sum(settled_micro_usd) FILTER (WHERE state = 'settled' AND utc_day = ${day}::date), 0)::text AS "daySettled",
        coalesce(sum(CASE WHEN state = 'settled' THEN settled_micro_usd ELSE reserved_micro_usd END)
          FILTER (WHERE utc_day = ${day}::date), 0)::text AS "dayCommitted",
        coalesce(sum(settled_micro_usd) FILTER (WHERE state = 'settled'), 0)::text AS "monthSettled",
        coalesce(sum(CASE WHEN state = 'settled' THEN settled_micro_usd ELSE reserved_micro_usd END), 0)::text AS "monthCommitted"
      FROM ai_ledger
      WHERE company_id = ${companyId}::uuid AND utc_month = ${month}::date
    `),
  );
  return {
    daySettled: Number(row?.daySettled ?? 0),
    dayCommitted: Number(row?.dayCommitted ?? 0),
    monthSettled: Number(row?.monthSettled ?? 0),
    monthCommitted: Number(row?.monthCommitted ?? 0),
  };
}

async function callsToday(tx: CompanyTransaction, companyId: string, actorId: string, feature: string, day: string): Promise<number> {
  const [row] = rows<{ n: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS n FROM ai_ledger
      WHERE company_id = ${companyId}::uuid AND actor_id = ${actorId}::uuid AND feature = ${feature} AND utc_day = ${day}::date
    `),
  );
  return row?.n ?? 0;
}

// Why a reservation of `microUsd` does not fit, or null when it does. A ceiling that settled spending
// alone already leaves no room for it waits for its period to end; room taken only by reservations
// still in progress or held may come back sooner, so that is asked again in a minute.
export function refusalFor(
  ceilings: AiCeilings,
  totals: Totals,
  microUsd: number,
  at: Date,
): Extract<AiReservation, { ok: false }> | null {
  if (totals.monthSettled + microUsd > ceilings.monthlyMicroUsd) {
    return { ok: false, reason: 'monthly', retryAfterSeconds: secondsUntilNextUtcMonth(at) };
  }
  if (totals.daySettled + microUsd > ceilings.dailyMicroUsd) {
    return { ok: false, reason: 'daily', retryAfterSeconds: secondsUntilNextUtcDay(at) };
  }
  if (totals.monthCommitted + microUsd > ceilings.monthlyMicroUsd || totals.dayCommitted + microUsd > ceilings.dailyMicroUsd) {
    return { ok: false, reason: 'held', retryAfterSeconds: HELD_RETRY_AFTER_SECONDS };
  }
  return null;
}

function resetsAt(at: Date, seconds: number): string {
  return new Date(Math.floor(at.getTime() / 1000) * 1000 + seconds * 1000).toISOString();
}

export function postgresAiBudget(db: Database, options: { registry?: AiRegistry } = {}): AiBudget {
  const registry = options.registry ?? AI_REGISTRY;

  // Settles or holds the row the reservation id names. A row already settled is left as it is (the
  // first settlement wins), and a hold of a held row changes nothing.
  async function close(reservationId: string, to: 'settled' | 'held', microUsd: number | null): Promise<void> {
    const { companyId, callId } = parseReservationId(reservationId);
    await withCompany(db, companyId, async (tx) => {
      const changed =
        to === 'settled'
          ? await tx.execute(sql`
              UPDATE ai_ledger SET state = 'settled', settled_micro_usd = ${microUsd}
              WHERE company_id = ${companyId}::uuid AND call_id = ${callId}::uuid AND state <> 'settled'
              RETURNING 1
            `)
          : await tx.execute(sql`
              UPDATE ai_ledger SET state = 'held'
              WHERE company_id = ${companyId}::uuid AND call_id = ${callId}::uuid AND state = 'reserved'
              RETURNING 1
            `);
      if (rows(changed).length > 0) return;
      const found = rows(
        await tx.execute(sql`SELECT 1 FROM ai_ledger WHERE company_id = ${companyId}::uuid AND call_id = ${callId}::uuid`),
      );
      if (found.length === 0) throw new BudgetError('unknown_reservation');
    });
  }

  return {
    async take({ companyId, actorId, feature, limit, day }) {
      const company = uuid(companyId);
      return withCompany(db, company, async (tx) => (await callsToday(tx, company, uuid(actorId), feature, day)) < limit);
    },

    async reserve(request) {
      const companyId = uuid(request.companyId);
      const actorId = uuid(request.actorId);
      const callId = uuid(request.callId);
      const microUsd = amount(request.microUsd);
      if (!isAiFeature(request.feature) || !(request.at instanceof Date) || Number.isNaN(request.at.getTime())) {
        throw new BudgetError('invalid_request');
      }
      const { feature, model, at } = request;
      const day = utcDay(at);
      const month = utcMonth(at);
      return withCompany(db, companyId, async (tx): Promise<AiReservation> => {
        await lockCompany(tx, companyId);
        // A retried reservation finds its own row; a call id another call used is refused, so a
        // settled call can never run again unreserved.
        const [existing] = rows<{ state: string; actor: string; feature: string }>(
          await tx.execute(sql`
            SELECT state, actor_id::text AS actor, feature FROM ai_ledger
            WHERE company_id = ${companyId}::uuid AND call_id = ${callId}::uuid
          `),
        );
        if (existing) {
          if (existing.state === 'reserved' && existing.actor === actorId && existing.feature === feature) {
            return { ok: true, reservationId: reservationIdOf(companyId, callId) };
          }
          throw new BudgetError('call_reused');
        }
        if ((await callsToday(tx, companyId, actorId, feature, day)) >= registry[feature].dailyQuotaPerUser) {
          return { ok: false, reason: 'quota', retryAfterSeconds: secondsUntilNextUtcDay(at) };
        }
        const refused = refusalFor(await readCeilings(tx, companyId), await readTotals(tx, companyId, day, month), microUsd, at);
        if (refused) return refused;
        await tx.execute(sql`
          INSERT INTO ai_ledger (company_id, call_id, actor_id, feature, model, reserved_micro_usd, utc_day, utc_month)
          VALUES (${companyId}::uuid, ${callId}::uuid, ${actorId}::uuid, ${feature}, ${model}, ${microUsd}, ${day}::date, ${month}::date)
        `);
        return { ok: true, reservationId: reservationIdOf(companyId, callId) };
      });
    },

    async settle(reservationId, microUsd) {
      await close(reservationId, 'settled', amount(microUsd));
    },

    async hold(reservationId) {
      await close(reservationId, 'held', null);
    },

    async usage(companyIdInput, at) {
      const companyId = uuid(companyIdInput);
      const day = utcDay(at);
      const month = utcMonth(at);
      return withCompany(db, companyId, async (tx) => {
        const ceilings = await readCeilings(tx, companyId);
        const totals = await readTotals(tx, companyId, day, month);
        return {
          today: {
            period: day,
            ceilingMicroUsd: ceilings.dailyMicroUsd,
            ceilingSet: ceilings.dailySet,
            usedMicroUsd: totals.dayCommitted,
            heldMicroUsd: totals.dayCommitted - totals.daySettled,
            resetsAt: resetsAt(at, secondsUntilNextUtcDay(at)),
          },
          thisMonth: {
            period: month.slice(0, 7),
            ceilingMicroUsd: ceilings.monthlyMicroUsd,
            ceilingSet: ceilings.monthlySet,
            usedMicroUsd: totals.monthCommitted,
            heldMicroUsd: totals.monthCommitted - totals.monthSettled,
            resetsAt: resetsAt(at, secondsUntilNextUtcMonth(at)),
          },
        };
      });
    },
  };
}

// A quota or budget refusal as the route answers it: 429 with Retry-After, and words that say the
// field work is saved and can go on without AI. Any other refusal is not a 429 and gets null.
export function aiRefusalResponse(refusal: AiRefusal): Response | null {
  if (refusal.code !== 'quota' && refusal.code !== 'budget') return null;
  const retryAfter = refusal.retryAfterSeconds ?? HELD_RETRY_AFTER_SECONDS;
  return Response.json(
    { error: refusal.code === 'quota' ? 'ai_quota' : 'ai_budget', message: refusal.message, retryAfterSeconds: retryAfter, fieldWorkContinues: true },
    { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } },
  );
}
