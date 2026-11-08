// The owner's switch from a rate book to their own price table (dryscope-v2).
const { test, expect } = require('@playwright/test');
const { checkScope } = require('./actions');

const uid = (role) => 'test-owner-ws-' + role;

async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function navigate(page, id) {
  await expect(page.locator('#workspaceNav')).toBeVisible();
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator('#' + id).click();
}
// A published rate book, as ADR has in production.
async function publishRates(page) {
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await page.locator('input[name=emergency_call]').fill('200');
  await page.locator('textarea[name=change_reason]').fill('Raise the trip charge');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v1');
}
async function publishSwitch(page) {
  await page.getByRole('button', { name: 'Switch to v2' }).click();
  await expect(page.locator('#priceEditor')).toBeVisible();
  await page.locator('#priceReason').fill('Move to our own table');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, price_books: true, ai_features: [] },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner switches, reviews the differences and publishes; a new job gets the item list and an old draft keeps v1 until repriced', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await start(page, 'owner');
  // A draft priced before the switch.
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#estimateRange')).toHaveText('$1,775.00–$1,788.90');
  const oldRange = await page.locator('#estimateRange').textContent();
  await publishRates(page);

  // The card names the three differences before anything changes.
  const card = page.locator('#priceSwitch');
  await expect(card).toContainText('tapers above 1,000 square feet instead of stepping');
  await expect(card).toContainText('Labor hours carry 50% on the high end at every job size');
  await expect(card).toContainText('after-hours 20% now prints as its own line');
  await expect(card).toContainText('Signed documents never change');
  await expect(card).toContainText('connect their phones so open drafts sync before you publish');
  await page.getByRole('button', { name: 'Switch to v2' }).click();

  // The rates carried over and the working copy survives a reload; nothing is published yet.
  await expect(page.locator('input[name=price_emergency_call]')).toHaveValue('200.00');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v1');
  await expect(page.locator('#priceImportFile')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('input[name=price_emergency_call]')).toHaveValue('200.00');
  await expect(page.locator('#priceSwitch')).toHaveCount(0);

  // The review shows the differences and sample jobs on both calculations.
  await page.locator('#priceReason').fill('Move to our own table');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const review = page.locator('#priceReview');
  await expect(review).toContainText('What changes for the same job');
  await expect(review).toContainText('tapers above 1,000 square feet');
  await expect(review).toContainText('Before: ');
  await expect(review).toContainText('After: ');
  await expect(review).toContainText('Drafts already started keep their current prices');
  await expect(review).toContainText('connect their phones so open drafts sync before you publish');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v2');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await expect(page.locator('#priceSwitch')).toHaveCount(0);
  await expect(page.locator('input[name=price_emergency_call]')).toHaveValue('200.00');

  // A new job builds its screen from the table.
  await page.evaluate(() => openNew());
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v1Scope')).toBeHidden();
  await expect(page.locator('#v2Scope')).toContainText('$200.00 each');

  // The old draft is as it was until the owner moves it.
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#estimateRange')).toHaveText(oldRange);
  await checkScope(page);
  await expect(page.locator('#v1Scope')).toBeVisible();
  await expect(page.locator('#v2Scope')).toBeHidden();
  await expect(page.locator('#jobPricingStatus')).toContainText('Newer company prices');
  await page.getByRole('button', { name: 'Review new prices for this job' }).click();
  const actions = page.locator('#jobPricingActions');
  await expect(actions).toContainText('tapers above 1,000 square feet');
  await expect(actions).toContainText('Customer estimate');
  await expect(actions).toContainText('This applies Prices v2 to this draft only');
  await page.getByRole('button', { name: 'Apply these prices to this job only' }).click();
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v1Scope')).toBeHidden();
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await expect(page.locator('#documents')).toBeHidden();
  await expect(page.locator('#jobPricingStatus')).toContainText('priced from Prices v2');

  // Priced from the table, it finishes with the new summary.
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#proposalBody')).toContainText('Priced from Prices v2.');
  expect(errors).toEqual([]);
});

test('a draft saved but not yet priced before the switch stays on the v1 form', async ({
  page,
}) => {
  await start(page, 'owner');
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  const id = await page.evaluate(() => state.draft.inspection_id);
  await publishRates(page);
  await publishSwitch(page);
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v2');
  await page.evaluate((value) => restoreDraft(value), id);
  await checkScope(page);
  await expect(page.locator('#jobPricingStatus')).toContainText('Newer company prices');
  await expect(page.locator('#v1Scope')).toBeVisible();
  await expect(page.locator('#v2Scope')).toBeHidden();
});

