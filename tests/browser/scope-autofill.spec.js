const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const words = 'Kitchen, category 2, 80 SF drywall. Use 3 fans.';
const room = (page, key) => page.locator('[data-room-index="0"][data-room-key="' + key + '"]');
async function ready(page) {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled();
  await checkScope(page);
  await page.locator('#address').fill('Synthetic scope autofill property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(words);
}
async function tapVisible(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  // A real coordinate tap cannot silently scroll a target into view like locator.click().
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test('fresh Kitchen autofill and explicit confirmation reach review with zero manual scrolls', async ({
  page,
}) => {
  await ready(page);
  await page.locator('#fillScopeProperty').scrollIntoViewIfNeeded();
  await tapVisible(page, '#fillScopeProperty');
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  expect(
    await page.evaluate(() =>
      Math.abs($('scopeSuggestionPanel').getBoundingClientRect().top - visibleBounds().top),
    ),
  ).toBeLessThan(2);
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 'name')).toHaveValue('Kitchen');
  await expect(room(page, 'category')).toHaveValue('2');
  await expect(room(page, 'finished_sf')).toHaveValue('80');
  await expect(room(page, 'finished_sf').locator('..')).toContainText('From walkthrough · Undo');
  await expect(page.locator('#scopeQuestions')).toContainText('Confirm any additional labor.');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath('autofill-390.png') });
  await tapVisible(page, '#confirmFilledScope');
  await expect(page.locator('#scopeConfirmed')).toBeChecked();
  await tapVisible(page, '#finishAudit');
  await expect(page.locator('#documents')).toBeVisible();
  const data = await page.evaluate(() => state.record.data);
  expect(data.rooms).toHaveLength(1);
  expect(data.scope_confirmed).toBe(true);
  const audited = await page.evaluate(() => ({
    revision: state.record.revision,
    version: state.localVersion,
  }));
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionStatus')).toContainText('No explicit changes found');
  await expect(page.locator('#scopeConfirmed')).toBeChecked();
  await expect(room(page, 'finished_sf').locator('..')).toContainText('From walkthrough · Undo');
  expect(
    await page.evaluate(() => ({ revision: state.record.revision, version: state.localVersion })),
  ).toEqual(audited);
  expect(await page.evaluate(() => state.record.audit)).not.toBeNull();
});

test('Undo restores the original room and manual edits are retained', async ({ page }) => {
  await ready(page);
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(room(page, 'name')).toHaveValue('Kitchen');
  await room(page, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(room(page, 'name')).toHaveValue('Room 1');
  await expect(room(page, 'finished_sf')).toHaveValue('80');
  await room(page, 'finished_sf')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(room(page, 'finished_sf')).toHaveValue('0');
  await room(page, 'category')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  // The panel from the first fill is still showing, so wait for this fill's own read to finish.
  const read = page.waitForResponse((r) => r.url().endsWith('/scope-suggestions'));
  await page.locator('#fillScopeProperty').click();
  await read;
  await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(room(page, 'name')).toHaveValue('Kitchen');
  await room(page, 'finished_sf').fill('95');
  await expect(room(page, 'finished_sf').locator('..').locator('.walkthrough-edit')).toHaveCount(0);
  await page
    .locator('#airMovers')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(room(page, 'finished_sf')).toHaveValue('95');
  await expect(room(page, 'name')).toHaveValue('Kitchen');
});

test('unsupported quotes stay as questions and never auto-apply', async ({ page }) => {
  await ready(page);
  await page.route('**/scope-suggestions', async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({
      json: {
        inspection_id: request.inspection_id,
        revision: request.expected_revision,
        changes: [
          { field: 'air_movers', room: null, value: 9 },
          { field: 'dehumidifiers', room: null, value: 2, source_quote: 'Invented statement' },
        ],
        questions: ['Confirm drying equipment.'],
      },
    });
  });
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('#airMovers')).toHaveValue('0');
  await expect(page.locator('#dehumidifiers')).toHaveValue('0');
  await expect(page.locator('#scopeQuestions')).toContainText('no supporting technician statement');
  await expect(page.locator('.walkthrough-edit')).toHaveCount(0);
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
});

