import { describe, expect, it } from 'vitest';
import { calendarDay, factsHash, watchState, watchSummary, type WatchReading } from '@/lib/drying/watch';
import { WATCH_STATES } from './drying-watch-fixtures';

// S5b-10 slice 10B, the drying watch's status: the port of backend/drying_watch.py checked against the
// old app's own fixtures, then the rules the plan names (California days across daylight saving, due
// and overdue, future readings, coverage, the stalled trend, closing decisions) and the facts hash.

const at = (value: string) => new Date(value);
const instant = (value: string | null) => (value === null ? null : at(value).getTime());

describe('the old app’s status fixtures', () => {
  it.each(WATCH_STATES)('$name', (fixture) => {
    const state = watchState({
      plannedDays: fixture.plannedDays,
      rooms: fixture.rooms,
      setupAt: at(fixture.setupAt),
      at: at(fixture.at),
      readings: fixture.readings.map((reading) => ({ ...reading, takenAt: at(reading.takenAt) })),
      decisions: fixture.decisions,
    });
    expect({ status: state.status, flags: state.flags, nextDueAt: instant(state.nextDueAt) }).toEqual({
      status: fixture.expected.status,
      flags: fixture.expected.flags,
      nextDueAt: instant(fixture.expected.nextDueAt),
    });
  });
});

const KITCHEN = [{ id: 'kitchen', name: 'Kitchen' }];
const material = (id: string, takenAt: string, moisture: number, extra: Partial<WatchReading> = {}): WatchReading => ({
  id,
  kind: 'material',
  roomId: 'kitchen',
  takenAt: at(takenAt),
  material: 'Drywall',
  unit: '%WME',
  moisture,
  dryStandard: 12,
  affected: true,
  ...extra,
});
const air = (id: string, takenAt: string, gpp: number, extra: Partial<WatchReading> = {}): WatchReading => ({ id, kind: 'air', roomId: 'kitchen', takenAt: at(takenAt), zone: 'affected', gpp, ...extra });
const state = (readings: WatchReading[], now: string, extra: Partial<Parameters<typeof watchState>[0]> = {}) =>
  watchState({ plannedDays: 3, rooms: KITCHEN, setupAt: at('2026-10-21T16:00:00Z'), readings, decisions: [], at: at(now), ...extra });

describe('California days', () => {
  it('counts calendar days in America/Los_Angeles across a daylight saving change', () => {
    // 2026-11-01 02:00 PDT falls back to 01:00 PST: 23:30 PST on the 1st is still the 1st there.
    expect(calendarDay(at('2026-11-02T07:30:00Z'))).toBe('2026-11-01');
    expect(calendarDay(at('2026-11-02T08:30:00Z'))).toBe('2026-11-02');
    // Signed late on 31 October (PDT), day 3 is 2 November (PST), whatever the hours.
    const s = state([], '2026-11-02T20:00:00Z', { setupAt: at('2026-11-01T06:30:00Z') });
    expect(calendarDay(at('2026-11-01T06:30:00Z'))).toBe('2026-10-31');
    expect(s.dayNumber).toBe(3);
  });
});

describe('due and overdue', () => {
  it('is due 24 hours from the signing with no reading, then from the latest reading', () => {
    expect(state([], '2026-10-21T20:00:00Z').nextDueAt).toBe('2026-10-22T16:00:00.000000Z');
    expect(state([material('a', '2026-10-22T10:00:00Z', 20)], '2026-10-22T12:00:00Z').nextDueAt).toBe('2026-10-23T10:00:00.000000Z');
    expect(state([material('a', '2026-10-22T10:00:00Z', 20)], '2026-10-23T10:00:01Z').flags).toContain('overdue');
  });

  it('never lets a reading taken in the future defer a visit or attest dryness', () => {
    const future = [material('a', '2026-10-21T17:00:00Z', 30), material('b', '2026-10-30T17:00:00Z', 5)];
    const s = state(future, '2026-10-23T17:00:00Z');
    expect(s.status).toBe('active');
    expect(s.lastReadingAt).toBe('2026-10-21T17:00:00.000000Z');
    expect(s.flags).toContain('overdue');
  });
});

