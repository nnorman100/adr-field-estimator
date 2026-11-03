const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

const uid = (role) => 'test-owner-ws-' + role;
const auth = (role) => ({ Authorization: 'Bearer ' + uid(role) });
const ITEMS = {
  air_mover: { unit_price: '30.00' },
  lgr_dehumidifier: { unit_price: '100.00' },
  service_call: { unit_price: '150.00', default_quantity: '2' },
  setup_documentation: { unit_price: '40.00', default_quantity: '1' },
  desiccant_dehumidifier: { unit_price: '120.00' },
};

test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, price_books: true, ai_features: [] },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
const publish = (request, extra = {}) =>
  request.post('/__test/price-table', { data: { items: ITEMS, ...extra } });

async function open(page, role = 'owner') {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
}
// Decimal quantities come back from the server as strings.
const numbers = (items) =>
  Object.fromEntries(
    Object.entries(items || {}).map(([id, q]) => [id, { ...q, quantity: Number(q.quantity) }]),
  );
const jobId = (page) => page.evaluate(() => state.draft.inspection_id);
const remote = async (page, id, role = 'owner') =>
  (await page.request.get('/api/inspections/' + id, { headers: auth(role) })).json();
const storedRows = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('adr-private-drafts-v2');
        request.onerror = reject;
        request.onsuccess = () => {
          const db = request.result,
            all = db.transaction(['drafts']).objectStore('drafts').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
        };
      }),
  );
const cachedTable = async (page) =>
  (await storedRows(page)).find((row) => row.key.startsWith('prices:'))?.prices || null;
// The server answers the company table and the job's pin with this status.
const answerPrices = (page, status) =>
  Promise.all(
    ['**/api/companies/*/prices', '**/api/inspections/*/pricing'].map((path) =>
      page.route(path, (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Not available.' }),
        }),
      ),
    ),
  );
const stopAnswering = (page) =>
  Promise.all(
    ['**/api/companies/*/prices', '**/api/inspections/*/pricing'].map((path) => page.unroute(path)),
  );
const newJob = async (page) => {
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
};

