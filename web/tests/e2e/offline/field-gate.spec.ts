// S6-3's sync gate with the app's own field client (src/lib/field-db.ts) and the TC-7 App Check
// rule, in Chromium and WebKit, against the emulators behind a lane. GET /api/me is the lane's
// stand-in (field-phone.ts), so each test decides what the server says; the access records and the
// rules are the emulator's own.
import { expect, expectNothingSent, expectWithheld, test, SEND_MS } from './fixture';
import { FieldPhone, inDays, revokeSessions, serveCheckedMe, serveMe } from './field-phone';
import type { Person as FieldPerson } from './harness/field';
import { readDraft, removeAccess, seedCompany, setAccessExpiry, type World } from './world';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

const sent = async (world: World) => (await readDraft(world)).field.airMovers;
const DAY = 24 * 60 * 60 * 1000;

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

    // The owner turns the member off: their sessions are revoked, the server refuses them, and the
    // access record is removed. They sign in again on the phone while still turned off.
    const member = { enabled: false };
    await revokeSessions(world.tenantId, world.owner.uid);
    await removeAccess(world.companyId, world.owner);
    serveCheckedMe(lane, world.tenantId, member);
    lane.restore(['auth', 'firestore']);
    phone = await FieldPhone.open(context, lane);
    await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('locked: member-disabled');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true });
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number) });

    // The owner turns them back on (the enable route writes a fresh record): the phone asks again
    // by itself and sends the work once.
    await setAccessExpiry(world, world.owner, inDays(7));
    member.enabled = true;
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await expect.poll(() => phone.call('unsent', person)).toMatchObject({ lockedSince: null });
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });

  test('a phone signed in before the member was turned off says sign in again; after re-enabling and signing in, the work is sent once', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    await phone.page.close();

    const member = { enabled: false };
    await revokeSessions(world.tenantId, world.owner.uid);
    await removeAccess(world.companyId, world.owner);
    serveCheckedMe(lane, world.tenantId, member);
    lane.restore(['auth', 'firestore']);
    phone = await FieldPhone.open(context, lane);
    // Online, the phone's own Firebase sign-in finds its session revoked and ends it.
    expect(await phone.call('start', person, 'persistent')).toBe('persistent (signed out)');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('locked: sign-in-again');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number) });

    // Turned back on: the revoked sign-in stays refused, so nothing is sent until they sign in.
    await setAccessExpiry(world, world.owner, inDays(7));
    member.enabled = true;
    await phone.call('poke', person);
    await expectWithheld(async () => (await sent(world)) === 0);
    expect(await phone.call('gate', person)).toBe('locked: sign-in-again');

    await phone.call('stop', person);
    await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await expect.poll(() => phone.call('unsent', person)).toMatchObject({ lockedSince: null });
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });
});

