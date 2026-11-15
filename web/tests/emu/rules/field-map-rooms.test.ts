// Field map v2 room inputs in the field rules (S5a-10): room type, category with mold, water class,
// ceiling height, mold condition, affected area, the room's items (item id to quantity), prep tasks
// and findings, each checked for type, size and the per-room limits, against the emulator with two
// sign-in tenants. A map the rules pass is also one the shared Zod schema reads, and a value the
// schema refuses the rules refuse too (except what only the server checks: two decimal places, and
// whether an id is in the job's price list). 200 means the rules allowed the call, 403 refused it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PREP_TASK, MAX_PREP_TASKS, MAX_ROOM_ITEMS, roomFieldSchema } from '../../../src/lib/field/schema';
import { createTenant, signIn, signUp } from '../auth-emulator';
import { type Caller, createDoc, type Data, serverSet, updateDoc } from './firestore-rest';

type User = { uid: string; caller: Caller };

const run = randomUUID().slice(0, 8);
const A = `rooms-a-${run}`;
const B = `rooms-b-${run}`;
const HOUR = 60 * 60 * 1000;

let estimatorA: User;
let estimatorB: User;

async function user(name: string, tenantId: string): Promise<User> {
  const email = `${name}-${run}@field-rooms.example.test`;
  const password = `synthetic-password-${name}`;
  const uid = await signUp(tenantId, email, password);
  return { uid, caller: { idToken: await signIn(tenantId, email, password) } };
}

const draft = (company: string, id: string) => `companies/${company}/drafts/${id}`;
const room = (company: string, id: string, roomId: string) => `${draft(company, id)}/rooms/${roomId}`;

const itemsOf = (n: number, quantity: unknown = '2') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`item_${String(i).padStart(2, '0')}`, quantity]));

// Every new key at a value the engine accepts, beside the v1 keys.
const ROOM: Data = {
  name: 'Bathroom',
  roomTypeId: 'bathroom',
  category: 2,
  waterClass: 3,
  ceilingHeightFt: 8.5,
  floorSf: 60,
  wetFloorSf: 40,
  items: { flood_cut: '4', carpet_removal: '12.5' },
  prepTasks: ['Move the vanity contents to the garage.', 'Cover the hallway floor.'],
  findings: 'Wet drywall to 30 inches behind the toilet.',
};
const MOLD_ROOM: Data = { name: 'Attic', category: 'mold', moldCondition: 3, affectedSf: 45 };
// Each list and text at its largest size.
const LARGEST: Data = {
  name: 'r'.repeat(100),
  items: itemsOf(MAX_ROOM_ITEMS, '100000.00'),
  prepTasks: Array.from({ length: MAX_PREP_TASKS }, (_, i) => `${i}`.padEnd(MAX_PREP_TASK, 't')),
  findings: 'f'.repeat(2_000),
};

beforeAll(async () => {
  const tenantA = await createTenant('rooms-a');
  const tenantB = await createTenant('rooms-b');
  estimatorA = await user('estimatorA', tenantA);
  estimatorB = await user('estimatorB', tenantB);
  await serverSet(`companies/${A}`, { authTenantId: tenantA });
  await serverSet(`companies/${B}`, { authTenantId: tenantB });
  const expiresAt = new Date(Date.now() + HOUR);
  await serverSet(`companies/${A}/access/${estimatorA.uid}`, { role: 'estimator', expiresAt });
  await serverSet(`companies/${B}/access/${estimatorB.uid}`, { role: 'estimator', expiresAt });
  for (const [company, who] of [
    [A, estimatorA],
    [B, estimatorB],
  ] as const) {
    await serverSet(draft(company, 'editing'), { fieldOwnerUid: who.uid, state: 'editing', field: {} });
    await serverSet(room(company, 'editing', 'kitchen'), { field: { name: 'Kitchen' } });
  }
  await serverSet(draft(A, 'submitted'), { fieldOwnerUid: estimatorA.uid, state: 'submitted', field: {} });
  await serverSet(room(A, 'submitted', 'kitchen'), { field: { name: 'Kitchen' } });
});

