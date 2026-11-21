import { describe, expect, it } from 'vitest';
import { listQuery, readingBody, readingDigest, roomLabelOk, storedPayload, voidBody, voidDigest } from '@/lib/drying/schema';

// S5b-10 slice 10B: what the drying log accepts. Each kind is the strict variant of the old app's
// contracts (backend/contracts.py) and matches the database's payload check (0020): the bounds, the
// text rules, no other key, and never a supplied air value.

const ID = '1b4e28ba-2fa1-4d2a-9c3e-5f6a7b8c9d0e';
const TAKEN = '2026-11-20T09:30:00.000-08:00';
const air = (extra: Record<string, unknown> = {}) => ({ id: ID, kind: 'air', takenAt: TAKEN, temperatureF: 70, relativeHumidity: 50, ...extra });
const material = (extra: Record<string, unknown> = {}) => ({ id: ID, kind: 'material', takenAt: TAKEN, roomId: 'kitchen', material: 'Drywall', moisture: 18, unit: '%MC', ...extra });
const thermal = (extra: Record<string, unknown> = {}) => ({ id: ID, kind: 'thermal', takenAt: TAKEN, roomId: 'kitchen', deltaTF: -6.5, ...extra });
const ok = (value: unknown) => readingBody.safeParse(value).success;

describe('air readings', () => {
  it('takes -40 to 150 °F and 1 to 100% RH, both ends included', () => {
    for (const [t, rh] of [[-40, 1], [150, 100], [70.25, 44.5]]) expect(ok(air({ temperatureF: t, relativeHumidity: rh }))).toBe(true);
    for (const [t, rh] of [[-40.01, 50], [150.01, 50], [70, 0.99], [70, 100.01], [70, 0]]) expect(ok(air({ temperatureF: t, relativeHumidity: rh }))).toBe(false);
  });

  it('refuses an air value supplied by the phone, and any other key', () => {
    for (const key of ['gpp', 'dewPointF', 'dewPointDepressionF', 'vaporPressureInhg', 'enthalpyBtuLb', 'gpp_value', 'companyId']) {
      expect(ok(air({ [key]: 1 }))).toBe(false);
    }
  });

  it('defaults the zone to affected, and keeps outside air out of any room', () => {
    const parsed = readingBody.parse(air());
    expect(parsed).toMatchObject({ kind: 'air', zone: 'affected', note: '' });
    expect(ok(air({ zone: 'outside' }))).toBe(true);
    expect(ok(air({ zone: 'outside', roomId: 'kitchen' }))).toBe(false);
    expect(ok(air({ zone: 'dehu_outlet', roomId: 'kitchen' }))).toBe(true);
    expect(ok(air({ zone: 'attic' }))).toBe(false);
  });

  it('needs a time with its offset', () => {
    expect(ok(air({ takenAt: '2026-11-20T09:30:00Z' }))).toBe(true);
    expect(ok(air({ takenAt: '2026-11-20T09:30:00' }))).toBe(false);
    expect(ok(air({ takenAt: '2026-11-20' }))).toBe(false);
  });

  it('takes only a time the database stores as given: a real day and an offset of at most 15:59', () => {
    for (const takenAt of ['2026-11-20T09:30:00+15:59', '2026-11-20T09:30:00-15:00', '2024-02-29T09:30:00.123456Z']) expect(ok(air({ takenAt }))).toBe(true);
    for (const takenAt of ['2026-11-20T09:30:00+16:00', '2026-11-20T09:30:00-16:30', '2026-02-30T09:30:00Z', '2025-02-29T09:30:00Z', '2026-04-31T09:30:00Z']) expect(ok(air({ takenAt }))).toBe(false);
  });
});

describe('material readings', () => {
  it('takes a label, a unit, a reading of 0 to 1,000 and a dry standard on the same scale or none', () => {
    expect(readingBody.parse(material())).toMatchObject({ dryStandard: null, affected: true });
    expect(ok(material({ moisture: 0, dryStandard: 1000, affected: false }))).toBe(true);
    for (const extra of [{ moisture: -1 }, { moisture: 1000.5 }, { dryStandard: -0.1 }, { material: '' }, { material: '   ' }, { material: '  ' }, { unit: 'x'.repeat(21) }, { material: 'a\nb' }]) {
      expect(ok(material(extra))).toBe(false);
    }
  });

  it('counts characters as the database does', () => {
    // 100 characters, each two UTF-16 units: still 100 characters.
    expect(ok(material({ material: '\u{1F4A7}'.repeat(100) }))).toBe(true);
    expect(ok(material({ material: '\u{1F4A7}'.repeat(101) }))).toBe(false);
  });
});