test.describe('locked work kept past 30 days (O5)', () => {
  test('locked work past 30 days for a revoked or ended sign-in is hidden with no signal or no sign-in to ask with, removed when the server refuses the person, and kept before that', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany({ people: ['ana', 'ben', 'cleo'] });
    const phone = await FieldPhone.open(context, lane);
    const [ana, ben, cleo] = (['ana', 'ben', 'cleo'] as const).map((name) => phone.person(world, world.people[name]!));
    lane.drop('/api/me');
    const locked = (reason: string, days: number) => ({ writes: 1, unsentSince: Date.now(), lockedSince: Date.now() - days * DAY, lockedReason: reason });

    // The server said the sign-in was revoked, 31 days ago. With no signal the work is hidden and
    // kept (decision 010); the server refusing her again removes it. She is signed in on the phone,
    // so the gate asks the server for her.
    await phone.signIn(world, world.people.ana!);
    expect(await phone.call('start', ana!, 'persistent')).toBe('persistent');
    await phone.call('setMark', ana!, locked('session-revoked', 31));
    await phone.call('sync', ana!);
    await expect.poll(() => phone.call('gate', ana!)).toBe('locked: session-revoked');
    expect((await phone.call('enter', ana!)).state).toBe('hidden');
    expect(await phone.call('unsent', ana!)).toMatchObject({ unsentSince: expect.any(Number), lockedReason: 'session-revoked' });
    serveMe(lane, { status: 401, error: 'sign_in_revoked' });
    await phone.call('poke', ana!);
    await expect.poll(() => phone.call('gate', ana!)).toBe('removed');
    expect(await phone.call('unsent', ana!)).toEqual({ writes: 0, unsentSince: null, lockedSince: null });
    lane.drop('/api/me');
    lane.unserve('/api/me');

    // Firebase ended the revoked sign-in itself, so the phone has no sign-in to ask with: the lock
    // this saves counts too once it is 31 days old, read back at an offline start, and hides the
    // work; with no sign-in to ask with, nothing removes it.
    expect(await phone.call('start', ben!, 'persistent')).toBe('persistent (signed out)');
    await phone.call('setMark', ben!, { writes: 1, unsentSince: Date.now(), lockedSince: null });
    await phone.call('sync', ben!);
    await expect.poll(() => phone.call('gate', ben!)).toBe('locked: sign-in-again');
    const saved = await phone.call('unsent', ben!);
    expect(saved).toMatchObject({ lockedSince: expect.any(Number), lockedReason: 'sign-in-again' });
    await phone.call('stop', ben!);
    await phone.call('setMark', ben!, { ...(saved as object), lockedSince: Date.now() - 31 * DAY });
    await phone.call('start', ben!, 'persistent');
    await phone.call('sync', ben!);
    await expect.poll(() => phone.call('gate', ben!)).toBe('locked: sign-in-again');
    await phone.page.waitForTimeout(2000);
    expect(await phone.call('gate', ben!)).toBe('locked: sign-in-again');
    expect((await phone.call('enter', ben!)).state).toBe('hidden');
    expect(await phone.call('unsent', ben!)).toMatchObject({ unsentSince: expect.any(Number), lockedReason: 'sign-in-again' });

    // Locked for 29 days: kept.
    await phone.call('start', cleo!, 'persistent');
    await phone.call('setMark', cleo!, locked('sign-in-again', 29));
    await phone.call('sync', cleo!);
    await expect.poll(() => phone.call('gate', cleo!)).toBe('locked: sign-in-again');
    await phone.page.waitForTimeout(2000);
    expect(await phone.call('gate', cleo!)).toBe('locked: sign-in-again');
    expect(await phone.call('unsent', cleo!)).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number) });
    await context.close();
  });
});

