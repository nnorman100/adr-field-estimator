import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { BudgetError, postgresAiBudget, type AiBudget } from '@/lib/ai/budget';
import { createAiBoundary, type AiModelPort } from '@/lib/ai/call';
import { AI_REGISTRY, type AiFeature, type AiRegistry } from '@/lib/ai/registry';
import { setCompanyAiCeilings } from '@/lib/ai/settings';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S7-4: the AI spend ledger (web/src/lib/ai/budget.ts) as the app's runtime role against Postgres
// with migration 0012, on a server set up like a fresh Cloud SQL instance (see team-harness.ts):
// parallel reservations across two companies, UTC day and month rollover, per-person quotas,
// idempotent settlement by call id, and holds that only a settlement with a known cost releases,
// including the hold a real crash leaves behind.

const webDir = fileURLToPath(new URL('../..', import.meta.url));

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let pool: ReturnType<typeof openDatabase>;
let budget: AiBudget;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await pool?.close();
  h = await resetTeamDatabase(base, h ?? null);
  // Ten connections, so parallel reservations really run side by side.
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 10 });
  budget = postgresAiBudget(pool.db);
});

afterAll(async () => {
  await pool?.close();
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const NOON = new Date('2026-11-13T12:00:00Z');

const ceilings = (company: string, daily: number | null, monthly: number | null) =>
  setCompanyAiCeilings(h.handle.db, h.seed.operator, company, { dailyCeilingMicroUsd: daily, monthlyCeilingMicroUsd: monthly });

const reserve = (
  company: string,
  actor: string,
  microUsd: number,
  at: Date = NOON,
  options: { feature?: AiFeature; callId?: string; on?: AiBudget } = {},
) =>
  (options.on ?? budget).reserve({
    companyId: company,
    actorId: actor,
    feature: options.feature ?? 'summary_draft',
    callId: options.callId ?? randomUUID(),
    model: 'gemini-3.8-flash',
    microUsd,
    at,
  });

const ok = async (result: Promise<Awaited<ReturnType<AiBudget['reserve']>>>) => {
  const r = await result;
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.reservationId;
};

type LedgerRow = { company: string; call: string; state: string; reserved: number; settled: number | null; day: string; month: string };
const ledger = (company: string) =>
  h.admin<LedgerRow[]>`
    SELECT company_id::text AS company, call_id::text AS call, state, reserved_micro_usd::int AS reserved,
           settled_micro_usd::int AS settled, utc_day::text AS day, utc_month::text AS month
    FROM ai_ledger WHERE company_id = ${company} ORDER BY created_at, call_id`;
const sum = (rows: LedgerRow[]) => rows.reduce((total, row) => total + (row.state === 'settled' ? row.settled! : row.reserved), 0);

describe('ceilings under parallel reservations', () => {
  it('50 parallel reservations across two companies never pass either company’s daily or monthly ceiling', async () => {
    // A is held by its daily ceiling, B by its monthly one (its daily ceiling is the $10 default);
    // each asks for far more than it may have.
    await ceilings(h.seed.a, 1_000_000, 5_000_000);
    await ceilings(h.seed.b, null, 700_000);
    const actorsA = [h.seed.ownerA.actor, h.seed.estimatorA.actor, h.seed.officeA.actor];
    const actorsB = [h.seed.ownerB.actor, h.seed.estimatorB.actor];
    const asks = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0
        ? { company: h.seed.a, actor: actorsA[i % actorsA.length]!, feature: (['summary_draft', 'scope_fill', 'meter_reading'] as const)[i % 3] }
        : { company: h.seed.b, actor: actorsB[i % actorsB.length]!, feature: (['summary_draft', 'job_summary'] as const)[i % 2] },
    );
    const results = await Promise.all(asks.map((ask) => reserve(ask.company, ask.actor, 100_000, NOON, { feature: ask.feature })));

    const granted = (company: string) => results.filter((r, i) => r.ok && asks[i]!.company === company).length;
    expect(granted(h.seed.a)).toBe(10);
    expect(granted(h.seed.b)).toBe(7);
    // Every refusal is "room taken by calls in progress": nothing has settled yet.
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'held' && r.retryAfterSeconds === 60)).toBe(true);
    const a = await ledger(h.seed.a);
    const b = await ledger(h.seed.b);
    expect(sum(a)).toBe(1_000_000);
    expect(sum(b)).toBe(700_000);
    expect(new Set([...a, ...b].map((row) => row.call)).size).toBe(17);
    // Each company's usage shows its own rows only.
    expect((await budget.usage(h.seed.a, NOON)).today).toMatchObject({ usedMicroUsd: 1_000_000, heldMicroUsd: 1_000_000, ceilingMicroUsd: 1_000_000, ceilingSet: true });
    expect((await budget.usage(h.seed.b, NOON)).thisMonth).toMatchObject({ usedMicroUsd: 700_000, ceilingMicroUsd: 700_000 });
  });

  it('uses the V5 B defaults, $10 a day and $200 a month, for a company with no stored ceilings', async () => {
    const usage = await budget.usage(h.seed.a, NOON);
    expect(usage).toEqual({
      today: { period: '2026-11-13', ceilingMicroUsd: 10_000_000, ceilingSet: false, usedMicroUsd: 0, heldMicroUsd: 0, resetsAt: '2026-11-14T00:00:00.000Z' },
      thisMonth: { period: '2026-11', ceilingMicroUsd: 200_000_000, ceilingSet: false, usedMicroUsd: 0, heldMicroUsd: 0, resetsAt: '2026-12-01T00:00:00.000Z' },
    });
    await ok(reserve(h.seed.a, h.seed.ownerA.actor, 10_000_000));
    expect(await reserve(h.seed.a, h.seed.ownerA.actor, 1)).toMatchObject({ ok: false, reason: 'held' });
  });
});

