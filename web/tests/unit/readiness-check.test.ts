import { describe, expect, it } from 'vitest';
import { checkReadiness, parseDraft, READINESS_CODES, type ReadinessFacts } from '@/lib/readiness/check';
import { PORTED, ready } from './readiness-fixtures';

// S5b-11 slice 11A: the deterministic "Ready to review?" checklist (src/lib/readiness/check.ts). The
// old app's twelve cases (tests/fixtures/readiness.json) in the rebuilt app's data, then the cases
// the plan adds: mold against water category 3, duplicate room names, entered zeros, absent and
// unreadable prices, a part-filled claim, tagged and untagged photos, an older field shape, the
// setup reading unknown, absent and saved, and a stable order.

const codes = (facts: ReadinessFacts) => checkReadiness(facts).gaps.map((gap) => gap.code);

// Rooms given in any order, put in the draft's room order the way the route does: through parseDraft.
const inOrder = (facts: ReadinessFacts): ReadinessFacts => ({
  ...facts,
  rooms: parseDraft({ draft: facts.draft, rooms: facts.rooms.map((room) => ({ id: room.id, field: room.field })), photos: [] })!.rooms,
});

describe('the old app’s readiness cases, ported', () => {
  it.each(PORTED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = checkReadiness(c.facts);
    expect(result.gaps.map((gap) => gap.code)).toEqual(c.expected);
    expect(result.unavailable).toEqual(c.unavailable ?? ['ocr']);
    for (const gap of result.gaps) expect(READINESS_CODES.has(gap.code.startsWith('claim:') ? 'claim' : gap.code.startsWith('shot:') ? 'shot' : gap.code), gap.code).toBe(true);
  });

  it('says why each departure from the old rules was made', () => {
    for (const c of PORTED.filter((one) => one.ported !== undefined)) expect(c.ported!.length, c.name).toBeGreaterThan(40);
  });
});

describe('room gaps', () => {
  it('names a room by its stable id only, and treats water category 3 as water and mold as mold', () => {
    const facts: ReadinessFacts = {
      ...ready(),
      draft: { ...ready().draft, roomOrder: ['cat-3', 'mold'] },
      rooms: [
        { id: 'mold', field: { name: 'Bath', category: 'mold' } },
        { id: 'cat-3', field: { name: 'Bath', category: 3 } },
      ],
      photos: [],
    };
    const { gaps } = checkReadiness(inOrder(facts));
    expect(gaps).toEqual([
      { code: 'demolitionArea', roomId: 'cat-3' },
      { code: 'floorSf', roomId: 'cat-3' },
      { code: 'ceilingHeightFt', roomId: 'cat-3' },
      { code: 'waterClass', roomId: 'cat-3' },
      { code: 'shot:overview', roomId: 'cat-3', count: 1 },
      { code: 'shot:surface', roomId: 'cat-3', count: 1 },
      { code: 'shot:meter', roomId: 'cat-3', count: 1 },
      { code: 'affectedSf', roomId: 'mold' },
      { code: 'moldCondition', roomId: 'mold' },
      { code: 'shot:overview', roomId: 'mold', count: 1 },
      { code: 'shot:surface', roomId: 'mold', count: 1 },
      { code: 'shot:meter', roomId: 'mold', count: 1 },
    ]);
    // Two rooms with the same name are two rooms: neither one's photos count for the other.
    expect(JSON.stringify(gaps)).not.toContain('Bath');
  });

  it('asks a mold-only job for no drying equipment, and a water job with none for its counts', () => {
    const mold: ReadinessFacts = {
      ...ready(),
      draft: { ...ready().draft, airMovers: undefined, dehumidifiers: undefined },
      rooms: [{ id: 'room-1', field: { name: 'Attic', category: 'mold', affectedSf: 40, moldCondition: 2 } }],
    };
    expect(codes(mold)).toEqual([]);
    const water: ReadinessFacts = { ...ready(), draft: { ...ready().draft, airMovers: 0, dehumidifiers: undefined } };
    expect(codes(water)).toEqual(['equipment']);
    // With no equipment counted there is no setup reading to ask about, known or not.
    expect(checkReadiness({ ...water, setupReadings: 'unavailable' }).unavailable).toEqual(['ocr']);
  });

  it('keeps an entered zero: a wet floor area of 0 is a basis, a mold affected area of 0 is entered', () => {
    const wet: ReadinessFacts = { ...ready(), prices: { state: 'published', areaBasis: 'wet_floor' } };
    const zero = (field: object): ReadinessFacts => ({ ...wet, rooms: [{ id: 'room-1', field: { name: 'Kitchen', category: 2, ceilingHeightFt: 8, waterClass: 2, ...field } }] });
    expect(codes(zero({ wetFloorSf: 0, floorSf: 100 }))).toEqual([]);
    // Neither area: the room has no wet floor basis, and no floor area for the drying check.
    expect(codes(zero({}))).toEqual(['wetFloorArea', 'floorSf']);
    // The floor area alone is the wet floor basis's fallback.
    expect(codes(zero({ floorSf: 100 }))).toEqual([]);
    expect(codes(zero({ floorSf: 100, wetFloorSf: 120 }))).toEqual(['wetFloorExceedsFloor']);
    // Priced by demolition area: the demolition area is what is asked for.
    expect(codes({ ...zero({ floorSf: 100 }), prices: { state: 'published', areaBasis: 'demolition_with_waste' } })).toEqual(['demolitionArea']);
    const mold = { ...ready(), rooms: [{ id: 'room-1', field: { name: 'Attic', category: 'mold' as const, affectedSf: 0, moldCondition: 1 } }] };
    expect(codes(mold)).toEqual([]);
  });

  it('cannot tell the area basis while the price version is unreadable, and says so instead of guessing', () => {
    const facts: ReadinessFacts = { ...ready(), prices: { state: 'unavailable' }, rooms: [{ id: 'room-1', field: { name: 'Kitchen', category: 1, floorSf: 100, ceilingHeightFt: 8, waterClass: 2 } }] };
    const result = checkReadiness(facts);
    expect(result.gaps).toEqual([]);
    expect(result.unavailable).toEqual(['roomArea', 'ocr', 'prices']);
  });
});