// S6-3b: the 30-day clock starts, and is honoured, on every path that ends in "sign in again".
test.describe('locked work on every sign-in-again path (O5)', () => {
  const ourDatabases = async (phone: FieldPhone, person: FieldPerson) => (await phone.call('databases')).filter((name) => name.includes(person.uid));

  test('a sign-in past the role\'s limit that the server refuses starts the clock; 31 days on, the work is removed', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('setMark', person, { writes: 1, unsentSince: Date.now(), lockedSince: null });
    serveMe(lane, { status: 401, error: 'sign_in_revoked' });
    // Reopened on day 31 with no saved lock: nothing shows, and the refusal is still kept.
    await phone.call('sync', person, 31);
    await expect.poll(() => phone.call('gate', person)).toBe('expired');
    const saved = await phone.call('unsent', person);
    expect(saved).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number), lockedReason: 'session-revoked' });

    await phone.call('stop', person);
    await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - 31 * DAY });
    await phone.call('start', person, 'persistent');
    await phone.call('sync', person, 62);
    await expect.poll(() => phone.call('gate', person)).toBe('removed');
    expect(await phone.call('unsent', person)).toEqual({ writes: 0, unsentSince: null, lockedSince: null });
    await context.close();
  });

  test('a sign-in past the role\'s limit starts the clock with no signal and no refusal at all; 31 days on, the work is hidden until the server refuses the person', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('setMark', person, { writes: 1, unsentSince: Date.now(), lockedSince: null });
    lane.drop('/api/me');
    await phone.call('sync', person, 31);
    await expect.poll(() => phone.call('gate', person), { timeout: 20_000 }).toBe('expired');
    const saved = await phone.call('unsent', person);
    expect(saved).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number), lockedReason: 'sign-in-expired' });
    expect(await ourDatabases(phone, person)).not.toHaveLength(0);

    await phone.call('stop', person);
    await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - 31 * DAY });
    await phone.call('start', person, 'persistent');
    await phone.call('sync', person, 62);
    await expect.poll(() => phone.call('gate', person), { timeout: 20_000 }).toBe('expired');
    expect((await phone.call('enter', person)).state).toBe('hidden');
    expect(await ourDatabases(phone, person)).not.toHaveLength(0);
    serveMe(lane, { status: 401, error: 'sign_in_revoked' });
    await phone.call('poke', person);
    await expect.poll(() => phone.call('gate', person)).toBe('removed');
    expect(await phone.call('unsent', person)).toEqual({ writes: 0, unsentSince: null, lockedSince: null });
    await context.close();
  });

  test('a sign-out the app makes on a refusal keeps the clock with no saved sign-in, and reopening signed out at 31 days hides the work and removes nothing', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    expect(await phone.call('saveMe', person, { role: 'estimator', authTime: Date.now() })).toBe(true);
    await phone.call('setMark', person, { writes: 1, unsentSince: Date.now(), lockedSince: null });
    expect(await ourDatabases(phone, person)).not.toHaveLength(0);

    await phone.call('signOutKeep', person, 'sign-in-again');
    expect(await phone.call('latestMe')).toBeNull();
    const saved = await phone.call('unsent', person);
    expect(saved).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number), lockedReason: 'sign-in-again' });

    // Locked 29 days: the sign-in page keeps it.
    await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - 29 * DAY });
    expect(await phone.call('enter', person)).toEqual({ state: 'locked', removed: [] });
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number) });
    expect(await ourDatabases(phone, person)).not.toHaveLength(0);

    // Locked 31 days: reopening (the field shell signed out, or the sign-in page) hides it and
    // removes nothing: no server has refused the person since (decision 010).
    await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - 31 * DAY });
    expect(await phone.call('enter')).toEqual({ state: 'none', removed: [] });
    expect(await phone.call('enter', person)).toEqual({ state: 'hidden', removed: [] });
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number), lockedReason: 'sign-in-again' });
    expect(await ourDatabases(phone, person)).not.toHaveLength(0);
    await context.close();
  });

  test('a page hidden on day 29 of a lock and shown again on day 31, offline and past the sign-in limit, hides the work and removes nothing', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await phone.signIn(world, world.owner);
    lane.drop('/api/me');
    const locked = { writes: 1, unsentSince: Date.now(), lockedReason: 'company-inactive' };
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('setMark', person, { ...locked, lockedSince: Date.now() - 29 * DAY });
    await phone.call('sync', person, 31);
    await expect.poll(() => phone.call('gate', person), { timeout: 20_000 }).toBe('expired');
    await phone.call('suspend', person);

    await phone.call('setMark', person, { ...locked, lockedSince: Date.now() - 31 * DAY });
    await phone.call('resume', person);
    await phone.page.waitForTimeout(2000);
    expect(await phone.call('gate', person)).toBe('expired');
    expect((await phone.call('enter', person)).state).toBe('hidden');
    expect(await phone.call('unsent', person)).toMatchObject({ unsentSince: expect.any(Number), lockedReason: 'company-inactive' });
    await context.close();
  });

  test('a later sign-in lifts the person\'s own lock however old, and the work is sent once', async ({ browser, lane }) => {
    for (const days of [31, 29]) {
      const context = await browser.newContext();
      const world = await seedCompany();
      const phone = await FieldPhone.open(context, lane);
      const person = await editOffline(phone, world);
      await phone.call('stop', person);
      const saved = await phone.call('unsent', person);
      await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - days * DAY, lockedReason: 'sign-in-again' });
      lane.restore(['auth', 'firestore']);

      expect(await phone.call('letIn', person)).toBe('unlocked');
      expect(await phone.call('start', person, 'persistent')).toBe('persistent');
      await phone.call('sync', person);
      await expect.poll(() => phone.call('gate', person)).toBe('open');
      await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
      await expect.poll(() => phone.call('unsent', person)).toMatchObject({ lockedSince: null, unsentSince: null });
      await context.close();
    }
  });

  test('an open field window sends work locked past 30 days, once, when the server lets the person back in', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await editOffline(phone, world);
    await phone.call('stop', person);
    serveMe(lane, { status: 401, error: 'sign_in_again' });
    lane.restore(['auth', 'firestore']);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('locked: sign-in-again');
    const saved = await phone.call('unsent', person);
    await phone.call('setMark', person, { ...(saved as object), lockedSince: Date.now() - 31 * DAY });

    expect((await phone.call('enter', person)).state).toBe('hidden');

    serveMe(lane, { expiresAt: inDays(7) });
    await phone.call('poke', person);
    await expect.poll(() => phone.call('gate', person)).toBe('open');
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await expect.poll(() => phone.call('unsent', person)).toMatchObject({ lockedSince: null, unsentSince: null });
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
