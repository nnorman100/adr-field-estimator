// S6-1 (d): the two cache managers with two windows of the same browser open at once. The owner
// chose the single-window manager (O3), which makes "Open DryScope in one window" the app's job:
// these tests pin what the SDK does (and does not say) with a second window, so that job is built
// on what really happens.
import { expect, expectNothingSent, test, Phone } from './fixture';
import { readDraft, seedCompany } from './world';
import type { CacheKind } from './harness/page';
import type { BrowserContext } from '@playwright/test';
import type { NetworkLane } from './lane';
import type { World } from './world';

// Two windows, both signed in as the draft's owner and listening to the draft (so both are
// started, and both have the draft cached).
async function twoWindows(context: BrowserContext, lane: NetworkLane, world: World, cache: CacheKind) {
  const one = await Phone.open(context, lane);
  expect(await one.start(world, cache)).toMatchObject({ ok: true });
  await one.signIn(world.owner);
  const first = await one.call('listen', 'main', world.draftPath);
  await expect.poll(async () => (await one.call('events', first)).some((e) => e.fromCache === false)).toBe(true);
  const two = await Phone.open(context, lane);
  // The second window starts without an error from the SDK, whichever manager is chosen.
  expect(await two.start(world, cache)).toMatchObject({ ok: true });
  expect(await two.call('uid', 'main')).toBe(world.owner.uid);
  const second = await two.call('listen', 'main', world.draftPath);
  await expect.poll(async () => (await two.call('events', second)).some((e) => e.fromCache === false)).toBe(true);
  expect((await two.call('events', second)).some((e) => e.error)).toBe(false);
  return { one, two, first, second };
}

test.describe('two windows (S6-1 d)', () => {
  test('single-window manager: the second window gets no error, and its offline write is lost', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const { one, two } = await twoWindows(context, lane, world, 'single');
    lane.cut(['auth', 'firestore']);
    await one.call('update', 'main', world.draftPath, { 'field.notes': 'from the first window' });
    await two.call('update', 'main', world.draftPath, { 'field.summary': 'from the second window' });
    await expect.poll(async () => (await one.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await expect.poll(async () => (await two.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await one.page.close();
    await two.page.close();

    // The app is opened again with signal: one of the two edits is gone from the phone's queue.
    const three = await Phone.open(context, lane);
    await three.start(world, 'single');
    await three.call('uid', 'main');
    const kept = (await three.call('readCache', 'main', world.draftPath)).data?.field;
    expect(kept).toMatchObject({ notes: 'from the first window' });
    expect(kept).not.toHaveProperty('summary');
    lane.restore(['auth', 'firestore']);
    await three.call('waitPending', 'main', 3000);
    await expect.poll(async () => (await readDraft(world)).field, { timeout: 30_000 }).toMatchObject({ notes: 'from the first window' });
    await three.page.waitForTimeout(3000);
    expect((await readDraft(world)).field).not.toHaveProperty('summary');
    await context.close();
  });

  test('single-window manager: the first window\'s unsent write is not seen or sent by the second', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const { one, two, second } = await twoWindows(context, lane, world, 'single');
    lane.cut(['auth', 'firestore']);
    await one.call('update', 'main', world.draftPath, { 'field.notes': 'from the first window' });
    await expect.poll(async () => (await one.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await one.page.waitForTimeout(1500);
    expect((await two.call('events', second)).at(-1)?.hasPendingWrites).toBe(false);
    await one.page.close();
    lane.restore(['auth', 'firestore']);
    await two.page.waitForTimeout(6000);
    // The second window is open with signal and the first is closed; the edit has not gone out.
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await context.close();
  });

  test('multi-window manager: both windows\' writes survive, the second sees the first\'s, and the survivor sends it', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const { one, two, second } = await twoWindows(context, lane, world, 'multi');
    lane.cut(['auth', 'firestore']);
    await one.call('update', 'main', world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await two.call('update', 'main', world.draftPath, { 'field.summary': 'from the second window' });
    await expect
      .poll(async () => (await two.call('events', second)).at(-1)?.data?.field, { timeout: 15_000 })
      .toMatchObject({ airMovers: 1, summary: 'from the second window' });
    await expectNothingSent(lane);
    await one.page.close();
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await readDraft(world)).field, { timeout: 45_000 }).toMatchObject({ airMovers: 1, summary: 'from the second window' });
    await two.page.waitForTimeout(3000);
    // Sent once, not twice.
    expect((await readDraft(world)).field.airMovers).toBe(1);
    await context.close();
  });
});