describe('UTC day and month rollover', () => {
  it('starts a new day at UTC midnight and a new month on the 1st, and a late settlement stays in its own month', async () => {
    await ceilings(h.seed.a, 1_000_000, 1_500_000);
    const owner = h.seed.ownerA.actor;

    // 29 November, a millisecond before midnight: the day fills.
    const lastMoment29 = new Date('2026-11-29T23:59:59.999Z');
    await budget.settle(await ok(reserve(h.seed.a, owner, 1_000_000, lastMoment29)), 1_000_000);
    expect(await reserve(h.seed.a, owner, 1, lastMoment29)).toEqual({ ok: false, reason: 'daily', retryAfterSeconds: 1 });

    // 30 November: a new day, the same month (1.0 of 1.5 dollars used).
    const midnight30 = new Date('2026-11-30T00:00:00Z');
    const late = await ok(reserve(h.seed.a, owner, 500_000, midnight30));
    expect(await reserve(h.seed.a, owner, 1, midnight30)).toMatchObject({ ok: false, reason: 'held' });
    await budget.settle(late, 500_000);
    expect(await reserve(h.seed.a, owner, 1, midnight30)).toEqual({ ok: false, reason: 'monthly', retryAfterSeconds: 24 * 3600 });

    // A call reserved in the last second of November and settled after midnight stays in November.
    await ceilings(h.seed.a, 1_000_000, 2_000_000);
    const straddle = await ok(reserve(h.seed.a, owner, 200_000, new Date('2026-11-30T23:59:59Z')));

    // 1 December: a new day and a new month.
    const december = new Date('2026-12-01T00:00:00Z');
    await budget.settle(straddle, 300_000);
    await ok(reserve(h.seed.a, owner, 1_000_000, december));
    expect(await reserve(h.seed.a, owner, 1, december)).toMatchObject({ ok: false, reason: 'held' });

    const rows = await ledger(h.seed.a);
    expect(rows.map((row) => [row.day, row.month, row.state])).toEqual([
      ['2026-11-29', '2026-11-01', 'settled'],
      ['2026-11-30', '2026-11-01', 'settled'],
      ['2026-11-30', '2026-11-01', 'settled'],
      ['2026-12-01', '2026-12-01', 'reserved'],
    ]);
    expect((await budget.usage(h.seed.a, new Date('2026-11-30T12:00:00Z'))).thisMonth.usedMicroUsd).toBe(1_800_000);
    expect(await budget.usage(h.seed.a, december)).toMatchObject({
      today: { period: '2026-12-01', usedMicroUsd: 1_000_000 },
      thisMonth: { period: '2026-12', usedMicroUsd: 1_000_000 },
    });
  });
});

