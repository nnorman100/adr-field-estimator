const { test, expect } = require('@playwright/test');
const {
  csvRows,
  csvText,
  start,
  navigate,
  startUnset,
  priceEverything,
  publishTable,
  registerPriceHooks,
} = require('./prices-support');
registerPriceHooks();

const AREA_BASIS_MEANINGS = [
  [
    'Raw demolition area',
    'The square feet of material being removed in each room, added up, before any waste is added. Items set to Rooms: job area price from it. The flat cushion counts the square feet on each line priced by area, including items such as antimicrobial. It does not change how a high end built from the IICRC equipment range works.',
  ],
  [
    'Demolition area with waste',
    "The same square feet, plus each room's waste percent, or the item's if the room has none. A 100 sq ft room with 10% waste counts as 110 sq ft. This fills the flat cushion's first square feet sooner and does not change any item's price. It does not change how a high end built from the IICRC equipment range works.",
  ],
  [
    'Wet floor area',
    "The square feet of floor that got wet in each room, whether or not any of it is removed. A blank wet floor area uses the room's floor area. This only applies to items set to Rooms: job area. It does not change the flat cushion or how a high end built from the IICRC equipment range works.",
  ],
];
const CABINETRY_MEANINGS = [
  [
    'Custom cabinetry',
    'How much to multiply the demolition price in a Category 3 room when the technician ticks custom cabinetry. 1.0 adds nothing. 2.0 doubles it: 100 sq ft at $10 goes from $1,000 to $2,000.',
  ],
  [
    'Cabinetry applies to',
    "Finished-surface demolition only raises just the finished area in that room. All category 3 room lines raises every line priced from that room's square feet: finished and unfinished demolition, and wet floor and floor items such as antimicrobial and HEPA vacuuming. Items not priced from the room, such as equipment and labor hours, never change.",
  ],
];
const SETTING_MEANINGS = [...AREA_BASIS_MEANINGS, ...CABINETRY_MEANINGS];
const explain = (page, subject) => page.getByRole('button', { name: 'Explain ' + subject });
// What the icon sits above: the choice's own label, or the whole setting for cabinetry.
const explainedSetting = (page, subject) =>
  AREA_BASIS_MEANINGS.some(([name]) => name === subject)
    ? page.getByRole('group', { name: 'Area basis' }).getByText(subject, { exact: true })
    : subject === 'Custom cabinetry'
      ? page.locator('label.price-field', { hasText: subject })
      : page.getByRole('group', { name: subject });

async function expectQuestionIcons(page, activate) {
  await expect(page.locator('#priceEditor .price-help')).toHaveCount(SETTING_MEANINGS.length);
  for (const [subject, meaning] of SETTING_MEANINGS) {
    const icon = explain(page, subject),
      text = page.locator('#' + (await icon.getAttribute('aria-controls')));
    await expect(text).toBeHidden();
    await expect(icon).toHaveAttribute('aria-expanded', 'false');
    await icon.scrollIntoViewIfNeeded();
    const own = await icon.boundingBox(),
      setting = await explainedSetting(page, subject).boundingBox();
    expect(own.width).toBeGreaterThanOrEqual(48);
    expect(own.height).toBeGreaterThanOrEqual(48);
    expect(own.y + own.height).toBeLessThanOrEqual(setting.y + 1);
    await activate(icon);
    await expect(text).toBeVisible();
    await expect(text).toHaveText(meaning);
    await expect(icon).toHaveAttribute('aria-expanded', 'true');
    await activate(icon);
    await expect(text).toBeHidden();
    await expect(icon).toHaveAttribute('aria-expanded', 'false');
  }
}

for (const [width, height] of [
  [390, 844],
  [1280, 800],
]) {
  test.describe(`the settings question icons at ${width} px`, () => {
    test.use({ viewport: { width, height }, hasTouch: true });
    test('explain each setting by touch and keyboard and only those settings have one', async ({
      page,
      request,
    }) => {
      await startUnset(page, request);
      await expectQuestionIcons(page, (icon) => icon.tap());
      await expectQuestionIcons(page, async (icon) => {
        await icon.focus();
        await page.keyboard.press('Enter');
      });
      await expectQuestionIcons(page, async (icon) => {
        await icon.focus();
        await page.keyboard.press('Space');
      });
      // With every definition open the page still fits the screen.
      for (const [subject] of SETTING_MEANINGS) await explain(page, subject).click();
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways).toBeLessThanOrEqual(0);
    });
  });
}