test('initial-walk photo labels follow the default-room rename and name Undo through a reload', async ({
  page,
}) => {
  await ready(page);
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 50;
    canvas.getContext('2d').fillRect(0, 0, 50, 50);
    return canvas.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'initial-walk.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
  });
  await expect.poll(() => page.evaluate(() => state.draft.photos[0]?.uploaded)).toBe(true);
  await page.evaluate(async () => {
    await Promise.all([...state.ocr.values()]);
  });
  const original = await page.evaluate(() => state.record.photos[0]);
  expect(original.room).toBe('Room 1');
  await page.locator('#fillScope').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(room(page, 'name')).toHaveValue('Kitchen');
  await saveDraft(page);
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Kitchen');
  expect(await page.evaluate(() => state.record.photos[0].file)).toEqual(original.file);
  await room(page, 'name').locator('..').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(room(page, 'finished_sf')).toHaveValue('80');
  await saveDraft(page);
  await expect.poll(() => page.evaluate(() => state.record.photos[0].room)).toBe('Room 1');
  await page.reload();
  await expect(room(page, 'name')).toHaveValue('Room 1');
  expect(await page.evaluate(() => state.record.photos[0].file)).toEqual(original.file);
  expect(await page.evaluate(() => state.record.photos[0].room)).toBe('Room 1');
});

test('a manually entered room is preserved and Undo removes only a newly added room', async ({
  page,
}) => {
  await ready(page);
  await room(page, 'name').fill('Office');
  await room(page, 'finished_sf').fill('10');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(room(page, 'name')).toHaveValue('Office');
  await expect(room(page, 'finished_sf')).toHaveValue('10');
  await page
    .locator('[data-room-index="1"][data-room-key="name"]')
    .locator('..')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 'name')).toHaveValue('Office');
  await expect(room(page, 'finished_sf')).toHaveValue('10');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
});

const kitchen = (page, key) => page.locator('[data-room-index="1"][data-room-key="' + key + '"]');
const marker = (field) => field.locator('..').locator('.walkthrough-edit');
async function fillBesideOffice(page) {
  await ready(page);
  await room(page, 'name').fill('Office');
  await room(page, 'finished_sf').fill('10');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(kitchen(page, 'name')).toHaveValue('Kitchen');
}

test('a manual edit in a new walkthrough room keeps other field Undos and drops room removal', async ({
  page,
}) => {
  await fillBesideOffice(page);
  await kitchen(page, 'finished_sf').fill('95');
  await expect(marker(kitchen(page, 'finished_sf'))).toHaveCount(0);
  await expect(marker(kitchen(page, 'name'))).toHaveCount(0);
  await expect(marker(kitchen(page, 'category'))).toHaveCount(1);
  await marker(kitchen(page, 'category'))
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(kitchen(page, 'category')).toHaveValue('1');
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(kitchen(page, 'name')).toHaveValue('Kitchen');
  await expect(kitchen(page, 'finished_sf')).toHaveValue('95');
});

test('a field Undo keeps room removal for an otherwise unedited walkthrough room', async ({
  page,
}) => {
  await fillBesideOffice(page);
  await marker(kitchen(page, 'category'))
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(kitchen(page, 'category')).toHaveValue('1');
  await expect(marker(kitchen(page, 'finished_sf'))).toHaveCount(1);
  await marker(kitchen(page, 'name')).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#rooms .room')).toHaveCount(1);
  await expect(room(page, 'name')).toHaveValue('Office');
});

test('a repeated fill keeps unchanged field Undos but no room removal after a manual edit', async ({
  page,
}) => {
  await fillBesideOffice(page);
  await page.locator('#rooms .room').nth(1).locator('.room-more summary').click();
  await kitchen(page, 'waste_percent').fill('10');
  await expect(marker(kitchen(page, 'name'))).toHaveCount(0);
  await expect(marker(kitchen(page, 'finished_sf'))).toHaveCount(1);
  // The panel from the first fill is still showing, so wait for this fill's own read to finish.
  const read = page.waitForResponse((r) => r.url().endsWith('/scope-suggestions'));
  await page.locator('#fillScopeProperty').click();
  await read;
  await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(kitchen(page, 'waste_percent')).toHaveValue('10');
  await expect(marker(kitchen(page, 'name'))).toHaveCount(0);
  for (const key of ['category', 'finished_sf'])
    await expect(marker(kitchen(page, key))).toHaveCount(1);
  await marker(kitchen(page, 'finished_sf'))
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(kitchen(page, 'finished_sf')).toHaveValue('0');
  await expect(page.locator('#rooms .room')).toHaveCount(2);
  await expect(kitchen(page, 'waste_percent')).toHaveValue('10');
});

