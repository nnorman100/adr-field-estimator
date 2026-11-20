import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { keepKey } from '../../../src/lib/field/keep-consent';
import { firestoreJobProjectionStore } from '../../../src/lib/jobs/projection';
import { FieldPhone, inDays } from './field-phone';
import { expect, test } from './fixture';
import type { NetworkLane } from './lane';
import { adminDb, seedCompany, type World } from './world';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });

const ITEM_LIST = '/api/prices/item-list';
const capabilities = ['scope', 'prices_read'];

function serve(lane: NetworkLane, path: string, body: unknown) {
  lane.serve(path, { type: 'application/json', body: JSON.stringify(body) });
}

async function openScope(
  context: Parameters<typeof FieldPhone.open>[0],
  lane: NetworkLane,
  { world: supplied, consent = 'Keep jobs on this phone' }: { world?: World; consent?: string } = {},
) {
  const world = supplied ?? await seedCompany();
  const phone = await FieldPhone.open(context, lane);
  const person = await phone.signIn(world, world.owner);
  await phone.call('saveMe', person, { companyId: world.companyId, actorId: 'actor', role: 'estimator', capabilities, authTime: Date.now() });
  serve(lane, '/api/me', {
    company: { id: world.companyId, name: 'Field Test' }, actor: { id: 'actor', displayName: null }, role: 'estimator',
    capabilities, fieldAccessExpiresAt: inDays(7).toISOString(),
  });
  const jobId = randomUUID();
  serve(lane, `/api/jobs/${jobId}`, {
    job: {
      id: jobId, status: 'draft', currentDraftId: world.draftId, fieldOwnerActorId: 'actor',
      propertyAddress: 'Item list test job', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    customer: { name: '', phone: '', email: '' },
    claim: { carrier: '', claimNumber: '', policyNumber: '', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' },
  });
  serve(lane, `/api/jobs/${jobId}/scope-lists`, { version: 1, roomTypes: [], items: [], prepTasks: [] });
  await firestoreJobProjectionStore(adminDb()).projectJob(world.companyId, jobId, { currentDraftId: world.draftId, revision: 1 });
  const { page } = phone;
  await page.goto(`${lane.appUrl}/field?job=${jobId}`);
  if (!(await page.evaluate((key) => localStorage.getItem(key), keepKey(world.tenantId)))) {
    await page.getByRole('button', { name: consent }).click();
  }
  await expect(page.getByLabel('Year built')).toBeEditable();
  return { page, person, companyId: world.companyId };
}

function publication(publishedAt: string, name: string) {
  return { current: {
    versionId: randomUUID(), publishedAt,
    items: [{ itemId: 'extraction', name, unit: 'sf' }],
    roomTypes: [{ id: 'utility', name: 'Utility room', suggestedItemIds: ['extraction'] }],
  } };
}

async function openList(page: Page, date: string) {
  const summary = page.locator('summary').filter({ hasText: `Item list as of ${date}` });
  await summary.click();
  return page.getByRole('region', { name: 'Published item list' });
}

test('Check Scope reopens the dated reference offline and identifies an older copy when it refreshes', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Water extraction');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByLabel('Year built')).toBeEditable();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  lane.cut();
  await page.reload();
  const panel = await openList(page, 'Nov 10, 2026');
  await expect(panel.getByRole('list', { name: 'Items' })).toContainText('Water extraction (sq ft)');
  await expect(panel.getByRole('list', { name: 'Room types' })).toContainText('Utility room');
  await expect(panel.getByRole('list', { name: 'Room types' })).toContainText('Water extraction');
  await expect(panel.locator('input, select, button')).toHaveCount(0);
  expect(lane.bytesSinceCut('app')).toBe(0);

  const second = publication('2026-11-12T12:00:00Z', 'Updated extraction');
  serve(lane, ITEM_LIST, second);
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(panel.getByRole('status')).toContainText('The older copy was updated.');
  await expect(panel.getByText('Item list as of Nov 12, 2026', { exact: true })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('Updated extraction (sq ft)');
  await expectSaved(scope, second.current.versionId);

  lane.cut();
  await page.reload();
  const updated = await openList(page, 'Nov 12, 2026');
  await expect(updated.getByRole('list', { name: 'Items' })).toHaveText('Updated extraction (sq ft)');
  expect(lane.bytesSinceCut('app')).toBe(0);
});

test('Check Scope says Prices not set before a company publishes', async ({ context, lane }) => {
  serve(lane, ITEM_LIST, { current: null });
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expect(page.getByText('Prices not set', { exact: true })).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
  await expectSaved(scope, 'none');
  await page.evaluate(() => navigator.serviceWorker.ready);
  lane.cut();
  await page.reload();
  await expect(page.getByText('Prices not set', { exact: true })).toBeVisible();
  expect(lane.bytesSinceCut('app')).toBe(0);
});

const storedKeys = (page: Page) => page.evaluate(() => new Promise<IDBValidKey[]>((resolve, reject) => {
  const open = indexedDB.open('ds-prices');
  open.onupgradeneeded = () => open.transaction?.abort();
  open.onerror = () => open.error?.name === 'AbortError' ? resolve([]) : reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const transaction = db.transaction('item-lists', 'readonly');
    const keys = transaction.objectStore('item-lists').getAllKeys();
    transaction.oncomplete = () => {
      db.close();
      resolve(keys.result);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  };
}));

type Scope = Awaited<ReturnType<typeof openScope>>;
const keyOf = ({ person, companyId }: Scope, version: string) => [person.tenantId, person.uid, companyId, version];
const expectSaved = (scope: Scope, version: string) =>
  expect.poll(() => storedKeys(scope.page)).toContainEqual(keyOf(scope, version));

test('opening the Check Scope tab refreshes the publication and uses the local publication date', async ({ context, lane }) => {
  const first = publication('2026-11-11T02:00:00Z', 'First item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await expectSaved(scope, first.current.versionId);
  await page.getByRole('link', { name: 'Photos', exact: true }).click();

  const second = publication('2026-11-12T12:00:00Z', 'Updated item');
  serve(lane, ITEM_LIST, second);
  await page.getByRole('link', { name: 'Check Scope', exact: true }).click();
  const panel = await openList(page, 'Nov 12, 2026');
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('Updated item (sq ft)');
  await expectSaved(scope, second.current.versionId);
});

test('the newest answer and save warning stay visible through a storage failure and a signal loss', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Saved item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expectSaved(scope, first.current.versionId);
  // Reject this application's cache writes while leaving its reads and the app's other stores alone.
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      if (this.name === 'ds-prices' && mode === 'readwrite') throw new DOMException('Storage is full', 'QuotaExceededError');
      return transaction.call(this, names, mode, options);
    };
    window.addEventListener('allow-item-list-write', () => { IDBDatabase.prototype.transaction = transaction; }, { once: true });
  });
  const second = publication('2026-11-12T12:00:00Z', 'New online item');
  serve(lane, ITEM_LIST, second);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  const panel = await openList(page, 'Nov 12, 2026');
  const warning = panel.getByText('This item list could not be saved on this phone.', { exact: true });
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('New online item (sq ft)');
  await expect(warning).toBeVisible();
  expect(await storedKeys(page)).toEqual([keyOf(scope, first.current.versionId)]);

  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('New online item (sq ft)');
  await expect(warning).toBeVisible();

  lane.restore();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('allow-item-list-write'));
    window.dispatchEvent(new Event('online'));
  });
  await expectSaved(scope, second.current.versionId);
  await expect(warning).toHaveCount(0);
});