describe('per-person, per-feature quotas', () => {
  it('lets each person make the feature’s daily number of calls, counted in the same transaction as the money', async () => {
    const registry: AiRegistry = { ...AI_REGISTRY, scope_fill: { ...AI_REGISTRY.scope_fill, dailyQuotaPerUser: 3 } };
    const limited = postgresAiBudget(pool.db, { registry });
    const estimator = h.seed.estimatorA.actor;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(h.seed.a, estimator, 1_000, NOON, { feature: 'scope_fill', on: limited })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual(Array(7).fill({ ok: false, reason: 'quota', retryAfterSeconds: 12 * 3600 }));
    // Another person, another feature and the next UTC day are not counted against it.
    await ok(reserve(h.seed.a, h.seed.ownerA.actor, 1_000, NOON, { feature: 'scope_fill', on: limited }));
    await ok(reserve(h.seed.a, estimator, 1_000, NOON, { feature: 'meter_reading', on: limited }));
    await ok(reserve(h.seed.a, estimator, 1_000, new Date('2026-11-14T00:00:00Z'), { feature: 'scope_fill', on: limited }));
    // The quota port reads the same count.
    expect(await limited.take({ companyId: h.seed.a, actorId: estimator, feature: 'scope_fill', limit: 3, day: '2026-11-13' })).toBe(false);
    expect(await limited.take({ companyId: h.seed.a, actorId: estimator, feature: 'scope_fill', limit: 3, day: '2026-11-14' })).toBe(true);
  });
});

