const { checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');

// Per-room drying log on Check Scope against the synthetic backend: readings sit beside the
// inspection, the calculated GPP shows while typing, and the saved rows survive a reload.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
const rows = (page) => page.locator('#dryingLogBody .reading');
const card = (page, room) => page.locator('#dryingLogBody .drying-room[data-room="' + room + '"]');

test('readings are recorded per room with calculated GPP and kept with the job', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator('#logReading')).toBeVisible();
  await checkScope(page);
  const log = page.locator('#dryingLog');
  await expect(log).toBeVisible();
  await expect(page.locator('#dryingLogStatus')).toHaveText('No readings yet');
  await expect(log.locator('.empty')).toContainText('No drying readings yet');
  await expect(card(page, 'Room 1')).toContainText('No readings for this room yet.');
  await expect(card(page, '')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

  // Air reading: the dialog opens for the room, calculates as the technician types and saves.
  await card(page, 'Room 1').getByRole('button', { name: 'Add reading' }).click();
  const dialog = page.locator('#readingDialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#readingRoom')).toHaveValue('Room 1');
  await expect(page.locator('#readingTemp')).toBeFocused();
  await expect(page.locator('#readingTakenAt')).not.toHaveValue('');
  await expect(page.locator('#readingCalc')).toContainText('Enter temperature and humidity');
  await page.locator('#readingTemp').fill('74');
  await page.locator('#readingRh').fill('72');
  await expect(page.locator('#readingCalc')).toHaveText(
    '91 GPP · dew point 64°F · vapor pressure 0.609 inHg',
  );
  await page.locator('#readingTakenAt').fill('2026-10-21T09:30');
  await page.locator('#saveReading').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#message')).toHaveText('Reading saved.');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(
    'Affected air · 74°F · 72% RH → 91 GPP · dew point 64°F',
  );
  await expect(rows(page).first()).toContainText('synthetic@example.invalid');
  await expect(card(page, 'Room 1').locator('.drying-day h4')).toHaveText(/^Day 1 · /);
  await expect(card(page, 'Room 1').locator('.drying-day-summary')).toHaveText(
    'Affected 91 GPP · no dry reference air reading yet',
  );
  await expect(page.locator('#dryingLogStatus')).toHaveText('1 reading · 1 day');
  // Readings change nothing the revision, audit or signature bind to.
  expect(await page.evaluate(() => state.record.revision)).toBe(1);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');

  // A dry reference room elsewhere and the dehumidifier outlet give the day its comparisons.
  await page.locator('#addReading').click();
  await page.locator('#readingRoom').selectOption('');
  await page.locator('#readingZone').selectOption('unaffected');
  await page.locator('#readingTemp').fill('68');
  await page.locator('#readingRh').fill('45');
  await page.locator('#readingTakenAt').fill('2026-10-21T09:40');
  await page.locator('#saveReading').click();
  await expect(dialog).toBeHidden();
  // Walk & Photo offers the same dialog for the current room chip.
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await page.locator('#logReading').click();
  await expect(page.locator('#readingRoom')).toHaveValue('Room 1');
  await page.locator('#readingZone').selectOption('dehu_outlet');
  await page.locator('#readingTemp').fill('86');
  await page.locator('#readingRh').fill('36');
  await page.locator('#readingTakenAt').fill('2026-10-21T09:50');
  await page.locator('#saveReading').click();
  await expect(dialog).toBeHidden();
  await checkScope(page);
  await expect(card(page, 'Room 1').locator('.drying-day-summary')).toHaveText(
    'Affected 91 GPP · 45 GPP above the dry standard (46) · Dehumidifier Δ24 GPP · optimal · vapor pressure Δ0.158 inHg moderate',
  );
  await expect(card(page, '')).toContainText('Dry reference air · 68°F · 45% RH → 46 GPP');

  // Material and thermal readings carry their own fields and no calculated values.
  await card(page, 'Room 1').getByRole('button', { name: 'Add reading' }).click();
  await page.locator('#readingDialog input[name="readingKind"][value="material"]').check();
  await expect(page.locator('#readingTemp')).toBeHidden();
  await page.locator('#readingMaterial').fill('Drywall');
  await page.locator('#readingMoisture').fill('28');
  await page.locator('#readingDryStandard').fill('12');
  await page.locator('#readingTakenAt').fill('2026-10-22T10:00');
  await page.locator('#saveReading').click();
  await expect(dialog).toBeHidden();
  await card(page, 'Room 1').getByRole('button', { name: 'Add reading' }).click();
  await page.locator('#readingDialog input[name="readingKind"][value="thermal"]').check();
  await page.locator('#readingDeltaT').fill('-6.4');
  await page.locator('#readingBoundary').fill('Up 3 ft of the exterior wall');
  await page.locator('#readingTakenAt').fill('2026-10-22T10:05');
  await page.locator('#saveReading').click();
  await expect(dialog).toBeHidden();
  const second = card(page, 'Room 1').locator('.drying-day').nth(1);
  await expect(second.locator('h4')).toHaveText(/^Day 2 · /);
  await expect(second.locator('.reading')).toHaveText([
    /Drywall · 28 %MC · dry standard 12 %MC/,
    /Thermal ΔT -6.4°F · cold anomaly · Up 3 ft of the exterior wall/,
  ]);
  await expect(second.locator('.drying-day-summary')).toHaveCount(0);
  await expect(page.locator('#dryingLogStatus')).toHaveText('5 readings · 2 days');

  // Validation stays in the dialog; a blank form never reaches the server.
  await page.locator('#addReading').click();
  await page.locator('#saveReading').click();
  await expect(dialog).toBeVisible();
  await page.locator('#cancelReading').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#addReading')).toBeFocused();

  // The log is stored with the job: a reload shows the same rows, and removal is explicit.
  const id = await page.evaluate(() => state.draft.inspection_id);
  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  expect(await page.evaluate(() => state.draft.inspection_id)).toBe(id);
  await checkScope(page);
  await expect(rows(page)).toHaveCount(5);
  const saved = await page.request.get('/api/inspections/' + id + '/readings', {
    headers: { Authorization: 'Bearer test-owner-reload' },
  });
  expect(saved.status()).toBe(404);
  await rows(page).first().getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#message')).toHaveText('Reading removed.');
  await expect(rows(page)).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('an offline log reloads on reconnect and overlapping loads and removals keep the newest log', async ({
  page,
  context,
}) => {
  await open(page);
  await checkScope(page);
  for (const [time, temp] of [
    ['2026-10-21T09:30', '74'],
    ['2026-10-21T09:40', '75'],
    ['2026-10-21T09:50', '76'],
  ]) {
    await card(page, 'Room 1').getByRole('button', { name: 'Add reading' }).click();
    await page.locator('#readingTemp').fill(temp);
    await page.locator('#readingRh').fill('72');
    await page.locator('#readingTakenAt').fill(time);
    await page.locator('#saveReading').click();
    await expect(page.locator('#readingDialog')).toBeHidden();
  }
  await expect(rows(page)).toHaveCount(3);

  // Another job's readings never show under this one while its own log is not loaded.
  const own = await page.evaluate(() => {
    const id = state.draft.inspection_id;
    state.draft.inspection_id = 'f'.repeat(32);
    DryingLog.render();
    return id;
  });
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#dryingLogBody .empty')).toHaveText('Loading drying log…');
  await expect(page.locator('#addReading')).toBeDisabled();
  await page.evaluate((id) => {
    state.draft.inspection_id = id;
    DryingLog.render();
  }, own);
  await expect(rows(page)).toHaveCount(3);

  await context.setOffline(true);
  await page.evaluate(() => DryingLog.load());
  await expect(page.locator('#dryingLogBody .empty')).toContainText('You are offline');
  await expect(page.locator('#addReading')).toBeDisabled();
  await context.setOffline(false);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#addReading')).toBeEnabled();

  // Reopening the job while a removal is still on its way loads the log after it commits.
  let held = 'request';
  await page.route('**/readings/*', async (route) => {
    const stage = held;
    held = null;
    if (route.request().method() !== 'DELETE' || !stage) return route.continue();
    if (stage === 'request') {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route.continue();
    }
    // The removal commits on the server but its response arrives late.
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  await rows(page).nth(0).getByRole('button', { name: 'Remove' }).click();
  await page.evaluate(() => DryingLog.load());
  await expect(rows(page)).toHaveCount(2);
  await page.waitForTimeout(1200);
  await expect(rows(page)).toHaveCount(2);

  held = 'response';
  await rows(page).nth(0).getByRole('button', { name: 'Remove' }).click();
  await rows(page).nth(1).getByRole('button', { name: 'Remove' }).click();
  await expect(rows(page)).toHaveCount(0);
  await page.waitForTimeout(1200);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#dryingLogStatus')).toHaveText('No readings yet');
});

test('queued changes reach their own job after another opens, and a late save leaves a reopened dialog alone', async ({
  page,
}) => {
  await open(page);
  await checkScope(page);
  const dialog = page.locator('#readingDialog');
  for (const [time, temp] of [
    ['2026-10-21T09:30', '74'],
    ['2026-10-21T09:40', '75'],
    ['2026-10-21T09:50', '76'],
  ]) {
    await card(page, 'Room 1').getByRole('button', { name: 'Add reading' }).click();
    await page.locator('#readingTemp').fill(temp);
    await page.locator('#readingRh').fill('72');
    await page.locator('#readingTakenAt').fill(time);
    await page.locator('#saveReading').click();
    await expect(dialog).toBeHidden();
  }
  await expect(rows(page)).toHaveCount(3);
  const own = await page.evaluate(() => state.draft.inspection_id);

  // Two removals are queued behind a slow first one; another job opens before either is sent.
  const deletes = [];
  await page.route('**/readings/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletes.push(route.request().url());
    if (deletes.length === 1) await new Promise((resolve) => setTimeout(resolve, 800));
    return route.continue();
  });
  await rows(page).nth(0).getByRole('button', { name: 'Remove' }).click();
  await rows(page).nth(1).getByRole('button', { name: 'Remove' }).click();
  await page.evaluate(() => {
    state.draft.inspection_id = 'f'.repeat(32);
    DryingLog.render();
  });
  await expect.poll(() => deletes.length).toBe(2);
  await expect(rows(page)).toHaveCount(0);
  await page.evaluate((id) => {
    state.draft.inspection_id = id;
    return DryingLog.load();
  }, own);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('76°F');
  await page.unroute('**/readings/*');

  // A slow save is cancelled and the dialog reopened; its response leaves the new entry open.
  await page.route('**/readings', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  await page.locator('#addReading').click();
  await page.locator('#readingTemp').fill('70');
  await page.locator('#readingRh').fill('50');
  await page.locator('#saveReading').click();
  await expect(page.locator('#saveReading')).toBeDisabled();
  await page.locator('#cancelReading').click();
  await expect(dialog).toBeHidden();
  await page.locator('#addReading').click();
  await expect(page.locator('#saveReading')).toBeEnabled();
  await page.locator('#readingTemp').fill('81');
  await expect(page.locator('#message')).toHaveText('Reading saved.');
  await expect(rows(page)).toHaveCount(2);
  await expect(dialog).toBeVisible();
  await expect(page.locator('#readingTemp')).toHaveValue('81');
  await expect(page.locator('#saveReading')).toBeEnabled();
});

test('office staff read the drying log without recording controls', async ({ page, request }) => {
  const fixture = await (
    await request.post('/__test/workspaces', { data: { enabled: true } })
  ).json();
  try {
    const headers = {
      Authorization: 'Bearer test-owner-ws-estimator',
      'X-ADR-Workspace-Protocol': '1',
    };
    const saved = await request.post('/api/inspections/' + fixture.inspection_id + '/readings', {
      headers,
      data: {
        reading: {
          kind: 'air',
          room: 'Bathroom',
          zone: 'affected',
          temperature_f: 76,
          relative_humidity: 52,
          taken_at: '2026-10-21T16:00:00Z',
        },
      },
    });
    expect(saved.status()).toBe(200);
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      'test-owner-ws-office',
    );
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page
      .locator('#dashboardContent')
      .getByRole('button', { name: /Assigned bathroom/ })
      .click();
    await checkScope(page);
    await expect(page.locator('#dryingLog')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('76°F · 52% RH → 70 GPP');
    await expect(rows(page).first()).toContainText('test-owner-ws-estimator@example.invalid');
    await expect(page.locator('#addReading')).toBeHidden();
    await expect(page.locator('#dryingLogBody button')).toHaveCount(0);
    await expect(page.locator('#logReading')).toBeDisabled();
  } finally {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  }
});