test('the three area choices save, reach the review and keep demolition as the default', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  const group = page.getByRole('group', { name: 'Area basis' });
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expect(group.getByLabel('Raw demolition area')).toBeChecked();
  await priceEverything(page);
  await publishTable(page);
  // Reading a definition is not an edit.
  await explain(page, 'Demolition area with waste').click();
  await expect(group.getByLabel('Raw demolition area')).toBeChecked();
  await expect(page.locator('#priceUnpublished')).toBeHidden();

  await group.getByLabel('Demolition area with waste').check();
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await navigate(page, 'dashboardPrices');
  await expect(
    page.getByRole('group', { name: 'Area basis' }).getByLabel('Demolition area with waste'),
  ).toBeChecked();
  await page.locator('#priceReason').fill('Count waste in the area');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText(
    'Area basis: raw demolition area to demolition area with waste',
  );
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v2');
});

test('a reader cannot change the area choice and can still read what it means', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  await start(page, 'estimator');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#dashboardContent')).toContainText('Read only');
  await expect(page.getByLabel('Demolition area with waste')).toBeDisabled();
  await expectQuestionIcons(page, (icon) => icon.click());
});

test.describe('leaving the page during a slow review', () => {
  test.use({ serviceWorkers: 'block' });
  test('puts no review or Publish button on the next page', async ({ page, request }) => {
    await startUnset(page, request);
    await priceEverything(page);
    await publishTable(page);
    const slowly = async (url, start) => {
      let release;
      const held = new Promise((resolve) => (release = resolve));
      await page.route(url, async (route) => {
        await held;
        await route.fulfill({ json: { no_changes: true, diff: { items: [], policy: [] } } });
      });
      const answered = page.waitForResponse(url);
      await start();
      await navigate(page, 'dashboardTeam');
      await expect(page.locator('#priceEditor')).toHaveCount(0);
      release();
      await answered;
      await page.waitForTimeout(200);
      await expect(page.locator('#priceReview')).toHaveCount(0);
      await page.unroute(url);
      await navigate(page, 'dashboardPrices');
      await expect(page.locator('#priceEditor')).toBeVisible();
    };
    await slowly('**/prices/preview', async () => {
      await page.locator('#priceReason').fill('Slow review');
      await page.getByRole('button', { name: 'Review changes' }).click();
    });
    await slowly('**/prices/import-preview', async () => {
      await page.locator('#priceImportFile').setInputFiles({
        name: 'prices.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('x\n'),
      });
      await page.locator('#priceImportReason').fill('Slow import');
      await page.getByRole('button', { name: 'Import prices' }).click();
    });
    await slowly('**/restore', async () => {
      await page
        .getByPlaceholder(/Reason for restoring/)
        .first()
        .fill('Slow restore');
      await page
        .getByRole('button', { name: /^Restore / })
        .first()
        .click();
    });
  });
});

test('an import that raises a waste shows it in the review', async ({ page, request }) => {
  await request.post('/__test/workspaces', {
    data: {
      enabled: true,
      price_books: true,
      other_prices: false,
      ai_features: ['priced_extras'],
    },
  });
  await start(page, 'other');
  await navigate(page, 'dashboardPrices');
  await priceEverything(page);
  await publishTable(page);
  const template = await page.evaluate(async () => {
    const base = '/api/companies/' + state.session.company_id + '/prices';
    return (await api(base + '/export?format=csv')).text();
  });
  const [header, ...body] = csvRows(template.replace(/^\ufeff/, '')),
    row = body.find((line) => line[header.indexOf('item_id')] === 'air_mover');
  row[header.indexOf('waste_percent')] = '50';
  await page.locator('#priceImportFile').setInputFiles({
    name: 'prices.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvText([header, ...body]) + '\n'),
  });
  await page.locator('#priceImportReason').fill('Waste from the spreadsheet');
  await page.getByRole('button', { name: 'Import prices' }).click();
  await expect(page.locator('#priceReview')).toContainText(
    /Air mover.*waste 0(\.00)?% -> 50(\.00)?%/,
  );
});

