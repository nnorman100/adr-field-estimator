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

  test('an office job seeded from the table lists no sheet charge nobody entered', async ({
    page,
    request,
  }) => {
    await publish(request, {
      items: { ...ITEMS, hepa_filter: { enabled: false, unit_price: '' } },
    });
    await open(page);
    await page.evaluate(() => {
      Object.assign(state.draft.data, {
        emergency_calls: 1,
        monitoring_hours: 13.25,
        haul_loads: 1,
        air_scrubbers: 1,
        hepa_filters: 1,
      });
      delete state.draft.data.scope_items;
      ScopeItems.prepare();
      fillForm();
    });
    await expect(page.locator('#v2Unlisted')).toBeHidden();
    expect(await page.evaluate(() => state.draft.data.hepa_filters)).toBe(0);
  });

  test('reopening a first-revision job keeps what the technician entered', async ({
    page,
    request,
  }) => {
    await publish(request);
    await open(page);
    const reopened = (changes, row) =>
      page.evaluate(
        ({ changes, row }) => {
          const data = state.draft.data;
          delete data.scope_items;
          Object.assign(data, changes);
          state.record.revision = 1;
          if (row) ScopeItems.seed(state.draft.inspection_id, row);
          ScopeItems.prepare();
          return { emergency: data.emergency_calls, dump: data.dump_truck_loads };
        },
        { changes, row },
      );
    const zeros = {
      emergency_calls: 0,
      monitoring_hours: 0,
      haul_loads: 0,
      air_scrubbers: 0,
      hepa_filters: 0,
    };
    // A quantity entered on a job otherwise at the start.
    expect(await reopened({ ...zeros, dump_truck_loads: 2 })).toEqual({ emergency: 0, dump: 2 });
    // A deliberate zero on a job that has had its table.
    expect(await reopened({ ...zeros, dump_truck_loads: 0 })).toEqual({ emergency: 0, dump: 0 });
    // The same zeros on a phone that never had a table are where the job began, and only once.
    expect(await reopened(zeros, {})).toEqual({ emergency: 2, dump: 0 });
    expect(await reopened(zeros)).toEqual({ emergency: 0, dump: 0 });
    // Reopened before its first save, such a job has no revision yet and still starts from the table.
    const neverSaved = await page.evaluate((changes) => {
      const data = state.draft.data;
      Object.assign(data, changes);
      state.record = null;
      ScopeItems.seed(state.draft.inspection_id, {});
      ScopeItems.prepare();
      return data.emergency_calls;
    }, zeros);
    expect(neverSaved).toBe(2);
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
    // The open job has not been touched, so it moves to the table's defaults too.
    await expect(page.locator('#v2Scope')).toBeVisible();
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#monitoringHours')).toHaveValue('0');
    await page.evaluate(() => openNew());
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('#monitoringHours')).toHaveValue('0');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
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
    // A job begun with no table takes its defaults once the phone connects and loads it.
    await page.evaluate(() => openNew());
    await checkScope(page);
    await expect(page.locator('#emergencyCalls')).toHaveValue('0');
    await context.setOffline(false);
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#v2ScopeStatus')).toHaveText('');
    await expect(page.locator('#emergencyCalls')).toHaveValue('2');
    await expect(page.locator('[data-scope-item="setup_documentation"]')).toHaveValue('1');
  });
});
