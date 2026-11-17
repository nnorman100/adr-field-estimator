// The recovery journal, ds-journal (S6-4; docs/plans/S6.md section 4, steps 1, 2 and 6), and the
// one IndexedDB wrapper it opens through, with the app's own field client code in Chromium and
// WebKit against the emulators behind a lane. GET /api/me is the lane's stand-in (field-phone.ts).
import type { BrowserContext } from '@playwright/test';
import { expect, expectNothingSent, test, SEND_MS } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { Person as FieldPerson } from './harness/field';
import { fenceDraft, readDraft, seedCompany, type World } from './world';

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
    await expect.poll(async () => (await phone.call('journal', person))[0]?.reached).toBe(true);
    await expectNothingSent(lane);

    await phone.page.reload();
    expect(await phone.call('journal', person)).toEqual([entryFor('pending', { reached: true })]);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await kill(phone, browserName);

    // The journal is there before anything starts.
    phone = await FieldPhone.open(context, lane);
    expect(await phone.call('journal', person)).toEqual([entryFor('pending', { reached: true })]);
    // A killed page cannot give back the Firestore cache's single-window lease, which the SDK honours
    // for 5 seconds (MAX_PRIMARY_ELIGIBLE_AGE_MS in firebase 13.1.0); a start inside it says
    // "Reopen the app" (S6-3). The phone is opened again after it.
    await phone.page.waitForTimeout(6_000);
    await phone.page.close();
    phone = await reopen(context, phone, person);
    expect(await phone.call('journal', person)).toEqual([entryFor('pending', { reached: true })]);
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
      await expect.poll(async () => (await phone.call('journal', person))[0]?.reached).toBe(true);
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

test.describe('the one IndexedDB wrapper (S6-4)', () => {
  test('a connection it opened closes on a version change, so an old window never blocks an upgrade', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    await phone.call('hold', 'ds-wrapper-test');
    expect(await phone.call('upgrade', 'ds-wrapper-test')).toBe('upgraded');
  });

  test('a lost connection is opened once more; a second loss says to reopen the app', async ({ page, lane }) => {
    const phone = await FieldPhone.open(page.context(), lane);
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('ok');
    await phone.call('loseConnection', 1);
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('ok');
    await phone.call('loseConnection', 2);
    expect(await phone.call('tryRead', 'ds-wrapper-lost')).toBe('Reopen the app.');
  });
});