test('adding a second additional-work item keeps the editor saving', async ({ page, request }) => {
  await startUnset(page, request);
  const extras = page.locator('details.price-group[data-group=extras]');
  await extras.locator('> summary').click();
  await extras.getByLabel('New item name in Additional work').fill('Night work');
  await extras.getByRole('button', { name: 'Add item' }).click();
  const added = page.locator('[data-price-item=night_work]');
  await expect(added.getByLabel('Used on estimates')).not.toBeChecked();
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.locator('input[name=price_service_call]').fill('150');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
});

test('real sample totals show under the settings and before and after in the review', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  const samples = page.locator('#priceSamples');
  await page.locator('input[name=price_service_call]').fill('150');
  await expect(samples).toContainText('Clean-water kitchen leak prices at $');
  await expect(samples).toContainText('Items with no price are left out.');
  await expect(samples).toContainText('Sample job only. This does not price a saved job.');

  await priceEverything(page);
  await publishTable(page);
  await expect(samples).toContainText('Gray-water main floor prices at $');
  await expect(samples).not.toContainText('left out');
  const before = await samples.locator('p').first().textContent();
  await page.locator('details.price-group[data-group=labor] > summary').click();
  await page.locator('input[name=price_technician_labor]').fill('100');
  await expect(samples.locator('p').first()).not.toHaveText(before);
  await page.locator('#priceReason').fill('Raise the labor rate');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const review = page.locator('#priceReview');
  await expect(review).toContainText('Before: ' + before);
  await expect(review).toContainText('After: Gray-water main floor prices at $');
  await expect(review).toContainText('Sample job only. This does not price a saved job.');
});

test('after a dropped connection the sample line catches up with the saved edit', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  const line = page.locator('#priceSamples p').first(),
    status = page.locator('#priceSaveStatus'),
    call = page.locator('input[name=price_service_call]');
  await call.fill('150');
  await expect(line).toContainText(' prices at $');
  await expect(status).toContainText('Saved');
  const before = await line.textContent();
  await call.fill('175');
  await page.context().setOffline(true);
  await expect(status).toContainText('Not saved');
  // Past the edit's sample delay, so only the reconnect can bring the line up to date.
  await page.waitForTimeout(1500);
  await expect(line).toHaveText(before);
  await page.context().setOffline(false);
  await expect(status).toContainText('Saved');
  await expect(line).not.toHaveText(before);
  const caughtUp = await line.textContent();
  await page.reload();
  await navigate(page, 'dashboardPrices');
  await expect(call).toHaveValue('175.00');
  await expect(line).toHaveText(caughtUp);
});

test('correcting the reason closes the review, so history keeps the corrected reason', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  await page.locator('input[name=price_service_call]').fill('11');
  const reason = page.locator('#priceReason');
  await reason.fill('Spring prces');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toBeVisible();
  await reason.fill('Spring prices');
  await expect(page.locator('#priceReview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v2');
  await expect(page.locator('#dashboardContent')).toContainText('Spring prices');
  await expect(page.locator('#dashboardContent')).not.toContainText('Spring prces');
});