describe('settlement and holds', () => {
  it('settles once by call id: a repeat changes nothing, an unknown reservation is refused', async () => {
    const call = randomUUID();
    const id = await ok(reserve(h.seed.a, h.seed.ownerA.actor, 50_000, NOON, { callId: call }));
    // A retried reservation of the same call finds its row.
    expect(await reserve(h.seed.a, h.seed.ownerA.actor, 50_000, NOON, { callId: call })).toEqual({ ok: true, reservationId: id });
    await budget.settle(id, 12_345);
    await budget.settle(id, 99_999);
    await budget.hold(id);
    expect(await ledger(h.seed.a)).toEqual([expect.objectContaining({ call, state: 'settled', reserved: 50_000, settled: 12_345 })]);
    // A settled call id cannot be reserved again, so a call never runs twice on one reservation.
    await expect(reserve(h.seed.a, h.seed.ownerA.actor, 50_000, NOON, { callId: call })).rejects.toThrow(BudgetError);
    await expect(budget.settle(`${h.seed.a}:${randomUUID()}`, 1)).rejects.toMatchObject({ code: 'unknown_reservation' });
    await expect(budget.settle('not-a-reservation', 1)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(budget.settle(id, -1)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('cannot settle or read another company’s reservation', async () => {
    const id = await ok(reserve(h.seed.a, h.seed.ownerA.actor, 50_000));
    const callOfA = id.split(':')[1]!;
    await expect(budget.settle(`${h.seed.b}:${callOfA}`, 0)).rejects.toMatchObject({ code: 'unknown_reservation' });
    expect((await ledger(h.seed.a))[0]).toMatchObject({ state: 'reserved' });
    expect((await budget.usage(h.seed.b, NOON)).today.usedMicroUsd).toBe(0);
  });

  it('keeps a hold charged until a settlement with a known cost, which may be lower', async () => {
    await ceilings(h.seed.a, 100_000, 1_000_000);
    const id = await ok(reserve(h.seed.a, h.seed.ownerA.actor, 100_000));
    await budget.hold(id);
    await budget.hold(id);
    expect((await ledger(h.seed.a))[0]).toMatchObject({ state: 'held', settled: null });
    // Waiting releases nothing: later the same day the hold still fills the ceiling.
    expect(await reserve(h.seed.a, h.seed.ownerA.actor, 1, new Date('2026-11-13T23:59:00Z'))).toMatchObject({ ok: false, reason: 'held' });
    expect((await budget.usage(h.seed.a, NOON)).today).toMatchObject({ usedMicroUsd: 100_000, heldMicroUsd: 100_000 });
    await budget.settle(id, 40_000);
    expect((await budget.usage(h.seed.a, NOON)).today).toMatchObject({ usedMicroUsd: 40_000, heldMicroUsd: 0 });
    await ok(reserve(h.seed.a, h.seed.ownerA.actor, 60_000));
  });

  it('through the AI boundary: a timed-out model keeps the whole reservation as a hold', async () => {
    const registry: AiRegistry = { ...AI_REGISTRY, voice_note: { ...AI_REGISTRY.voice_note, deadlineMs: 50 } };
    const model: AiModelPort = { generate: () => new Promise(() => {}) };
    const boundary = createAiBoundary({
      model,
      armor: { screenPrompt: async () => ({ ok: true, category: 'passed' }), screenResponse: async () => ({ ok: true, category: 'passed' }) },
      quota: budget,
      budget,
      registry,
      log: () => {},
    });
    const outcome = await boundary.call(
      { companyId: h.seed.a, actorId: h.seed.estimatorA.actor, capabilities: ['scope'], flags: { ai_voice_notes: true } },
      { feature: 'voice_note', audio: { bytes: new Uint8Array(3_000), mimeType: 'audio/webm' }, schema: z.string() },
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code: 'model_timeout' } });
    const [row] = await ledger(h.seed.a);
    expect(row).toMatchObject({ state: 'held', settled: null });
    expect(row!.reserved).toBeGreaterThan(0);
  });
});

describe('a crash', () => {
  it('leaves the reservation charged as an open hold when the process dies during the model call', async () => {
    // About $0.12 is reserved for the voice note (its bytes / 3 plus its output cap).
    await ceilings(h.seed.a, 200_000, 1_000_000);
    const dir = mkdtempSync(join(tmpdir(), 'dryscope-ai-crash-'));
    const marker = join(dir, 'model-called');
    const call = randomUUID();
    try {
      const child = spawn('npx', ['tsx', 'tests/db/ai-budget-crash-child.ts'], {
        cwd: webDir,
        env: {
          ...process.env,
          DATABASE_URL: '',
          CRASH_DATABASE_URL: h.apiUrl,
          CRASH_COMPANY: h.seed.a,
          CRASH_ACTOR: h.seed.estimatorA.actor,
          CRASH_CALL: call,
          CRASH_MARKER: marker,
        },
        stdio: 'ignore',
        detached: true,
      });
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
      const deadline = Date.now() + 25_000;
      while (!existsSync(marker) || readFileSync(marker, 'utf8') === '') {
        if (Date.now() > deadline) throw new Error('the process never reached its model call');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // SIGKILL to the whole process group (npx, tsx and node): no settlement and no clean-up run.
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const [row] = await ledger(h.seed.a);
    expect(row).toMatchObject({ call, state: 'reserved', settled: null });
    // The hold counts against the ceiling, and nothing refunds it by itself: the room left is the
    // ceiling less the whole reservation, now and later the same UTC day.
    const room = 200_000 - row!.reserved;
    expect((await budget.usage(h.seed.a, new Date())).today).toMatchObject({ usedMicroUsd: row!.reserved, heldMicroUsd: row!.reserved });
    expect(await reserve(h.seed.a, h.seed.ownerA.actor, room + 1, new Date())).toMatchObject({ ok: false, reason: 'held' });
    // Only a settlement with a known cost releases it (the sweeper's job, S8).
    await budget.settle(`${h.seed.a}:${call}`, 0);
    await ok(reserve(h.seed.a, h.seed.ownerA.actor, 200_000, new Date()));
  });
});
