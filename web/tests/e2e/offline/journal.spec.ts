// The recovery journal, ds-journal (S6-4; docs/plans/S6.md section 4, steps 1, 2 and 6), and the
// one IndexedDB wrapper it opens through, with the app's own field client code in Chromium and
// WebKit against the emulators behind a lane. GET /api/me is the lane's stand-in (field-phone.ts).
import type { BrowserContext } from '@playwright/test';
import { expect, expectNothingSent, test, SEND_MS } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { Person as FieldPerson } from './harness/field';
import { adminDb, fenceDraft, readDraft, removeAccess, seedCompany, type World } from './world';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

const notes = { 'field.notes': 'typed with no signal' };
const entryFor = (state: string, more: Record<string, unknown> = {}) =>
  expect.objectContaining({ state, writes: [expect.objectContaining({ fields: notes })], ...more });

// Signed in, the gate open and the draft read once (so it is cached), then the signal cut.
async function online(phone: FieldPhone, world: World): Promise<FieldPerson> {
  serveMe(phone.lane, { expiresAt: inDays(7) });
  const person = await phone.signIn(world, world.owner);
  expect(await phone.call('start', person, 'persistent')).toBe('persistent');
  await phone.call('sync', person);
  await expect.poll(() => phone.call('gate', person)).toBe('open');
  expect(await phone.call('readServer', person, world.draftPath)).toMatchObject({ data: { field: { airMovers: 0 } } });
  return person;
}

// The app opened again: the person's client and gate started as the field shell starts them.
async function reopen(context: BrowserContext, phone: FieldPhone, person: FieldPerson): Promise<FieldPhone> {
  const next = await FieldPhone.open(context, phone.lane);
  expect(await next.call('start', person, 'persistent')).toBe('persistent');
  await next.call('sync', person);
  return next;
}

// The page is killed with no unload: Chromium's renderer crashes; WebKit has no crash call, so its
// page is closed without running any unload handler.
async function kill(phone: FieldPhone, browserName: string): Promise<void> {
  if (browserName === 'chromium') {
    const crashed = phone.page.waitForEvent('crash');
    const session = await phone.page.context().newCDPSession(phone.page);
    void session.send('Page.crash').catch(() => undefined);
    await crashed;
  }
  await phone.page.close({ runBeforeUnload: false });
}

