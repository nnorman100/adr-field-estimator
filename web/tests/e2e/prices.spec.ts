import { test as base, expect as baseExpect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { updateFixture } from '../../src/lib/sign-in/local-directory';
import { expectNoAxeViolations } from './a11y';
import { idTokenFor } from './sign-in/emulator';
import { FIXTURE_PATH, PASSWORD, readSeed, type PricesSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';

// The Prices screens (S4-8) in Chromium and WebKit at phone width. They sign in to the Auth
// emulator's tenants; the server checks each sign-in, the company's price_books switch and each
// prices call as it does in production, and only the price tables are a local file
// (src/lib/prices/local-prices.ts). Each browser project has a company of its own with the switch
// on (sign-in/global-setup.ts); every test first puts that company's prices in a known state, so
// the order of the tests does not matter. The team company has the switch off.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
// The tests of one browser share its company's prices, so they run one after another.
test.describe.configure({ mode: 'serial' });
const expect = baseExpect.configure({ timeout: 20_000 });

let company: PricesSeed;
let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  const seed = readSeed();
  company = seed.prices[testInfo.project.name]!;
  team = seed.teams[testInfo.project.name]!;
});

type Json = Record<string, unknown>;

async function call(request: APIRequestContext, who: TeamAccount, method: 'GET' | 'PUT' | 'POST', path: string, data?: unknown) {
  const token = await idTokenFor(company.tenantId, who.email, PASSWORD);
  const response = await request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, data });
  return { status: response.status(), body: (await response.json().catch(() => null)) as Json };
}

// The company back to no saved working copy and no version, as a new company starts.
async function resetPrices() {
  updateFixture(FIXTURE_PATH, (data) => {
    const found = data.companies.find((candidate) => candidate.id === company.companyId)!;
    delete found.prices;
  });
}

// Saves a working copy with two items on and priced (drywall removal and water extraction), every
// other item off, as the owner would on another device; returns the saved revision.
async function savePriced(request: APIRequestContext, drywall = '4.00') {
  const read = await call(request, company.owner, 'GET', '/api/prices');
  expect(read.status).toBe(200);
  const working = read.body.workingCopy as { revision: number; table: { items: Json[] } & Json };
  const items = working.table.items.map((item) =>
    item.item_id === 'demo_drywall'
      ? { ...item, unit_price: drywall }
      : item.item_id === 'water_extraction'
        ? { ...item, unit_price: '1.25' }
        : { ...item, enabled: false },
  );
  const saved = await call(request, company.owner, 'PUT', '/api/prices/working-copy', {
    expectedRevision: working.revision,
    table: { ...working.table, items },
  });
  expect(saved.status).toBe(200);
  return saved.body.revision as number;
}

async function publishFirst(request: APIRequestContext) {
  const revision = await savePriced(request);
  const published = await call(request, company.owner, 'POST', '/api/prices/publish', {
    expectedRevision: revision,
    reason: 'First prices',
    publishKey: `e2e-${randomUUID()}`,
    rangeChoice: 'range',
  });
  expect(published.status).toBe(201);
}

async function signInTo(page: Page, address: string, companyName: string, who: TeamAccount) {
  await page.goto(`/sign-in/${address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${companyName}` })).toBeVisible();
}

