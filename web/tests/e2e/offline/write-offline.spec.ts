// S6-1 (a) and (f): what the Firestore SDK does with a write made while the network is cut.
// Each test runs in Chromium and WebKit with the pinned `firebase` web SDK, against the Firestore
// emulator, through a lane the test cuts and restores (lane.ts).
import { expect, expectNothingSent, expectWithheld, test, SEND_MS } from './fixture';
import { Phone } from './fixture';
import { readDraft, seedCompany } from './world';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

test.describe('a write made offline (S6-1 a)', () => {
  test('survives a reload and is sent once on reconnect', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await Phone.open(context, lane);
    expect(await phone.start(world, 'single')).toMatchObject({ ok: true });
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);

    // The network goes. The page can still be loaded (the app is up), but Firestore and Auth are not.
    lane.cut(['auth', 'firestore']);
    // An increment is not safe to send twice: a copy that went out twice would show as 2.
    const write = await phone.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(() => phone.call('op', write)).toEqual({ state: 'pending' });
    await expect.poll(async () => (await phone.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);

    // The window ends both ways a window can, a reload and then a close followed by a new window:
    // its memory goes each time, the phone's storage does not.
    for (const end of ['reload', 'close and reopen'] as const) {
      if (end === 'reload') await phone.reload();
      else phone = await phone.restart(context);
      expect(await phone.start(world, 'single')).toMatchObject({ ok: true });
      expect(await phone.call('uid', 'main')).toBe(world.owner.uid);
      const kept = await phone.call('readCache', 'main', world.draftPath);
      expect(kept, `after a ${end}`).toMatchObject({ exists: true, fromCache: true, hasPendingWrites: true });
      expect(kept.data?.field).toMatchObject({ airMovers: 1 });
      expect((await readDraft(world)).field.airMovers).toBe(0);
    }

    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('waitPending', 'main', 4000), { timeout: 45_000 }).toBe('done');
    await expect.poll(async () => (await readDraft(world)).field.airMovers, { timeout: 15_000 }).toBe(1);
    // Nothing is sent a second time.
    await phone.page.waitForTimeout(3000);
    expect((await readDraft(world)).field.airMovers).toBe(1);
    await context.close();
  });

  // The client does nothing until the app first uses it, so queued writes wait for that first use:
  // the field screen's own start-up (S6-3) must make it (a listener or waitForPendingWrites).
  test('a client that is started and not used sends nothing until its first use', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.notes': 'saved on the phone' });
    await expect.poll(async () => (await phone.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    phone = await phone.restart(context);
    lane.restore(['auth', 'firestore']);
    await phone.start(world, 'single');
    expect(await phone.call('uid', 'main')).toBe(world.owner.uid);
    await expectWithheld(async () => !('notes' in (await readDraft(world)).field));
    // The first use starts it.
    await phone.call('waitPending', 'main', 1000);
    await expect.poll(async () => (await readDraft(world)).field, { timeout: SEND_MS }).toMatchObject({ notes: 'saved on the phone' });
    await context.close();
  });
});

// S6-1 (f): the sync gate (S6-3) keeps the network off from start-up until the server has said the
// person's access is current. What the SDK does with queued writes meanwhile decides whether that
// gate can work.
test.describe('the network switched off at start-up (S6-1 f)', () => {
  test('queued writes wait for enableNetwork, with the network itself up', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single', 'main', { networkOff: true });
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    // Before the first listen is answered, nothing has reached the server: the cache is empty.
    const write = await phone.call('set', 'main', world.draftPath, { field: { airMovers: { __inc: 1 } } });
    expect(await phone.call('waitPending', 'main', 2500)).toBe('timeout');
    await expectWithheld(async () => (await readDraft(world)).field.airMovers === 0);
    expect(await phone.call('op', write)).toEqual({ state: 'pending' });
    expect((await phone.call('events', listener)).every((event) => event.fromCache !== false)).toBe(true);

    await phone.call('enableNetwork', 'main');
    await expect.poll(() => phone.call('op', write), { timeout: SEND_MS }).toEqual({ state: 'acked' });
    expect((await readDraft(world)).field.airMovers).toBe(1);
    await context.close();
  });

  test('a write queued before a restart is held by a client started with the network off', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    let phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await phone.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);

    // The phone comes back with signal, and the app opens with the network off.
    phone = await phone.restart(context);
    lane.restore(['auth', 'firestore']);
    await phone.start(world, 'single', 'main', { networkOff: true });
    await phone.call('uid', 'main');
    await phone.call('listen', 'main', world.draftPath);
    expect(await phone.call('waitPending', 'main', 4000)).toBe('timeout');
    await expectWithheld(async () => (await readDraft(world)).field.airMovers === 0);

    await phone.call('enableNetwork', 'main');
    await expect.poll(async () => (await readDraft(world)).field.airMovers, { timeout: SEND_MS }).toBe(1);
    await context.close();
  });
});
