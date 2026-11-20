import type { ReadinessFacts } from '@/lib/readiness/check';

// The old app's readiness cases (tests/fixtures/readiness.json, checked by tests/test_readiness.py
// against backend/readiness.py), ported to the rebuilt app's data: the field map's keys
// (src/lib/field/schema.ts), stable room ids, the job's address and claim from Postgres, and the
// job's price version. Where the rebuilt rules differ from the old ones, `ported` says how and why
// (S5b-10/11 plan, 11A, "Recommended deterministic checklist"; owner answer Q2 option A: the room
// photo checklist uses the room ids, tags and measurements the app already collects, without the
// old room switches and counts).

export type Case = {
  name: string;
  facts: ReadinessFacts;
  expected: string[];
  unavailable?: string[];
  ported?: string;
};

const photo = (roomId: string, shotTag: 'overview' | 'surface' | 'meter' | 'source' | 'contents' | 'equipment') => ({ roomId, shotTag });

/** The old "fully ready" case: one water room, its three baseline photos, equipment and a setup reading. */
export const ready = (): ReadinessFacts => ({
  propertyAddress: 'Synthetic property',
  claim: {},
  prices: { state: 'published', areaBasis: 'demolition' },
  draft: { yearBuilt: 2000, roomOrder: ['room-1'], summary: 'Synthetic summary of findings.', scopeConfirmed: true, airMovers: 3, dehumidifiers: 1 },
  rooms: [{ id: 'room-1', field: { name: 'Kitchen', category: 1, finishedSf: 10, unfinishedSf: 0, floorSf: 100, ceilingHeightFt: 8, waterClass: 2 } }],
  photos: [photo('room-1', 'overview'), photo('room-1', 'surface'), photo('room-1', 'meter')],
  setupReadings: 'present',
});

const withRoom = (facts: ReadinessFacts, field: ReadinessFacts['rooms'][number]['field']): ReadinessFacts => ({
  ...facts,
  rooms: [{ id: 'room-1', field }],
});

export const PORTED: Case[] = [
  {
    name: 'empty job',
    facts: {
      propertyAddress: '',
      claim: {},
      prices: { state: 'published', areaBasis: 'demolition' },
      draft: {},
      rooms: [],
      photos: [],
      setupReadings: 'unavailable',
    },
    expected: ['propertyAddress', 'yearBuilt', 'rooms', 'summary', 'scopeConfirmed'],
    unavailable: ['ocr'],
    ported:
      'No equipment gap: the rebuilt check asks for drying equipment only when a water room calls for it. The summary of findings is required (owner decision J1), so its gap is added.',
  },
  {
    name: 'no demolition',
    facts: withRoom(ready(), { name: 'Kitchen', category: 1, finishedSf: 0, unfinishedSf: 0, floorSf: 100, ceilingHeightFt: 8, waterClass: 2 }),
    expected: ['demolitionArea'],
  },
  {
    name: 'water sizing missing',
    facts: withRoom(ready(), { name: 'Kitchen', category: 1, finishedSf: 10, unfinishedSf: 0 }),
    expected: ['floorSf', 'ceilingHeightFt', 'waterClass'],
  },
  {
    name: 'mold only outside sizing',
    facts: withRoom(ready(), { name: 'Kitchen', category: 'mold', finishedSf: 0, unfinishedSf: 0 }),
    expected: ['affectedSf', 'moldCondition'],
    ported:
      'A mold room is sized by its affected area and condition, not by demolition area, and has no water sizing. The old room had neither, so those two gaps replace the old demolition gap.',
  },
  {
    name: 'two surfaces one photo',
    facts: { ...ready(), photos: [photo('room-1', 'overview'), photo('room-1', 'meter')] },
    expected: ['shot:surface'],
    ported:
      'The old case needed two surface photos from a room count of two. The rebuilt app keeps no room counts (owner answer Q2, option A), so the baseline needs one surface photo, and this case has none.',
  },
  {
    name: 'partial insurance claim',
    facts: { ...ready(), claim: { carrier: 'Synthetic carrier', claimNumber: 'C-1', dateOfLoss: '2026-10-20', adjusterName: 'Synthetic adjuster', policyNumber: '', lossCause: null } },
    expected: ['claim:policyNumber', 'claim:lossCause', 'claim:adjusterEmail', 'claim:adjusterPhone', 'claim:deductible'],
  },
  {
    name: 'equipment without setup readings',
    facts: { ...ready(), setupReadings: 'absent' },
    expected: ['setupReadings'],
  },
  {
    name: 'pending OCR',
    facts: ready(),
    expected: [],
    unavailable: ['ocr'],
    ported:
      'No meter-reading status is stored yet (it waits on the S7 meter workflow), so the check is always reported as unavailable and never guessed from a photo.',
  },
  {
    name: 'scope unconfirmed',
    facts: { ...ready(), draft: { ...ready().draft, scopeConfirmed: false } },
    expected: ['scopeConfirmed'],
  },
  {
    name: 'dehumidifiers without AHAM',
    facts: ready(),
    expected: [],
    ported: 'The field map has no dehumidifier pints-per-day rating to check, so no gap is raised for it.',
  },
  {
    name: 'legacy loss',
    facts: withRoom(ready(), { name: 'Kitchen', finishedSf: 10, unfinishedSf: 0 }),
    expected: ['category'],
    ported:
      'The old room had category 3 and no loss type, read as mold. A rebuilt room names water 1 to 3 or mold itself; one with no category gets a category gap and no sizing guessed for either kind.',
  },
  {
    name: 'fully ready',
    facts: ready(),
    expected: [],
  },
];