test('a confirmed refusal erases the scoped list before it can reopen offline', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Formerly visible item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);
  lane.serve(ITEM_LIST, { type: 'application/json', body: '{"error":"not_allowed"}', status: 403 });
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText('The item list could not be read. Try opening Check Scope again.')).toBeVisible();
  await expect.poll(() => storedKeys(page)).not.toContainEqual(keyOf(scope, first.current.versionId));

  lane.cut();
  await page.reload();
  await expect(page.getByText('Connect to get the published item list.', { exact: true })).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
});

test('Online only opens the reference with signal and leaves no saved item list', async ({ context, lane }) => {
  const current = publication('2026-11-10T12:00:00Z', 'Online reference item');
  serve(lane, ITEM_LIST, current);
  const { page } = await openScope(context, lane, { consent: 'Online only' });
  const panel = await openList(page, 'Nov 10, 2026');
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('Online reference item (sq ft)');
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  expect(await storedKeys(page)).toEqual([]);
});

test('sign-out clears only that company and person’s item list', async ({ context, lane }) => {
  const firstList = publication('2026-11-10T12:00:00Z', 'First item');
  serve(lane, ITEM_LIST, firstList);
  const company = await seedCompany({ people: ['first', 'second'] });
  const first = await openScope(context, lane, { world: company });
  await expect(first.page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await expectSaved(first, firstList.current.versionId);
  await first.page.close();

  const secondList = publication('2026-11-12T12:00:00Z', 'Second item');
  serve(lane, ITEM_LIST, secondList);
  const second = await openScope(context, lane);
  await expect(second.page.getByText('Item list as of Nov 12, 2026', { exact: true })).toBeVisible();
  await expectSaved(second, secondList.current.versionId);
  await second.page.close();

  // A second estimator in the first tenant owns their own field draft.
  const draftId = randomUUID();
  const draftPath = `companies/${company.companyId}/drafts/${draftId}`;
  const owner = company.people.second!;
  await adminDb().doc(draftPath).set({ fieldOwnerUid: owner.uid, state: 'editing', field: { airMovers: 0 } });
  serve(lane, ITEM_LIST, firstList);
  const sameTenant = await openScope(context, lane, { world: { ...company, owner, draftId, draftPath } });
  await expectSaved(sameTenant, firstList.current.versionId);
  const firstKey = keyOf(first, firstList.current.versionId);
  const secondKey = keyOf(second, secondList.current.versionId);
  const sameTenantKey = keyOf(sameTenant, firstList.current.versionId);
  expect(await storedKeys(sameTenant.page)).toEqual(expect.arrayContaining([firstKey, secondKey, sameTenantKey]));

  const entry = await FieldPhone.open(context, lane);
  await entry.call('signOutKeep', second.person);
  expect(await storedKeys(entry.page)).toEqual(expect.arrayContaining([firstKey, sameTenantKey]));
  expect(await storedKeys(entry.page)).not.toContainEqual(secondKey);
  await entry.call('signOutKeep', sameTenant.person);
  expect(await storedKeys(entry.page)).toEqual([firstKey]);
});

// GET /api/me from now on: the person is let in with `granted`.
function serveAccess(lane: NetworkLane, companyId: string, granted: string[]) {
  serve(lane, '/api/me', {
    company: { id: companyId, name: 'Field Test' }, actor: { id: 'actor', displayName: null }, role: 'estimator',
    capabilities: granted, fieldAccessExpiresAt: inDays(7).toISOString(),
  });
}

// The page's writes to these app databases fail, as on a full phone, until the page reloads (or
// 'allow-writes' is dispatched); reads and the app's other databases work.
const refuseWrites = (page: Page, names: string[]) => page.evaluate((refused) => {
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    if (refused.includes(this.name) && mode === 'readwrite') throw new DOMException('Storage is full', 'QuotaExceededError');
    return transaction.call(this, stores, mode, options);
  };
  window.addEventListener('allow-writes', () => { IDBDatabase.prototype.transaction = transaction; }, { once: true });
}, names);

