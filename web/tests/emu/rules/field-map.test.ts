// Field map v1 in the field rules (S5a-1): each draft, room and photo-reference `field` map is
// checked for its keys, their types and their sizes, against the emulator with two sign-in
// tenants. The maps that pass are also parsed by the shared Zod schema, so a value the rules let
// through is one the server reads. 200 means the rules allowed the call, 403 refused it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  draftFieldSchema,
  MAX_ROOMS,
  photoFieldSchema,
  roomFieldSchema,
  SHOT_TAGS,
} from '../../../src/lib/field/schema';
import { createTenant, signIn, signUp } from '../auth-emulator';
import { type Caller, commit, createDoc, type Data, serverSet, updateDoc, type Write } from './firestore-rest';

type User = { uid: string; caller: Caller };

const run = randomUUID().slice(0, 8);
const A = `field-a-${run}`;
const B = `field-b-${run}`;
const HOUR = 60 * 60 * 1000;

let estimatorA: User;
let estimatorB: User;

async function user(name: string, tenantId: string): Promise<User> {
  const email = `${name}-${run}@field-map.example.test`;
  const password = `synthetic-password-${name}`;
  const uid = await signUp(tenantId, email, password);
  return { uid, caller: { idToken: await signIn(tenantId, email, password) } };
}

const draft = (company: string, id: string) => `companies/${company}/drafts/${id}`;
const room = (company: string, id: string, roomId: string) => `${draft(company, id)}/rooms/${roomId}`;
const photo = (company: string, id: string, photoId: string) => `${draft(company, id)}/photos/${photoId}`;

async function serverDraft(company: string, id: string, owner: User, state: string): Promise<void> {
  await serverSet(draft(company, id), { fieldOwnerUid: owner.uid, state, field: {} });
  await serverSet(room(company, id, 'kitchen'), { field: { name: 'Kitchen' } });
  await serverSet(photo(company, id, 'p1'), { field: {} });
}

// A complete map of each kind, every key set to a value the engine accepts.
const DRAFT: Data = {
  yearBuilt: 1972,
  roomOrder: ['kitchen', 'hall'],
  notes: 'Supply line under the sink.',
  summary: 'Category 2 water in the kitchen and hall.',
  scopeConfirmed: true,
  airMovers: 4,
  dehumidifiers: 1,
  airScrubbers: 1,
  dryingDays: 3,
  woodFloorSystems: 0,
  woodFloorDays: 7,
  emergencyCalls: 1,
  monitoringHours: 13.25,
  haulLoads: 1,
  hepaFilters: 1,
  matterportScans: 0,
  dumpTruckLoads: 0,
  equipmentDecon: 0,
  powerDistribution: 0,
  laborHours: 2.5,
  isAfterHours: false,
};
const ROOM: Data = {
  name: 'Hall',
  category: 2,
  unfinishedSf: 40.5,
  finishedSf: 12,
  floorSf: 80,
  wetFloorSf: 60,
  wastePercent: 10,
};
const PHOTO: Data = { roomId: 'hall', shotTag: 'meter', capturedAt: '2026-11-15T12:00:00.000Z' };
// The room map with every key the Zod schema names, the v2 room inputs (S5a-10) beside the v1 keys.
const EVERY_ROOM_KEY: Data = {
  ...ROOM,
  roomTypeId: 'bathroom',
  waterClass: 2,
  ceilingHeightFt: 8,
  moldCondition: 1,
  affectedSf: 10,
  items: { flood_cut: '4' },
  prepTasks: ['Cover the hallway floor.'],
  findings: 'Wet drywall to 30 inches.',
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `room-${i}`);

beforeAll(async () => {
  const tenantA = await createTenant('field-a');
  const tenantB = await createTenant('field-b');
  estimatorA = await user('estimatorA', tenantA);
  estimatorB = await user('estimatorB', tenantB);
  await serverSet(`companies/${A}`, { authTenantId: tenantA });
  await serverSet(`companies/${B}`, { authTenantId: tenantB });
  const expiresAt = new Date(Date.now() + HOUR);
  await serverSet(`companies/${A}/access/${estimatorA.uid}`, { role: 'estimator', expiresAt });
  await serverSet(`companies/${B}/access/${estimatorB.uid}`, { role: 'estimator', expiresAt });
  await serverDraft(A, 'editing', estimatorA, 'editing');
  await serverDraft(A, 'submitting', estimatorA, 'submitting');
  await serverDraft(B, 'editing', estimatorB, 'editing');
});