test.describe('suggested counts on a company price list', () => {
  const uid = 'test-owner-ws-estimator';
  const NOTES = 'Kitchen, category 2, 80 SF drywall.';
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  async function open(page, request, features = ['estimate_assist']) {
    await request.post('/__test/workspaces', {
      data: { enabled: true, price_books: true, ai_features: features },
    });
    await request.post('/__test/price-table', { data: {} });
    await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid);
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await checkScope(page);
    await page.locator('#address').fill('Synthetic scope autofill property');
    await page.locator('#yearBuilt').fill('1998');
    await page.locator('#technicianNotes').fill(NOTES);
    await room(page, 'name').fill('Kitchen');
    await page.locator('#rooms .room-more summary').first().click();
    await room(page, 'floor_sf').fill('140');
    await room(page, 'ceiling_height_ft').fill('8');
    await room(page, 'water_class').selectOption('2');
    await page.locator('#dehumidifierPpd').fill('70');
    await page.locator('#airMovers').fill('1');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
  }
  async function fillScope(page) {
    await page.locator('#fillScopeProperty').click();
    await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  }

  test('the fill raises a count to the S500 minimum, asks a reason to lower it, and Undo restores it', async ({
    page,
    request,
  }) => {
    await open(page, request);
    await fillScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await expect(page.locator('#dehumidifiers')).toHaveValue('1');
    const list = page.locator('#scopeSuggestionList');
    await expect(list).toContainText('From the IICRC sizing check');
    await expect(list).toContainText(
      'IICRC S500 minimum for 140 sq ft of wet floor across 1 room; the maximum is 4.',
    );
    await expect(list).toContainText(
      '23 pints/day recommended for the stated room volumes and classes; 1 unit at 70 pints/day each.',
    );
    const movers = page.locator('#airMovers').locator('..');
    await expect(movers).toContainText('From sizing check · Undo');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = await page.evaluate(() => state.record.data.quantity_overrides);
    expect(saved.air_movers).toEqual({ measured: '3', entered: '3' });
    expect(saved.dehumidifiers).toEqual({ measured: '1', entered: '1' });

    // Lowering the count opens the reason box, and the server keeps the reason.
    const reason = page.locator('[data-override-reason="air_movers"]');
    await expect(reason).toBeHidden();
    await page.locator('#airMovers').fill('2');
    await expect(reason).toBeVisible();
    await reason.fill('Only one wall is wet');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    expect(await page.evaluate(() => state.record.data.quantity_overrides.air_movers)).toEqual({
      measured: '3',
      entered: '2',
      reason: 'Only one wall is wet',
    });
    // Reading the walkthrough again leaves the explained count.
    const read = page.waitForResponse((r) => r.url().endsWith('/scope-suggestions'));
    await page.locator('#fillScopeProperty').click();
    await read;
    await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');
    await expect(page.locator('#airMovers')).toHaveValue('2');
  });

  test('Undo restores the earlier count and asks for no reason', async ({ page, request }) => {
    await open(page, request);
    await fillScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await page
      .locator('#airMovers')
      .locator('..')
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    await expect(page.locator('#airMovers')).toHaveValue('1');
    await expect(page.locator('[data-override-reason="air_movers"]')).toBeHidden();
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    const saved = await page.evaluate(() => state.record.data);
    expect(saved.air_movers).toBe(1);
    expect(saved.quantity_overrides.air_movers).toBeUndefined();
  });

  test('a spoken count stays even below the minimum', async ({ page, request }) => {
    await open(page, request);
    await page.locator('#technicianNotes').fill(words);
    // 350 sq ft of wet floor: the IICRC minimum is 6 air movers, and the technician said 3.
    await room(page, 'floor_sf').fill('350');
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await fillScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('3');
    await expect(page.locator('#airMovers').locator('..')).toContainText('From walkthrough');
    await expect(page.locator('#scopeSuggestionList')).not.toContainText('IICRC S500 minimum');
  });

  test('with the flag off the fill leaves the counts alone', async ({ page, request }) => {
    await open(page, request, []);
    await fillScope(page);
    await expect(page.locator('#airMovers')).toHaveValue('1');
    await expect(page.locator('#dehumidifiers')).toHaveValue('0');
    await expect(page.locator('#scopeSuggestionList')).not.toContainText('IICRC sizing check');
  });
});