describe('photos', () => {
  it('counts only a photo tagged with the shot and placed in that room', () => {
    const facts = (photos: ReadinessFacts['photos']): ReadinessFacts => ({ ...ready(), photos });
    expect(codes(facts([{ roomId: 'room-1', shotTag: 'overview' }, { roomId: 'room-1', shotTag: 'surface' }, { roomId: 'room-1' }]))).toEqual(['shot:meter']);
    // Untagged, unplaced, or placed in a room the draft does not list: none of them is the meter photo.
    expect(codes(facts([{ roomId: 'room-1', shotTag: 'overview' }, { roomId: 'room-1', shotTag: 'surface' }, { shotTag: 'meter' }, { roomId: 'gone', shotTag: 'meter' }]))).toEqual(['shot:meter']);
    // The conditional shots (source, contents, equipment) are never required (owner answer Q2, option A).
    expect(codes(facts([{ roomId: 'room-1', shotTag: 'overview' }, { roomId: 'room-1', shotTag: 'surface' }, { roomId: 'room-1', shotTag: 'meter' }]))).toEqual([]);
    expect(codes(facts([{ roomId: 'room-1', shotTag: 'source' }, { roomId: 'room-1', shotTag: 'contents' }, { roomId: 'room-1', shotTag: 'equipment' }]))).toEqual(['shot:overview', 'shot:surface', 'shot:meter']);
  });
});

