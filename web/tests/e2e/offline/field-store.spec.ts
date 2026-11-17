// The field shell's phone-storage screens (S6-3), in Chromium and WebKit at phone width, through a
// lane: "Keep jobs on this phone?" once per company, "Open DryScope in one window", the memory
// fallback's banner and "Reopen the app", the offline sign-in's age limit, and what the shell says
// while the sync gate waits. The field client code itself is tested in field-gate.spec.ts.
import type { Page } from '@playwright/test';
import { NOT_KEPT_TEXT, NOT_SAVED_TEXT, OFFLINE_TEXT } from '../../../src/app/field/banners';
import * as text from '../../../src/app/field/field-store-text';
import { ME_DB, ME_DB_VERSION, ME_STORE, meKey, type DsMe } from '../../../src/lib/field/ds-me';
import { keepKey } from '../../../src/lib/field/keep-consent';
import { unsentKey } from '../../../src/lib/field/unsent';
import { expectNoAxeViolations } from '../a11y';
import { browserConfig, expect, test } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { NetworkLane } from './lane';
import { seedCompany, type Person, type World } from './world';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

test.use({ viewport: { width: 390, height: 844 } });

const DAY = 24 * 60 * 60 * 1000;

// Saves the row the sign-in page saves, for `who` in `world`, signed in `ageDays` ago.
async function saveRow(page: Page, lane: NetworkLane, world: World, who: Person, company: string, ageDays = 0): Promise<void> {
  const row: DsMe & { key: string } = {
    key: meKey(world.tenantId, who.uid),
    tenantId: world.tenantId,
    uid: who.uid,
    companyName: company,
    address: 'field-store-test',
    config: browserConfig(lane),
    savedAt: Date.now(),
    role: 'estimator',
    companyId: world.companyId,
    // The row the sign-in page saves holds the person's actor id too (S5b-1).
    actorId: 'actor',
    capabilities: ['scope'],
    authTime: Date.now() - ageDays * DAY,
  };
  await page.evaluate(
    ([db, store, version, value]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db as string, version as number);
        open.onupgradeneeded = () => open.result.createObjectStore(store as string, { keyPath: 'key' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction(store as string, 'readwrite');
          transaction.objectStore(store as string).put(value);
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    [ME_DB, ME_STORE, ME_DB_VERSION, row] as const,
  );
}

const setLocal = (page: Page, key: string, value: string) =>
  page.evaluate(([k, v]) => window.localStorage.setItem(k!, v!), [key, value]);

// A shell at /field for a saved sign-in of `who`, with "keep jobs" already answered.
async function openShell(page: Page, lane: NetworkLane, world: World, who: Person, ageDays = 0): Promise<void> {
  await page.goto(`${lane.appUrl}/field`);
  await saveRow(page, lane, world, who, 'Field Store Test', ageDays);
  await setLocal(page, keepKey(world.tenantId), 'keep');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Field Store Test' })).toBeVisible();
}

test.describe('the field shell\'s phone storage (S6-3)', () => {
  test('asks once per phone and company whether to keep jobs here', async ({ page, lane }) => {
    const [one, two] = [await seedCompany(), await seedCompany()];
    await page.goto(`${lane.appUrl}/field`);
    await saveRow(page, lane, one, one.owner, 'Company One');
    await page.reload();
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toBeVisible();
    await expect(page.getByText(text.KEEP_LIMITS)).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: text.KEEP_YES }).click();
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Company One' })).toBeVisible();
    await expect(page.getByText(text.LOCKED_SIGN_IN_TEXT)).toBeVisible();
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toHaveCount(0);

    // Another company on the same phone is asked for itself.
    await saveRow(page, lane, two, two.owner, 'Company Two');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Company Two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toBeVisible();
    await page.getByRole('button', { name: text.KEEP_NO }).click();
    await expect(page.getByText(text.ONLINE_ONLY_NOTICE)).toBeVisible();
  });

  test('a second window of the same storage says to use one window', async ({ context, page, lane }) => {
    const world = await seedCompany();
    await openShell(page, lane, world, world.owner);
    await expect(page.getByText(text.LOCKED_SIGN_IN_TEXT)).toBeVisible();
    const second = await context.newPage();
    await second.goto(`${lane.appUrl}/field`);
    await expect(second.getByRole('heading', { name: text.ONE_WINDOW_TITLE })).toBeVisible();
    await expectNoAxeViolations(second);
    // The first window is not disturbed, and once it closes the next window opens normally.
    await expect(page.getByRole('heading', { name: text.ONE_WINDOW_TITLE })).toHaveCount(0);
    await page.close();
    await second.reload();
    await expect(second.getByText(text.LOCKED_SIGN_IN_TEXT)).toBeVisible();
  });

  test('a cache that does not start falls back to memory and says nothing is saved', async ({ page, lane }) => {
    const world = await seedCompany();
    await openShell(page, lane, world, world.owner);
    // Firestore's own databases never open from now on (a hung IndexedDB); the rest still works.
    await page.addInitScript(() => {
      const real = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        return name.startsWith('firestore/') ? ({} as IDBOpenDBRequest) : real.call(this, name, version);
      } as typeof real;
    });
    await page.reload();
    await expect(page.getByText(NOT_SAVED_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(text.LOCKED_SIGN_IN_MEMORY_TEXT)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('with unsent work, a cache that does not start asks to reopen the app and takes no edits', async ({ page, lane }) => {
    const world = await seedCompany();
    await openShell(page, lane, world, world.owner);
    await setLocal(page, unsentKey(world.tenantId, world.owner.uid), JSON.stringify({ writes: 1, unsentSince: Date.now(), lockedSince: null }));
    await page.addInitScript(() => {
      const real = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        return name.startsWith('firestore/') ? ({} as IDBOpenDBRequest) : real.call(this, name, version);
      } as typeof real;
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: text.REOPEN_TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
    await expect(page.getByText(NOT_SAVED_TEXT)).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test('a cache the browser refuses at once falls back to memory and says nothing is saved', async ({ page, lane }) => {
    const world = await seedCompany();
    await openShell(page, lane, world, world.owner);
    // Firestore's own databases fail to open the way a private window fails them; the SDK then goes
    // on in memory by itself, and its first cache read still answers.
    await page.addInitScript(() => {
      const real = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        if (!name.startsWith('firestore/')) return real.call(this, name, version);
        const request = {} as { error?: DOMException; onerror?: (event: { target: unknown }) => void };
        setTimeout(() => {
          request.error = new DOMException('Storage refused', 'InvalidStateError');
          request.onerror?.({ target: request });
        });
        return request as unknown as IDBOpenDBRequest;
      } as typeof real;
    });
    await page.reload();
    await expect(page.getByText(NOT_SAVED_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(text.LOCKED_SIGN_IN_MEMORY_TEXT)).toBeVisible();
  });

  test('with unsent work, a cache the browser refuses at once asks to reopen the app and takes no edits', async ({ page, lane }) => {
    const world = await seedCompany();
    await openShell(page, lane, world, world.owner);
    await setLocal(page, unsentKey(world.tenantId, world.owner.uid), JSON.stringify({ writes: 1, unsentSince: Date.now(), lockedSince: null }));
    await page.addInitScript(() => {
      const real = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
        if (!name.startsWith('firestore/')) return real.call(this, name, version);
        const request = {} as { error?: DOMException; onerror?: (event: { target: unknown }) => void };
        setTimeout(() => {
          request.error = new DOMException('Storage refused', 'InvalidStateError');
          request.onerror?.({ target: request });
        });
        return request as unknown as IDBOpenDBRequest;
      } as typeof real;
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: text.REOPEN_TITLE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
  });

  test('with Online only chosen, no signal does not say the work is saved on this phone', async ({ context, page, lane }) => {
    const world = await seedCompany();
    await page.goto(`${lane.appUrl}/field`);
    await saveRow(page, lane, world, world.owner, 'Field Store Test');
    await setLocal(page, keepKey(world.tenantId), 'online-only');
    await page.reload();
    await expect(page.getByText(text.ONLINE_ONLY_NOTICE)).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText(NOT_KEPT_TEXT)).toBeVisible();
    await expect(page.getByText(OFFLINE_TEXT)).toHaveCount(0);
    await context.setOffline(false);
  });

  test('an offline sign-in stops standing in at the role\'s limit while the shell stays open (day 29 to day 31)', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    await harness.signIn(world, world.owner);
    await harness.page.close();
    lane.drop('/api/me');
    await page.clock.install();
    await openShell(page, lane, world, world.owner, 29);
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toHaveCount(0);
    // Two days later, the same window still open with no signal: an estimator's 30 days are up.
    await page.clock.fastForward('48:00:00');
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
  });

  test('an open shell stops at the role\'s limit when /api/me stops answering but the app is still reachable (day 29 to day 31)', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    await harness.signIn(world, world.owner);
    await harness.page.close();
    // The shell's clock runs 29 days after that sign-in; the server lets the person in.
    serveMe(lane, { expiresAt: inDays(29 + 7) });
    await page.clock.install({ time: inDays(29) });
    await openShell(page, lane, world, world.owner);
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toHaveCount(0);

    // /api/me stops answering while the app itself stays reachable; two days on, the window is
    // still open and the estimator's 30 days are up.
    serveMe(lane, { status: 503, error: 'unavailable' });
    await page.clock.fastForward('48:00:00');
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
  });

  test('a shell opened in a hidden page asks nothing until it is shown', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    await harness.signIn(world, world.owner);
    await harness.page.close();
    serveMe(lane, { status: 403, error: 'member_disabled' });
    await page.addInitScript(() => {
      const shown = { value: false };
      (window as unknown as { shown: typeof shown }).shown = shown;
      Object.defineProperty(document, 'visibilityState', { get: () => (shown.value ? 'visible' : 'hidden'), configurable: true });
    });
    let asked = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/me') asked += 1;
    });
    await openShell(page, lane, world, world.owner);
    await page.waitForTimeout(3000);
    expect(asked).toBe(0);
    await expect(page.getByText(text.LOCKED_DISABLED_TEXT)).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { shown: { value: boolean } }).shown.value = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByText(text.LOCKED_DISABLED_TEXT)).toBeVisible();
    expect(asked).toBeGreaterThan(0);
  });

  test('a shell that keeps nothing never says unsent work is kept on this phone', async ({ page, lane }) => {
    const world = await seedCompany();
    await page.goto(`${lane.appUrl}/field`);
    await saveRow(page, lane, world, world.owner, 'Field Store Test');
    await setLocal(page, keepKey(world.tenantId), 'online-only');
    await page.reload();
    // Nobody is signed in on this phone, so the gate asks for a sign-in.
    await expect(page.getByText(text.LOCKED_SIGN_IN_MEMORY_TEXT)).toBeVisible();
    await expect(page.getByText(text.LOCKED_SIGN_IN_TEXT)).toHaveCount(0);
    await expect(page.getByText(/stay on this phone/)).toHaveCount(0);
  });

  test('a browser without the window lock gets no field client and says it cannot keep work offline', async ({ page, lane }) => {
    const world = await seedCompany();
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
    });
    await openShell(page, lane, world, world.owner);
    await expect(page.getByRole('heading', { name: text.NO_LOCK_TITLE })).toBeVisible();
    await expect(page.getByText(NOT_SAVED_TEXT)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
    await expect(page.getByText(text.LOCKED_SIGN_IN_TEXT)).toHaveCount(0);
  });

  test('with unsent work only in memory, leaving the shell asks first; with none, it does not', async ({ page, lane }) => {
    const world = await seedCompany();
    await page.goto(`${lane.appUrl}/field`);
    await saveRow(page, lane, world, world.owner, 'Field Store Test');
    await setLocal(page, keepKey(world.tenantId), 'online-only');
    await page.reload();
    await expect(page.getByText(text.ONLINE_ONLY_NOTICE)).toBeVisible();
    // A user gesture, which browsers want before they ask on leaving.
    await page.getByText(text.ONLINE_ONLY_NOTICE).click();
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.type());
      void dialog.accept();
    });
    const leavingAsks = () =>
      page.evaluate(() => {
        const leaving = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(leaving);
        return leaving.defaultPrevented;
      });
    expect(await leavingAsks()).toBe(false);
    await setLocal(page, unsentKey(world.tenantId, world.owner.uid), JSON.stringify({ writes: 1, unsentSince: Date.now(), lockedSince: null, memoryOnly: true }));
    expect(await leavingAsks()).toBe(true);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => asked).toEqual(['beforeunload']);
  });

  test('says what the phone waits for: no signal with an old sign-in, a renewal, a refusal', async ({ context, page, lane }) => {
    const world = await seedCompany();
    // Signed in on this phone (the company's own sign-in, as the sign-in page leaves it).
    const harness = await FieldPhone.open(context, lane);
    await harness.signIn(world, world.owner);
    await harness.page.close();

    // No answer from the server, and a sign-in 31 days old: an estimator must come online first.
    lane.drop('/api/me');
    await openShell(page, lane, world, world.owner, 31);
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // The same with a sign-in from yesterday: the phone works offline.
    await saveRow(page, lane, world, world.owner, 'Field Store Test', 1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();

    serveMe(lane, { expiresAt: inDays(-1) });
    await page.reload();
    await expect(page.getByText(text.RENEWING_TEXT)).toBeVisible();

    serveMe(lane, { status: 403, error: 'member_disabled' });
    await page.reload();
    await expect(page.getByText(text.LOCKED_DISABLED_TEXT)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toHaveCount(0);
    await expectNoAxeViolations(page);

    serveMe(lane, { expiresAt: inDays(7) });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();
    await expect(page.getByText(text.RENEWING_TEXT)).toHaveCount(0);
  });
});