async function openPricesAsOwner(page: Page) {
  await signInTo(page, company.address, company.companyName, company.owner);
  await page.getByRole('link', { name: 'Company settings' }).click();
  await page.getByRole('link', { name: 'Prices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prices', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

// The drywall item's card: closed to one line until opened.
const drywall = (page: Page) => page.getByRole('listitem').filter({ has: page.getByText('Drywall removal', { exact: true }) }).first();

test('with the price_books switch off the page shows nothing about prices', async ({ page, request }) => {
  await signInTo(page, team.address, team.companyName, team.owner);
  await page.getByRole('link', { name: 'Company settings' }).click();
  await expect(page.getByRole('heading', { name: 'Company settings' })).toBeVisible();
  await expect(page.getByLabel('Company address')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Prices', exact: true })).toHaveCount(0);

  await page.goto(`/sign-in/${team.address}/prices`);
  await expect(page.getByRole('heading', { name: 'Prices are not available' })).toBeVisible();
  await expect(page.getByLabel(/price/i)).toHaveCount(0);
  await expectNoAxeViolations(page);
  // The server refuses the route itself for that company, before any role check.
  const token = await idTokenFor(team.tenantId, team.owner.email, PASSWORD);
  const answer = await request.get('/api/prices', { headers: { Authorization: `Bearer ${token}` } });
  expect(answer.status()).toBe(404);
});

test('the owner sets one price, then a price per water category, and sees what a room pays', async ({ page }) => {
  await resetPrices();
  await openPricesAsOwner(page);
  await expect(page.getByText('No prices are published yet')).toBeVisible();
  await expect(drywall(page)).toContainText('Price not set');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('4.00');
  await expect(drywall(page).getByLabel('Category 3 price (per sq ft)')).toHaveCount(0);
  await drywall(page).getByLabel('Price varies by water category').check();
  // One price per category the item is used in (Category 1, 2 and 3), each used as set.
  await expect(drywall(page).getByLabel('Default price (per sq ft)')).toHaveValue('4.00');
  await drywall(page).getByLabel('Category 1 price (per sq ft)').fill('4.00');
  await drywall(page).getByLabel('Category 2 price (per sq ft)').fill('5.00');
  await drywall(page).getByLabel('Category 3 price (per sq ft)').fill('6.50');
  await expect(drywall(page).getByText('This category price replaces the multiplier.').first()).toBeVisible();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved. The prices are not published until you publish them.')).toBeVisible();

  const pays = page.getByRole('region', { name: 'What does this room pay?' });
  await pays.getByLabel('Category 3').check();
  const line = pays.getByRole('listitem').filter({ hasText: 'Drywall removal' });
  await expect(line).toContainText('$6.50 per sq ft');
  await expect(line).toContainText('The Cat 3 price, used as set.');
  await pays.getByLabel('Category 2').check();
  await expect(line).toContainText('$5.00 per sq ft');

  // What the server holds is what a reload shows.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
  await expect(drywall(page)).toContainText('$4.00 per sq ft');
  await expect(drywall(page)).toContainText('varies by water category');
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await expect(drywall(page).getByLabel('Category 3 price (per sq ft)')).toHaveValue('6.50');

  // Turned off again, the item has one price, and Category 3 pays it times the multiplier.
  await drywall(page).getByLabel('Price varies by water category').uncheck();
  await expect(drywall(page).getByLabel('Category 3 price (per sq ft)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
  await pays.getByLabel('Category 3').check();
  await expect(line).toContainText('$4.00 per sq ft');
  await expect(line).toContainText('The default price.');
});

test('a price the table refuses is not saved, and the server says which item', async ({ page }) => {
  await resetPrices();
  await openPricesAsOwner(page);
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('4.005');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Something in the prices cannot be saved\. Drywall removal: must have at most 2 decimal places/)).toBeVisible();
  await expect(page.getByText('You have changes that are not saved.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('the owner previews, publishes with a reason and the range choice, and copies a version back', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);

  await page.getByRole('button', { name: 'Price the sample jobs' }).click();
  const preview = page.getByRole('region', { name: 'Preview on sample jobs' });
  await expect(preview.getByText('These prices can be published.')).toBeVisible();
  await expect(preview.getByText('Kitchen, Category 1')).toBeVisible();

  await page.getByRole('button', { name: 'Check the prices before publishing' }).click();
  const publish = page.getByRole('region', { name: 'Publish', exact: true });
  await publish.getByLabel('A price range (low to high)').check();
  await publish.getByLabel('What changed (kept with the version)').fill('First prices');
  await expectNoAxeViolations(page);
  await publish.getByRole('button', { name: 'Publish these prices' }).click();
  await expect(publish.getByText('Published as version 1.', { exact: false })).toBeVisible();
  await expect(page.getByText(/Estimates use version 1, published/)).toBeVisible();

  // A saved change, then version 1 copied back over it.
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('9.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
  const versions = page.getByRole('region', { name: 'Published versions' });
  await versions.getByRole('button', { name: 'Show the published versions' }).click();
  await expect(versions.getByText('First prices')).toBeVisible();
  await versions.getByRole('button', { name: 'Copy version 1 into the working copy' }).click();
  await versions.getByRole('button', { name: 'Restore version 1' }).click();
  await expect(versions.getByText('Version 1 is now the working copy.', { exact: false })).toBeVisible();
  await expect(drywall(page).getByLabel('Price (per sq ft)', { exact: true })).toHaveValue('4.00');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
});

test('a save after the prices changed on another device is refused, then the saved prices reload', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);
  await savePriced(request, '7.00');

  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('8.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/changed on another device/)).toBeVisible();
  await page.getByRole('button', { name: 'Reload the saved prices' }).click();
  await expect(drywall(page).getByLabel('Price (per sq ft)', { exact: true })).toHaveValue('7.00');
});

test('the owner downloads the price list and loads a changed one back', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);
  const files = page.getByRole('region', { name: 'Price-list file' });
  const download = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Download the price list' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  const lines = csv.split(/\r?\n/);
  const at = lines.findIndex((text) => text.startsWith('demo_drywall,'));
  expect(lines[at]).toMatch(/,4\.00$/);
  lines[at] = lines[at]!.replace(/,4\.00$/, ',4.25');
  await files.getByLabel('Load a price-list file').setInputFiles({
    name: 'price-list.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(lines.join('\n')),
  });
  await expect(files.getByText('The file changed 1 price in the working copy.')).toBeVisible();
  await expect(drywall(page)).toContainText('$4.25 per sq ft');
});

test('every field is locked while a save is out, so nothing typed meanwhile is lost', async ({ page }) => {
  await resetPrices();
  await openPricesAsOwner(page);
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  const price = drywall(page).getByLabel('Price (per sq ft)', { exact: true });
  await price.fill('4.00');
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/prices/working-copy', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
  await expect(price).toBeDisabled();
  await expect(page.getByLabel('Small: up to (sq ft)')).toBeDisabled();
  release();
  await expect(page.getByText('Saved. The prices are not published until you publish them.')).toBeVisible();
  await expect(price).toBeEnabled();
  await expect(price).toHaveValue('4.00');
});

test('a whole-number field holding something else is neither saved nor published', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);
  const small = page.getByLabel('Small: up to (sq ft)');
  const before = await small.inputValue();
  const save = page.getByRole('button', { name: 'Save changes' });
  const publish = page.getByRole('region', { name: 'Publish', exact: true });

  await small.fill('3.5');
  await expect(page.getByText(/holds something else\. Correct it before you save or publish\./)).toBeVisible();
  await expect(publish.getByText('Save your changes before you publish.')).toBeVisible();
  await expect(save).toBeDisabled();
  // Another change does not carry the old number to the server in its place.
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('5.00');
  await expect(save).toBeDisabled();

  // Undo puts back what is saved, on screen too.
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(small).toHaveValue(before);
  await expect(page.getByText('All changes are saved.')).toBeVisible();

  await small.fill('100');
  await save.click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Small: up to (sq ft)')).toHaveValue('100');
});

test('the previews wait while a whole-number field holds something else', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);
  const preview = page.getByRole('region', { name: 'Preview on sample jobs' });
  const run = preview.getByRole('button', { name: 'Price the sample jobs' });
  await run.click();
  await expect(preview.getByText('These prices can be published.')).toBeVisible();
  const pays = page.getByRole('region', { name: 'What does this room pay?' });
  const line = pays.getByRole('listitem').filter({ hasText: 'Drywall removal' });
  await expect(line).toContainText('$4.00 per sq ft');

  const small = page.getByLabel('Small: up to (sq ft)');
  const before = await small.inputValue();
  await small.fill('3.5');
  await expect(preview.getByText('These prices can be published.')).toHaveCount(0);
  await expect(run).toBeDisabled();
  await expect(line).toHaveCount(0);
  await expect(pays.getByText(/to see what this room pays\./)).toBeVisible();

  await small.fill(before);
  await expect(run).toBeEnabled();
  await expect(line).toContainText('$4.00 per sq ft');
  await expect(preview.getByText('These prices can be published.')).toBeVisible();
});