test.describe('a slow sample answer', () => {
  test.use({ serviceWorkers: 'block' });
  test('never replaces a newer one', async ({ page, request }) => {
    await startUnset(page, request);
    const answer = (label) => ({
      json: {
        problems: [],
        samples: [{ key: 'medium', label, low: '$1.00', high: null, notice: 'Sample job only.' }],
      },
    });
    let calls = 0,
      release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/prices/calculate', async (route) => {
      calls += 1;
      if (calls === 1) {
        await held;
        await route.fulfill(answer('Older sample'));
      } else await route.fulfill(answer('Newer sample'));
    });
    const call = page.locator('input[name=price_service_call]');
    await call.fill('40');
    await expect.poll(() => calls).toBe(1);
    await call.fill('41');
    const samples = page.locator('#priceSamples');
    await expect(samples).toContainText('Newer sample');
    const older = page.waitForResponse('**/prices/calculate');
    release();
    await older;
    await page.waitForTimeout(200);
    await expect(samples).toContainText('Newer sample');
    await expect(samples).not.toContainText('Older sample');
  });
  // A browser's own scroll anchoring cannot be relied on: WebKit lost about one timed tap in four
  // to it, too rarely to test directly. With it switched off, only the app can hold the button.
  for (const [width, anchoring] of [
    [1280, 'off'],
    [390, 'off'],
    [1280, 'on'],
    [390, 'on'],
  ]) {
    test(`landing mid-tap leaves Publish prices under the finger at ${width}px, browser anchoring ${anchoring}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await startUnset(page, request);
      if (anchoring === 'off') await page.addStyleTag({ content: '* { overflow-anchor: none; }' });
      let release;
      const held = new Promise((resolve) => (release = resolve));
      await page.route('**/prices/calculate', async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
      const asked = page.waitForRequest('**/prices/calculate');
      await priceEverything(page);
      await asked;
      const line = page.locator('#priceSamples p').first();
      await expect(line).toBeHidden();

      await page.locator('#priceReason').fill('First price table');
      await page.getByRole('button', { name: 'Review changes' }).click();
      const publish = page.getByRole('button', { name: 'Publish prices' });
      await publish.scrollIntoViewIfNeeded();
      const before = await publish.boundingBox();
      const x = before.x + before.width / 2,
        y = before.y + before.height / 2;
      // The watcher is in place before the answer is let go, or it could miss the paint it measures.
      await publish.evaluate(
        (button, point) => {
          window.firstInstant = new Promise((done) => {
            new MutationObserver((_, watcher) => {
              watcher.disconnect();
              done({
                top: button.getBoundingClientRect().top,
                underFinger: button.contains(document.elementFromPoint(point.x, point.y)),
              });
            }).observe(document.getElementById('priceSamples'), { childList: true });
          });
        },
        { x, y },
      );
      await page.mouse.move(x, y);
      await page.mouse.down();
      release();
      const landed = await page.evaluate(() => window.firstInstant);
      expect(landed.underFinger).toBe(true);
      expect(Math.abs(landed.top - before.y)).toBeLessThan(1);
      // Two frames, so any adjustment the browser makes on its own has happened as well.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const settled = await publish.boundingBox();
      expect(Math.abs(settled.y - before.y)).toBeLessThan(1);
      await page.mouse.up();
      await expect(page.locator('#dashboardContent')).toContainText('Prices v1');
    });
  }
  test('landing does not scroll the settings an owner is still editing', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startUnset(page, request);
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/prices/calculate', async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const asked = page.waitForRequest('**/prices/calculate');
    await priceEverything(page);
    await asked;
    const samples = page.locator('#priceSamples');
    await samples.evaluate((box) => box.parentElement.scrollIntoView({ block: 'end' }));
    const reason = await page.locator('#priceReason').boundingBox();
    expect(reason.y).toBeGreaterThan(844);
    const scrolled = await page.evaluate(() => window.scrollY);
    release();
    await expect(samples.locator('p').first()).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  });
});

test("a v2 job's after-hours sentence has the table's percent whichever code answers first", async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', {
    data: {
      items: { after_hours_charge: { unit_price: '200.00' } },
      policy: { after_hours: { multiplier: '1.250' } },
    },
  });
  await start(page, 'owner');
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('.task-nav [data-task="property"]').click();
  const sentence = page.locator('#afterHoursLabelV2');
  await expect(sentence).toContainText('$200.00');
  await expect(sentence).toContainText('25% on labor and materials');
  await expect(sentence).not.toContainText('20%');

  // The job's pricing answers after the form was built.
  await page.evaluate(() => Prices.noteJob());
  await expect(sentence).toContainText('25% on labor and materials');
  await expect(page.locator('#afterHoursLabel')).toHaveCount(0);

  // It answers before the form is built: nothing is written, and the form then sets the sentence.
  const written = await page.evaluate(async () => {
    const label = document.getElementById('afterHoursLabelV2');
    label.id = 'afterHoursLabel';
    label.textContent = 'not built yet';
    await Prices.noteJob();
    return label.textContent;
  });
  expect(written).toBe('not built yet');
  await page.evaluate(() => ScopeItems.refresh());
  await expect(sentence).toContainText('25% on labor and materials');
});

test('the owner sets the drying days a new job starts at, and a publish carries it to a new job', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', { data: {} });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  const days = page.locator('input[name="policy_assist.drying_days"]');
  await expect(days).toHaveValue('3');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await days.fill('61');
  await expect(page.locator('#priceSaveStatus')).toContainText(
    'Settings: assist.drying_days must be an integer from 1 to 60.',
  );
  await days.fill('5');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await page.locator('#priceReason').fill('Longer default drying');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText(
    'Drying days a new job starts at: 3 to 5',
  );
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v2');

  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  const saved = await page.evaluate(() => state.record.data);
  expect(saved.drying_days).toBe(5);
  // A starting value is not a measured one, so changing it needs no reason.
  expect(saved.quantity_overrides?.drying_days).toBeUndefined();
});

test('a table published before the setting shows the old value and no unpublished changes', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', { data: { policy: { assist: null } } });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  const days = page.locator('input[name="policy_assist.drying_days"]');
  await expect(days).toHaveValue('3');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  // Changing it and going back is no change, though the working copy now holds the full map.
  await days.fill('4');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await days.fill('3');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
});

test('the owner chooses how the high end is built, and the sample and review follow', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', {
    data: { policy: { assist: { range_method: 'cushion' } } },
  });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  const cushion = page.locator('input[name="policy_range.first_percent"]');
  const extra = page.locator('input[name="policy_assist.extra_drying_days"]');
  const percent = (category) =>
    page.locator(`input[name="policy_assist.hidden_damage_percent.${category}"]`);
  const method = (value) => page.locator(`input[name=range_method][value=${value}]`);
  const samples = page.locator('#priceSamples');
  await expect(method('cushion')).toBeChecked();
  await expect(cushion).toBeVisible();
  await expect(extra).toBeHidden();
  await expect(percent(1)).toBeHidden();
  await expect(samples).toContainText('Clean-water kitchen leak prices at');
  const before = await samples.innerText();

  await method('uncertainty').check();
  await expect(cushion).toBeHidden();
  await expect(extra).toBeVisible();
  for (const category of [1, 2, 3]) await expect(percent(category)).toBeVisible();
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(samples).not.toHaveText(before);

  await extra.fill('31');
  await expect(page.locator('#priceSaveStatus')).toContainText(
    'Settings: assist.extra_drying_days must be an integer from 0 to 30.',
  );
  await extra.fill('2');
  await percent(2).fill('20');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  const stored = await samples.innerText();
  await percent(2).fill('60');
  await expect(samples).not.toHaveText(stored);

  await page.locator('#priceReason').fill('Build the high end from the job');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const review = page.locator('#priceReview');
  await expect(review).toContainText(
    'How the high end is built: a flat cushion to the IICRC equipment range and hidden damage',
  );
  await expect(review).toContainText('Extra drying days on the high end: 1 to 2');
  await expect(review).toContainText('Hidden damage in category 2 rooms (%): 15 to 60');
  await expect(review).toContainText('A price or setting changed by a lot');
});

test('one price hides the high-end settings, and a change of mode brings them back', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', { data: {} });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  const method = page.locator('input[name=range_method]');
  const extra = page.locator('input[name="policy_assist.extra_drying_days"]');
  const days = page.locator('input[name="policy_assist.drying_days"]');
  const cushion = page.locator('input[name="policy_range.first_percent"]');
  // A new company's table starts on the method with its starter settings.
  await expect(page.locator('input[name=range_method][value=uncertainty]')).toBeChecked();
  await expect(extra).toHaveValue('1');
  await expect(cushion).toBeHidden();

  await page.locator('input[name=estimate_mode][value=single]').check();
  await expect(days).toBeVisible();
  await expect(method.first()).toBeHidden();
  await expect(extra).toBeHidden();
  await expect(cushion).toBeHidden();

  await page.locator('input[name=estimate_mode][value=range]').check();
  await expect(method.first()).toBeVisible();
  await expect(extra).toBeVisible();
  await expect(cushion).toBeHidden();
});

test('a table published before the settings shows the cushion and no unpublished changes', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', { data: { policy: { assist: null } } });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('input[name=range_method][value=cushion]')).toBeChecked();
  await expect(page.locator('input[name="policy_range.first_percent"]')).toBeVisible();
  await expect(page.locator('input[name="policy_assist.extra_drying_days"]')).toHaveValue('0');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
});