describe('thermal readings', () => {
  it('takes a delta from -200 to 200 and a named pattern, with a boundary note', () => {
    expect(readingBody.parse(thermal())).toMatchObject({ pattern: 'cold_anomaly', boundary: '' });
    expect(ok(thermal({ deltaTF: 200, pattern: 'evaporative_cooling', boundary: 'Line one\nline two' }))).toBe(true);
    for (const extra of [{ deltaTF: 200.1 }, { pattern: 'hot_spot' }, { boundary: 'x'.repeat(301) }, { boundary: 'bell\u0007' }]) expect(ok(thermal(extra))).toBe(false);
  });
});

describe('every reading', () => {
  it('has a note of at most 500 characters with line breaks and tabs, and no other control character', () => {
    expect(ok(air({ note: 'x'.repeat(500) }))).toBe(true);
    expect(ok(air({ note: 'x'.repeat(501) }))).toBe(false);
    expect(ok(air({ note: 'a\tb\r\nc' }))).toBe(true);
    expect(ok(air({ note: 'a\u0000b' }))).toBe(false);
  });

  it('names a room by its field id only', () => {
    expect(ok(material({ roomId: null }))).toBe(true);
    for (const roomId of ['', 'has space', 'x'.repeat(65), 7]) expect(ok(material({ roomId }))).toBe(false);
  });

  it('stores the kind fields under the database payload keys', () => {
    expect(storedPayload(readingBody.parse(air()))).toEqual({ zone: 'affected', temperature_f: 70, relative_humidity: 50, note: '' });
    expect(storedPayload(readingBody.parse(material()))).toEqual({ material: 'Drywall', moisture: 18, unit: '%MC', dry_standard: null, affected: true, note: '' });
    expect(storedPayload(readingBody.parse(thermal()))).toEqual({ delta_t_f: -6.5, pattern: 'cold_anomaly', boundary: '', note: '' });
  });

  it('digests the same reading the same way whatever the key order or a default left out', () => {
    const a = readingDigest(readingBody.parse(air()));
    expect(readingDigest(readingBody.parse({ relativeHumidity: 50, temperatureF: 70, kind: 'air', takenAt: TAKEN, id: ID, zone: 'affected', note: '', roomId: null }))).toBe(a);
    expect(readingDigest(readingBody.parse(air({ relativeHumidity: 51 })))).not.toBe(a);
    expect(readingDigest(readingBody.parse(air({ roomId: 'kitchen' })))).not.toBe(a);
  });
});

describe('voids and pages', () => {
  it('voids with the phone own change id and the active state it expects, nothing else', () => {
    expect(voidBody.safeParse({ changeId: ID, expectedState: 'active' }).success).toBe(true);
    for (const body of [{ changeId: ID }, { changeId: ID, expectedState: 'voided' }, { changeId: ID, expectedState: 'active', reason: 'x' }]) {
      expect(voidBody.safeParse(body).success).toBe(false);
    }
    const change = voidBody.parse({ changeId: ID, expectedState: 'active' });
    expect(voidDigest('r1', change)).not.toBe(voidDigest('r2', change));
    // The same ids in another letter case are the same void.
    expect(voidDigest('r1', voidBody.parse({ changeId: ID.toUpperCase(), expectedState: 'active' }))).toBe(voidDigest('r1', change));
  });

  it('takes a limit of 1 to 200 and an opaque cursor, nothing else', () => {
    expect(listQuery.parse({ limit: '200' })).toEqual({ limit: 200 });
    for (const query of [{ limit: '0' }, { limit: '201' }, { limit: '-1' }, { limit: '1.5' }, { cursor: 'not/base64' }, { other: '1' }]) {
      expect(listQuery.safeParse(query).success).toBe(false);
    }
  });

  it('keeps a room name as a label only as the database would', () => {
    expect(roomLabelOk('Kitchen')).toBe(true);
    expect(roomLabelOk('Kitchen\tnorth')).toBe(true);
    for (const value of ['', '   ', 'x'.repeat(101), 'a\u0001', 7, undefined]) expect(roomLabelOk(value)).toBe(false);
  });
});
