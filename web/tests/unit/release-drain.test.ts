import { describe, expect, it } from 'vitest';
import { DRAIN_SECONDS, drainWaitSeconds } from '../../scripts/release-drain';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const changed = (minutesAgo: number) => ({
  name: 'projects/dryscope/locations/us-central1/services/dryscope-api-test',
  updateTime: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

describe('the drain wait before staging', () => {
  it('waits the full 15 minutes right after a traffic move', () => {
    expect(DRAIN_SECONDS).toBe(900);
    expect(drainWaitSeconds(changed(0), NOW)).toBe(900);
  });

  it('waits only what is left of the 15 minutes', () => {
    expect(drainWaitSeconds(changed(5), NOW)).toBe(600);
    expect(drainWaitSeconds({ updateTime: '2026-11-17T11:50:00.123456Z' }, NOW)).toBe(301);
  });

  it('does not wait once the service last changed 15 minutes ago or more', () => {
    expect(drainWaitSeconds(changed(15), NOW)).toBe(0);
    expect(drainWaitSeconds(changed(240), NOW)).toBe(0);
  });

  it('waits no more than 15 minutes when the service time is ahead of the runner clock', () => {
    expect(drainWaitSeconds(changed(-3), NOW)).toBe(900);
  });

  it.each([[{}], [{ updateTime: 'yesterday' }], [{ updateTime: 1700000000 }], [null]])(
    'refuses a service without a readable updateTime: %j',
    (service) => {
      expect(() => drainWaitSeconds(service, NOW)).toThrow('the service has no updateTime');
    },
  );
});