describe('field map v2 room rules', () => {
  it('accepts a water room, a mold room and a room at every largest size in each company, and Zod reads them', async () => {
    for (const field of [ROOM, MOLD_ROOM, LARGEST]) expect(roomFieldSchema.safeParse(field).success).toBe(true);
    for (const [company, who] of [
      [A, estimatorA],
      [B, estimatorB],
    ] as const) {
      expect(await createDoc(who.caller, room(company, 'editing', 'bath'), { field: ROOM }), company).toBe(200);
      expect(await updateDoc(who.caller, room(company, 'editing', 'kitchen'), { field: MOLD_ROOM }), company).toBe(200);
      expect(await updateDoc(who.caller, room(company, 'editing', 'kitchen'), { field: LARGEST }), company).toBe(200);
      // Empty lists and an empty note are allowed; clearing is deleting the key.
      expect(await updateDoc(who.caller, room(company, 'editing', 'kitchen'), { field: { items: {}, prepTasks: [], findings: '' } }), company).toBe(200);
    }
  });

  it("refuses the same room from company B's estimator on company A's draft, and on a submitted draft", async () => {
    expect(await createDoc(estimatorB.caller, room(A, 'editing', 'b-room'), { field: ROOM })).toBe(403);
    expect(await updateDoc(estimatorB.caller, room(A, 'editing', 'kitchen'), { field: ROOM })).toBe(403);
    expect(await updateDoc(estimatorA.caller, room(A, 'submitted', 'kitchen'), { field: ROOM })).toBe(403);
  });

  it('refuses a value of the wrong type or out of range', async () => {
    const a = estimatorA.caller;
    for (const field of [
      { category: 'Mold' },
      { category: 'water' },
      { category: 4 },
      { category: 2.5 },
      { roomTypeId: 'Bathroom' },
      { roomTypeId: 'b' },
      { roomTypeId: 'bathroom/../x' },
      { roomTypeId: 7 },
      { waterClass: 0 },
      { waterClass: 5 },
      { waterClass: 2.5 },
      { waterClass: '2' },
      { ceilingHeightFt: 0 },
      { ceilingHeightFt: 60.5 },
      { moldCondition: 4 },
      { moldCondition: '3' },
      { affectedSf: -1 },
      { affectedSf: 100_001 },
      { findings: 9 },
      { findings: 'f'.repeat(2_001) },
    ]) {
      expect(roomFieldSchema.safeParse(field).success, JSON.stringify(field)).toBe(false);
      expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field }), JSON.stringify(field)).toBe(403);
    }
  });

  it("refuses items that are not a map of item id to a quantity, at every place in the room's list", async () => {
    const a = estimatorA.caller;
    const last = `item_${String(MAX_ROOM_ITEMS - 1).padStart(2, '0')}`;
    for (const items of [
      [{ itemId: 'flood_cut', quantity: '4' }],
      'flood_cut',
      itemsOf(MAX_ROOM_ITEMS + 1),
      { 'Flood-cut': '4' },
      { flood_cut: '4', '9lives': '1' },
      { f: '4' },
      // A key or a quantity holding a comma cannot pass as two entries.
      { 'flood_cut,carpet': '4' },
      { flood_cut: '4,5' },
      { flood_cut: '-1' },
      { flood_cut: '100001' },
      { flood_cut: '100000.5' },
      { flood_cut: '1.005' },
      { flood_cut: '' },
      { flood_cut: '1e3' },
      { flood_cut: 4 },
      { flood_cut: null },
      { flood_cut: { quantity: '4' } },
      // A bad quantity among fifty good ones, first and last in key order.
      { ...itemsOf(MAX_ROOM_ITEMS - 1), aaa_first: 'four' },
      { ...itemsOf(MAX_ROOM_ITEMS - 1), [last.replace('item_', 'zz_')]: 4 },
      { ...itemsOf(MAX_ROOM_ITEMS), [last]: '-2' },
    ]) {
      const label = JSON.stringify(items).slice(0, 80);
      expect(roomFieldSchema.safeParse({ items }).success, label).toBe(false);
      expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { items } }), label).toBe(403);
    }
  });

  it('refuses prep tasks that are not a list of up to ten texts of 1 to 300 characters, at every place', async () => {
    const a = estimatorA.caller;
    const ten = Array.from({ length: MAX_PREP_TASKS }, (_, i) => `Task ${i}`);
    for (const prepTasks of [
      'Cover the floor',
      { 0: 'Cover the floor' },
      [...ten, 'One more'],
      ['t'.repeat(MAX_PREP_TASK + 1)],
      [''],
      [7],
      ['Cover the floor', null],
      [...ten.slice(0, 9), 't'.repeat(MAX_PREP_TASK + 1)],
      [...ten.slice(0, 9), 42],
    ]) {
      const label = JSON.stringify(prepTasks).slice(0, 80);
      expect(roomFieldSchema.safeParse({ prepTasks }).success, label).toBe(false);
      expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field: { prepTasks } }), label).toBe(403);
    }
  });

  it('refuses a room key the field map does not name, and a price beside an item', async () => {
    const a = estimatorA.caller;
    for (const field of [{ ...ROOM, unitPrice: '3.00' }, { ...ROOM, loss: 'mold' }, { ...ROOM, sizeTier: 'm' }, { ...ROOM, itemPrices: { flood_cut: 3 } }]) {
      expect(roomFieldSchema.safeParse(field).success).toBe(false);
      expect(await updateDoc(a, room(A, 'editing', 'kitchen'), { field })).toBe(403);
    }
  });
});
