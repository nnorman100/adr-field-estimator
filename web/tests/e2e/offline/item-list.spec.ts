import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { firestoreJobProjectionStore } from '../../../src/lib/jobs/projection';
import { FieldPhone, inDays } from './field-phone';
import { expect, test } from './fixture';
import type { NetworkLane } from './lane';
import { adminDb, seedCompany } from './world';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

const ITEM_LIST = '/api/prices/item-list';
const capabilities = ['scope', 'prices_read'];

function serve(lane: NetworkLane, path: string, body: unknown) {
  lane.serve(path, { type: 'application/json', body: JSON.stringify(body) });
}

async function openScope(context: Parameters<typeof FieldPhone.open>[0], lane: NetworkLane) {
  const world = await seedCompany();
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
  await page.getByRole('button', { name: 'Keep jobs on this phone' }).click();
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
  serve(lane, ITEM_LIST, publication('2026-11-10T12:00:00Z', 'Water extraction'));
  const { page } = await openScope(context, lane);
  await expect(page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
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

  serve(lane, ITEM_LIST, publication('2026-11-12T12:00:00Z', 'Updated extraction'));
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(panel.getByRole('status')).toContainText('The older copy was updated.');
  await expect(panel.getByText('Item list as of Nov 12, 2026', { exact: true })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Items' })).toHaveText('Updated extraction (sq ft)');

  lane.cut();
  await page.reload();
  const updated = await openList(page, 'Nov 12, 2026');
  await expect(updated.getByRole('list', { name: 'Items' })).toHaveText('Updated extraction (sq ft)');
  expect(lane.bytesSinceCut('app')).toBe(0);
});

test('Check Scope says Prices not set before a company publishes', async ({ context, lane }) => {
  serve(lane, ITEM_LIST, { current: null });
  const { page } = await openScope(context, lane);
  await expect(page.getByText('Prices not set', { exact: true })).toBeVisible();
  await expect(page.getByText('Item list as of', { exact: false })).toHaveCount(0);
});

const storedKeys = (page: Page) => page.evaluate(() => new Promise<IDBValidKey[]>((resolve, reject) => {
  const open = indexedDB.open('ds-prices');
  open.onerror = () => reject(open.error);
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

test('sign-out clears only that company and person’s item list', async ({ context, lane }) => {
  const firstList = publication('2026-11-10T12:00:00Z', 'First item');
  serve(lane, ITEM_LIST, firstList);
  const first = await openScope(context, lane);
  await expect(first.page.getByText('Item list as of Nov 10, 2026', { exact: true })).toBeVisible();
  await first.page.close();

  const secondList = publication('2026-11-12T12:00:00Z', 'Second item');
  serve(lane, ITEM_LIST, secondList);
  const second = await openScope(context, lane);
  await expect(second.page.getByText('Item list as of Nov 12, 2026', { exact: true })).toBeVisible();
  const key = ({ person, companyId }: typeof first, id: string) => [person.tenantId, person.uid, companyId, id];
  const firstKey = key(first, firstList.current.versionId);
  const secondKey = key(second, secondList.current.versionId);
  expect(await storedKeys(second.page)).toEqual(expect.arrayContaining([firstKey, secondKey]));

  const entry = await FieldPhone.open(context, lane);
  await entry.call('signOutKeep', second.person);
  expect(await storedKeys(entry.page)).toEqual([firstKey]);
});
