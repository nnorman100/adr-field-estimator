// S6-1 (e): the start-up hang. Firestore's persistent cache has open Safari reports of a client
// that never starts (firebase-js-sdk issues 8081, 9802, 10469), worst with a desktop browser
// identity (the iPad default) and many reloads. The first test reloads a persistent client many
// times in each engine, under the identities the issues name, and fails on any start that takes
// longer than the watchdog the field screen will use. The second makes the stall itself (a
// database that never opens) and settles what a watchdog can see and what it can do: whether a
// start that stalled can be redone with the memory cache on the same Firebase app.
import { expect, test, Phone, OFFLINE_TEST_TIMEOUT } from './fixture';
import { seedCompany } from './world';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

// How long the field screen will wait for the cache to answer before it calls the start stalled.
const WATCHDOG_MS = 5000;
const RELOADS = 25;
// Room for each reload or new window, on top of the watchdog, in the test's time limit.
const NAVIGATION_MS = 5000;

// Safari's own desktop identity (what an iPad sends by default) at a version the SDK's workaround
// covers (14 to 16) and at one it does not.
const SAFARI_16 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const SAFARI_26 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

test.describe('the start-up hang (S6-1 e)', () => {
  test(`a persistent client starts within the watchdog on each of ${RELOADS} reloads`, async ({ browser, lane }, info) => {
    const agents = info.project.name === 'webkit' ? [SAFARI_16, SAFARI_26] : [undefined];
    test.setTimeout(OFFLINE_TEST_TIMEOUT + agents.length * RELOADS * (WATCHDOG_MS + NAVIGATION_MS));
    for (const userAgent of agents) {
      const context = await browser.newContext(userAgent ? { userAgent } : {});
      const world = await seedCompany();
      let phone = await Phone.open(context, lane);
      await phone.start(world, 'single');
      await phone.signIn(world.owner);
      const first = await phone.call('listen', 'main', world.draftPath);
      await expect.poll(async () => (await phone.call('events', first)).some((e) => e.fromCache === false)).toBe(true);

      const slowest: number[] = [];
      for (let reload = 0; reload < RELOADS; reload += 1) {
        // Alternate the two ways a window ends: a reload, and a close followed by a new window.
        if (reload % 2 === 0) await phone.reload();
        else phone = await phone.restart(context);
        const started = Date.now();
        expect(await phone.start(world, 'single')).toMatchObject({ ok: true });
        const answer = await phone.call('readCache', 'main', world.draftPath, WATCHDOG_MS);
        slowest.push(Date.now() - started);
        expect(answer, `reload ${reload} under ${userAgent ?? 'the default identity'} stalled`).toMatchObject({ exists: true, fromCache: true });
      }
      info.annotations.push({ type: 'slowest start (ms)', description: `${userAgent?.includes('Version/26') ? 'Safari 26' : userAgent ? 'Safari 16' : 'default'}: ${Math.max(...slowest)}` });
      await context.close();
    }
  });

  test('a stalled start is seen as silence, and the memory cache can take over on the same app', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await Phone.open(context, lane);
    // Firestore's own database never opens; Auth's storage is untouched.
    await phone.call('stallDatabases', 'firestore/');
    expect(await phone.start(world, 'single')).toMatchObject({ ok: true });
    await phone.signIn(world.owner);

    // What a watchdog can see: no answer from the cache, no snapshot, no error, nothing pending resolves.
    expect(await phone.call('readCache', 'main', world.draftPath, 3000)).toEqual({ error: 'timeout' });
    const listener = await phone.call('listen', 'main', world.draftPath);
    await phone.page.waitForTimeout(2000);
    expect(await phone.call('events', listener)).toEqual([]);
    expect(await phone.call('waitPending', 'main', 1500)).toBe('timeout');

    // The same app cannot simply be started again with another cache.
    expect(await phone.start(world, 'memory', 'fallback')).toEqual({ ok: false, error: 'failed-precondition' });
    // terminate() on the stalled client never finishes, but calling it frees the app for a new start.
    expect(await phone.call('terminate', 'main', 2000)).toBe('timeout');
    expect(await phone.start(world, 'memory', 'fallback')).toMatchObject({ ok: true });
    expect(await phone.call('uid', 'fallback')).toBe(world.owner.uid);
    expect(await phone.call('readServer', 'fallback', world.draftPath, 8000)).toMatchObject({ exists: true, fromCache: false });
    const write = await phone.call('update', 'fallback', world.draftPath, { 'field.notes': 'kept in memory only' });
    await expect.poll(() => phone.call('op', write)).toEqual({ state: 'acked' });
    await context.close();
  });
});
