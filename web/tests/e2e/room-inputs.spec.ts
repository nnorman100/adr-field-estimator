import { test as base, expect as baseExpect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { contentHash, ENGINE_VERSION, parseTable } from '../../src/engine/table';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, seedCompany, type Company, type Person } from './jobs/seed';
import { PASSWORD } from './sign-in/seed';

// Room inputs on Check Scope (S5a-10) in Chromium and WebKit at phone width, against the jobs
// server (tests/e2e/jobs/server.ts) as in jobs.spec.ts: room type, category, water class or mold
// condition and affected area, the items typed for a room from the job's price list, prep tasks
// from the company's templates or the estimator's own words, and the findings note. The browser
// writes the room to the field database itself, under the real rules (web/firestore.rules).

const test = base;
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const expect = baseExpect.configure({ timeout: 20_000 });

const TEMPLATE = 'Move the vanity contents to the garage.';

// The company's published prices: a flood cut and toe-kick removal typed per room, water extraction
// priced from the room's wet floor, and a Bathroom room type that suggests the flood cut and the
// extraction.
async function publishPrices(company: Company): Promise<void> {
  const db = adminSql();
  const table = parseTable({
    items: [
      { item_id: 'flood_cut', group: 'demolition', name: '4 ft flood cut', unit: 'lf', quantity_source: 'room:typed', unit_price: '3.00' },
      { item_id: 'toe_kick', group: 'demolition', name: 'Toe-kick removal', unit: 'lf', quantity_source: 'room:typed', unit_price: '4.00' },
      { item_id: 'extraction', group: 'treatment', name: 'Water extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' },
    ],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      room_types: [{ id: 'bathroom', name: 'Bathroom', suggested_items: ['flood_cut', 'extraction'] }],
    },
  });
  const [owner] = await db<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id} AND display_name = 'owner'`;
  await db`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${company.id}, 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner!.id}, ${`key-${randomUUID()}`})
  `;
}

const setTemplates = (company: Company, prepTasks: string[]) =>
  adminSql()`UPDATE companies SET profile_documents = ${JSON.stringify({ prep_tasks: prepTasks })}::text::jsonb WHERE id = ${company.id}`;

async function signIn(page: Page, company: Company, person: Person) {
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${company.name}` })).toBeVisible();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
  const keep = page.getByRole('button', { name: 'Keep jobs on this phone', exact: true });
  if (await keep.isVisible()) await keep.click();
}

async function startJob(page: Page, address: string) {
  await page.getByRole('main').getByRole('link', { name: 'New job' }).click();
  await page.getByLabel('Property address').fill(address);
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
  await expect(page.getByLabel('Year built')).toBeEditable();
}

