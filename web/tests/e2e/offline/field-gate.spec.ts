// S6-3's sync gate with the app's own field client (src/lib/field-db.ts) and the TC-7 App Check
// rule, in Chromium and WebKit, against the emulators behind a lane. GET /api/me is the lane's
// stand-in (field-phone.ts), so each test decides what the server says; the access records and the
// rules are the emulator's own.
import { expect, expectNothingSent, expectWithheld, test, SEND_MS } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { Person as FieldPerson } from './harness/field';
import { readDraft, removeAccess, seedCompany, setAccessExpiry, type World } from './world';

const sent = async (world: World) => (await readDraft(world)).field.airMovers;

// Signed in, the gate open, the draft read once (so it is cached), then the signal cut and one
// edit made: +1 to a counter, so a test can count how many times it reached the server.
async function editOffline(phone: FieldPhone, world: World): Promise<FieldPerson> {
  serveMe(phone.lane, { expiresAt: inDays(7) });
  const person = await phone.signIn(world, world.owner);
  expect(await phone.call('start', person, 'persistent')).toBe('persistent');
  await phone.call('sync', person);
  await expect.poll(() => phone.call('gate', person)).toBe('open');
  expect(await phone.call('readServer', person, world.draftPath)).toMatchObject({ data: { field: { airMovers: 0 } } });
  phone.lane.cut(['auth', 'firestore']);
  await phone.call('write', person, world.draftPath, { 'field.airMovers': { __inc: 1 } });
  await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
  await expectNothingSent(phone.lane);
  expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number) });
  return person;
}

test.describe('the sync gate (S6-3)', () => {
  test('an offline edit survives closing and reopening the app, and is sent once', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);

    phone = await phone.restart(context);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true, data: { field: { airMovers: 1 } } });
    lane.restore(['auth', 'firestore']);
    await phone.call('sync', person);
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    // Acknowledged, so the phone no longer counts it as unsent.
    await expect.poll(() => phone.call('unsent', person)).toMatchObject({ unsentSince: null });
    await context.close();
  });

  test('a write queued past its access record waits for the renewal, and is not dropped', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    await phone.page.close();

    // Days later: the record ran out while the phone was offline, and the first /api/me after the
    // signal comes back skips its renewal (another run held the actor): 200, with the old expiry.
    await setAccessExpiry(world, world.owner, inDays(-1));
    serveMe(lane, { expiresAt: inDays(-1) });
    lane.restore(['auth', 'firestore']);
    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('renewing');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true });

    // The next call renews the record and says so: the write goes, once.
    await setAccessExpiry(world, world.owner, inDays(7));
    serveMe(lane, { expiresAt: inDays(7) });
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    expect(await phone.call('gate', person)).toBe('open');
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });

  // What the gate is for: the rules refuse a write on a record that ran out (FS: no rules change),
  // and the SDK then drops it.
  test('without the gate, the rules refuse a write on a record that ran out', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    await setAccessExpiry(world, world.owner, inDays(-1));
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    const write = await phone.call('write', person, world.draftPath, { 'field.notes': 'too late' });
    await phone.call('openWithoutGate', person);
    await expect.poll(() => phone.call('op', write), { timeout: SEND_MS }).toEqual({ state: 'rejected', code: 'permission-denied' });
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await context.close();
  });

  test('a disabled member\'s phone sends nothing and keeps the work, and sends it once access is back', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    await phone.page.close();

    // The owner turns the member off: the server refuses, and the access record is removed.
    await removeAccess(world.companyId, world.owner);
    serveMe(lane, { status: 403, error: 'member_disabled' });
    lane.restore(['auth', 'firestore']);
    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('locked: member-disabled');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true });
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number) });

    // The owner turns them back on (the enable route writes a fresh record): the phone asks again
    // by itself and sends the work once.
    await setAccessExpiry(world, world.owner, inDays(7));
    serveMe(lane, { expiresAt: inDays(7) });
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await expect.poll(() => phone.call('unsent', person)).toMatchObject({ lockedSince: null });
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });
});

test.describe('App Check and queued work (TC-7)', () => {
  test('a write queued offline with an expired token is sent once after reconnect, in monitor mode', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    phone = await phone.restart(context);
    await phone.call('appCheck', 'monitor', 'expired');
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    lane.restore(['auth', 'firestore']);
    await phone.call('sync', person);
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    expect(await phone.call('tokenCalls')).toBeGreaterThan(0);
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });

  test('under enforcement a token that will not come holds the queue, untouched, until one does', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    phone = await phone.restart(context);
    await phone.call('appCheck', 'enforce', 'expired');
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    lane.restore(['auth', 'firestore']);
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('checking-phone');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true });
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number) });

    await phone.call('appCheck', 'enforce', 'fresh');
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await context.close();
  });
});