test.describe('without a service worker', () => {
  test.use({ serviceWorkers: 'block' });

  test("a v2 company's Check Scope lists its own items and unit prices, none of the workbook's", async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#v1Scope')).toBeHidden();
    const list = page.locator('#v2Scope');
    await expect(list).toContainText('Emergency service call');
    await expect(list).toContainText('$150.00 each');
    await expect(list).toContainText('$30.00 per unit-day');
    await expect(list).toContainText('Drying equipment');
    for (const workbook of [
      'Matterport',
      'Haul pickup',
      'Standard job charges',
      '1,180.20',
      'sheet',
      '47.46',
    ])
      expect((await page.locator('#v2Scope').innerText()).toLowerCase()).not.toContain(
        workbook.toLowerCase(),
      );
    await expect(page.locator('#scopeConfirmText')).toContainText("company's price list");
    // The same inputs, now inside the item list: collect() and the sizing check keep reading them.
    await expect(list.locator('#airMovers')).toBeVisible();
    await expect(list.locator('#dryingDays')).toBeVisible();
    await expect(page.locator('#v2Sizing #sizingCheck')).toHaveCount(1);
    // Totals are the server's: no dollar total is computed on the phone.
    await expect(list).not.toContainText('Total');
  });

  test('a new draft starts at the table defaults and the pin is the table it was created under', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#monitoringHours')).toHaveValue('0');
    await expect(page.locator('#haulLoads')).toHaveValue('0');
    await expect(page.locator('#airScrubbers')).toHaveValue('0');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
    const record = await remote(page, await jobId(page));
    expect(record.data.emergency_calls).toBe(2);
    expect(record.data.monitoring_hours).toBe(0);
    expect(numbers(record.data.scope_items).setup_documentation.quantity).toBe(1);
    expect(record.data.seeded_from_version).toBeTruthy();
    const pricing = await (
      await page.request.get('/api/inspections/' + (await jobId(page)) + '/pricing', {
        headers: auth('owner'),
      })
    ).json();
    expect(pricing.calculation_version).toBe('dryscope-v2');
    expect(pricing.pinned).not.toBeNull();
  });

  test('custom typed and equipment items save with the draft and come back after a reload', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.locator('[data-scope-item="setup_documentation"]').fill('3');
    const desiccant = page.locator('[data-scope-item="desiccant_dehumidifier"]');
    await desiccant.first().fill('2');
    await desiccant.nth(1).fill('4');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = numbers((await remote(page, id)).data.scope_items);
    expect(saved.setup_documentation).toEqual({ quantity: 3, count: 0, days: 0 });
    expect(saved.desiccant_dehumidifier).toEqual({ quantity: 0, count: 2, days: 4 });
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('3');
    await expect(
      page.locator('[data-scope-item="desiccant_dehumidifier"][data-scope-key="days"]'),
    ).toHaveValue('4');
    await expect(page.locator('[data-group-summary="drying_equipment"]')).toContainText(
      'desiccant dehumidifier',
    );
  });

  test('a synced draft reopens with no conflict and keeps saving', async ({ page, request }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.locator('[data-scope-item="setup_documentation"]').fill('2.5');
    await page.locator('#technicianNotes').fill('Synced note');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    // The phone's acknowledged copy is byte-equal to the server's, and reopening stays clean.
    const sameAsServer = () =>
      page.evaluate(
        async (value) => stable((await jsonApi('/api/inspections/' + value)).data) === state.ack,
        id,
      );
    expect(await sameAsServer()).toBe(true);
    await page.evaluate((value) => restoreDraft(value), id);
    await expect(page.locator('#conflictActions')).toBeHidden();
    expect(await page.evaluate(() => state.conflict)).toBe(false);
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#conflictActions')).toBeHidden();
    expect(await page.evaluate(() => state.conflict)).toBe(false);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await page.locator('[data-scope-item="setup_documentation"]').fill('4');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect(numbers((await remote(page, id)).data.scope_items).setup_documentation.quantity).toBe(4);
  });

  test('reading the pin does not rebuild a screen that already shows it', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const box = page.locator('[data-scope-item="setup_documentation"]');
    await box.focus();
    await box.evaluate((el) => (el.dataset.original = 'yes'));
    await page.evaluate(() => ScopeItems.pull());
    expect(await page.evaluate(() => document.activeElement.dataset.original)).toBe('yes');
  });

  test('a pin that differs from the company table rebuilds the room cards too', async ({
    page,
    request,
  }) => {
    await publish(request, { policy: { area_basis: 'wet_floor' } });
    await open(page);
    const id = await jobId(page);
    await publish(request, {
      items: { ...ITEMS, air_mover: { unit_price: '35.00' } },
      policy: { area_basis: 'demolition' },
    });
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    const wet = page.locator('[data-room-index="0"][data-room-key="wet_floor_sf"]');
    await page.evaluate((value) => {
      // This phone has no row for the job: it starts from the company's current table.
      ScopeItems.seed(value, null);
      fillForm();
    }, id);
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect.poll(() => wet.evaluate((el) => !el.closest('.room-more'))).toBe(true);
  });

  test('a draft started before a publish keeps its pinned table and says newer prices exist', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await publish(request, { items: { ...ITEMS, air_mover: { unit_price: '35.00' } } });
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect(page.locator('#v2Scope')).not.toContainText('$35.00');
    await expect(page.locator('#jobPricingStatus')).toContainText('Newer company prices');
    // A job started now is on the new table.
    await page.evaluate(() => openNew());
    await expect(page.locator('#v2Scope')).toContainText('$35.00 per unit-day');
  });

  test('items the table no longer lists stay with the job under a visible heading', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.evaluate(() => {
      state.draft.data.scope_items = {
        ...state.draft.data.scope_items,
        retired_item: { quantity: 4, count: 0, days: 0 },
      };
      changed();
      fillForm();
    });
    await expect(page.locator('#v2Unlisted')).toBeVisible();
    await page.locator('#v2Unlisted summary').click();
    await expect(page.locator('#v2UnlistedList')).toContainText('retired item');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect(numbers((await remote(page, id)).data.scope_items).retired_item.quantity).toBe(4);
    await expect(page.locator('#v2UnlistedList').getByRole('button')).toHaveCount(0);
    await expect(page.locator('#v2UnlistedList input')).toHaveCount(0);
  });

  test('a field quantity whose item is gone is listed read-only and stays with the job', async ({
    page,
    request,
  }) => {
    await publish(request, {
      items: { ...ITEMS, air_scrubber: { enabled: false, unit_price: '' } },
    });
    await open(page);
    const id = await jobId(page);
    await expect(page.locator('#v2Unlisted')).toBeHidden();
    await page.evaluate(() => {
      state.draft.data.air_scrubbers = 2;
      changed();
      fillForm();
    });
    await expect(page.locator('#v2Unlisted')).toBeVisible();
    await page.locator('#v2Unlisted summary').click();
    await expect(page.locator('#v2UnlistedList')).toContainText('air scrubbers · 2');
    await expect(page.locator('#v2UnlistedList').getByRole('button')).toHaveCount(0);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.air_scrubbers).toBe(2);
  });

  test('room-sourced items show their unit price', async ({ page, request }) => {
    await publish(request);
    await open(page);
    const line = page.locator('[data-from-rooms]').first();
    await expect(line).toContainText('From rooms:');
    await expect(line).toContainText('$25.00 per');
    // Room inputs save through their own handlers; the line still follows every room change.
    const rooms = page.locator('[data-from-rooms]');
    const showing = (quantity) => rooms.filter({ hasText: '· ' + quantity + ' sq ft' });
    await page.locator('[data-room-index="0"][data-room-key="finished_sf"]').fill('77');
    await expect.poll(() => showing(77).count()).toBeGreaterThan(0);
    await page.locator('[data-room-index="0"][data-room-key="finished_sf"]').fill('78');
    await expect.poll(() => showing(78).count()).toBeGreaterThan(0);
    await expect(showing(77)).toHaveCount(0);
    await page.evaluate(() => {
      state.draft.data.rooms.splice(0, 1);
      changed();
    });
    await expect(showing(78)).toHaveCount(0);
  });

  test("a technician's zero on a job begun from the table survives a reopen", async ({
    page,
    context,
    request,
  }) => {
    await publish(request, {
      items: {
        ...ITEMS,
        service_call: { unit_price: '150.00', default_quantity: '1' },
        setup_documentation: { unit_price: '40.00', default_quantity: '0' },
        monitoring_visit: { unit_price: '25.00', default_quantity: '13.25' },
        debris_haul: { unit_price: '25.00', default_quantity: '1' },
        air_scrubber: { unit_price: '25.00', default_quantity: '1' },
        hepa_filter: { unit_price: '25.00', default_quantity: '1' },
        air_mover: { unit_price: '30.00', default_quantity: '3' },
      },
    });
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('owner'),
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    // Offline, so the zero is already in the draft when the first save makes revision 1.
    await context.setOffline(true);
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await checkScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await page.locator('#airMovers').fill('0');
    const id = await jobId(page);
    await context.setOffline(false);
    await saveDraft(page);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).revision).toBe(1);
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('0');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.air_movers).toBe(0);
  });

  test('an item limited to other categories hides, and its quantity stays visible and read-only', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    const box = page.locator('[data-scope-item="containment"]');
    const off = page.locator('#v2OffCategory');
    const category = page.locator('[data-room-index="0"][data-room-key="category"]');
    await category.selectOption('1');
    await expect(box).toHaveCount(0);
    await expect(off).toBeHidden();
    // A room in a matching category brings the item in, with no reload.
    await category.selectOption('2');
    await expect(box).toBeVisible();
    await box.fill('200');
    const summary = page.locator('[data-group-summary="job_charges"]');
    await expect(summary).toContainText('containment');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    // Back to category 1 the entered quantity stays with the job, out of the priced list.
    await category.selectOption('1');
    await expect(box).toHaveCount(0);
    await expect(off).toBeVisible();
    await expect(off.locator('summary')).toHaveText("Not priced for this job's categories");
    await off.locator('summary').click();
    await expect(page.locator('#v2OffCategoryList')).toContainText('200');
    await expect(page.locator('#v2OffCategoryList input')).toHaveCount(0);
    await expect(page.locator('#v2OffCategoryList button')).toHaveCount(0);
    await expect(summary).not.toContainText('containment');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect(numbers((await remote(page, id)).data.scope_items).containment.quantity).toBe(200);
    await category.selectOption('3');
    await expect(box).toHaveValue('200');
    await expect(off).toBeHidden();
  });

  test('the not-priced list follows the drying days edited on another row', async ({
    page,
    request,
  }) => {
    await publish(request, {
      items: { ...ITEMS, air_mover: { unit_price: '30.00', categories: [3] } },
    });
    await open(page);
    await page.locator('[data-room-index="0"][data-room-key="category"]').selectOption('1');
    await page.evaluate(() => {
      state.draft.data.air_movers = 2;
      changed();
      fillForm();
    });
    const list = page.locator('#v2OffCategoryList');
    await page.locator('#v2OffCategory summary').click();
    await expect(list).toContainText('2 air mover, 3 days');
    await page.locator('#dryingDays').fill('5');
    await expect(list).toContainText('2 air mover, 5 days');
  });

  test('turning the flag off shows the v1 form on a phone holding the draft, and on brings the list back unchanged', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    const typed = page.locator('[data-scope-item=odor_treatment][data-scope-key=quantity]');
    await typed.fill('3');
    await page.locator('#airMovers').fill('2');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const held = () =>
      page.evaluate(async (value) => {
        await persist();
        return (await localDrafts()).find((row) => row.draft.inspection_id === value).pricing;
      }, id);
    const pricing = await held();
    expect(pricing.calculation_version).toBe('dryscope-v2');

    await request.post('/__test/price-books', { data: { enabled: false } });
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#v1Scope')).toBeVisible();
    await expect(page.locator('#v2Scope')).toBeHidden();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#v1Scope')).toBeVisible();
    await expect(page.locator('#v2Scope')).toBeHidden();
    await expect(page.locator('#airMovers')).toHaveValue('2');
    await page.locator('#airMovers').fill('4');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect(await held()).toEqual(pricing);
    const saved = (await remote(page, id)).data;
    expect(Number(saved.scope_items.odor_treatment.quantity)).toBe(3);
    expect(saved.air_movers).toBe(4);

    await request.post('/__test/price-books', { data: { enabled: true } });
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#v1Scope')).toBeHidden();
    await expect(typed).toHaveValue('3');
    await expect(page.locator('#v2Scope #airMovers')).toHaveValue('4');
    expect(await held()).toEqual(pricing);
  });

  test('a job carrying overrides keeps them current on the v1 form after a rollback', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.locator('#address').fill('Synthetic rollback property');
    await page.locator('#yearBuilt').fill('1998');
    await page.locator('#technicianNotes').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await page.evaluate((value) => {
      // The flag is off again and this phone has no row for the job.
      state.session.pricing_version = null;
      state.session.price_books_enabled = false;
      ScopeItems.seed(value, null);
      fillForm();
    }, id);
    await expect(page.locator('#v1Scope')).toBeVisible();
    await page.locator('#airMovers').fill('5');
    const reason = page.locator('[data-override-reason="air_movers"]');
    await expect(reason).toBeVisible();
    await expect(page.locator('#saveStatus')).toHaveText('Reason needed');
    await reason.fill('Two more fans for the hall');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.quantity_overrides.air_movers).toEqual({
      measured: '3',
      entered: '5',
      reason: 'Two more fans for the hall',
    });
    const finished = page.locator('[data-room-index="0"][data-room-key="finished_sf"]');
    await finished.fill('95');
    const roomReason = page.locator('[data-override-reason="Kitchen:finished_sf"]');
    await expect(roomReason).toBeVisible();
    await roomReason.fill('Wet behind the pantry');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    // Removing the room takes its value with it, so the next save is not refused.
    await page.evaluate(() => {
      state.draft.data.rooms.splice(0, 1);
      changed();
      fillForm();
    });
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = (await remote(page, id)).data;
    expect(saved.rooms).toEqual([]);
    expect(saved.quantity_overrides['Kitchen:finished_sf']).toBeUndefined();
  });

  test('a first publish after sign-in reaches this phone: new jobs seed from the table', async ({
    page,
    request,
  }) => {
    await open(page);
    await expect(page.locator('#v1Scope')).toBeVisible();
    await expect(page.locator('#emergencyCalls')).toHaveValue('1');
    await publish(request);
    await page.evaluate(() => WorkspaceUI.refresh());
    // A job is seeded once, when it is started: the open job keeps its quantities.
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#emergencyCalls')).toHaveValue('1');
    await expect(page.locator('#monitoringHours')).toHaveValue('13.25');
    await page.evaluate(() => openNew());
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#monitoringHours')).toHaveValue('0');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
  });

  test('a republish reaches a phone that stayed open: new jobs seed from the new table', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
    await publish(request, {
      items: {
        ...ITEMS,
        service_call: { unit_price: '150.00', default_quantity: '3' },
        setup_documentation: { unit_price: '40.00', default_quantity: '4' },
      },
    });
    await page.evaluate(() => WorkspaceUI.refresh());
    await page.evaluate(() => openNew());
    await expect(page.locator('#emergencyCalls')).toHaveValue('3');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('4');
  });

  test('a table reload that failed is tried again at the next refresh', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await publish(request, {
      items: {
        ...ITEMS,
        setup_documentation: { unit_price: '40.00', default_quantity: '4' },
      },
    });
    let failed = 0;
    await page.route('**/api/companies/*/prices', (route) => {
      failed++;
      return route.abort();
    });
    await page.evaluate(() => WorkspaceUI.refresh());
    expect(failed).toBe(1);
    await page.unroute('**/api/companies/*/prices');
    // The phone's copy is older than the table the session names: a new job does not seed from it.
    await page.evaluate(() => openNew());
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('0');
    await page.evaluate(() => WorkspaceUI.refresh());
    await page.evaluate(() => openNew());
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('4');
    // Once current, a refresh does not fetch the table again.
    let fetched = 0;
    page.on('request', (sent) => {
      if (sent.url().endsWith('/prices')) fetched++;
    });
    await page.evaluate(() => WorkspaceUI.refresh());
    expect(fetched).toBe(0);
  });

  test('a refused price list clears the copy on the phone, says so and seeds nothing', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    await answerPrices(page, 403);
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect.poll(() => cachedTable(page)).toBeNull();
    await newJob(page);
    await expect(page.locator('#v2ScopeStatus')).toContainText(
      "You don't have access to your company's price list",
    );
    await expect(page.locator('#v2ScopeStatus')).toContainText(
      'New jobs start with no default quantities',
    );
    await expect(page.locator('#v2Scope')).not.toContainText('$30.00');
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    expect(await page.evaluate(() => state.draft.data.seeded_from_version)).toBeUndefined();
    // Access back: the next refresh loads the table and the next job seeds from it.
    await stopAnswering(page);
    await expect
      .poll(async () => {
        await page.evaluate(() => WorkspaceUI.refresh());
        return !!(await cachedTable(page));
      })
      .toBe(true);
    await page.evaluate(() => openNew());
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#v2ScopeStatus')).toHaveText('');
  });

  test('401, 403 and 404 each clear the copy on the phone', async ({ page, request }) => {
    await publish(request);
    await open(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    for (const status of [401, 403, 404]) {
      await answerPrices(page, status);
      await page.evaluate(() => ScopeItems.loadCompany());
      expect(await cachedTable(page), 'cleared on ' + status).toBeNull();
      await stopAnswering(page);
      await page.evaluate(() => ScopeItems.loadCompany());
      expect(await cachedTable(page), 'loaded after ' + status).toBeTruthy();
    }
  });

  test('a server error serves no old prices, says so and keeps the copy for offline', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    await answerPrices(page, 503);
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await newJob(page);
    await expect(page.locator('#v2ScopeStatus')).toContainText(
      "Your company's price list could not load",
    );
    await expect(page.locator('#v2Scope')).not.toContainText('$30.00');
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    expect(await cachedTable(page)).toBeTruthy();
  });

  test('a phone copy older than the current table is dated and seeds nothing', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    await publish(request, {
      items: {
        ...ITEMS,
        service_call: { unit_price: '150.00', default_quantity: '3' },
        setup_documentation: { unit_price: '40.00', default_quantity: '4' },
      },
    });
    await page.route('**/api/companies/*/prices', (route) => route.abort());
    await page.route('**/api/inspections/*/pricing', (route) => route.abort());
    await page.evaluate(() => WorkspaceUI.refresh());
    await page.evaluate(() => openNew());
    await checkScope(page);
    const status = page.locator('#v2ScopeStatus');
    await expect(status).toContainText('Prices as of');
    await expect(status).toContainText('Your company has newer prices');
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('0');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const id = await jobId(page);
    await expect
      .poll(async () => (await storedRows(page)).find((r) => r.draft?.inspection_id === id))
      .toBeTruthy();
    // The out-of-date copy is not kept beside the draft as if it were the job's table.
    await page.waitForTimeout(1500);
    const row = (await storedRows(page)).find((r) => r.draft?.inspection_id === id);
    expect(row.pricing).toBeUndefined();
    expect(row.draft.data.seeded_from_version).toBeUndefined();
  });

  test('a job already holding its table does not carry the price list warning', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect.poll(() => page.evaluate(() => ScopeItems.table()?.content_sha256)).toBeTruthy();
    await page.route('**/api/companies/*/prices', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Not available.' }),
      }),
    );
    await page.evaluate(() => ScopeItems.sessionChanged());
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect(page.locator('#v2ScopeStatus')).toHaveText('');
  });

  const startOfficeJob = async (context) => {
    const office = await context.newPage();
    await office.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('office'),
    );
    await office.goto('/app');
    await expect(office.locator('#workspaceDashboard')).toBeVisible();
    await office.getByRole('button', { name: 'New job', exact: true }).click();
    await expect(office.locator('#saveStatus')).toHaveText('Saved');
    return office;
  };
  const openOn = async (context, id, role = 'owner') => {
    const other = await context.newPage();
    await other.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
    await other.goto('/app');
    await expect(other.locator('#workspaceDashboard')).toBeVisible();
    await other.evaluate((value) => restoreDraft(value), id);
    await checkScope(other);
    return other;
  };

  test('an office job starts at the table defaults, seeded by the server', async ({
    page,
    context,
    request,
  }) => {
    await publish(request, {
      items: { ...ITEMS, hepa_filter: { enabled: false, unit_price: '' } },
    });
    const office = await startOfficeJob(context);
    const id = await jobId(office);
    // The office phone holds the server's copy, so reopening it is not a sync conflict.
    await expect(office.locator('#emergencyCalls')).toHaveValue('2');
    await office.evaluate((value) => restoreDraft(value), id);
    await expect(office.locator('#conflictActions')).toBeHidden();
    const path = '/api/jobs/' + id + '/coordination';
    const headers = { ...auth('office'), 'X-ADR-Workspace-Protocol': '1' };
    const coordination = await (await office.request.get(path, { headers })).json();
    const saved = await office.request.put(path, {
      headers,
      data: {
        expected_version: coordination.version,
        address: 'Synthetic office intake',
        assigned_estimator_uid: null,
        customer_name: '',
        customer_phone: '',
        customer_email: '',
        office_notes: '',
      },
    });
    expect(saved.ok()).toBe(true);
    await office.close();
    await open(page);
    const before = await remote(page, id);
    expect(before.revision).toBeGreaterThan(1);
    expect(before.data.address).toBe('Synthetic office intake');
    expect(before.data.monitoring_hours).toBe(0);
    expect(before.data.hepa_filters).toBe(0);
    expect(before.data.seeded_from_version).toBeTruthy();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#monitoringHours')).toHaveValue('0');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
    await expect(page.locator('#v2Unlisted')).toBeHidden();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).revision).toBe(before.revision);
  });

  test('an office phone that lost the create response still takes the seeded copy', async ({
    context,
    request,
  }) => {
    await publish(request);
    const office = await context.newPage();
    await office.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('office'),
    );
    await office.goto('/app');
    await expect(office.locator('#workspaceDashboard')).toBeVisible();
    // The server saves the job, but its answer never reaches the phone.
    let lost = 0;
    await office.route('**/api/inspections', async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.fallback();
      lost++;
      await route.fetch();
      return route.abort();
    });
    await office.getByRole('button', { name: 'New job', exact: true }).click();
    await expect(office.locator('#emergencyCalls')).toHaveValue('1');
    await expect.poll(() => lost).toBe(1);
    await expect(office.locator('#saveStatus')).not.toHaveText('Saving…');
    expect(await office.evaluate(() => state.record)).toBeNull();
    await office.evaluate(() => syncDraft().catch(() => {}));
    await expect(office.locator('#emergencyCalls')).toHaveValue('2');
    await expect(office.locator('#conflictActions')).toBeHidden();
    const id = await jobId(office);
    await office.evaluate((value) => restoreDraft(value), id);
    await expect(office.locator('#conflictActions')).toBeHidden();
    await expect(office.locator('#emergencyCalls')).toHaveValue('2');
    await office.close();
  });

  test("a worked office job keeps the estimator's zero on a phone with no row for it", async ({
    page,
    context,
    browser,
    request,
  }) => {
    await publish(request, {
      items: { ...ITEMS, air_mover: { unit_price: '30.00', default_quantity: '3' } },
    });
    const office = await startOfficeJob(context);
    const id = await jobId(office);
    await office.close();
    await open(page);
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await page.locator('#airMovers').fill('0');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const before = await remote(page, id);
    // The same person on another phone: a fresh browser profile holds no row for the job.
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const other = await openOn(phone, id);
    await expect(other.locator('#airMovers')).toHaveValue('0');
    await other.waitForTimeout(1500);
    const after = await remote(other, id);
    expect(after.revision).toBe(before.revision);
    expect(after.data.air_movers).toBe(0);
    await phone.close();
  });

  test('a job begun before the first publish is left as it is when opened', async ({
    page,
    context,
    request,
  }) => {
    await open(page, 'estimator');
    const id = await jobId(page);
    await expect(page.locator('#monitoringHours')).toHaveValue('13.25');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const before = await remote(page, id, 'estimator');
    await publish(request);
    const owner = await openOn(context, id);
    await expect(owner.locator('#v2Scope')).toBeVisible();
    await expect(owner.locator('#monitoringHours')).toHaveValue('13.25');
    await expect(owner.locator('[data-scope-item="setup_documentation"]')).toHaveValue('0');
    await owner.waitForTimeout(1500);
    const after = await remote(owner, id);
    expect(after.revision).toBe(before.revision);
    expect(after.data.seeded_from_version).toBeUndefined();
    await owner.close();
  });

  test('a worked job opened on a phone with no row for it keeps its deliberate zeros', async ({
    page,
    context,
    request,
  }) => {
    await publish(request, {
      items: {
        ...ITEMS,
        service_call: { unit_price: '150.00', default_quantity: '1' },
        setup_documentation: { unit_price: '40.00', default_quantity: '0' },
        monitoring_visit: { unit_price: '25.00', default_quantity: '13.25' },
        debris_haul: { unit_price: '25.00', default_quantity: '1' },
        air_scrubber: { unit_price: '25.00', default_quantity: '1' },
        hepa_filter: { unit_price: '25.00', default_quantity: '1' },
        air_mover: { unit_price: '30.00', default_quantity: '3' },
      },
    });
    await open(page, 'estimator');
    const id = await jobId(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await page.locator('#airMovers').fill('0');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await page.locator('#technicianNotes').fill('Second save');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const before = await remote(page, id, 'estimator');
    expect(before.revision).toBeGreaterThan(1);
    const owner = await context.newPage();
    await owner.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('owner'),
    );
    await owner.goto('/app');
    await expect(owner.locator('#workspaceDashboard')).toBeVisible();
    await owner.evaluate((value) => restoreDraft(value), id);
    await checkScope(owner);
    await expect(owner.locator('#airMovers')).toHaveValue('0');
    await owner.evaluate(() => syncChain);
    await owner.waitForTimeout(1500);
    await expect(owner.locator('#saveStatus')).toHaveText('Saved');
    const after = await remote(owner, id);
    expect(after.revision).toBe(before.revision);
    expect(after.data.air_movers).toBe(0);
    await owner.close();
  });

  test('a first publish leaves quantities the technician already changed', async ({
    page,
    request,
  }) => {
    await open(page);
    await page.locator('details.sheet-charges summary').click();
    await page.locator('#monitoringHours').fill('8');
    await publish(request);
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#monitoringHours')).toHaveValue('8');
    await expect(page.locator('#emergencyCalls')).toHaveValue('1');
  });

  test('a company with no published prices gets the prices gap on the phone', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const pricing = await page.evaluate(() => {
      const id = state.draft.inspection_id,
        before = ScopeItems.readinessPricing();
      state.session.prices_set = false;
      const pinned = ScopeItems.readinessPricing();
      state.session.pricing_version = null;
      ScopeItems.seed(id, null);
      return { before, pinned, unset: ScopeItems.readinessPricing() };
    });
    expect(pricing.before.prices_set).toBe(true);
    expect(pricing.pinned.prices_set).toBe(true);
    expect(pricing.unset).toEqual({ prices_set: false });
  });

  test('a company on the v1 rate book sees the form it always had', async ({ page }) => {
    await open(page);
    await expect(page.locator('#v1Scope')).toBeVisible();
    await expect(page.locator('#v2Scope')).toBeHidden();
    await expect(page.locator('#emergencyCalls')).toHaveValue('1');
    await expect(page.locator('#monitoringHours')).toHaveValue('13.25');
    await expect(page.locator('#panel-property')).toContainText('Standard job charges');
    expect(
      await page.evaluate(
        () => state.draft.data.scope_items === undefined && !('pricing' in state.draft),
      ),
    ).toBe(true);
  });

  test('changing a walkthrough-filled value needs a short reason the owner can read', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.locator('#address').fill('Synthetic override property');
    await page.locator('#yearBuilt').fill('1998');
    await page.locator('#technicianNotes').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
    await expect(page.locator('#airMovers')).toHaveValue('3');
    const reason = page.locator('[data-override-reason="air_movers"]');
    await expect(reason).toBeHidden();
    await page.locator('#airMovers').fill('5');
    await expect(reason).toBeVisible();
    // Unexplained, the form refuses to go on and the change stays on the phone.
    expect(await page.evaluate(() => $('inspectionForm').checkValidity())).toBe(false);
    expect(await page.evaluate(() => state.draft.data.quantity_overrides.air_movers)).toEqual({
      measured: '3',
      entered: '5',
    });
    await expect(page.locator('#saveStatus')).toHaveText('Reason needed');
    // Spaces are not a reason, whatever the browser's own length check would say.
    await reason.fill('     ');
    expect(await page.evaluate(() => $('inspectionForm').checkValidity())).toBe(false);
    await expect(page.locator('#saveStatus')).toHaveText('Reason needed');
    expect((await remote(page, id)).data.air_movers).not.toBe(5);
    await reason.fill('Two more fans for the hall');
    expect(await page.evaluate(() => $('inspectionForm').checkValidity())).toBe(true);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.quantity_overrides.air_movers).toEqual({
      measured: '3',
      entered: '5',
      reason: 'Two more fans for the hall',
    });
    // Back at the measured value there is nothing to explain.
    await page.locator('#airMovers').fill('3');
    await expect(reason).toBeHidden();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.quantity_overrides.air_movers).toEqual({
      measured: '3',
      entered: '3',
    });
    // A later change is measured against the same value, with the entered value kept current.
    // The earlier reason does not carry over: this change has to be explained on its own.
    await page.locator('#airMovers').fill('5');
    await expect(reason).toHaveValue('');
    expect(await page.evaluate(() => $('inspectionForm').checkValidity())).toBe(false);
    await expect(page.locator('#saveStatus')).toHaveText('Reason needed');
    await reason.fill('Two more fans for the hall');
    await page.locator('#airMovers').fill('7');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.quantity_overrides.air_movers).toEqual({
      measured: '3',
      entered: '7',
      reason: 'Two more fans for the hall',
    });
    // A room measurement the walkthrough filled is covered the same way.
    const finished = page.locator('[data-room-index="0"][data-room-key="finished_sf"]');
    await expect(finished).toHaveValue('80');
    await finished.fill('95');
    const roomReason = page.locator('[data-override-reason="Kitchen:finished_sf"]');
    await expect(roomReason).toBeVisible();
    await roomReason.fill('Wet behind the pantry');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect((await remote(page, id)).data.quantity_overrides['Kitchen:finished_sf']).toEqual({
      measured: '80',
      entered: '95',
      reason: 'Wet behind the pantry',
    });
    // Renaming the room keeps its measured value, its reason and its reason box.
    await page.locator('[data-room-index="0"][data-room-key="name"]').fill('Pantry');
    const renamed = page.locator('[data-override-reason="Pantry:finished_sf"]');
    await expect(renamed).toBeVisible();
    await renamed.fill('Wet behind the back wall');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const overrides = (await remote(page, id)).data.quantity_overrides;
    expect(overrides['Kitchen:finished_sf']).toBeUndefined();
    expect(overrides['Pantry:finished_sf']).toEqual({
      measured: '80',
      entered: '95',
      reason: 'Wet behind the back wall',
    });
    // Another phone, with no local row, sees the same requirement.
    await page.evaluate((value) => {
      ScopeItems.forget();
      ScopeItems.seed(value, null);
      fillForm();
    }, id);
    await expect(page.locator('[data-override-reason="air_movers"]')).toBeVisible();
    await page.locator('#airMovers').fill('9');
    await expect(page.locator('[data-override-reason="air_movers"]')).toHaveValue(
      'Two more fans for the hall',
    );
  });

  test('Save draft says so when a missing reason keeps the change on the phone', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const id = await jobId(page);
    await page.locator('#address').fill('Synthetic save property');
    await page.locator('#yearBuilt').fill('1998');
    await page.locator('#technicianNotes').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await page.locator('#airMovers').fill('5');
    await saveDraft(page);
    const reason = page.locator('[data-override-reason="air_movers"]');
    const message = page.locator('#message');
    await expect(message).toContainText('Saved on this phone only');
    await expect(message).not.toContainText('saved privately');
    await expect(page.locator('#validationFeedback')).toBeVisible();
    await expect(reason).toBeFocused();
    expect((await remote(page, id)).data.air_movers).toBe(3);
    // Going back to the measured value leaves nothing to explain, so the prompt goes too.
    await page.locator('#airMovers').fill('3');
    await expect(page.locator('#validationFeedback')).toBeHidden();
    await page.locator('#airMovers').fill('5');
    await saveDraft(page);
    await expect(page.locator('#validationFeedback')).toBeVisible();
    await reason.fill('Two more fans for the hall');
    await expect(page.locator('#validationFeedback')).toBeHidden();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await saveDraft(page);
    await expect(message).toContainText('Draft saved privately');
    expect((await remote(page, id)).data.air_movers).toBe(5);
  });

  test('undoing a walkthrough value asks for no reason', async ({ page, request }) => {
    await publish(request);
    await open(page);
    await page.locator('#address').fill('Synthetic undo property');
    await page.locator('#yearBuilt').fill('1998');
    await page.locator('#technicianNotes').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await page
      .locator('label', { has: page.locator('#airMovers') })
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(page.locator('#airMovers')).toHaveValue('0');
    await expect(page.locator('[data-override-reason="air_movers"]')).toBeHidden();
    expect(await page.evaluate(() => $('inspectionForm').checkValidity())).toBe(true);
    expect(
      await page.evaluate(() => state.draft.data.quantity_overrides.air_movers),
    ).toBeUndefined();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
  });

  const roomField = (page, key) => page.locator(`[data-room-index="0"][data-room-key="${key}"]`);
  const tapMold = async (page) => {
    await page.locator('[name="room-loss-0"][value="mold"]').check({ force: true });
    await page.locator('#rooms .room-more > summary').first().click();
  };

  const NO_WET_FLOOR_ITEM = {
    items: { ...ITEMS, antimicrobial: { enabled: false, unit_price: '' } },
  };

  test('a mold room on a price list asks for the floor area it prices from', async ({
    page,
    request,
  }) => {
    await publish(request, NO_WET_FLOOR_ITEM);
    await open(page);
    await tapMold(page);
    await expect(roomField(page, 'floor_sf')).toBeVisible();
    for (const hidden of ['wet_floor_sf', 'ceiling_height_ft', 'water_class'])
      await expect(roomField(page, hidden)).toBeHidden();
    await expect(page.locator('#rooms .room-sizing-title')).toBeHidden();
    await expect(page.locator('#rooms .wet-floor-hint')).toBeHidden();
    await roomField(page, 'floor_sf').fill('120');
    await expect(
      page.locator('[data-from-rooms="surface_cleaning"]', { hasText: '· 120 sq ft' }),
    ).toHaveCount(1);
    // Back on water the whole drying check returns.
    await page.locator('[name="room-loss-0"][value="water"]').check({ force: true });
    for (const shown of ['floor_sf', 'wet_floor_sf', 'ceiling_height_ft', 'water_class'])
      await expect(roomField(page, shown)).toBeVisible();
    await expect(page.locator('#rooms .room-sizing-title')).toBeVisible();
  });

  test('a mold room on a wet-floor price list keeps both areas', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await publish(request, { policy: { area_basis: 'wet_floor' } });
    await open(page);
    await tapMold(page);
    const wet = roomField(page, 'wet_floor_sf');
    await expect(wet).toBeVisible();
    expect(await wet.evaluate((el) => !el.closest('.room-more'))).toBe(true);
    await expect(roomField(page, 'floor_sf')).toBeVisible();
    await expect(roomField(page, 'ceiling_height_ft')).toBeHidden();
    // Tapping back to water finds the wet floor input already on the card.
    await page.locator('[name="room-loss-0"][value="water"]').check({ force: true });
    await expect(roomField(page, 'ceiling_height_ft')).toBeVisible();
    await expect(wet).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a mold room shows the wet floor input an item prices it from, on any area basis', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const wet = roomField(page, 'wet_floor_sf');
    const line = page.locator('[data-from-rooms="antimicrobial"]');
    await roomField(page, 'floor_sf').evaluate((el) => (el.closest('details').open = true));
    await roomField(page, 'floor_sf').fill('120');
    await wet.fill('40');
    await expect(line).toContainText('· 40 sq ft');
    await page.locator('[name="room-loss-0"][value="mold"]').check({ force: true });
    // The saved area still prices the room, so it can still be corrected.
    await expect(wet).toBeVisible();
    await expect(page.locator('#rooms .wet-floor-hint')).toBeVisible();
    await expect(roomField(page, 'ceiling_height_ft')).toBeHidden();
    await wet.fill('');
    await expect(line).toContainText('· 120 sq ft');
  });

  test('the wet floor input follows the categories the item prices', async ({ page, request }) => {
    await publish(request, {
      items: { ...ITEMS, antimicrobial: { unit_price: '25.00', categories: [1] } },
    });
    await open(page);
    await tapMold(page);
    const wet = roomField(page, 'wet_floor_sf');
    await expect(wet).toBeHidden();
    // On a mold room moved to a category the item prices, the same area counts again.
    await roomField(page, 'category').selectOption('1');
    await expect(wet).toBeVisible();
  });

  test('a changed wet floor value on a room turned mold keeps its reason box', async ({
    page,
    request,
  }) => {
    await publish(request, NO_WET_FLOOR_ITEM);
    await open(page);
    const key = await page.evaluate(() => {
      const room = state.draft.data.rooms[0];
      room.wet_floor_sf = 40;
      const name = room.name + ':wet_floor_sf';
      state.draft.data.quantity_overrides = { [name]: { measured: '30', entered: '40' } };
      changed();
      fillForm();
      return name;
    });
    await tapMold(page);
    await expect(roomField(page, 'wet_floor_sf')).toBeVisible();
    const reason = page.locator(`[data-override-reason="${key}"]`);
    await expect(reason).toBeVisible();
    await reason.fill('Only the closet floor stayed wet');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
  });

  test('a mold room on the v1 form still has no floor area input', async ({ page }) => {
    await open(page);
    await tapMold(page);
    for (const hidden of ['floor_sf', 'wet_floor_sf', 'ceiling_height_ft', 'water_class'])
      await expect(roomField(page, hidden)).toBeHidden();
  });

  test('a wet-floor company enters the wet floor area on the room card', async ({
    page,
    request,
  }) => {
    await publish(request, { policy: { area_basis: 'wet_floor' } });
    await open(page);
    const wet = page.locator('[data-room-index="0"][data-room-key="wet_floor_sf"]');
    await expect(wet).toBeVisible();
    expect(await wet.evaluate((el) => !el.closest('.room-more'))).toBe(true);
  });
});