describe('field map v1 rules', () => {
  it('accepts a complete draft, room and photo map in each company, and Zod reads them', async () => {
    expect(draftFieldSchema.safeParse(DRAFT).success).toBe(true);
    expect(roomFieldSchema.safeParse(ROOM).success).toBe(true);
    expect(photoFieldSchema.safeParse(PHOTO).success).toBe(true);
    for (const [company, who] of [
      [A, estimatorA],
      [B, estimatorB],
    ] as const) {
      expect(await updateDoc(who.caller, draft(company, 'editing'), { field: DRAFT }), company).toBe(200);
      expect(await createDoc(who.caller, room(company, 'editing', 'hall'), { field: ROOM }), company).toBe(200);
      expect(await updateDoc(who.caller, room(company, 'editing', 'kitchen'), { field: ROOM }), company).toBe(
        200,
      );
      expect(await createDoc(who.caller, photo(company, 'editing', 'p2'), { field: PHOTO }), company).toBe(200);
      expect(await updateDoc(who.caller, photo(company, 'editing', 'p1'), { field: PHOTO }), company).toBe(200);
      // Every key is optional: an empty map, and a draft holding only a summary, both pass.
      expect(await createDoc(who.caller, room(company, 'editing', 'empty'), { field: {} }), company).toBe(200);
      expect(await updateDoc(who.caller, draft(company, 'editing'), { field: { summary: 'x' } }), company).toBe(
        200,
      );
    }
  });

  it('accepts every key the Zod schema names in each map, and every shot tag', async () => {
    const a = estimatorA.caller;
    expect(Object.keys(DRAFT).sort()).toEqual(Object.keys(draftFieldSchema.shape).sort());
    expect(Object.keys(EVERY_ROOM_KEY).sort()).toEqual(Object.keys(roomFieldSchema.shape).sort());
    expect(Object.keys(PHOTO).sort()).toEqual(Object.keys(photoFieldSchema.shape).sort());
    expect(roomFieldSchema.safeParse(EVERY_ROOM_KEY).success).toBe(true);
    expect(await updateDoc(a, draft(A, 'editing'), { field: DRAFT })).toBe(200);
    expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: EVERY_ROOM_KEY })).toBe(200);
    expect(await updateDoc(a, photo(A, 'editing', 'p1'), { field: PHOTO })).toBe(200);
    for (const shotTag of SHOT_TAGS) {
      expect(photoFieldSchema.safeParse({ roomId: 'hall', shotTag }).success, shotTag).toBe(true);
      expect(await updateDoc(a, photo(A, 'editing', 'p1'), { field: { roomId: 'hall', shotTag } }), shotTag).toBe(200);
    }
  });

  it("refuses a valid map from company B's estimator on company A's draft", async () => {
    const b = estimatorB.caller;
    expect(await updateDoc(b, draft(A, 'editing'), { field: DRAFT })).toBe(403);
    expect(await createDoc(b, room(A, 'editing', 'b-room'), { field: ROOM })).toBe(403);
    expect(await updateDoc(b, room(A, 'editing', 'kitchen'), { field: ROOM })).toBe(403);
    expect(await createDoc(b, photo(A, 'editing', 'b-photo'), { field: PHOTO })).toBe(403);
  });

  it('refuses a value of the wrong type', async () => {
    const a = estimatorA.caller;
    const cases: Array<[string, string, Data]> = [
      ['draft', draft(A, 'editing'), { yearBuilt: '1972' }],
      ['draft', draft(A, 'editing'), { airMovers: 2.5 }],
      ['draft', draft(A, 'editing'), { scopeConfirmed: 'yes' }],
      ['draft', draft(A, 'editing'), { monitoringHours: '13' }],
      ['draft', draft(A, 'editing'), { notes: 12 }],
      ['draft', draft(A, 'editing'), { roomOrder: 'kitchen' }],
      ['draft', draft(A, 'editing'), { isAfterHours: null }],
      ['room', room(A, 'editing', 'kitchen'), { category: '2' }],
      ['room', room(A, 'editing', 'kitchen'), { category: 2.5 }],
      ['room', room(A, 'editing', 'kitchen'), { name: 7 }],
      ['room', room(A, 'editing', 'kitchen'), { unfinishedSf: '40' }],
      ['photo', photo(A, 'editing', 'p1'), { shotTag: 4 }],
      ['photo', photo(A, 'editing', 'p1'), { roomId: 4 }],
      ['photo', photo(A, 'editing', 'p1'), { capturedAt: 42 }],
      ['photo', photo(A, 'editing', 'p1'), { capturedAt: true }],
      ['photo', photo(A, 'editing', 'p1'), { capturedAt: { seconds: 1 } }],
    ];
    for (const [kind, path, field] of cases) {
      const label = `${kind} ${JSON.stringify(field)}`;
      const schema = { draft: draftFieldSchema, room: roomFieldSchema, photo: photoFieldSchema }[kind];
      expect(schema?.safeParse(field).success, label).toBe(false);
      expect(await updateDoc(a, path, { field }), label).toBe(403);
    }
    // `field` itself must be a map.
    expect(await updateDoc(a, draft(A, 'editing'), { field: 'notes' })).toBe(403);
    expect(await createDoc(a, room(A, 'editing', 'not-a-map'), { field: ['Hall'] })).toBe(403);
  });

  it('refuses a value out of range, and a shot tag or category not in the list', async () => {
    const a = estimatorA.caller;
    const nextYear = new Date().getUTCFullYear() + 1;
    for (const field of [
      { yearBuilt: 1799 },
      { yearBuilt: nextYear },
      { dryingDays: 0 },
      { airMovers: 101 },
      { airMovers: -1 },
      { laborHours: 500.5 },
    ]) {
      expect(draftFieldSchema.safeParse(field).success, JSON.stringify(field)).toBe(false);
      expect(await updateDoc(a, draft(A, 'editing'), { field }), JSON.stringify(field)).toBe(403);
    }
    for (const field of [{ category: 4 }, { category: 0 }, { floorSf: 0 }, { wastePercent: 101 }, { name: '' }]) {
      expect(roomFieldSchema.safeParse(field).success, JSON.stringify(field)).toBe(false);
      expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field }), JSON.stringify(field)).toBe(403);
    }
    for (const field of [
      { shotTag: 'selfie' },
      { roomId: '' },
      { roomId: 'kitchen/../x' },
      { capturedAt: '2026-11-15T12:00:00' },
      { capturedAt: '2026-11-15t12:00:00z' },
      { capturedAt: '2026-13-01T12:00:00Z' },
      { capturedAt: '2026-11-15T25:00:00Z' },
      { capturedAt: 'bad' },
      { capturedAt: '' },
      { capturedAt: `2026-11-15T12:00:00.${'1'.repeat(25)}Z` },
    ]) {
      expect(photoFieldSchema.safeParse(field).success, JSON.stringify(field)).toBe(false);
      expect(await updateDoc(a, photo(A, 'editing', 'p1'), { field }), JSON.stringify(field)).toBe(403);
    }
  });

  it('refuses a key the field map does not name, inside `field` and beside it', async () => {
    const a = estimatorA.caller;
    expect(draftFieldSchema.safeParse({ ...DRAFT, unitPrice: '9.99' }).success).toBe(false);
    expect(await updateDoc(a, draft(A, 'editing'), { field: { ...DRAFT, unitPrice: '9.99' } })).toBe(403);
    expect(await updateDoc(a, draft(A, 'editing'), { field: { total: 100 } })).toBe(403);
    expect(roomFieldSchema.safeParse({ ...ROOM, price: 1 }).success).toBe(false);
    expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { ...ROOM, price: 1 } })).toBe(403);
    expect(await createDoc(a, room(A, 'editing', 'extra-key'), { field: { name: 'x', loss: 'mold' } })).toBe(403);
    expect(photoFieldSchema.safeParse({ ...PHOTO, sha256: 'ab' }).success).toBe(false);
    expect(await createDoc(a, photo(A, 'editing', 'p-extra'), { field: { ...PHOTO, sha256: 'ab' } })).toBe(403);
    // Beside `field`, and in a collection or depth the map does not have.
    expect(await createDoc(a, photo(A, 'editing', 'p-side'), { field: PHOTO, ocrStatus: 'verified' })).toBe(403);
    expect(await createDoc(a, `${draft(A, 'editing')}/readings/r1`, { field: {} })).toBe(403);
    expect(await createDoc(a, `${room(A, 'editing', 'kitchen')}/readings/r1`, { field: {} })).toBe(403);
  });

  it('refuses an oversized list or text, and accepts each at its largest size', async () => {
    const a = estimatorA.caller;
    const path = draft(A, 'editing');
    const atMost: Data[] = [
      { roomOrder: ids(MAX_ROOMS) },
      { notes: 'n'.repeat(40_000) },
      { summary: 's'.repeat(6_000) },
    ];
    for (const field of atMost) {
      expect(draftFieldSchema.safeParse(field).success).toBe(true);
      expect(await updateDoc(a, path, { field })).toBe(200);
    }
    const tooLarge: Data[] = [
      { roomOrder: ids(MAX_ROOMS + 1) },
      { roomOrder: ['kitchen', 'kitchen'] },
      { notes: 'n'.repeat(40_001) },
      { summary: 's'.repeat(6_001) },
    ];
    for (const field of tooLarge) {
      expect(draftFieldSchema.safeParse(field).success).toBe(false);
      expect(await updateDoc(a, path, { field })).toBe(403);
    }
    expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { name: 'r'.repeat(100) } })).toBe(200);
    expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { name: 'r'.repeat(101) } })).toBe(403);
    expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { unfinishedSf: 100_001 } })).toBe(403);
    expect(await updateDoc(a, photo(A, 'editing', 'p1'), { field: { roomId: 'i'.repeat(65) } })).toBe(403);
  });

  it('refuses a valid map on a draft that is submitting', async () => {
    const a = estimatorA.caller;
    expect(await updateDoc(a, draft(A, 'submitting'), { field: DRAFT })).toBe(403);
    expect(await createDoc(a, room(A, 'submitting', 'hall'), { field: ROOM })).toBe(403);
    expect(await updateDoc(a, room(A, 'submitting', 'kitchen'), { field: ROOM })).toBe(403);
    expect(await createDoc(a, photo(A, 'submitting', 'p2'), { field: PHOTO })).toBe(403);
    expect(await updateDoc(a, photo(A, 'submitting', 'p1'), { field: PHOTO })).toBe(403);
    expect(await commit(a, [{ path: draft(A, 'submitting'), data: { field: DRAFT } }])).toBe(403);
    // Control: the same writes to company A's editing draft pass.
    expect(await createDoc(a, room(A, 'editing', 'control'), { field: ROOM })).toBe(200);
  });

  it('bounds every room-order entry to a string field id, including the last entry', async () => {
    const a = estimatorA.caller;
    const path = draft(A, 'editing');
    for (const entry of ['', 'x'.repeat(65), 'x'.repeat(200_000), 'room.with.dot', 'a,b', 1, null, { room: 'kitchen' }]) {
      const roomOrder = [...ids(MAX_ROOMS - 1), entry];
      expect(draftFieldSchema.safeParse({ roomOrder }).success).toBe(false);
      expect(await updateDoc(a, path, { field: { roomOrder } })).toBe(403);
    }
    for (const roomOrder of [[], [randomUUID()], ['A', '_', '-', 'a'.repeat(64)], ids(MAX_ROOMS)]) {
      expect(await updateDoc(a, path, { field: { roomOrder } })).toBe(200);
    }
  });

  it('refuses malformed room and photo document ids on create and update', async () => {
    const a = estimatorA.caller;
    for (const nested of [room, photo]) {
      for (const id of ['x'.repeat(65), 'x'.repeat(1000), 'id.with.dot', 'id,comma', 'id space', 'é']) {
        const path = nested(A, 'editing', id);
        expect(await createDoc(a, path, { field: {} })).toBe(403);
        // Old malformed references cannot be edited into apparently valid ones either.
        await serverSet(path, { field: {} });
        expect(await updateDoc(a, path, { field: {} })).toBe(403);
      }
      for (const id of [randomUUID(), 'A', '_', '-', 'a'.repeat(64)]) {
        const path = nested(A, 'editing', id);
        expect(await createDoc(a, path, { field: {} })).toBe(200);
        expect(await updateDoc(a, path, { field: {} })).toBe(200);
      }
    }
  });

  it('passes a batched write at the lookup limits', async () => {
    // Each write reads the company, the access record and, for a room or photo, the draft: two
    // or three documents, under the limit of 10 per write. A batch may read 20 documents in all;
    // counted per write, the draft update (2) and six room or photo writes (3 each) make 20.
    const writes: Write[] = [{ path: draft(B, 'editing'), data: { field: DRAFT } }];
    for (let i = 0; i < 3; i++) {
      writes.push({ path: room(B, 'editing', `batch-room-${i}`), data: { field: ROOM }, create: true });
      writes.push({ path: photo(B, 'editing', `batch-photo-${i}`), data: { field: PHOTO }, create: true });
    }
    expect(await commit(estimatorB.caller, writes)).toBe(200);
    // One bad map refuses the whole batch.
    const bad = writes.map((write) => ({ ...write, path: write.path.replace('batch-', 'bad-batch-') }));
    bad[0] = { path: draft(B, 'editing'), data: { field: { ...DRAFT, airMovers: 'four' } } };
    expect(await commit(estimatorB.caller, bad)).toBe(403);
  });
});