test.describe('the recovery journal (S6-4)', () => {
  test('an edit is journaled first, survives a reload and a killed page, is sent once and then pruned', async ({ browser, browserName, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalWrite', person, world.draftPath, notes);
    expect(await phone.call('journal', person)).toEqual([entryFor('pending', { tenantId: world.tenantId, uid: world.owner.uid })]);
    await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);

    await phone.page.reload();
    expect(await phone.call('journal', person)).toEqual([entryFor('pending')]);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await kill(phone, browserName);

    // The journal is there before anything starts.
    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('journal', person)).toEqual([entryFor('pending')]);
    // A killed page cannot give back the Firestore cache's single-window lease, which the SDK honours
    // for 5 seconds (MAX_PRIMARY_ELIGIBLE_AGE_MS in firebase 13.1.0); a start inside it says
    // "Reopen the app" (S6-3). The phone is opened again after it.
    await phone.page.waitForTimeout(6_000);
    await phone.page.close();
    phone = await reopen(context, phone, person);
    expect(await phone.call('journal', person)).toEqual([entryFor('pending')]);
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await readDraft(world)).field.notes, { timeout: SEND_MS }).toBe(notes['field.notes']);
    // The server has the edit, so the journal holds nothing for it any more.
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([]);
    await context.close();
  });

  test('an entry that never reached Firestore (the page died between the two) is made again on the next start', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalOnly', person, world.draftPath, notes);
    await phone.page.close({ runBeforeUnload: false });

    phone = await reopen(context, phone, person);
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await readDraft(world)).field.notes, { timeout: SEND_MS }).toBe(notes['field.notes']);
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([]);
    await context.close();
  });

  for (const restart of [false, true]) {
    test(`a write queued before the fence and sent after it is refused, stays in the journal and leaves the submitted record unchanged (${restart ? 'after a restart' : 'page alive'})`, async ({ browser, lane }) => {
      const context = await browser.newContext();
      const world = await seedCompany();
      let phone = await FieldPhone.open(context, lane);
      const person = await online(phone, world);
      lane.cut(['auth', 'firestore']);
      const write = await phone.call('journalWrite', person, world.draftPath, notes);
      await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
      await expectNothingSent(lane);
      // The job is finished on the server while the phone has no signal.
      await fenceDraft(world);
      const submitted = await readDraft(world);
      if (restart) {
        await phone.page.close({ runBeforeUnload: false });
        phone = await reopen(context, phone, person);
      }
      lane.restore(['auth', 'firestore']);
      if (!restart) await expect.poll(() => phone.call('op', write), { timeout: SEND_MS }).toEqual({ state: 'rejected', code: 'permission-denied' });
      await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([entryFor('rejected', { reason: 'locked' })]);
      expect(await readDraft(world)).toEqual(submitted);
      expect((await readDraft(world)).field).not.toHaveProperty('notes');
      // Never sent again: a later start leaves the record and the entry as they are.
      await phone.page.close({ runBeforeUnload: false });
      phone = await reopen(context, phone, person);
      await expect.poll(() => phone.call('gate', person)).toBe('open');
      await phone.page.waitForTimeout(3000);
      expect(await phone.call('journal', person)).toEqual([entryFor('rejected', { reason: 'locked' })]);
      expect(await readDraft(world)).toEqual(submitted);
      await context.close();
    });
  }

  test('a write refused because the field work moved to another person is rejected as owner-changed, not no-access', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany({ people: ['ana', 'ben'] });
    const phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalWrite', person, world.draftPath, notes);
    await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);
    // The owner moves the field work to Ben while Ana's phone has no signal: Ana may no longer
    // even read the draft.
    await adminDb().doc(world.draftPath).update({ fieldOwnerUid: world.people.ben!.uid });
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([entryFor('rejected', { reason: 'owner-changed' })]);
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await context.close();
  });

  test('a write refused after the person lost their access is rejected as no-access, not owner-changed', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalWrite', person, world.draftPath, notes);
    await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);
    // The person is removed from the company while the phone has no signal; the gate let them in
    // as an estimator before.
    await removeAccess(world.companyId, world.owner);
    serveMe(lane, { status: 403, error: 'member_disabled' });
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([entryFor('rejected', { reason: 'no-access' })]);
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await context.close();
  });

  test('an edit made while the next start is still making earlier entries again lands after them', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalOnly', person, world.draftPath, { 'field.notes': 'older' });
    await phone.call('journalOnly', person, world.draftPath, { 'field.notes': 'old' });
    await phone.page.close({ runBeforeUnload: false });

    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    const fresh = await phone.call('syncAndWrite', person, world.draftPath, { 'field.notes': 'new' });
    expect(await phone.call('op', fresh)).toEqual({ state: 'pending' });
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('op', fresh), { timeout: SEND_MS }).toEqual({ state: 'acked' });
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([]);
    expect((await readDraft(world)).field.notes).toBe('new');
    await context.close();
  });

  // Firstmate ruling R1 (2026-11-17): after a restart it is unknown whether an entry reached
  // Firestore, so it is never made again blindly over a later save from another phone.
  test('an edit that may never have reached Firestore is not made again over another phone\'s later save: it is kept as changed', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalOnly', person, world.draftPath, { 'field.notes': 'A, typed on this phone' });
    await phone.page.close({ runBeforeUnload: false });
    // The same person's other phone saves later.
    await adminDb().doc(world.draftPath).update({ 'field.notes': 'B, from the other phone' });

    phone = await reopen(context, phone, person);
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([
      expect.objectContaining({ state: 'changed', writes: [expect.objectContaining({ fields: { 'field.notes': 'A, typed on this phone' } })] }),
    ]);
    await phone.page.waitForTimeout(3000);
    expect((await readDraft(world)).field.notes).toBe('B, from the other phone');
    await context.close();
  });

  // Firstmate ruling R3 (2026-11-17): a write refused after the fence stays rejected: locked, even
  // when the server's value happens to match it.
  test('1 then 0 saved offline, the page killed and the job finished elsewhere: both are rejected as locked though the server still holds 0', async ({ browser, browserName, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalWrite', person, world.draftPath, { 'field.airMovers': 1 });
    await phone.call('journalWrite', person, world.draftPath, { 'field.airMovers': 0 });
    await expect.poll(() => phone.call('readCache', person, world.draftPath)).toMatchObject({ pending: true, data: { field: { airMovers: 0 } } });
    await expectNothingSent(lane);
    await kill(phone, browserName);
    await fenceDraft(world);
    const submitted = await readDraft(world);

    // The killed page's Firestore lease runs out first (5 seconds; see the killed-page test).
    phone = await FieldPhone.open(context, lane);
    await phone.page.waitForTimeout(6_000);
    await phone.page.close();
    phone = await reopen(context, phone, person);
    lane.restore(['auth', 'firestore']);
    const locked = (value: number) => expect.objectContaining({ state: 'rejected', reason: 'locked', writes: [expect.objectContaining({ fields: { 'field.airMovers': value } })] });
    await expect.poll(() => phone.call('journal', person), { timeout: SEND_MS }).toEqual([locked(1), locked(0)]);
    expect(await readDraft(world)).toEqual(submitted);
    await context.close();
  });

  test('rows are kept per company and person: one person\'s are never read or removed for another', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const [one, two] = [await seedCompany({ people: ['ana', 'ben'] }), await seedCompany()];
    const phone = await FieldPhone.open(context, lane);
    const ana = phone.person(one, one.people.ana!);
    const ben = phone.person(one, one.people.ben!);
    const other = phone.person(two, two.owner);
    for (const person of [ana, ben, other]) await phone.call('journalOnly', person, one.draftPath, notes);
    for (const person of [ana, ben, other]) {
      expect(await phone.call('journal', person)).toEqual([expect.objectContaining({ tenantId: person.tenantId, uid: person.uid })]);
    }
    await phone.call('forgetJournal', ana);
    expect(await phone.call('journal', ana)).toEqual([]);
    expect(await phone.call('journal', ben)).toHaveLength(1);
    expect(await phone.call('journal', other)).toHaveLength(1);
    await context.close();
  });
});

