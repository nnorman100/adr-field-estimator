import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiBudgetServices } from '@/lib/ai/services';
import type { Harness } from './team-harness';

// S7-4: the AI usage route (the owner's "AI used today / this month") and the operator's AI
// settings route, through the real route files as the runtime role against Postgres (see
// team-harness.ts). Only the company's owner reads its usage; an estimator is refused (403) and
// another company's owner is told it does not exist (404). Only a platform operator sets a
// company's ceilings, and each change writes exactly one audit row; a refused request writes
// nothing. The answer holds AI spending only, never a price of the company's work.
const live = vi.hoisted(() => ({ harness: null as Harness | null, ai: null as AiBudgetServices | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/ai/services', async (actual) => ({
  ...(await actual<typeof import('@/lib/ai/services')>()),
  aiBudgetServices: () => live.ai!,
}));

const { GET: readUsage } = await import('@/app/api/companies/[companyId]/ai-usage/route');
const { PUT: putSettings } = await import('@/app/api/platform/companies/[companyId]/ai-settings/route');
const { aiBudgetService } = await import('@/lib/ai/services');
const { postgresAiBudget } = await import('@/lib/ai/budget');
const { everything, operatorClaims, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
type FakeClaims = import('./team-harness').FakeClaims;

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.ai = aiBudgetService(h.handle.db);
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const estimator: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const office: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ownerB: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const usage = async (claims: FakeClaims | null, companyId: string) => {
  const response = await readUsage(request(claims, `/api/companies/${companyId}/ai-usage`), params({ companyId }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null, response };
};
const setCeilings = async (claims: FakeClaims | null, companyId: string, body: unknown) => {
  const response = await putSettings(
    request(claims, `/api/platform/companies/${companyId}/ai-settings`, { method: 'PUT', body }),
    params({ companyId }),
  );
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null };
};
const audits = () =>
  h.admin<Json[]>`SELECT company_id::text, actor_id, operator_actor_id::text, action, target, details FROM audit_events WHERE action = 'ai_ceilings_set' ORDER BY created_at`;

// A settled call and an open one for company A, today.
async function spend(companyId: string, actor: string) {
  const budget = postgresAiBudget(h.handle.db);
  const at = new Date();
  const first = await budget.reserve({ companyId, actorId: actor, feature: 'summary_draft', callId: randomUUID(), model: 'gemini-3.8-flash', microUsd: 30_000, at });
  if (!first.ok) throw new Error('refused');
  await budget.settle(first.reservationId, 12_500);
  const second = await budget.reserve({ companyId, actorId: actor, feature: 'scope_fill', callId: randomUUID(), model: 'gemini-3.8-flash', microUsd: 40_000, at });
  if (!second.ok) throw new Error('refused');
}

const PERIOD = {
  period: expect.any(String),
  ceilingMicroUsd: expect.any(Number),
  ceilingSet: expect.any(Boolean),
  usedMicroUsd: expect.any(Number),
  heldMicroUsd: expect.any(Number),
  resetsAt: expect.any(String),
};

describe('GET /api/companies/{companyId}/ai-usage', () => {
  it('shows the owner the AI used today and this month against the default ceilings, and nothing else', async () => {
    await spend(h.seed.a, h.seed.estimatorA.actor);
    const { status, body, response } = await usage(owner(), h.seed.a);
    expect(status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ today: PERIOD, thisMonth: PERIOD });
    expect(body!.today).toMatchObject({ ceilingMicroUsd: 10_000_000, ceilingSet: false, usedMicroUsd: 52_500, heldMicroUsd: 40_000 });
    expect(body!.thisMonth).toMatchObject({ ceilingMicroUsd: 200_000_000, ceilingSet: false, usedMicroUsd: 52_500, heldMicroUsd: 40_000 });
    expect(body!.today.period).toBe(new Date().toISOString().slice(0, 10));
    // No price of the company's work, no person, no feature breakdown: only the two totals.
    expect(JSON.stringify(body)).not.toMatch(/price|total|estimate|job|actor|feature|email/i);
  });

  it('is refused to an estimator and to an office user, reading nothing', async () => {
    await spend(h.seed.a, h.seed.estimatorA.actor);
    for (const claims of [estimator, office]) {
      expect(await usage(claims, h.seed.a)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    }
  });

  it('tells another company’s owner that the company does not exist', async () => {
    await spend(h.seed.a, h.seed.estimatorA.actor);
    expect(await usage(ownerB, h.seed.a)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    // B's owner reads B's own usage, which holds nothing of A's.
    const own = await usage(ownerB, h.seed.b);
    expect(own.status).toBe(200);
    expect(own.body!.today.usedMicroUsd).toBe(0);
    expect(own.body!.thisMonth.usedMicroUsd).toBe(0);
  });

  it('is refused to a signed-out caller, and answers 404 for an id that is not a company id', async () => {
    expect((await usage(null, h.seed.a)).status).toBe(401);
    expect((await usage(owner(), 'not-a-uuid')).status).toBe(404);
    expect((await usage(owner(), randomUUID())).status).toBe(404);
  });
});

describe('PUT /api/platform/companies/{companyId}/ai-settings', () => {
  it('sets a company’s ceilings and writes exactly one audit row naming the operator', async () => {
    const before = await audits();
    expect(before).toEqual([]);
    const changed = await setCeilings(operatorClaims(), h.seed.a, { dailyCeilingMicroUsd: 5_000_000, monthlyCeilingMicroUsd: 100_000_000 });
    expect(changed).toEqual({
      status: 200,
      body: {
        companyId: h.seed.a,
        dailyCeilingMicroUsd: 5_000_000,
        monthlyCeilingMicroUsd: 100_000_000,
        previous: { dailyCeilingMicroUsd: null, monthlyCeilingMicroUsd: null },
      },
    });
    expect(await audits()).toEqual([
      {
        company_id: h.seed.a,
        actor_id: null,
        operator_actor_id: h.seed.operator,
        action: 'ai_ceilings_set',
        target: h.seed.a,
        details: {
          daily_ceiling_micro_usd: 5_000_000,
          monthly_ceiling_micro_usd: 100_000_000,
          previous_daily_ceiling_micro_usd: null,
          previous_monthly_ceiling_micro_usd: null,
        },
      },
    ]);
    const [row] = await h.admin<Json[]>`
      SELECT daily_ceiling_micro_usd::int AS daily, monthly_ceiling_micro_usd::int AS monthly, ceilings_set_by_operator_id::text AS operator,
             ceilings_set_at IS NOT NULL AS stamped, default_voice
      FROM company_ai_settings WHERE company_id = ${h.seed.a}`;
    expect(row).toEqual({ daily: 5_000_000, monthly: 100_000_000, operator: h.seed.operator, stamped: true, default_voice: null });
    // The owner now sees the stored ceilings; company B still has the defaults.
    expect((await usage(owner(), h.seed.a)).body!.today).toMatchObject({ ceilingMicroUsd: 5_000_000, ceilingSet: true });
    expect((await usage(ownerB, h.seed.b)).body!.today).toMatchObject({ ceilingMicroUsd: 10_000_000, ceilingSet: false });
  });

  it('records the previous ceilings, and null puts a ceiling back to the default', async () => {
    await setCeilings(operatorClaims(), h.seed.a, { dailyCeilingMicroUsd: 1_000_000, monthlyCeilingMicroUsd: 10_000_000 });
    const back = await setCeilings(operatorClaims(), h.seed.a, { dailyCeilingMicroUsd: null, monthlyCeilingMicroUsd: 10_000_000 });
    expect(back.body).toMatchObject({ previous: { dailyCeilingMicroUsd: 1_000_000, monthlyCeilingMicroUsd: 10_000_000 } });
    expect((await audits()).map((row) => row.details.previous_daily_ceiling_micro_usd)).toEqual([null, 1_000_000]);
    const today = (await usage(owner(), h.seed.a)).body!.today;
    expect(today).toMatchObject({ ceilingMicroUsd: 10_000_000, ceilingSet: false });
  });

  it('is refused to an owner, an estimator and an office user, writing nothing', async () => {
    const before = await everything(h.admin);
    for (const claims of [owner(), estimator, office, ownerB]) {
      const refused = await setCeilings(claims, h.seed.a, { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 1 });
      expect(refused).toEqual({ status: 403, body: { error: 'not_an_operator' } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a bad body and an unknown company, writing nothing (no audit row)', async () => {
    const before = await everything(h.admin);
    for (const body of [
      { dailyCeilingMicroUsd: 2_000_000, monthlyCeilingMicroUsd: 1_000_000 },
      { dailyCeilingMicroUsd: 1.5, monthlyCeilingMicroUsd: 10 },
      { dailyCeilingMicroUsd: 1_000_000 },
      { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 10, defaultVoice: 'Charon' },
      'not json',
    ]) {
      expect(await setCeilings(operatorClaims(), h.seed.a, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await setCeilings(operatorClaims(), randomUUID(), { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 1 })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await setCeilings(operatorClaims(), 'not-a-uuid', { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 1 })).toMatchObject({ status: 404 });
    expect(await everything(h.admin)).toBe(before);
  });

  it('leaves the company’s own voice choice as it was', async () => {
    await h.admin`INSERT INTO company_ai_settings (company_id, default_voice, default_voice_set_by_actor_id) VALUES (${h.seed.a}, 'Charon', ${h.seed.ownerA.actor})`;
    await setCeilings(operatorClaims(), h.seed.a, { dailyCeilingMicroUsd: 2_000_000, monthlyCeilingMicroUsd: 20_000_000 });
    const [row] = await h.admin<Json[]>`SELECT default_voice, daily_ceiling_micro_usd::int AS daily FROM company_ai_settings WHERE company_id = ${h.seed.a}`;
    expect(row).toEqual({ default_voice: 'Charon', daily: 2_000_000 });
  });
});