test('a draft not yet priced before the switch stays on the v1 form offline', async ({
  page,
  context,
}) => {
  await start(page, 'owner');
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  const id = await page.evaluate(() => state.draft.inspection_id);
  // Left before the switch, so nothing has told this phone how the server rules on this draft.
  await page.evaluate(() => openNew());
  await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(id);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await publishRates(page);
  await publishSwitch(page);
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v2');
  await expect.poll(() => page.evaluate(() => state.session.pricing_version)).toBe('dryscope-v2');
  await context.setOffline(true);
  await page.evaluate((value) => restoreDraft(value), id);
  await checkScope(page);
  await expect(page.locator('#v1Scope')).toBeVisible();
  await expect(page.locator('#v2Scope')).toBeHidden();
  // A job started on this phone after the switch has no server record yet and shows the item list.
  await page.evaluate(() => openNew());
  await checkScope(page);
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v1Scope')).toBeHidden();
  await context.setOffline(false);
});

// A job started after the switch that has not reached the server: nothing seeded, still the item list.
const switched = async (page) => {
  await start(page, 'owner');
  await publishRates(page);
  await publishSwitch(page);
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v2');
  await expect.poll(() => page.evaluate(() => !!state.session.switched_at)).toBe(true);
};
const unsavedJob = async (page, context) => {
  await page.route('**/api/inspections**', (route) =>
    ['POST', 'PUT', 'PATCH'].includes(route.request().method()) ? route.abort() : route.continue(),
  );
  await page.evaluate(() => openNew().catch(() => {}));
  const id = await page.evaluate(() => state.draft.inspection_id);
  await context.setOffline(true);
  await page.evaluate((value) => restoreDraft(value), id);
  expect(await page.evaluate(() => [state.record, state.draft.data.seeded_from_version])).toEqual([
    null,
    undefined,
  ]);
  await checkScope(page);
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v1Scope')).toBeHidden();
  await expect(page.locator('#emergencyCalls')).toHaveValue('0');
  return page.locator('#v2ScopeStatus');
};

test('a job started after the switch stays on the item list across an offline reload, and started_at stays on the phone', async ({
  page,
  context,
}) => {
  await switched(page);
  await page.evaluate(() => openNew());
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  const saved = await page.evaluate(async () => {
    const id = state.draft.inspection_id,
      record = await jsonApi('/api/inspections/' + id);
    return { started: state.draft.started_at, record };
  });
  expect(Date.parse(saved.started)).not.toBeNaN();
  expect(saved.record.started_at).toBeUndefined();
  expect(saved.record.data.started_at).toBeUndefined();
  // Let the debounced local save finish, then drop the table copy: this job can seed from nothing.
  await page.evaluate(() => syncChain);
  await page.waitForTimeout(1500);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('adr-private-drafts-v2');
        open.onerror = reject;
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction(['drafts'], 'readwrite'),
            store = tx.objectStore('drafts'),
            all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result) if (row.key.startsWith('prices:')) store.delete(row.key);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
  );
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.evaluate(() => openNew());
  const id = await page.evaluate(() => state.draft.inspection_id);
  await checkScope(page);
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v2ScopeStatus')).toContainText('Connect once');
  await expect(page.locator('#emergencyCalls')).toHaveValue('0');
  await page.locator('#technicianNotes').fill('Started offline');
  await expect
    .poll(() =>
      page.evaluate(async (value) => {
        const rows = await localDrafts();
        return rows.find((r) => r.draft.inspection_id === value)?.draft.started_at;
      }, id),
    )
    .toBeTruthy();
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.evaluate((value) => restoreDraft(value), id);
  await checkScope(page);
  await expect(page.locator('#v2Scope')).toBeVisible();
  await expect(page.locator('#v1Scope')).toBeHidden();
  await context.setOffline(false);
});

