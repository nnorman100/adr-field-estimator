// S6-1 (b): a write the rules refuse after the app was closed and opened again. While the page
// that made the write is alive, its promise says "permission-denied". After a restart the promise
// is gone; these tests record what the SDK does then and what a listener sees, because the
// recovery journal (S6-4) exists for whatever the SDK does not say.
import { expect, expectNothingSent, test, Phone } from './fixture';
import { fenceDraft, readDraft, removeAccess, seedCompany, type World } from './world';
import { adminDb } from './world';

// Why the rules refuse, and whether the person can still read the draft afterwards. A refusal that
// also takes away the read ends the listener with an error; one that only closes the draft does not.
const reasons: Record<string, { refuse: (world: World) => Promise<void>; stillReadable: boolean }> = {
  // The job was finished (or the draft archived) while the phone was away.
  'the draft was fenced': { refuse: (world) => fenceDraft(world), stillReadable: true },
  // The person's access was taken away while the phone was away.
  'access was removed': { refuse: (world) => removeAccess(world.companyId, world.owner), stillReadable: false },
  // The access record ran out (7 days in production) while the phone was away.
  'the access record ran out': {
    refuse: async (world) => {
      await adminDb().doc(`companies/${world.companyId}/access/${world.owner.uid}`).update({ expiresAt: new Date(Date.now() - 60_000) });
    },
    stillReadable: false,
  },
};

test.describe('a write the rules refuse (S6-1 b)', () => {
  for (const [reason, { refuse, stillReadable }] of Object.entries(reasons)) {
    test(`after a restart, when ${reason}: the write is dropped and no error says so`, async ({ browser, lane }) => {
      const context = await browser.newContext();
      const world = await seedCompany({ people: ['owner'] });
      let phone = await Phone.open(context, lane);
      await phone.start(world, 'single');
      await phone.signIn(world.owner);
      const first = await phone.call('listen', 'main', world.draftPath);
      await expect.poll(async () => (await phone.call('events', first)).some((e) => e.fromCache === false)).toBe(true);

      lane.cut(['auth', 'firestore']);
      const write = await phone.call('update', 'main', world.draftPath, { 'field.notes': 'edited with no signal' });
      await expect.poll(async () => (await phone.call('readCache', 'main', world.draftPath)).hasPendingWrites).toBe(true);
      await expectNothingSent(lane);
      await refuse(world);

      // The app is closed and opened again, with signal.
      phone = await phone.restart(context);
      await phone.start(world, 'single');
      expect(await phone.call('uid', 'main')).toBe(world.owner.uid);
      const listener = await phone.call('listen', 'main', world.draftPath);
      await expect.poll(async () => (await phone.call('events', listener)).length).toBeGreaterThan(0);
      // The first thing it sees is the unsent edit, shown as if it were saved.
      expect((await phone.call('events', listener))[0]).toMatchObject({ fromCache: true, hasPendingWrites: true });
      expect((await phone.call('events', listener))[0]?.data?.field).toMatchObject({ notes: 'edited with no signal' });

      lane.restore(['auth', 'firestore']);
      // The refusal arrives; the edit is dropped from the queue, and waiting for it ends well.
      await expect.poll(() => phone.call('waitPending', 'main', 4000), { timeout: 45_000 }).toBe('done');
      const seen = await phone.call('events', listener);
      if (stillReadable) {
        await expect
          .poll(async () => (await phone.call('events', listener)).at(-1), { timeout: 20_000 })
          .toMatchObject({ hasPendingWrites: false, fromCache: false });
        // The listener never errors for a refused write; it just sees the server's copy, without the edit.
        expect((await phone.call('events', listener)).some((event) => event.error)).toBe(false);
        expect((await phone.call('events', listener)).at(-1)?.data?.field).not.toHaveProperty('notes');
      } else {
        // The read went with the access, so the listener ends with an error; the edit is not in the
        // queue any more, and nothing says it was lost.
        await expect.poll(async () => (await phone.call('events', listener)).at(-1), { timeout: 20_000 }).toEqual({ error: 'permission-denied' });
        expect(seen.length).toBeGreaterThan(0);
      }
      await expect.poll(async () => (await phone.call('readCache', 'main', world.draftPath)).hasPendingWrites).not.toBe(true);
      expect((await readDraft(world)).field).not.toHaveProperty('notes');
      // Nothing is left to tell the app the edit was lost.
      expect(await phone.call('op', write)).toBeNull();
      await context.close();
    });
  }

  test('while the page is alive, the write promise says permission-denied', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    const listener = await phone.call('listen', 'main', world.draftPath);
    await expect.poll(async () => (await phone.call('events', listener)).some((e) => e.fromCache === false)).toBe(true);
    lane.cut(['auth', 'firestore']);
    const write = await phone.call('update', 'main', world.draftPath, { 'field.notes': 'edited with no signal' });
    await expect.poll(() => phone.call('op', write)).toEqual({ state: 'pending' });
    await expectNothingSent(lane);
    await fenceDraft(world);
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => phone.call('op', write), { timeout: 45_000 }).toEqual({ state: 'rejected', code: 'permission-denied' });
    await context.close();
  });

  test('a refused write does not hold up the ones behind it', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    // A second draft of the same person that stays editable.
    const other = `${world.draftPath}-other`;
    await adminDb().doc(other).set({ fieldOwnerUid: world.owner.uid, state: 'editing', field: { airMovers: 0 } });
    let phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    for (const path of [world.draftPath, other]) {
      const id = await phone.call('listen', 'main', path);
      await expect.poll(async () => (await phone.call('events', id)).some((e) => e.fromCache === false)).toBe(true);
    }
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.notes': 'first, will be refused' });
    await phone.call('update', 'main', other, { 'field.notes': 'second, allowed' });
    await expect.poll(async () => (await phone.call('readCache', 'main', other)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await fenceDraft(world);
    phone = await phone.restart(context);
    await phone.start(world, 'single');
    await phone.call('uid', 'main');
    await phone.call('listen', 'main', other);
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await adminDb().doc(other).get()).data()?.field, { timeout: 45_000 }).toMatchObject({ notes: 'second, allowed' });
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await context.close();
  });

  // Why field edits are absolute values and never increments (the plan's section 4 rule): with a
  // refused write queued ahead of it, an increment was applied twice, with the page alive and
  // after a restart, in Chromium and WebKit, against the emulator. An absolute value is the same
  // however many times it lands. If this test starts to fail, the SDK or the emulator changed:
  // re-read it before relaxing anything.
  test('an increment queued behind a refused write is applied twice (so edits are absolute values)', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    const other = `${world.draftPath}-other`;
    await adminDb().doc(other).set({ fieldOwnerUid: world.owner.uid, state: 'editing', field: { airMovers: 0 } });
    const phone = await Phone.open(context, lane);
    await phone.start(world, 'single');
    await phone.signIn(world.owner);
    for (const path of [world.draftPath, other]) {
      const id = await phone.call('listen', 'main', path);
      await expect.poll(async () => (await phone.call('events', id)).some((e) => e.fromCache === false)).toBe(true);
    }
    lane.cut(['auth', 'firestore']);
    await phone.call('update', 'main', world.draftPath, { 'field.notes': 'first, will be refused' });
    await phone.call('update', 'main', other, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await phone.call('readCache', 'main', other)).hasPendingWrites).toBe(true);
    await expectNothingSent(lane);
    await fenceDraft(world);
    lane.restore(['auth', 'firestore']);
    await expect.poll(async () => (await adminDb().doc(other).get()).data()?.field, { timeout: 45_000 }).toMatchObject({ airMovers: 2 });
    await context.close();
  });
});
