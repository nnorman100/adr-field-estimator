import { describe, expect, it } from 'vitest';
import { aiUsageView, canReadAiUsage, formatMicroUsd, usedOf } from '@/lib/ai/usage-screen';

// S7-4: the pure helpers behind "AI used today / this month" on the owner's Company settings.
// tests/db/ai-usage-api.test.ts drives the route against Postgres; tests/e2e/company.spec.ts the screen.

const period = {
  period: '2026-11-13',
  ceilingMicroUsd: 10_000_000,
  ceilingSet: false,
  usedMicroUsd: 52_500,
  heldMicroUsd: 40_000,
  resetsAt: '2026-11-14T00:00:00.000Z',
};
const answer = { today: period, thisMonth: { ...period, period: '2026-11', ceilingMicroUsd: 200_000_000 } };

describe('the AI use lines', () => {
  it('reads the server’s answer, and nothing of another shape', () => {
    expect(aiUsageView(answer)).toEqual(answer);
    for (const bad of [
      null,
      {},
      { today: period },
      { today: { ...period, usedMicroUsd: '52500' }, thisMonth: period },
      { today: { ...period, usedMicroUsd: -1 }, thisMonth: period },
      { today: { ...period, usedMicroUsd: 1.5 }, thisMonth: period },
      { today: { ...period, heldMicroUsd: 60_000 }, thisMonth: period },
      { today: { ...period, ceilingSet: 'no' }, thisMonth: period },
    ]) {
      expect(aiUsageView(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('shows dollars and cents, rounding what was used up to the next cent', () => {
    expect(formatMicroUsd(0)).toBe('$0.00');
    expect(formatMicroUsd(1)).toBe('$0.01');
    expect(formatMicroUsd(52_500)).toBe('$0.06');
    expect(formatMicroUsd(10_000_000)).toBe('$10.00');
    expect(formatMicroUsd(200_000_000)).toBe('$200.00');
    expect(formatMicroUsd(1_234_567_890)).toBe('$1,234.57');
    expect(formatMicroUsd(9_999, 'down')).toBe('$0.00');
    expect(usedOf(answer.today)).toBe('$0.06 of $10.00');
    expect(usedOf(answer.thisMonth)).toBe('$0.06 of $200.00');
  });

  it('asks for the usage only for a role holding ai_usage_read', () => {
    expect(canReadAiUsage({ capabilities: ['profile_manage', 'ai_usage_read'] })).toBe(true);
    expect(canReadAiUsage({ capabilities: ['jobs_read', 'scope'] })).toBe(false);
    expect(canReadAiUsage({ capabilities: 'ai_usage_read' })).toBe(false);
    expect(canReadAiUsage(null)).toBe(false);
  });
});
