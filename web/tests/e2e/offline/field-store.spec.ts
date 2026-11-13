// The field shell's phone-storage screens (S6-3), in Chromium and WebKit at phone width, through a
// lane: "Keep jobs on this phone?" once per company, "Open DryScope in one window", the memory
// fallback's banner and "Reopen the app", the offline sign-in's age limit, and what the shell says
// while the sync gate waits. The field client code itself is tested in field-gate.spec.ts.
import type { Page } from '@playwright/test';
import { NOT_SAVED_TEXT } from '../../../src/app/field/banners';
import * as text from '../../../src/app/field/field-store-text';
import { ME_DB, ME_DB_VERSION, ME_STORE, meKey, type DsMe } from '../../../src/lib/field/ds-me';
import { keepKey } from '../../../src/lib/field/keep-consent';
import { unsentKey } from '../../../src/lib/field/unsent';
import { expectNoAxeViolations } from '../a11y';
import { browserConfig, expect, test } from './fixture';
import { FieldPhone, inDays, serveMe } from './field-phone';
import type { NetworkLane } from './lane';
import { seedCompany, type Person, type World } from './world';

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
    await expect(page.getByText(text.LOCKED_SIGN_IN_TEXT)).toBeVisible();
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
    await expect(page.getByText('Your jobs will show here.')).toHaveCount(0);
    await expect(page.getByText(NOT_SAVED_TEXT)).toHaveCount(0);
    await expectNoAxeViolations(page);
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
    await expect(page.getByText('Your jobs will show here.')).toHaveCount(0);
    await expectNoAxeViolations(page);

    // The same with a sign-in from yesterday: the phone works offline.
    await saveRow(page, lane, world, world.owner, 'Field Store Test', 1);
    await page.reload();
    await expect(page.getByText('Your jobs will show here.')).toBeVisible();

    serveMe(lane, { expiresAt: inDays(-1) });
    await page.reload();
    await expect(page.getByText(text.RENEWING_TEXT)).toBeVisible();

    serveMe(lane, { status: 403, error: 'member_disabled' });
    await page.reload();
    await expect(page.getByText(text.LOCKED_DISABLED_TEXT)).toBeVisible();
    await expect(page.getByText('Your jobs will show here.')).toHaveCount(0);
    await expectNoAxeViolations(page);

    serveMe(lane, { expiresAt: inDays(7) });
    await page.reload();
    await expect(page.getByText('Your jobs will show here.')).toBeVisible();
    await expect(page.getByText(text.RENEWING_TEXT)).toHaveCount(0);
  });
});