test('a check or a preview of earlier prices is not shown once the prices change', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request, '');
  await openPricesAsOwner(page);
  const publish = page.getByRole('region', { name: 'Publish', exact: true });
  await publish.getByRole('button', { name: 'Check the prices before publishing' }).click();
  await expect(publish.getByText(/^Not ready to publish/)).toBeVisible();
  await page.getByRole('button', { name: 'Price the sample jobs' }).click();
  const preview = page.getByRole('region', { name: 'Preview on sample jobs' });
  await expect(preview.getByText(/^Not ready to publish/)).toBeVisible();

  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  await drywall(page).getByLabel('Price (per sq ft)', { exact: true }).fill('4.00');
  await expect(preview.getByText(/^Not ready to publish/)).toHaveCount(0);
  await expect(preview.getByText('Kitchen, Category 1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();

  // The saved prices are checked afresh, and now they can be published.
  await publish.getByRole('button', { name: 'Check the prices before publishing' }).click();
  await expect(publish.getByRole('button', { name: 'Publish these prices' })).toBeVisible();
  await expect(publish.getByText(/^Not ready to publish/)).toHaveCount(0);
});

test('a publish whose answer was lost is retried with its key, and another publish gets a new one', async ({ page, request }) => {
  await resetPrices();
  await savePriced(request);
  await openPricesAsOwner(page);
  const keys: string[] = [];
  await page.route('**/api/prices/publish', async (route) => {
    keys.push((route.request().postDataJSON() as { publishKey: string }).publishKey);
    if (keys.length > 2) return route.continue();
    // The server publishes; its answer never reaches the phone.
    await route.fetch();
    await route.abort();
  });
  const publish = page.getByRole('region', { name: 'Publish', exact: true });
  const send = publish.getByRole('button', { name: 'Publish these prices' });
  await publish.getByRole('button', { name: 'Check the prices before publishing' }).click();
  await publish.getByLabel('A price range (low to high)').check();
  await publish.getByLabel('What changed (kept with the version)').fill('First prices');
  await send.click();
  await expect(publish.getByText(/could not reach DryScope/)).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(send).toBeEnabled();

  // The version did publish, so this screen's save is stale; reloaded, changed and saved, the new
  // prices publish as a new version under the same reason.
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  const price = drywall(page).getByLabel('Price (per sq ft)', { exact: true });
  await price.fill('9.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/changed on another device/)).toBeVisible();
  await page.getByRole('button', { name: 'Reload the saved prices' }).click();
  await expect(page.getByText(/Estimates use version 1, published/)).toBeVisible();
  await price.fill('9.00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
  await publish.getByRole('button', { name: 'Check the prices before publishing' }).click();
  await expect(publish.getByLabel('What changed (kept with the version)')).toHaveValue('First prices');
  await send.click();
  await expect(publish.getByText('Published as version 2.', { exact: false })).toBeVisible();
  expect(keys[2]).not.toBe(keys[0]);
});

test('a room type removed after it was chosen gives way to the first one listed', async ({ page, request }) => {
  await resetPrices();
  const read = await call(request, company.owner, 'GET', '/api/prices');
  const working = read.body.workingCopy as { revision: number; table: { items: Json[]; policy: Json } & Json };
  const items = working.table.items.map((item) =>
    item.item_id === 'demo_drywall' ? { ...item, unit_price: '4.00', rows: [{ room_type: 'bathroom', unit_price: '7.00' }] } : item,
  );
  const saved = await call(request, company.owner, 'PUT', '/api/prices/working-copy', {
    expectedRevision: working.revision,
    table: { ...working.table, items, policy: { ...working.table.policy, room_type_pricing: true } },
  });
  expect(saved.status).toBe(200);
  await openPricesAsOwner(page);

  const pays = page.getByRole('region', { name: 'What does this room pay?' });
  await pays.getByLabel('Category 3').check();
  await pays.getByLabel('Room type').selectOption('kitchen');
  const line = pays.getByRole('listitem').filter({ hasText: 'Drywall removal' });
  await expect(line).toContainText('$4.00 per sq ft');
  await drywall(page).getByText('Drywall removal', { exact: true }).click();
  const card = drywall(page);
  await card.getByLabel('Room type').selectOption('kitchen');
  await card.getByLabel('Category', { exact: true }).selectOption('2');

  const types = page.getByRole('region', { name: 'Room types' });
  await types.getByText(/^Kitchen · /).click();
  await types.getByRole('button', { name: 'Remove the Kitchen room type' }).click();
  await expect(pays.getByLabel('Room type')).toHaveValue('bathroom');
  await expect(line).toContainText('$7.00 per sq ft');
  await expect(line).toContainText('The Bathroom price, used as set.');
  await card.getByRole('button', { name: 'Add a room-type price' }).click();
  await expect(card.getByLabel('Bathroom, Cat 2 price (per sq ft)')).toBeVisible();

  // A category the item is no longer used in gives way to "Any category".
  await card.getByLabel('Category', { exact: true }).selectOption('1');
  await card.getByLabel('Category 1', { exact: true }).uncheck();
  await card.getByRole('button', { name: 'Add a room-type price' }).click();
  await expect(card.getByLabel('Bathroom, Cat 1 price (per sq ft)')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^Remove the .* price$/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
});

// Office users need the authenticator-app second step (D2, since 2026-11-14): one who has not set it
// up gets only the setup screen, and the server refuses the Prices routes until it is done.
test('an office user without the second step is refused on Prices', async ({ page, request }) => {
  await resetPrices();
  await publishFirst(request);
  const person = company.officeWithoutApp;
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up your second sign-in step' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Signed in to ${company.companyName}` })).toHaveCount(0);

  await page.goto(`/sign-in/${company.address}/prices`);
  await expect(page.getByRole('heading', { name: 'Prices', level: 1 })).toHaveCount(0);
  await expect(page.getByText('Drywall removal')).toHaveCount(0);

  const read = await call(request, person, 'GET', '/api/prices');
  expect(read.status).toBe(403);
  expect(read.body).toEqual({ error: 'second_step_required' });
  const save = await call(request, person, 'PUT', '/api/prices/working-copy', { expectedRevision: 1, table: {} });
  expect(save.status).toBe(403);
  expect(save.body).toEqual({ error: 'second_step_required' });
});

for (const role of ['estimator', 'office'] as const) {
  test(`the ${role} reads the published prices and changes nothing`, async ({ page, request }) => {
    await resetPrices();
    await publishFirst(request);
    // A later saved change the owner has not published stays the owner's.
    await savePriced(request, '9.99');
    await signInTo(page, company.address, company.companyName, company[role]);
    await page.goto(`/sign-in/${company.address}/prices`);
    await expect(page.getByRole('heading', { name: 'Prices', level: 1 })).toBeVisible();
    await expect(page.getByText(/Version 1, published .*Only the owner can change the prices\./)).toBeVisible();
    const list = page.getByRole('region', { name: 'Price list', exact: true });
    await expect(list.getByRole('listitem').filter({ hasText: 'Drywall removal' })).toContainText('$4.00 per sq ft');
    await expect(list.getByText('Antimicrobial application')).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Save|Publish|Restore/ })).toHaveCount(0);
    const pays = page.getByRole('region', { name: 'What does this room pay?' });
    await pays.getByLabel('Category 3').check();
    await expect(pays.getByRole('listitem').filter({ hasText: 'Drywall removal' })).toContainText('$4.00 per sq ft');
    await expectNoAxeViolations(page);
    await expectNoSideways(page);
    // The server refuses the owner's routes to this role.
    const save = await call(request, company[role], 'PUT', '/api/prices/working-copy', { expectedRevision: 1, table: {} });
    expect(save.status).toBe(403);
  });
}

