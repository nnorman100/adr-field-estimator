import { describe, expect, it } from 'vitest';
import { HELD_RETRY_AFTER_SECONDS, aiRefusalResponse, refusalFor, reservationIdOf } from '@/lib/ai/budget';
import { AI_CEILING_DEFAULTS } from '@/lib/ai/ceilings';
import { aiSettingsInput } from '@/lib/ai/settings';
import { secondsUntilNextUtcDay, secondsUntilNextUtcMonth, utcDay, utcMonth } from '@/lib/ai/utc';

// S7-4: the ledger's pure rules. Reservations, settlement, holds and the routes against Postgres are
// tests/db/ai-budget.test.ts and tests/db/ai-usage-api.test.ts.

const at = (iso: string) => new Date(iso);
const none = { daySettled: 0, dayCommitted: 0, monthSettled: 0, monthCommitted: 0 };
const ceilings = { dailyMicroUsd: 1_000_000, monthlyMicroUsd: 5_000_000 };

describe('the UTC calendar', () => {
  it('counts in UTC days and months, whatever the local clock', () => {
    expect(utcDay(at('2026-11-30T23:59:59.999Z'))).toBe('2026-11-30');
    expect(utcDay(at('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    // 4 p.m. on 30 November in California is already 1 December in UTC.
    expect(utcDay(at('2026-11-30T16:00:00-08:00'))).toBe('2026-12-01');
    expect(utcMonth(at('2026-11-30T23:59:59.999Z'))).toBe('2026-11-01');
    expect(utcMonth(at('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    expect(utcMonth(at('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });

  it('says how long until the next UTC day and month, never zero', () => {
    expect(secondsUntilNextUtcDay(at('2026-11-13T12:00:00Z'))).toBe(12 * 3600);
    expect(secondsUntilNextUtcDay(at('2026-11-13T23:59:59.500Z'))).toBe(1);
    expect(secondsUntilNextUtcDay(at('2026-11-13T00:00:00Z'))).toBe(24 * 3600);
    expect(secondsUntilNextUtcMonth(at('2026-12-31T23:00:00Z'))).toBe(3600);
    expect(secondsUntilNextUtcMonth(at('2026-02-01T00:00:00Z'))).toBe(28 * 24 * 3600);
    expect(secondsUntilNextUtcMonth(at('2026-11-30T23:59:59.999Z'))).toBe(1);
  });
});

describe('whether a reservation fits', () => {
  const noon = at('2026-11-13T12:00:00Z');

  it('fits up to the ceiling exactly, and not one micro-USD more', () => {
    expect(refusalFor(ceilings, none, 1_000_000, noon)).toBeNull();
    expect(refusalFor(ceilings, { ...none, dayCommitted: 999_999, monthCommitted: 999_999 }, 1, noon)).toBeNull();
    expect(refusalFor(ceilings, { ...none, dayCommitted: 999_999, monthCommitted: 999_999 }, 2, noon)).toMatchObject({ ok: false });
  });

  it('waits for the next UTC day when settled spending fills the day', () => {
    const totals = { daySettled: 900_000, dayCommitted: 900_000, monthSettled: 900_000, monthCommitted: 900_000 };
    expect(refusalFor(ceilings, totals, 200_000, noon)).toEqual({ ok: false, reason: 'daily', retryAfterSeconds: 12 * 3600 });
  });

  it('waits for the next UTC month when settled spending fills the month, even if the day has room', () => {
    const totals = { daySettled: 0, dayCommitted: 0, monthSettled: 4_900_000, monthCommitted: 4_900_000 };
    expect(refusalFor(ceilings, totals, 200_000, at('2026-11-30T23:00:00Z'))).toEqual({
      ok: false,
      reason: 'monthly',
      retryAfterSeconds: 3600,
    });
  });

  it('asks again in a minute when only reservations still open or held take the room', () => {
    const totals = { daySettled: 100_000, dayCommitted: 950_000, monthSettled: 100_000, monthCommitted: 950_000 };
    expect(refusalFor(ceilings, totals, 100_000, noon)).toEqual({ ok: false, reason: 'held', retryAfterSeconds: HELD_RETRY_AFTER_SECONDS });
  });

  it('uses the V5 B defaults: $10 a day and $200 a month', () => {
    expect(AI_CEILING_DEFAULTS).toEqual({ dailyMicroUsd: 10_000_000, monthlyMicroUsd: 200_000_000 });
    expect(refusalFor(AI_CEILING_DEFAULTS, none, 10_000_000, noon)).toBeNull();
    expect(refusalFor(AI_CEILING_DEFAULTS, none, 10_000_001, noon)).toMatchObject({ reason: 'daily' });
  });
});

describe('the 429 a refused AI call answers', () => {
  it('says field work can continue, with Retry-After from the ledger', async () => {
    const response = aiRefusalResponse({
      code: 'budget',
      retryable: false,
      message: "Your company's AI allowance does not cover this request now. Your field work is saved; you can keep working without AI.",
      retryAfterSeconds: 3600,
    })!;
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ error: 'ai_budget', retryAfterSeconds: 3600, fieldWorkContinues: true });
    expect(body.message).toMatch(/field work is saved; you can keep working without AI/);
  });

  it('answers a quota refusal the same way, and a minute when no time is known', async () => {
    const response = aiRefusalResponse({ code: 'quota', retryable: false, message: 'Used up today. Your field work is saved.' })!;
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(HELD_RETRY_AFTER_SECONDS));
    expect(await response.json()).toMatchObject({ error: 'ai_quota', fieldWorkContinues: true });
  });

  it('is not a 429 for any other refusal', () => {
    for (const code of ['feature_off', 'model_timeout', 'input_blocked', 'not_allowed'] as const) {
      expect(aiRefusalResponse({ code, retryable: false, message: 'x' })).toBeNull();
    }
  });
});

describe('the reservation id and the operator’s ceilings body', () => {
  it('names one company and one call, and nothing else', () => {
    const company = '00000000-0000-4000-8000-00000000000A';
    const call = '00000000-0000-4000-8000-000000000001';
    expect(reservationIdOf(company, call)).toBe(`${company.toLowerCase()}:${call}`);
    expect(() => reservationIdOf('not-a-uuid', call)).toThrow();
  });

  it('takes two whole micro-USD amounts or null, the daily one not above the monthly one', () => {
    expect(aiSettingsInput.safeParse({ dailyCeilingMicroUsd: 5_000_000, monthlyCeilingMicroUsd: 100_000_000 }).success).toBe(true);
    expect(aiSettingsInput.safeParse({ dailyCeilingMicroUsd: null, monthlyCeilingMicroUsd: null }).success).toBe(true);
    for (const bad of [
      { dailyCeilingMicroUsd: 2, monthlyCeilingMicroUsd: 1 },
      { dailyCeilingMicroUsd: 1.5, monthlyCeilingMicroUsd: 10 },
      { dailyCeilingMicroUsd: -1, monthlyCeilingMicroUsd: 10 },
      { dailyCeilingMicroUsd: '5', monthlyCeilingMicroUsd: 10 },
      { dailyCeilingMicroUsd: 1 },
      { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 10, defaultVoice: 'Charon' },
      { dailyCeilingMicroUsd: Number.MAX_SAFE_INTEGER + 1, monthlyCeilingMicroUsd: null },
    ]) {
      expect(aiSettingsInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