const databaseNames = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));

// Waits until the item-list work this person's pages have queued (erases, saves) is over.
const itemListWorkDone = (page: Page, { tenantId, uid }: { tenantId: string; uid: string }) =>
  page.evaluate((lock) => navigator.locks.request(lock, () => undefined), JSON.stringify(['ds-prices', tenantId, uid]));

const UNREADABLE = 'The item list could not be read. Try opening Check Scope again.';

test('losing price-list access erases the saved list when neither the erase nor the permissions can be written until a reload', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Withdrawn item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Published item list' })).toHaveCount(0);

  await refuseWrites(page, ['ds-prices', 'ds-me']);
  serveAccess(lane, scope.companyId, ['scope']);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('link', { name: 'Check Scope', exact: true }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
  await expect(page.getByRole('region', { name: 'Published item list' })).toHaveCount(0);
  await itemListWorkDone(page, scope.person);
  expect(await storedKeys(page)).toContainEqual(keyOf(scope, first.current.versionId));

  // Storage works again after the reload; the saved sign-in still offers the list.
  lane.cut();
  await page.reload();
  await expect(page.getByText('Connect to get the published item list.', { exact: true })).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
  expect(await storedKeys(page)).not.toContainEqual(keyOf(scope, first.current.versionId));
});

test('a refusal whose erase and permissions write both fail still keeps the list from an offline reload', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Refused item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);

  await refuseWrites(page, ['ds-prices', 'ds-me']);
  lane.serve(ITEM_LIST, { type: 'application/json', body: '{"error":"not_allowed"}', status: 403 });
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText(UNREADABLE)).toBeVisible();
  await itemListWorkDone(page, scope.person);
  expect(await storedKeys(page)).toContainEqual(keyOf(scope, first.current.versionId));

  lane.cut();
  await page.reload();
  await expect(page.getByText('Connect to get the published item list.', { exact: true })).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
  expect(await storedKeys(page)).not.toContainEqual(keyOf(scope, first.current.versionId));
});