test.describe('with the service worker', () => {
  async function controlled(page) {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
    });
  }
  const rows = (page) =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('adr-private-drafts-v2');
          request.onerror = reject;
          request.onsuccess = () => {
            const db = request.result,
              all = db.transaction(['drafts']).objectStore('drafts').getAll();
            all.onsuccess = () => {
              db.close();
              resolve(all.result);
            };
          };
        }),
    );

  test('the price list is cached on the phone, never listed as a draft, and drives an offline job', async ({
    page,
    context,
    request,
  }) => {
    await publish(request);
    await open(page);
    await controlled(page);
    await expect
      .poll(async () => (await rows(page)).some((r) => r.key.startsWith('prices:')))
      .toBe(true);
    const all = await rows(page);
    const cached = all.find((r) => r.key.startsWith('prices:'));
    expect(cached.prices.table.items.length).toBeGreaterThan(10);
    expect(cached.draft).toBeUndefined();
    expect(all.find((r) => r.draft).pricing.calculation_version).toBe('dryscope-v2');
    // The cached row is never offered as a draft.
    expect(await page.evaluate(async () => (await localDrafts()).every((r) => r.draft))).toBe(true);
    const id = await jobId(page);
    await context.setOffline(true);
    await page.locator('[data-scope-item="setup_documentation"]').fill('5');
    await page.locator('#technicianNotes').fill('Entered with no signal');
    await expect
      .poll(
        async () =>
          (await rows(page)).find((r) => r.draft?.inspection_id === id)?.draft.data.scope_items,
      )
      .toMatchObject({ setup_documentation: { quantity: '5' } });
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('5');
    await context.setOffline(false);
    await saveDraft(page);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = await remote(page, id);
    expect(numbers(saved.data.scope_items).setup_documentation.quantity).toBe(5);
    expect(saved.data.technician_notes).toBe('Entered with no signal');
  });

  test('offline, a new job seeds from a current phone copy and shows its date', async ({
    page,
    context,
    request,
  }) => {
    await publish(request);
    await open(page);
    await controlled(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    await page.evaluate(() => syncChain);
    await page.waitForTimeout(1500);
    // Date the copy, so the screen can only be reading the cached date.
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
              for (const row of all.result)
                if (row.key.startsWith('prices:')) {
                  row.prices.cached_at = '2026-10-05T12:00:00.000Z';
                  store.put(row);
                }
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
    await checkScope(page);
    await expect(page.locator('#v2ScopeStatus')).toHaveText('Prices as of Oct 5, 2026.');
    await expect(page.locator('#v2Scope')).toContainText('$30.00 per unit-day');
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
    // Back online, the same table is fetched fresh rather than kept as the dated copy.
    const fetched = page.waitForRequest((sent) => sent.url().endsWith('/prices'));
    await context.setOffline(false);
    await page.evaluate(() => WorkspaceUI.refresh());
    await fetched;
    await expect(page.locator('#v2ScopeStatus')).toHaveText('');
  });

  test('offline, a stored session older than the phone copy does not mark the copy out of date', async ({
    page,
    context,
    request,
  }) => {
    await publish(request);
    await open(page);
    await controlled(page);
    await expect.poll(() => cachedTable(page)).toBeTruthy();
    await page.evaluate(() => syncChain);
    await page.waitForTimeout(1500);
    // The session stored beside the draft names an earlier table than the copy on the phone.
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
              for (const row of all.result)
                if (row.session) {
                  row.session.pricing_table_version = 'an-earlier-table';
                  store.put(row);
                }
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
    expect(await page.evaluate(() => state.session.pricing_table_version)).toBe('an-earlier-table');
    await page.evaluate(() => openNew());
    await checkScope(page);
    await expect(page.locator('#v2ScopeStatus')).toContainText('Prices as of');
    await expect(page.locator('#v2ScopeStatus')).not.toContainText('newer');
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
    await context.setOffline(false);
  });

  test('a phone that never loaded the price list says to connect once', async ({
    page,
    context,
    request,
  }) => {
    await publish(request);
    await open(page);
    await controlled(page);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    // Let the pending pricing refresh and its debounced local save finish before removing the cache.
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
              for (const row of all.result) {
                if (row.key.startsWith('prices:')) store.delete(row.key);
                else {
                  delete row.pricing;
                  store.put(row);
                }
              }
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        }),
    );
    const id = await jobId(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.evaluate((value) => restoreDraft(value), id);
    await checkScope(page);
    await expect(page.locator('#v2ScopeStatus')).toContainText(
      "Connect once to load your company's price list",
    );
    await expect(page.locator('#v1Scope')).toBeHidden();
    // Rooms still work.
    await expect(page.locator('#rooms .room')).toHaveCount(1);
    // A job begun with no table stays at zero; the next new job has the table once connected.
    await page.evaluate(() => openNew());
    await checkScope(page);
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    await context.setOffline(false);
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#v2ScopeStatus')).toHaveText('');
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    await page.evaluate(() => openNew());
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
  });
});