describe('job gaps', () => {
  it('raises the no-prices gap only when no price version is published', () => {
    expect(codes({ ...ready(), prices: { state: 'none' } })).toEqual(['prices']);
    expect(checkReadiness({ ...ready(), prices: { state: 'none' } }).unavailable).toEqual(['roomArea', 'ocr']);
  });

  it('flags a part-filled claim by key only, and counts an entered deductible of 0', () => {
    const claim = { carrier: 'Do not repeat this carrier', claimNumber: 'C-1', policyNumber: 'P-1', dateOfLoss: '2026-10-20', lossCause: 'Pipe', adjusterName: 'A', adjusterEmail: 'a@example.invalid', adjusterPhone: '555-0100', deductible: '0' };
    expect(codes({ ...ready(), claim })).toEqual([]);
    const { gaps } = checkReadiness({ ...ready(), claim: { ...claim, deductible: '  ', adjusterPhone: null } });
    expect(gaps).toEqual([{ code: 'claim:adjusterPhone' }, { code: 'claim:deductible' }]);
    expect(JSON.stringify(gaps)).not.toContain('Do not repeat');
    // An empty claim is not a claim: nothing is asked for.
    expect(codes({ ...ready(), claim: { carrier: ' ', claimNumber: '', dateOfLoss: null } })).toEqual([]);
  });

  it('reads the setup reading as saved, absent or unknown, and never claims one is missing when unknown', () => {
    expect(codes({ ...ready(), setupReadings: 'present' })).toEqual([]);
    expect(codes({ ...ready(), setupReadings: 'absent' })).toEqual(['setupReadings']);
    const unknown = checkReadiness({ ...ready(), setupReadings: 'unavailable' });
    expect(unknown.gaps).toEqual([]);
    expect(unknown.unavailable).toEqual(['setupReadings', 'ocr']);
  });

  it('gives every gap in one stable order: job, rooms in the room order, then the job’s other checks', () => {
    const facts: ReadinessFacts = {
      propertyAddress: ' ',
      claim: { carrier: 'X' },
      prices: { state: 'none' },
      draft: { roomOrder: ['b', 'a'], dehumidifiers: 1 },
      rooms: [
        { id: 'a', field: { name: 'A' } },
        { id: 'b', field: { name: 'B', category: 2, floorSf: 10, wetFloorSf: 20, ceilingHeightFt: 8, waterClass: 1, finishedSf: 5 } },
      ],
      photos: [],
      setupReadings: 'absent',
    };
    const first = checkReadiness(inOrder(facts));
    expect(first.gaps.map((gap) => [gap.code, gap.roomId ?? ''])).toEqual([
      ['propertyAddress', ''],
      ['yearBuilt', ''],
      ['wetFloorExceedsFloor', 'b'],
      ['shot:overview', 'b'],
      ['shot:surface', 'b'],
      ['shot:meter', 'b'],
      ['category', 'a'],
      ['shot:overview', 'a'],
      ['shot:surface', 'a'],
      ['shot:meter', 'a'],
      ['claim:claimNumber', ''],
      ['claim:policyNumber', ''],
      ['claim:dateOfLoss', ''],
      ['claim:lossCause', ''],
      ['claim:adjusterName', ''],
      ['claim:adjusterEmail', ''],
      ['claim:adjusterPhone', ''],
      ['claim:deductible', ''],
      ['setupReadings', ''],
      ['prices', ''],
      ['summary', ''],
      ['scopeConfirmed', ''],
    ]);
    expect(checkReadiness(inOrder(structuredClone(facts)))).toEqual(first);
  });

  it('changes nothing it is given', () => {
    const facts = ready();
    const before = structuredClone(facts);
    checkReadiness(facts);
    expect(facts).toEqual(before);
  });
});

describe('reading the draft', () => {
  const manifest = (draft: unknown, rooms: { id: string; field: unknown }[], photos: { id: string; field: unknown }[] = []) => ({ draft, rooms, photos });

  it('puts the rooms in the room order and keeps the photo ids', () => {
    const parsed = parseDraft(
      manifest(
        { roomOrder: ['b', 'a'], yearBuilt: 1990 },
        [
          { id: 'a', field: { name: 'A' } },
          { id: 'b', field: { name: 'B' } },
        ],
        [{ id: 'p1', field: { roomId: 'a', shotTag: 'meter' } }],
      ),
    );
    expect(parsed).toEqual({
      draft: { roomOrder: ['b', 'a'], yearBuilt: 1990 },
      rooms: [
        { id: 'b', field: { name: 'B' } },
        { id: 'a', field: { name: 'A' } },
      ],
      photos: [{ id: 'p1', field: { roomId: 'a', shotTag: 'meter' } }],
    });
  });

  it('reads an older field shape, from before room types, items, prep tasks, findings and capture times', () => {
    const old = parseDraft(
      manifest({ roomOrder: ['k'], yearBuilt: 1970, notes: 'n', scopeConfirmed: true, airMovers: 2 }, [{ id: 'k', field: { name: 'Kitchen', category: 2, floorSf: 90 } }], [{ id: 'p', field: { roomId: 'k', shotTag: 'overview' } }]),
    );
    expect(old?.rooms).toEqual([{ id: 'k', field: { name: 'Kitchen', category: 2, floorSf: 90 } }]);
  });

  it('gives null, never a guess, for a draft whose maps or room order do not match the field map', () => {
    expect(parseDraft(manifest({ roomOrder: ['a'] }, []))).toBeNull();
    expect(parseDraft(manifest({}, [{ id: 'a', field: { name: 'A' } }]))).toBeNull();
    expect(parseDraft(manifest({ roomOrder: ['a'] }, [{ id: 'a', field: { name: 'A', category: 4 } }]))).toBeNull();
    expect(parseDraft(manifest({ unknownKey: 1 }, []))).toBeNull();
    expect(parseDraft(manifest({ roomOrder: ['a/b'] }, [{ id: 'a/b', field: {} }]))).toBeNull();
  });

  it('leaves out a photo reference whose map does not match, so it satisfies no shot', () => {
    const parsed = parseDraft(manifest({}, [], [{ id: 'bad', field: { shotTag: 'selfie' } }, { id: 'good', field: { shotTag: 'meter' } }]));
    expect(parsed?.photos).toEqual([{ id: 'good', field: { shotTag: 'meter' } }]);
  });
});