test('access given back after a refusal saves the same version again, and the older refusal does not take it away', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Returned item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);

  await refuseWrites(page, ['ds-prices']);
  lane.serve(ITEM_LIST, { type: 'application/json', body: '{"error":"not_allowed"}', status: 403 });
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText(UNREADABLE)).toBeVisible();
  await itemListWorkDone(page, scope.person);

  serve(lane, ITEM_LIST, first);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('allow-writes'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await itemListWorkDone(page, scope.person);

  lane.cut();
  await page.reload();
  const panel = await openList(page, 'Nov 10, 2026');
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('Returned item (sq ft)');
  expect(await storedKeys(page)).toContainEqual(keyOf(scope, first.current.versionId));
});

test('a sign-out that cannot open the saved lists leaves their erase owed until the next read', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Signed-out item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  await expectSaved(scope, first.current.versionId);
  await scope.page.close();

  const entry = await FieldPhone.open(context, lane);
  await entry.page.evaluate(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (name === 'ds-prices') throw new DOMException('The storage policy refused it', 'SecurityError');
      return open.call(this, name, version);
    };
  });
  await entry.call('signOutKeep', scope.person);

  const later = await FieldPhone.open(context, lane);
  expect(await storedKeys(later.page)).toContainEqual(keyOf(scope, first.current.versionId));
  expect(await later.call('savedItemList', scope.person, scope.companyId)).toBeNull();
  expect(await storedKeys(later.page)).not.toContainEqual(keyOf(scope, first.current.versionId));
});

test('a refusal that only asks to sign in again hides the list and keeps the copy', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Kept item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await expectSaved(scope, first.current.versionId);

  lane.serve(ITEM_LIST, { type: 'application/json', body: '{"error":"sign_in_again"}', status: 401 });
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText(UNREADABLE)).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
  await itemListWorkDone(page, scope.person);
  expect(await storedKeys(page)).toContainEqual(keyOf(scope, first.current.versionId));
});

test('a 403 page from the network, not the server, neither hides nor erases the list', async ({ context, lane }) => {
  const first = publication('2026-11-10T12:00:00Z', 'Portal item');
  serve(lane, ITEM_LIST, first);
  const scope = await openScope(context, lane);
  const { page } = scope;
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await expectSaved(scope, first.current.versionId);
  await page.evaluate(() => navigator.serviceWorker.ready);

  lane.serve(ITEM_LIST, { type: 'text/html', body: '<html><body>Sign in to this network</body></html>', status: 403 });
  const answered = page.waitForResponse((response) => response.url().endsWith(ITEM_LIST) && response.status() === 403);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await answered;
  await itemListWorkDone(page, scope.person);
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  expect(await storedKeys(page)).toContainEqual(keyOf(scope, first.current.versionId));

  lane.cut();
  await page.reload();
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
});

test('a refusal on an Online only phone leaves no item-list database behind', async ({ context, lane }) => {
  serve(lane, ITEM_LIST, publication('2026-11-10T12:00:00Z', 'Online item'));
  const scope = await openScope(context, lane, { consent: 'Online only' });
  const { page } = scope;
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();

  lane.serve(ITEM_LIST, { type: 'application/json', body: '{"error":"not_allowed"}', status: 403 });
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText(UNREADABLE)).toBeVisible();
  await itemListWorkDone(page, scope.person);
  expect(await databaseNames(page)).not.toContain('ds-prices');
});

test('discarding on a phone that never saved an item list leaves no item-list database behind', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await FieldPhone.open(context, lane);
  const person = await phone.signIn(world, world.owner);
  expect(await phone.call('signOutDiscard', person)).toBe('signed-out');
  expect(await databaseNames(phone.page)).not.toContain('ds-prices');
});