async function addRoom(page: Page, name: string) {
  await page.getByLabel('New room name').fill(name);
  await page.getByRole('button', { name: 'Add room' }).click();
  await expect(page.getByRole('form', { name })).toBeVisible();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('an estimator types a room’s type, class, items, prep tasks and findings, and reads them back', async ({ page }) => {
  const company = await seedCompany('rooms', { owner: 'owner', estimator: 'estimator' });
  await publishPrices(company);
  await setTemplates(company, [TEMPLATE]);
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '14 Example Street, Testville, CA 90000');
  await addRoom(page, 'Bathroom');
  const bath = page.getByRole('form', { name: 'Bathroom' });

  // Other is preselected; the job's price list offers Bathroom, which suggests the flood cut to type
  // and the extraction priced from the room's measurements, shown before any quantity is typed.
  await expect(bath.getByLabel('Room type')).toHaveValue('');
  await expect(bath.getByLabel('Room type').locator('option:checked')).toHaveText('Other');
  await bath.getByLabel('Room type').selectOption({ label: 'Bathroom' });
  await expect(bath.getByRole('list', { name: 'Priced from this room’s measurements' }).getByRole('listitem')).toHaveText(['Water extraction']);
  await expect(bath.getByRole('button', { name: 'Add Water extraction' })).toHaveCount(0);
  await bath.getByRole('button', { name: 'Add 4 ft flood cut' }).click();
  await bath.getByLabel('4 ft flood cut (linear ft)').fill('4');
  await bath.getByLabel('Another item').selectOption({ label: 'Toe-kick removal' });
  await bath.getByRole('button', { name: 'Add item' }).click();
  await bath.getByLabel('Toe-kick removal (linear ft)').fill('2.5');

  await bath.getByLabel('Water category or mold').selectOption('2');
  await bath.getByLabel(/^Class 2:/).check();
  await bath.getByLabel('Ceiling height (ft)').fill('8');
  await bath.getByLabel('Floor area (sq ft)', { exact: true }).fill('60');
  await bath.getByLabel('Wet floor area (sq ft)').fill('40');

  // A template's words, picked from the company list, and the estimator's own.
  await bath.getByLabel('From the company list').selectOption({ label: TEMPLATE });
  await bath.getByRole('button', { name: 'Add task' }).click();
  await bath.getByLabel('Your own prep task').fill('Tape off the hallway.');
  await bath.getByRole('button', { name: 'Add own task' }).click();
  await bath.getByLabel('Findings in this room').fill('Wet drywall to 30 inches behind the toilet.');
  await bath.getByRole('button', { name: 'Save room' }).click();
  await expect(bath.getByRole('status')).toHaveText('Room saved.');

  // The equipment the room suggests, which the technician confirms by entering the counts.
  await expect(page.getByLabel('Suggested equipment')).toContainText('air movers');
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // A mold room asks for the mold condition and the affected area instead of a water class.
  await addRoom(page, 'Attic');
  const attic = page.getByRole('form', { name: 'Attic' });
  await attic.getByLabel('Water category or mold').selectOption('mold');
  await expect(attic.getByText('Water class')).toHaveCount(0);
  await attic.getByLabel(/^Condition 3:/).check();
  await attic.getByLabel('Affected area (sq ft)').fill('45');
  await attic.getByRole('button', { name: 'Save room' }).click();
  await expect(attic.getByRole('status')).toHaveText('Room saved.');
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // The owner edits the template afterwards: the room keeps the words it was given.
  await setTemplates(company, ['Empty the vanity into boxes.']);
  await page.reload();
  const again = page.getByRole('form', { name: 'Bathroom' });
  await expect(again.getByLabel('Room type')).toHaveValue('bathroom');
  await expect(again.getByLabel('4 ft flood cut (linear ft)')).toHaveValue('4');
  await expect(again.getByLabel('Toe-kick removal (linear ft)')).toHaveValue('2.5');
  await expect(again.getByLabel(/^Class 2:/)).toBeChecked();
  await expect(again.getByRole('list', { name: 'Prep tasks' }).getByRole('listitem')).toHaveText([TEMPLATE, 'Tape off the hallway.'].map((task) => new RegExp(task.replace('.', '\\.'))));
  await expect(again.getByLabel('From the company list').locator('option')).toHaveText(['Choose a prep task', 'Empty the vanity into boxes.']);
  await expect(again.getByLabel('Findings in this room')).toHaveValue('Wet drywall to 30 inches behind the toilet.');
  const attic2 = page.getByRole('form', { name: 'Attic' });
  await expect(attic2.getByLabel('Water category or mold')).toHaveValue('mold');
  await expect(attic2.getByLabel(/^Condition 3:/)).toBeChecked();
  await expect(attic2.getByLabel('Affected area (sq ft)')).toHaveValue('45');

  // Removing an item and saving takes it out of the room.
  await again.getByRole('button', { name: 'Remove Toe-kick removal' }).click();
  await again.getByRole('button', { name: 'Save room' }).click();
  await expect(again.getByRole('status')).toHaveText('Room saved.');
  await page.reload();
  await expect(page.getByRole('form', { name: 'Bathroom' }).getByLabel('Toe-kick removal (linear ft)')).toHaveCount(0);
});

test('a quantity that is missing or out of range is not saved', async ({ page }) => {
  const company = await seedCompany('rooms-bad', { owner: 'owner', estimator: 'estimator' });
  await publishPrices(company);
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '15 Example Street, Testville, CA 90000');
  await addRoom(page, 'Hall');
  const hall = page.getByRole('form', { name: 'Hall' });
  await hall.getByLabel('Another item').selectOption({ label: '4 ft flood cut' });
  await hall.getByRole('button', { name: 'Add item' }).click();
  await hall.getByRole('button', { name: 'Save room' }).click();
  await expect(hall.getByText('Enter a quantity, or remove the item.')).toBeVisible();
  await expect(hall.getByLabel('4 ft flood cut (linear ft)')).toHaveAttribute('aria-invalid', 'true');
  await hall.getByLabel('4 ft flood cut (linear ft)').fill('4.125');
  await hall.getByRole('button', { name: 'Save room' }).click();
  await expect(hall.getByText('Enter 0 to 100,000, with at most two decimal places.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('form', { name: 'Hall' }).getByLabel('4 ft flood cut (linear ft)')).toHaveCount(0);
});
