import { test, expect as baseExpect, type Page } from '@playwright/test';
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

async function signIn(page: Page) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(team.estimator.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

// Saves an item list for the estimator as Check Scope would, stamped with the refusals recorded so
// far, so no refusal before this covers it. Waits first for the item-list work sign-in queued.
const saveCopy = (page: Page, owner: { tenantId: string; uid: string; companyId: string }) =>
  page.evaluate(async ({ tenantId, uid, companyId }) => {
    await navigator.locks.request(JSON.stringify(['ds-prices', tenantId, uid]), () => undefined);
    const counter = (scope: string[]) => Number(localStorage.getItem(`ds-prices-erase/${JSON.stringify(scope)}`)) || 0;
    const seen = [counter([tenantId, uid]), counter([tenantId, uid, companyId])];
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
