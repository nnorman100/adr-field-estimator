import { describe, expect, it } from 'vitest';
import { AI_CEILING_DEFAULTS, effectiveCeilings } from '@/lib/ai/ceilings';

// S7-3, owner decision V5 B (docs/plans/S7.md section 8): with nothing stored, a company may spend
// $10 a day and $200 a month on AI, all features together. An explicit ceiling set by the operator
// replaces the default for that period only. Test companies' ceilings ($5 and $100 for the staff
// company, $1 and $10 for any other) are the owner's settings (step H), never code.
describe('AI ceilings', () => {
  it('defaults to $10 a day and $200 a month, in micro-USD', () => {
    expect(AI_CEILING_DEFAULTS).toEqual({
      dailyMicroUsd: 10_000_000,
      monthlyMicroUsd: 200_000_000,
    });
    expect(Object.isFrozen(AI_CEILING_DEFAULTS)).toBe(true);
  });

  it('uses the defaults when a company has no settings row, or a row with no ceilings', () => {
    expect(effectiveCeilings(null)).toEqual({
      dailyMicroUsd: 10_000_000,
      monthlyMicroUsd: 200_000_000,
    });
    expect(effectiveCeilings(undefined)).toEqual({
      dailyMicroUsd: 10_000_000,
      monthlyMicroUsd: 200_000_000,
    });
    expect(effectiveCeilings({ dailyCeilingMicroUsd: null, monthlyCeilingMicroUsd: null })).toEqual(
      { dailyMicroUsd: 10_000_000, monthlyMicroUsd: 200_000_000 },
    );
  });

  it('lets an explicit ceiling replace the default, each period on its own', () => {
    // The staff test company (step H).
    expect(
      effectiveCeilings({ dailyCeilingMicroUsd: 5_000_000, monthlyCeilingMicroUsd: 100_000_000 }),
    ).toEqual({ dailyMicroUsd: 5_000_000, monthlyMicroUsd: 100_000_000 });
    // Another test company (step H).
    expect(
      effectiveCeilings({ dailyCeilingMicroUsd: 1_000_000, monthlyCeilingMicroUsd: 10_000_000 }),
    ).toEqual({ dailyMicroUsd: 1_000_000, monthlyMicroUsd: 10_000_000 });
    expect(
      effectiveCeilings({ dailyCeilingMicroUsd: 2_000_000, monthlyCeilingMicroUsd: null }),
    ).toEqual({ dailyMicroUsd: 2_000_000, monthlyMicroUsd: 200_000_000 });
    // Zero is a real ceiling (no AI at all), not "unset".
    expect(effectiveCeilings({ dailyCeilingMicroUsd: 0, monthlyCeilingMicroUsd: 0 })).toEqual({
      dailyMicroUsd: 0,
      monthlyMicroUsd: 0,
    });
  });
});
