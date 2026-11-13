// S6-3: whose work the app's field client keeps apart on one phone (the walls S6-1 (c) found the
// SDK does not build itself): one Firestore cache per company and person (src/lib/field-db.ts),
// and sign-outs that keep or discard only the signed-in person's work in that company.
import { expect, expectNothingSent, expectWithheld, test, SEND_MS } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { Person as FieldPerson } from './harness/field';
import { readDraft, seedCompany, type Person, type World } from './world';

const sent = async (world: World) => (await readDraft(world)).field.airMovers;

// Signed in as `who`, the gate open and the draft cached.
async function ready(phone: FieldPhone, world: World, who: Person): Promise<FieldPerson> {
  const person = await phone.signIn(world, who);
  expect(await phone.call('start', person, 'persistent')).toBe('persistent');
  await phone.call('sync', person);
  await expect.poll(() => phone.call('gate', person)).toBe('open');
  expect(await phone.call('readServer', person, world.draftPath)).toMatchObject({ data: { field: { airMovers: 0 } } });
  return person;
}

test.describe('people and companies on one phone (S6-3)', () => {
  test('company B signing out (and discarding) leaves company A\'s unsent work alone', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const [a, b] = [await seedCompany(), await seedCompany()];
    serveMe(lane, { expiresAt: inDays(7) });
    const phone = await FieldPhone.open(context, lane);
    const inA = await ready(phone, a, a.owner);
    const inB = await ready(phone, b, b.owner);
    lane.cut(['auth', 'firestore']);
    await phone.call('write', inA, a.draftPath, { 'field.airMovers': { __inc: 1 } });
    await phone.call('write', inB, b.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await phone.call('readCache', inA, a.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);

    expect(await phone.call('signOutDiscard', inB)).toBe('signed-out');
    expect(await phone.call('unsent', inB)).toEqual({ writes: 0, unsentSince: null, lockedSince: null });
    expect(await phone.call('unsent', inA)).toMatchObject({ unsentSince: expect.any(Number) });
    lane.restore(['auth', 'firestore']);
    await expect.poll(() => sent(a), { timeout: SEND_MS }).toBe(1);
    await expectWithheld(async () => (await sent(b)) === 0);
    expect(await sent(a)).toBe(1);
    await context.close();
  });

  test('the same person signing out and in again keeps the unsent work, and it is sent once (D7)', async ({ browser, lane }) => {
    const context = await browser.newContext();
    const world = await seedCompany();
    serveMe(lane, { expiresAt: inDays(7) });
    let phone = await FieldPhone.open(context, lane);
    const person = await ready(phone, world, world.owner);
    lane.cut(['auth', 'firestore']);
    await phone.call('write', person, world.draftPath, { 'field.airMovers': { __inc: 1 } });
    await expect.poll(async () => (await phone.call('readCache', person, world.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);
    // A sign-out that keeps the work (Keep, or one the app made because the sign-in ran out).
    await phone.call('signOutKeep', person);
    lane.restore(['auth', 'firestore']);
    phone = await phone.restart(context);
    // Signed out, the app opened again with signal: nothing is sent.
    expect(await phone.call('start', person, 'persistent')).toBe('persistent (signed out)');
    await phone.call('sync', person);
    await expect.poll(() => phone.call('gate', person)).toBe('locked: sign-in-again');
    await expectWithheld(async () => (await sent(world)) === 0);
    await phone.call('stop', person);

    await phone.signIn(world, world.owner);
    expect(await phone.call('start', person, 'persistent')).toBe('persistent');
    await phone.call('sync', person);
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    await phone.page.waitForTimeout(3000);
    expect(await sent(world)).toBe(1);
    await context.close();
  });

  test('a different person on the same phone neither sees nor sends the first person\'s work', async ({ browser, lane }) => {
    const context = await browser.newContext();
    // Cleo is another estimator of the same company: the rules refuse her Ana's draft.
    const world = await seedCompany({ people: ['ana', 'cleo'] });
    const [ana, cleo] = [world.people.ana!, world.people.cleo!];
    serveMe(lane, { expiresAt: inDays(7) });
    let phone = await FieldPhone.open(context, lane);
    const asAna = await ready(phone, world, ana);
    lane.cut(['auth', 'firestore']);
    await phone.call('write', asAna, world.draftPath, { 'field.airMovers': { __inc: 1 }, 'field.notes': 'Ana only' });
    await expect.poll(async () => (await phone.call('readCache', asAna, world.draftPath)).pending).toBe(true);
    await expectNothingSent(lane);
    await phone.call('signOutKeep', asAna);

    // Cleo signs in on the same phone, still with no signal: Ana's cached draft is not hers to read.
    lane.restore(['auth']);
    phone = await phone.restart(context);
    const asCleo = phone.person(world, cleo);
    await phone.signIn(world, cleo);
    expect(await phone.call('start', asCleo, 'persistent')).toBe('persistent');
    expect(await phone.call('readCache', asCleo, world.draftPath)).toEqual({ error: 'unavailable' });
    expect(await phone.call('unsent', asCleo)).toEqual({ writes: 0, unsentSince: null, lockedSince: null });
    // Their caches are databases of their own.
    const names = await phone.call('databases');
    expect(names.filter((name) => name.includes(ana.uid))).not.toHaveLength(0);
    expect(names.filter((name) => name.includes(cleo.uid))).not.toHaveLength(0);
    expect(names.some((name) => name.includes(ana.uid) && name.includes(cleo.uid))).toBe(false);

    // With signal, Cleo's open gate sends nothing of Ana's.
    lane.restore(['firestore']);
    await phone.call('sync', asCleo);
    await expect.poll(() => phone.call('gate', asCleo)).toBe('open');
    await expectWithheld(async () => (await sent(world)) === 0);
    expect((await readDraft(world)).field).not.toHaveProperty('notes');
    await phone.call('signOutKeep', asCleo);

    // Ana comes back: her work goes, once.
    await phone.signIn(world, ana);
    expect(await phone.call('start', asAna, 'persistent')).toBe('persistent');
    await phone.call('sync', asAna);
    await expect.poll(() => sent(world), { timeout: SEND_MS }).toBe(1);
    expect((await readDraft(world)).field).toMatchObject({ notes: 'Ana only' });
    await context.close();
  });
});