describe('microseconds and case', () => {
  it('orders readings and answers times to the microsecond', () => {
    // The wet reading is a few hundred microseconds later than the dry one, within one millisecond.
    // As the service passes them: the database's text of each time, microseconds kept.
    const readings = [
      material('wet', '2026-10-22T16:00:00Z', 30, { takenAt: '2026-10-22T16:00:00.123900Z' }),
      material('dry', '2026-10-22T16:00:00Z', 10, { takenAt: '2026-10-22T16:00:00.123100Z' }),
    ];
    const s = state(readings, '2026-10-22T17:00:00Z', { at: '2026-10-22T17:00:00.000000Z' });
    expect(s.status).toBe('active');
    expect(s.lastReadingAt).toBe('2026-10-22T16:00:00.123900Z');
    expect(s.nextDueAt).toBe('2026-10-23T16:00:00.123900Z');
    expect(s.roomReadings).toEqual([{ roomId: 'kitchen', lastReadingAt: '2026-10-22T16:00:00.123900Z', overdue: false }]);
    // Due means that very instant has passed.
    expect(state(readings, '2026-10-23T16:00:00Z', { at: '2026-10-23T16:00:00.123900Z' }).flags).not.toContain('overdue');
    expect(state(readings, '2026-10-23T16:00:00Z', { at: '2026-10-23T16:00:00.123901Z' }).flags).toContain('overdue');
  });

  it('matches a material whatever its case, ß, SS and capital ẞ alike', () => {
    const readings = [material('a', '2026-10-22T16:00:00Z', 30, { material: 'Außenwand' }), material('b', '2026-10-23T16:00:00Z', 10, { material: 'AUẞENWAND' }), material('c', '2026-10-23T16:05:00Z', 10, { material: 'AUSSENWAND' })];
    expect(state(readings, '2026-10-23T17:00:00Z')).toMatchObject({ status: 'dry_standard_met', materials: [{ moisture: 10 }] });
  });
});

describe('coverage and automatic dry', () => {
  it('needs an affected material reading in every signed room, each at or under its own standard', () => {
    const rooms = [...KITCHEN, { id: 'bath', name: 'Bath' }];
    const dryKitchen = [material('a', '2026-10-22T16:00:00Z', 10)];
    expect(state(dryKitchen, '2026-10-22T17:00:00Z', { rooms })).toMatchObject({ status: 'active', missingRooms: ['bath'] });
    const both = [...dryKitchen, material('b', '2026-10-22T16:05:00Z', 11, { roomId: 'bath' })];
    expect(state(both, '2026-10-22T17:00:00Z', { rooms })).toMatchObject({ status: 'dry_standard_met', missingRooms: [], flags: [], nextDueAt: null });
    // Air alone never proves dryness, and an unaffected material is no evidence.
    expect(state([air('c', '2026-10-22T16:00:00Z', 40), material('d', '2026-10-22T16:00:00Z', 5, { affected: false })], '2026-10-22T17:00:00Z').status).toBe('active');
  });

  it('reads the latest reading of each material, by label and unit whatever their case', () => {
    const readings = [material('a', '2026-10-22T16:00:00Z', 10), material('b', '2026-10-23T16:00:00Z', 15, { material: 'DRYWALL', unit: '%wme' })];
    expect(state(readings, '2026-10-23T17:00:00Z')).toMatchObject({ status: 'active', materials: [{ moisture: 15 }] });
    // Two readings taken at the same instant: the one received later is the latest.
    const tied = [material('z', '2026-10-23T16:00:00Z', 20, { receivedAt: at('2026-10-23T16:00:05Z') }), material('y', '2026-10-23T16:00:00Z', 9, { receivedAt: at('2026-10-23T16:00:09Z') })];
    expect(state(tied, '2026-10-23T17:00:00Z').status).toBe('dry_standard_met');
  });

  it('flags a missing standard', () => {
    expect(state([material('a', '2026-10-22T16:00:00Z', 10, { dryStandard: null })], '2026-10-22T17:00:00Z').flags).toEqual(['missing_dry_standard']);
  });
});