test.describe('a lost IndexedDB connection reaches the person as "Reopen the app" (S6-4)', () => {
  test('ds-me: one loss is opened again; two make its start answer reopen', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = phone.person(world, world.owner);
    expect(await phone.call('saveMe', person)).toBe(true);
    await phone.call('loseConnection', 1, 'ds-me');
    expect(await phone.call('latestMeAnswer')).toBe(`${world.tenantId}/${world.owner.uid}`);
    await phone.call('loseConnection', 2, 'ds-me');
    expect(await phone.call('latestMeAnswer')).toBe('reopen');
    await context.close();
  });

  // Every ds-me transaction loses its connection, so whichever of the shell's reads comes first
  // (its start, or the retention routine) the start sees two losses.
  test('the field shell shows "Reopen the app" when ds-me keeps losing its connection', async ({ page, lane }) => {
    await page.addInitScript(() => {
      const real = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        if (this.name === 'ds-me') {
          throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
        }
        return real.apply(this, args);
      } as IDBDatabase['transaction'];
    });
    await page.goto(`${lane.appUrl}/field`);
    await expect(page.getByRole('heading', { name: 'Reopen the app' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toHaveCount(0);
  });

  test('a journal append: one loss is opened again; two refuse the edit with "Reopen the app." and journal nothing', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('loseConnection', 1, 'ds-journal');
    const kept = await phone.call('journalWrite', person, world.draftPath, notes);
    expect(await phone.call('op', kept)).toEqual({ state: 'pending' });
    expect(await phone.call('journal', person)).toHaveLength(1);
    await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
    await phone.call('loseConnection', 2, 'ds-journal');
    const refused = await phone.call('journalWrite', person, world.draftPath, { 'field.notes': 'never made' });
    expect(await phone.call('op', refused)).toEqual({ state: 'rejected', code: expect.stringContaining('Reopen the app.') });
    expect(await phone.call('journal', person)).toHaveLength(1);
    expect(await phone.call('readCache', person, world.draftPath)).toMatchObject({ data: { field: { notes: notes['field.notes'] } } });
    await context.close();
  });

  test('recovery at the next start: two losses stop the gate and ask for the app to be reopened', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await FieldPhone.open(context, lane);
    const person = await online(phone, world);
    lane.cut(['auth', 'firestore']);
    await phone.call('journalOnly', person, world.draftPath, notes);
    await phone.page.close({ runBeforeUnload: false });

    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('loseConnection', 2, 'ds-journal');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('reopen');
    // Nothing was lost: the entry is still there for the next start.
    expect(await phone.call('journal', person)).toEqual([entryFor('pending')]);
    await context.close();
  });
});

test.describe('the one IndexedDB wrapper (S6-4)', () => {
  test('a connection it opened closes on a version change, so an old window never blocks an upgrade', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    await phone.call('hold', 'ds-wrapper-test');
    expect(await phone.call('upgrade', 'ds-wrapper-test')).toBe('upgraded');
  });

  test('a failed request rejects its transaction with the request\'s own error', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    expect(await phone.call('failedTransaction', 'ds-wrapper-failed')).toBe('ConstraintError');
  });

  test('a lost connection is opened once more; a second loss says to reopen the app', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('ok');
    await phone.call('loseConnection', 1, 'ds-wrapper-lost');
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('ok');
    await phone.call('loseConnection', 2, 'ds-wrapper-lost');
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('Reopen the app.');
  });

  // One retry budget covers the open and the work (Firstmate ruling R4, 2026-11-17).
  test('a loss while opening and another in the transaction say to reopen the app, never open a third connection', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    expect(await phone.call('tryRead', 'ds-wrapper-budget')).toBe('ok');
    await phone.call('loseOpen', 1, 'ds-wrapper-budget');
    expect(await phone.call('tryRead', 'ds-wrapper-budget')).toBe('ok');
    await phone.call('loseOpen', 2, 'ds-wrapper-budget');
    expect(await phone.call('tryRead', 'ds-wrapper-budget')).toBe('Reopen the app.');
    await phone.call('loseOpen', 1, 'ds-wrapper-budget');
    await phone.call('loseConnection', 1, 'ds-wrapper-budget');
    expect(await phone.call('tryRead', 'ds-wrapper-budget')).toBe('Reopen the app.');
  });
});
