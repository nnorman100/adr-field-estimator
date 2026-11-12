// S6-1 (c): whose queued writes and cached documents the SDK keeps apart. The field screens
// (S6-3, S6-4) rely on it, or build their own walls, so these tests pin what the pinned SDK does:
// a person signing out and in again, another person signing in on the same app instance, and two
// companies' app instances in one browser.
import { expect, expectNothingSent, expectWithheld, test, Phone, SEND_MS } from './fixture';
import { readDraft, seedCompany } from './world';

const cached = (phone: Phone, path: string, key = 'main') => phone.call('readCache', key, path);

test.describe('people and companies on one phone (S6-1 c)', () => {
  test('the same person signing out and in again keeps the unsent write and sends it once', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await cached(phone, world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);

    await phone.call('signOut', 'main');
    lane.restore(['auth', 'firestore']);
    // Signed out, with signal: nothing is sent, and the write is not shown as the nobody's.
    await expectWithheld(async () => (await readDraft(world)).field.airMovers === 0);

    await phone.signIn(world.owner);
    await expect.poll(async () => (await readDraft(world)).field.airMovers, { timeout: SEND_MS }).toBe(1);
    await phone.page.waitForTimeout(3000);
    expect((await readDraft(world)).field.airMovers).toBe(1);
    await context.close();
  });

  test('another person signing in on the same instance does not send the first person\'s write', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany({ people: ['ana', 'ben'], roles: { ben: 'office' } });
    const [ana, ben] = [world.people.ana!, world.people.ben!];
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(ana);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await cached(phone, world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);

    await phone.call('signOut', 'main');
    lane.restore(['auth', 'firestore']);
    await phone.signIn(ben);
    // Ben (office: may read every draft, edit none) is signed in, with signal, for long enough.
    await expectWithheld(async () => (await readDraft(world)).field.airMovers === 0);
    // What Ben sees of the draft ana had cached: the document is shared, ana's pending edit is not.
    const seenByBen = await cached(phone, world.draftPath);
    expect(seenByBen).toMatchObject({ exists: true, fromCache: true, hasPendingWrites: false });
    expect(seenByBen.data?.field).toMatchObject({ airMovers: 0 });

    // Ana comes back: her write is still there, and goes out once.
    await phone.call('signOut', 'main');
    await phone.signIn(ana);
    await expect.poll(async () => (await readDraft(world)).field.airMovers, { timeout: SEND_MS }).toBe(1);
    await context.close();
  });

  // The rules stop Cleo reading Ana's draft from the server, but the cache holds documents for the
  // instance, not for a person. So signing out must empty the cache (S6-3), or the next person
  // reads what the last one had open.
  test('cached documents are shared between people on the same instance', async ({ browser, lane }) => {
    const context = await browser.newContext();
    // Cleo is an estimator who does not own the draft, so the rules refuse her the read.
    const world = await seedCompany({ people: ['ana', 'cleo'] });
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.people.ana!);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    await phone.call('unlisten', listener);
    await phone.call('signOut', 'main');
    await phone.signIn(world.people.cleo!);
    expect(await phone.call('readServer', 'main', world.draftPath)).toEqual({ error: 'permission-denied' });
    expect(await cached(phone, world.draftPath)).toMatchObject({ exists: true, fromCache: true });
    // Signed out altogether, offline: still there.
    await phone.call('signOut', 'main');
    lane.cut(['auth', 'firestore']);
    expect(await cached(phone, world.draftPath)).toMatchObject({ exists: true, fromCache: true });
    await context.close();
  });

  // The cache and the queue are one database, so emptying it at sign-out to keep the next person
  // out of the cache also drops the person's unsent writes: they must live elsewhere (the journal,
  // S6-4) to be sent when that person signs in again.
  test('emptying the cache at sign-out also drops the person\'s unsent writes', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await cached(phone, world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await phone.call('signOut', 'main');
    expect(await phone.call('clearPersistence', 'main')).toBe('cleared');
    lane.restore(['auth', 'firestore']);

    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    expect(await cached(phone, world.draftPath)).toMatchObject({ error: 'unavailable' });
    expect(await phone.call('waitPending', 'main', 3000)).toBe('done');
    await phone.page.waitForTimeout(3000);
    expect((await readDraft(world)).field.airMovers).toBe(0);
    await context.close();
  });

  test('two companies on one phone have separate caches and queues', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const [one, two] = [await seedCompany(), await seedCompany()];
    const phone = await Phone.open(context, lane);
    await phone.start(one, 'single', 'one');
    await phone.start(two, 'single', 'two');
    await phone.signIn(one.owner, 'one');
    await phone.signIn(two.owner, 'two');
    for (const [key, world] of [['one', one], ['two', two]] as const) {
      const id = await phone.call('listen', key, world.draftPath);
      await expect.poll(async () => (await phone.call('events', id)).some((e) => e.fromCache === false)).toBe(true);
    }
    // Each company's cache is a database of its own, named for its app.
    const names = await phone.call('databases');
    const forOne = names.filter((name) => name.includes(`dryscope-${one.tenantId}`));
    const forTwo = names.filter((name) => name.includes(`dryscope-${two.tenantId}`));
    expect(forOne.length).toBeGreaterThan(0);
    expect(forTwo.length).toBeGreaterThan(0);
    expect(forOne.some((name) => forTwo.includes(name))).toBe(false);
    // A document cached for one company is not in the other's cache.
    expect(await cached(phone, one.draftPath, 'two')).toMatchObject({ error: expect.any(String) });

    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'one', one.draftPath, { 'field.airMovers': { __inc: 1 } });
    await phone.call('update', 'two', two.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await cached(phone, two.draftPath, 'two')).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    // Company one signs out; company two does not.
    await phone.call('signOut', 'one');
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await readDraft(two)).field.airMovers, { timeout: SEND_MS }).toBe(1);
    await expectWithheld(async () => (await readDraft(one)).field.airMovers === 0);
    await phone.signIn(one.owner, 'one');
    await expect.poll(async () => (await readDraft(one)).field.airMovers, { timeout: SEND_MS }).toBe(1);
    expect((await readDraft(two)).field.airMovers).toBe(1);
    await context.close();
  });
});