// S6-3b: work locked past the 30-day limit (O5) is hidden when the shell is shown again, with no
// navigation, whether it is signed out or open for someone else; the phone alone removes nothing,
// only the server refusing the person does (decision 010).
test.describe('the field shell hides outlived locked work when it is shown again, and removes nothing by itself', () => {
  // A page whose visibility the test sets, as a phone hides and shows the app.
  const controlVisibility = (page: Page) =>
    page.addInitScript(() => {
      const shown = { value: true };
      (window as unknown as { shown: typeof shown }).shown = shown;
      Object.defineProperty(document, 'visibilityState', { get: () => (shown.value ? 'visible' : 'hidden'), configurable: true });
    });
  const setShown = (page: Page, value: boolean) =>
    page.evaluate((shown) => {
      (window as unknown as { shown: { value: boolean } }).shown.value = shown;
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  const hasDatabase = (page: Page, uid: string) =>
    page.evaluate(async (id) => ((await indexedDB.databases()) ?? []).some((database) => (database.name ?? '').includes(id)), uid);
  const getLocal = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key);

  // Locked work of `who` kept on the phone by a sign-out the app made on a refusal.
  async function lockedAndSignedOut(harness: FieldPhone, world: World, who: Person): Promise<void> {
    const person = await harness.signIn(world, who);
    expect(await harness.call('start', person, 'persistent')).toBe('persistent');
    await harness.call('signOutKeep', person, 'sign-in-again');
  }

  // The lock is 29 days old now; hidden, two days pass; shown again, the work is past the limit,
  // and still all there.
  async function hideFromDay29ToDay31(page: Page, world: World, who: Person): Promise<void> {
    const key = unsentKey(world.tenantId, who.uid);
    const mark = JSON.parse((await getLocal(page, key))!) as Record<string, unknown>;
    const aged = JSON.stringify({ ...mark, lockedSince: Date.now() - 29 * DAY });
    await setLocal(page, key, aged);
    await setShown(page, false);
    await page.clock.fastForward('48:00:00');
    expect(await hasDatabase(page, who.uid)).toBe(true);
    await setShown(page, true);
    await page.waitForTimeout(1000);
    expect(await hasDatabase(page, who.uid)).toBe(true);
    expect(await getLocal(page, key)).toBe(aged);
  }

  test('signed out', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    await lockedAndSignedOut(harness, world, world.owner);
    await harness.page.close();
    await controlVisibility(page);
    await page.clock.install();
    await page.goto(`${lane.appUrl}/field`);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await hideFromDay29ToDay31(page, world, world.owner);
  });

  test('open for another person of the company', async ({ context, page, lane }) => {
    const world = await seedCompany({ people: ['owner', 'ben'] });
    const ben = world.people.ben!;
    const harness = await FieldPhone.open(context, lane);
    await lockedAndSignedOut(harness, world, ben);
    await harness.signIn(world, world.owner);
    await harness.page.close();
    lane.drop('/api/me');
    await controlVisibility(page);
    await page.clock.install();
    await openShell(page, lane, world, world.owner);
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();
    await hideFromDay29ToDay31(page, world, ben);
    await expect(page.getByRole('heading', { name: 'My jobs', exact: true })).toBeVisible();
  });

  test('open for the person whose work it is: the shell hides it, and says it was removed once the server refuses her', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    const person = await harness.signIn(world, world.owner);
    expect(await harness.call('start', person, 'persistent')).toBe('persistent');
    await harness.call('setMark', person, { writes: 1, unsentSince: Date.now(), lockedSince: Date.now() - 20 * DAY, lockedReason: 'company-inactive' });
    await harness.page.close();
    lane.drop('/api/me');
    await controlVisibility(page);
    await page.clock.install();
    await openShell(page, lane, world, world.owner);
    await expect(page.getByText(text.LOCKED_INACTIVE_TEXT)).toBeVisible();
    await hideFromDay29ToDay31(page, world, world.owner);
    await expect(page.getByText(text.HIDDEN_TEXT)).toBeVisible();
    await expect(page.getByText(text.LOCKED_INACTIVE_TEXT)).toHaveCount(0);

    // The signal is back and the server still refuses her: the work goes, and the shell says so.
    serveMe(lane, { status: 403, error: 'company_inactive' });
    await page.clock.fastForward('00:01:00');
    await expect.poll(() => hasDatabase(page, world.owner.uid)).toBe(false);
    await expect(page.getByText(text.REMOVED_TEXT)).toBeVisible();
    await expect(page.getByText(text.HIDDEN_TEXT)).toHaveCount(0);
  });

  test('open on another company\'s "Keep jobs on this phone?" question', async ({ context, page, lane }) => {
    const [one, two] = [await seedCompany({ people: ['owner', 'ben'] }), await seedCompany()];
    const ben = one.people.ben!;
    const harness = await FieldPhone.open(context, lane);
    await lockedAndSignedOut(harness, one, ben);
    await harness.page.close();
    await controlVisibility(page);
    await page.clock.install();
    await page.goto(`${lane.appUrl}/field`);
    await saveRow(page, lane, two, two.owner, 'Company Two');
    await page.reload();
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toBeVisible();
    await hideFromDay29ToDay31(page, one, ben);
    await expect(page.getByRole('heading', { name: text.KEEP_TITLE })).toBeVisible();
  });

  test('left open and shown across the limit, with nothing hidden or shown again: the work stays', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    await lockedAndSignedOut(harness, world, world.owner);
    await harness.page.close();
    await page.clock.install();
    await page.goto(`${lane.appUrl}/field`);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    const key = unsentKey(world.tenantId, world.owner.uid);
    const mark = JSON.parse((await getLocal(page, key))!) as Record<string, unknown>;
    const aged = JSON.stringify({ ...mark, lockedSince: Date.now() - 29 * DAY });
    await setLocal(page, key, aged);
    await page.clock.fastForward('48:00:00');
    await page.waitForTimeout(1000);
    expect(await hasDatabase(page, world.owner.uid)).toBe(true);
    expect(await getLocal(page, key)).toBe(aged);
  });

  // A saved sign-in past its role's limit starts the 30 days with no refusal from any server.
  test('a sign-in past its role\'s limit, opened with no signal and no refusal saved, is locked out from then; shown again 30 days later, the work is hidden and kept', async ({ context, page, lane }) => {
    const world = await seedCompany();
    const harness = await FieldPhone.open(context, lane);
    const person = await harness.signIn(world, world.owner);
    expect(await harness.call('start', person, 'persistent')).toBe('persistent');
    await harness.call('setMark', person, { writes: 1, unsentSince: Date.now(), lockedSince: null });
    await harness.page.close();
    lane.drop('/api/me');
    const key = unsentKey(world.tenantId, world.owner.uid);
    const mark = async () => JSON.parse((await getLocal(page, key)) ?? 'null') as Record<string, unknown> | null;
    await controlVisibility(page);
    await page.clock.install();
    const opened = Date.now();
    await openShell(page, lane, world, world.owner, 31);
    await expect(page.getByRole('heading', { name: text.ONLINE_ONCE_TITLE })).toBeVisible();
    await expect.poll(mark).toMatchObject({ unsentSince: expect.any(Number), lockedSince: expect.any(Number), lockedReason: 'sign-in-expired' });
    const since = (await mark())!.lockedSince as number;
    expect(Math.abs(since - opened)).toBeLessThan(60_000);

    // 29 days on, hidden and shown: still there, and the first time stands.
    await setShown(page, false);
    await page.clock.fastForward(29 * DAY);
    await setShown(page, true);
    await page.waitForTimeout(1000);
    expect(await hasDatabase(page, world.owner.uid)).toBe(true);
    expect(await mark()).toMatchObject({ lockedSince: since });

    await setShown(page, false);
    await page.clock.fastForward(2 * DAY);
    await setShown(page, true);
    await expect(page.getByText(text.HIDDEN_TEXT)).toBeVisible();
    // Nothing is removed: no server has refused the person (decision 010). The first time stands.
    expect(await hasDatabase(page, world.owner.uid)).toBe(true);
    expect(await mark()).toMatchObject({ unsentSince: expect.any(Number), lockedSince: since, lockedReason: 'sign-in-expired' });
  });
});