describe('the air trend', () => {
  it('is stalled when the latest affected GPP has not fallen across three recorded days, per room', () => {
    const stalled = [air('a', '2026-10-21T16:00:00Z', 70), air('b', '2026-10-22T16:00:00Z', 72), air('c', '2026-10-23T16:00:00Z', 72)];
    expect(state(stalled, '2026-10-23T17:00:00Z')).toMatchObject({ airTrends: [{ roomId: 'kitchen', trend: 'stalled' }] });
    expect(state(stalled, '2026-10-23T17:00:00Z').flags).toContain('stalled');
    const improving = [air('a', '2026-10-21T16:00:00Z', 70), air('b', '2026-10-22T16:00:00Z', 72), air('c', '2026-10-23T16:00:00Z', 60)];
    expect(state(improving, '2026-10-23T17:00:00Z').airTrends).toEqual([{ roomId: 'kitchen', trend: 'improving' }]);
    expect(state([air('a', '2026-10-21T16:00:00Z', 70)], '2026-10-21T17:00:00Z').airTrends).toEqual([{ roomId: 'kitchen', trend: 'recorded' }]);
  });

  it('measures progress against a reference only when one exists', () => {
    const readings = [air('a', '2026-10-21T16:00:00Z', 90), air('b', '2026-10-22T16:00:00Z', 70), air('r', '2026-10-22T16:10:00Z', 50, { roomId: null, zone: 'unaffected' })];
    expect(state(readings, '2026-10-22T17:00:00Z').air).toEqual([{ roomId: 'kitchen', firstGpp: 90, latestGpp: 70, referenceGpp: 50, percent: 50, days: 2 }]);
    expect(state(readings.slice(0, 2), '2026-10-22T17:00:00Z').air).toEqual([]);
  });
});

describe('staff decisions and the plan', () => {
  it('keeps an explicit closure closed, whatever the log says, with no due time or flags', () => {
    const wet = [material('a', '2026-10-22T16:00:00Z', 30)];
    expect(state(wet, '2026-10-30T17:00:00Z', { decisions: [{ action: 'mark_dry' }] })).toMatchObject({ status: 'marked_dry', flags: [], nextDueAt: null });
    expect(state(wet, '2026-10-30T17:00:00Z', { decisions: [{ action: 'extend' }, { action: 'close' }] })).toMatchObject({ status: 'closed' });
  });

  it('flags past the signed plan, and an extension does not move it', () => {
    const wet = [material('a', '2026-10-24T16:00:00Z', 30)];
    expect(state(wet, '2026-10-24T17:00:00Z', { decisions: [{ action: 'extend' }] }).flags).toContain('past_signed_plan');
  });
});

describe('the facts hash and the summary', () => {
  it('changes with the state, the log version, the agreement and the watch revision', () => {
    const s = state([material('a', '2026-10-22T16:00:00Z', 20)], '2026-10-22T17:00:00Z');
    const base = { agreementId: 'a1', state: s, log: { readings: 1, voids: 0, changedAt: '2026-10-22T16:00:01.000000Z' }, revision: 0 };
    const hash = factsHash(base);
    expect(factsHash({ ...base })).toBe(hash);
    for (const changed of [{ agreementId: 'a2' }, { revision: 1 }, { log: { ...base.log, voids: 1 } }, { state: { ...s, dayNumber: 3 } }]) {
      expect(factsHash({ ...base, ...changed })).not.toBe(hash);
    }
  });

  it('is fixed sentences from the facts, naming only signed rooms', () => {
    const stalled = [air('a', '2026-10-21T16:00:00Z', 70), air('b', '2026-10-22T16:00:00Z', 72), air('c', '2026-10-23T16:00:00Z', 72)];
    expect(watchSummary(state(stalled, '2026-10-23T17:00:00Z'))).toEqual([
      'Day 3 of 3 signed drying days.',
      '0 of 1 signed rooms have affected material readings.',
      'Kitchen: affected air has not fallen across three recorded days.',
    ]);
    // Read later the same California day as the next visit is due.
    expect(watchSummary(state(stalled, '2026-10-24T08:00:00Z'))).toContain('A reading is due today.');
  });
});