test.describe('without a service worker', () => {
  // page.route cannot see a fetch that a controlling service worker handles, as in WebKit here.
  test.use({ serviceWorkers: 'block' });

  for (const [status, text] of [
    [401, "You don't have access to your company's price list"],
    [503, "Your company's price list could not load"],
  ])
    test(
      'a job started after the switch keeps the item list and the message when the table answers ' +
        status,
      async ({ page, context }) => {
        await switched(page);
        // Publishing starts a table load. Let it finish before forcing the next load to fail.
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                !!ScopeItems.table()?.version_id &&
                ScopeItems.table().version_id === state.session.pricing_table_version,
            ),
          )
          .toBe(true);
        await page.route('**/api/companies/*/prices', (route) =>
          route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Not available.' }),
          }),
        );
        await page.evaluate(() => ScopeItems.loadCompany());
        await expect(await unsavedJob(page, context)).toContainText(text);
        await context.setOffline(false);
      },
    );

  test('a job started after the switch from an out-of-date phone copy keeps the item list and its date', async ({
    page,
    context,
    request,
  }) => {
    await switched(page);
    await expect.poll(() => page.evaluate(() => !!ScopeItems.table()?.version_id)).toBe(true);
    const copy = await page.evaluate(() => ScopeItems.table().version_id);
    // The owner republishes and this phone cannot fetch the new table: its copy is out of date.
    await request.post('/__test/price-table', {
      data: { items: { service_call: { unit_price: '160.00', default_quantity: '3' } } },
    });
    await page.route('**/api/companies/*/prices', (route) => route.abort());
    await expect
      .poll(async () => {
        await page.evaluate(() => WorkspaceUI.refresh());
        return page.evaluate(() => state.session.pricing_table_version);
      })
      .not.toBe(copy);
    expect(await page.evaluate(() => !!state.session.switched_at)).toBe(true);
    expect(await page.evaluate(() => ScopeItems.table().version_id)).toBe(copy);
    const status = await unsavedJob(page, context);
    await expect(status).toContainText('Prices as of');
    await expect(status).toContainText('Your company has newer prices');
    await context.setOffline(false);
  });

  test('a draft begun before the switch that never reached the server shows the v1 form offline, then the table at its first save', async ({
    page,
    context,
  }) => {
    await start(page, 'owner');
    await publishRates(page);
    await page.route('**/api/inspections**', (route) =>
      ['POST', 'PUT', 'PATCH'].includes(route.request().method())
        ? route.abort()
        : route.continue(),
    );
    await page.evaluate(() => openNew().catch(() => {}));
    const id = await page.evaluate(() => state.draft.inspection_id);
    await publishSwitch(page);
    await page.getByRole('button', { name: 'Publish prices' }).click();
    await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v2');
    await expect
      .poll(() => page.evaluate(() => [state.session.pricing_version, !!state.session.switched_at]))
      .toEqual(['dryscope-v2', true]);
    await context.setOffline(true);
    await page.evaluate((value) => restoreDraft(value), id);
    expect(await page.evaluate(() => state.record)).toBeNull();
    await checkScope(page);
    await expect(page.locator('#v1Scope')).toBeVisible();
    await expect(page.locator('#v2Scope')).toBeHidden();
    await page.locator('#airMovers').fill('2');

    // Back online the server first sees the job now, so it is a new job on the published table.
    await page.unroute('**/api/inspections**');
    await context.setOffline(false);
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#v1Scope')).toBeHidden();
    await expect(page.locator('#v2Scope #airMovers')).toHaveValue('2');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = await page.evaluate(async (value) => {
      const pricing = await jsonApi('/api/inspections/' + value + '/pricing');
      const record = await jsonApi('/api/inspections/' + value);
      return { pricing, airMovers: record.data.air_movers };
    }, id);
    expect(saved.airMovers).toBe(2);
    expect(saved.pricing.calculation_version).toBe('dryscope-v2');
    expect(saved.pricing.pinned.reason).toBe('first_price');
    expect(saved.pricing.can_reprice).toBe(false);
  });
});

test('discarding the switch returns to the rate book, and only the owner is offered it', async ({
  page,
  browser,
}) => {
  await start(page, 'owner');
  await publishRates(page);
  await expect(page.locator('#priceSwitch')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to v2' }).click();
  await expect(page.locator('#priceEditor')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Yes, discard' }).click();
  await expect(page.locator('#priceSwitch')).toBeVisible();
  await expect(page.locator('input[name=emergency_call]')).toHaveValue('200.00');

  for (const role of ['estimator', 'office']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const other = await context.newPage();
    await start(other, role);
    await navigate(other, 'dashboardPrices');
    await expect(other.locator('#dashboardHeading')).toHaveText('Company prices');
    await expect(other.locator('#dashboardContent')).toContainText('Prices v1');
    await expect(other.locator('#priceSwitch')).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'Switch to v2' })).toHaveCount(0);
    await context.close();
  }
});
