import { test, expect as baseExpect, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PASSWORD, readSeed, type TeamSeed } from './sign-in/seed';

// S6-8 follow-up: Company settings, Team, Finish and Review erase the phone's saved item list (names
// and units) when GET /api/me lets the person in without prices_read, as the field gate, Prices and
// sign-in do (src/lib/field/ds-prices.ts). The team company has the price_books switch off, so its
// /api/me never grants prices_read. Each test saves a copy after sign-in has finished its own erase,
// then opens one screen, which must erase it.

test.use({ viewport: { width: 390, height: 844 } });
// The dev server compiles each page and route the first time it is asked.
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

async function signIn(page: Page, who: { email: string } = team.estimator) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

// Saves an item list for the estimator as Check Scope would, stamped with a time after every refusal
// recorded so far, so none covers it. Waits first for the item-list work sign-in queued.
const saveCopy = (page: Page, owner: { tenantId: string; uid: string; companyId: string }) =>
  page.evaluate(async ({ tenantId, uid, companyId }) => {
    await navigator.locks.request(JSON.stringify(['ds-prices', tenantId, uid]), () => undefined);
    const refusedAt = (scope: string[]) => Number(localStorage.getItem(`ds-prices-erase/${JSON.stringify(scope)}`)) || 0;
    const seen = Math.max(Date.now(), refusedAt([tenantId, uid]) + 1, refusedAt([tenantId, uid, companyId]) + 1);
    const list = {
      versionId: crypto.randomUUID(), publishedAt: '2026-11-10T12:00:00Z',
      items: [{ itemId: 'extraction', name: 'Water extraction', unit: 'sf' }], roomTypes: [],
    };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('ds-prices', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('item-lists', { keyPath: ['tenantId', 'uid', 'companyId', 'versionId'] });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('item-lists', 'readwrite');
        transaction.objectStore('item-lists').put({ tenantId, uid, companyId, versionId: list.versionId, list, seen });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, owner);

const savedCount = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open('ds-prices', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const count = db.transaction('item-lists', 'readonly').objectStore('item-lists').count();
    count.onsuccess = () => { db.close(); resolve(count.result); };
    count.onerror = () => { db.close(); reject(count.error); };
  };
}));

const screens: [string, () => string][] = [
  ['Company settings', () => `/sign-in/${team.address}/company`],
  ['Team', () => `/sign-in/${team.address}/team`],
  ['Finish', () => `/sign-in/${team.address}/jobs/${randomUUID()}/finish`],
  ['Review', () => `/sign-in/${team.address}/jobs/${randomUUID()}/review`],
];

for (const [name, path] of screens) {
  test(`${name} erases the saved item list when /api/me no longer grants prices_read`, async ({ page }) => {
    await signIn(page);
    await saveCopy(page, { tenantId: team.tenantId, uid: team.estimator.uid, companyId: team.companyId });
    expect(await savedCount(page)).toBe(1);

    const me = page.waitForResponse((response) => response.url().endsWith('/api/me') && response.status() === 200);
    await page.goto(path());
    await me;
    await expect.poll(() => savedCount(page)).toBe(0);
  });
}

test('a screen records the refusal before it shows its answer, even while another tab holds the item-list lock', async ({ page, context }) => {
  const owner = { tenantId: team.tenantId, uid: team.estimator.uid, companyId: team.companyId };
  await signIn(page);
  await saveCopy(page, owner);
  const refusedAt = () => page.evaluate((scope) => Number(localStorage.getItem(`ds-prices-erase/${JSON.stringify(scope)}`)) || 0, [owner.tenantId, owner.uid, owner.companyId]);

  // Another tab (Check Scope in the middle of a slow save) holds the person's item-list lock. Its page
  // is one that runs none of the app's item-list code.
  const other = await context.newPage();
  await other.goto('/no-such-page');
  await other.evaluate((lock) => new Promise<void>((held) => {
    void navigator.locks.request(lock, () => new Promise<void>((release) => {
      (window as unknown as { releaseItemListLock: () => void }).releaseItemListLock = release;
      held();
    }));
  }), JSON.stringify(['ds-prices', owner.tenantId, owner.uid]));

  const before = await refusedAt();
  await page.goto(`/sign-in/${team.address}/company`);
  await expect(page.getByRole('heading', { name: 'This screen is for the company owner' })).toBeVisible();
  // Recorded already: a reload in any tab, even offline, now shows nothing of the saved copy.
  expect(await refusedAt()).toBeGreaterThan(before);
  expect(await savedCount(page)).toBe(1);

  await other.evaluate(() => (window as unknown as { releaseItemListLock: () => void }).releaseItemListLock());
  await expect.poll(() => savedCount(page)).toBe(0);
});

test('a screen the person has left drops its late /api/me answer and records no refusal', async ({ page }) => {
  // The owner: the signed-in screen links to Company settings only for them.
  const owner = { tenantId: team.tenantId, uid: team.owner.uid, companyId: team.companyId };
  await signIn(page, team.owner);
  await saveCopy(page, owner);
  const refusedAt = () => page.evaluate((scope) => Number(localStorage.getItem(`ds-prices-erase/${JSON.stringify(scope)}`)) || 0, [owner.tenantId, owner.uid, owner.companyId]);

  // Company settings' GET /api/me is held until the person has gone back (an in-app navigation).
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const captured = Promise.withResolvers<Request>();
  let first = true;
  await page.route('**/api/me', async (route) => {
    if (!first) return route.continue();
    first = false;
    captured.resolve(route.request());
    await held;
    await route.continue();
  });
  await page.getByRole('link', { name: 'Company settings' }).click();
  await expect(page).toHaveURL(new RegExp(`/sign-in/${team.address}/company$`));
  // Company settings has sent its request (and it is held) before the person goes back.
  const companyRequest = await captured.promise;
  await page.goBack();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
  // What the sign-in screen recorded, once its own item-list work is done.
  await page.evaluate((lock) => navigator.locks.request(lock, () => undefined), JSON.stringify(['ds-prices', owner.tenantId, owner.uid]));
  const before = await refusedAt();

  release();
  await companyRequest.response();
  await page.waitForTimeout(500);
  await page.evaluate((lock) => navigator.locks.request(lock, () => undefined), JSON.stringify(['ds-prices', owner.tenantId, owner.uid]));
  expect(await refusedAt()).toBe(before);
});