test('the owner adds, edits and removes a named adjustment, and none is seeded', async ({ page, request }) => {
  await resetPrices();
  await openPricesAsOwner(page);
  const section = page.getByRole('region', { name: 'Named adjustments' });
  await expect(section.getByText('No adjustments yet.')).toBeVisible();

  await section.getByLabel('New adjustment').fill('Weekend start');
  await section.getByRole('button', { name: 'Add the adjustment' }).click();
  const card = section.getByRole('group', { name: 'Weekend start' });
  await card.getByLabel('Charge (raises the price)').check();
  await card.getByLabel('A fixed dollar amount').check();
  await card.getByRole('textbox', { name: 'Amount' }).fill('125');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved. The prices are not published until you publish them.')).toBeVisible();

  // What the server holds is what a reload shows.
  const saved = await call(request, company.owner, 'GET', '/api/prices');
  expect((saved.body.workingCopy as { table: Json }).table.adjustments).toEqual([
    { adjustment_id: 'weekend_start', name: 'Weekend start', kind: 'amount', direction: 'charge', value: '125' },
  ]);
  await page.reload();
  await expect(section.getByRole('group', { name: 'Weekend start' }).getByRole('textbox', { name: 'Amount' })).toHaveValue('125');

  await section.getByRole('button', { name: 'Remove the Weekend start adjustment' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved. The prices are not published until you publish them.')).toBeVisible();
  const removed = await call(request, company.owner, 'GET', '/api/prices');
  expect((removed.body.workingCopy as { table: Json }).table).not.toHaveProperty('adjustments');
});
