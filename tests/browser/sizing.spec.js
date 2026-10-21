const { test, expect } = require('@playwright/test');
const { checkScope } = require('./actions');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const room = (page, key) => page.locator('[data-room-index="0"][data-room-key="' + key + '"]');
const row = (page, label) => page.locator('#sizingResult .sizing-row').filter({ hasText: label });
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await checkScope(page);
  await page.locator('#address').fill('Synthetic sizing property');
  await page.locator('#yearBuilt').fill('1998');
  await room(page, 'finished_sf').fill('40');
  await page.locator('#airMovers').fill('6');
  await page.locator('#dehumidifiers').fill('1');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}

test('Check Scope compares entered equipment with the server sizing check and survives reload', async ({
  page,
  browserName,
}) => {
  await ready(page);
  // More equipment & labor stays closed; its summary line says why there is no comparison yet.
  const equipment = page.locator('details.more-equipment');
  await expect(equipment).not.toHaveAttribute('open', '');
  await expect(equipment.locator('summary')).toHaveText(
    'More equipment & labor · sizing check not available',
  );
  await expect(page.locator('#sizingResult')).toHaveText(
    'Check not available. Add the floor area, ceiling height and water class under More room options for Room 1.',
  );
  const drawer = page.locator('#rooms .room-sizing').first(),
    more = page.locator('#rooms .room-more').first();
  await expect(drawer.locator('.summary-note')).toHaveText(
    '· check not available · add floor area, ceiling height and water class',
  );
  await more.locator('summary').click();
  await room(page, 'floor_sf').fill('140');
  await room(page, 'ceiling_height_ft').fill('8');
  await room(page, 'water_class').selectOption('2');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(drawer.locator('.summary-note')).toHaveText('· 3–4 air movers · 22.4 pints/day');
  await expect(room(page, 'wet_floor_sf')).toHaveAttribute('placeholder', 'Whole floor');
  await expect(page.locator('#sizingNote')).toHaveText('· Air movers above');
  await expect(page.locator('#sizingNote')).toHaveAttribute('data-flagged', 'true');
  await equipment.locator('summary').click();
  await expect(page.locator('#sizingCheck')).toBeVisible();
  await expect(row(page, 'Air movers')).toContainText('AboveRecommended 3–4 · Entered 6');
  await expect(row(page, 'Air movers').locator('.sizing-flag')).toHaveAttribute(
    'data-flag',
    'above',
  );
  await expect(row(page, 'Dehumidification')).toContainText(
    'Recommended 23 pints/day · Entered 1 LGR dehumidifier',
  );
  await expect(row(page, 'Dehumidification').locator('.sizing-flag')).toHaveCount(0);
  await page.locator('#dehumidifierPpd').fill('70');
  await page.locator('#airMovers').fill('2');
  // Unsaved edits never show a result for different counts.
  await expect(page.locator('#sizingResult')).toHaveText('The check updates once the draft saves.');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(row(page, 'Air movers').locator('.sizing-flag')).toHaveText('Below');
  await expect(row(page, 'Dehumidification').locator('.sizing-flag')).toHaveText('Within range');
  await expect(page.locator('#sizingNote')).toHaveText(
    '· Air movers below · Dehumidification within range',
  );
  // The check never changes the technician's counts.
  await expect(page.locator('#airMovers')).toHaveValue('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (browserName === 'chromium') {
    await equipment.screenshot({ path: test.info().outputPath('sizing.png') });
    await page
      .locator('#rooms .room')
      .first()
      .screenshot({ path: test.info().outputPath('sizing-room.png') });
  }

  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
  await expect(room(page, 'floor_sf')).toHaveValue('140');
  await expect(room(page, 'water_class')).toHaveValue('2');
  await expect(page.locator('#dehumidifierPpd')).toHaveValue('70');
  await expect(row(page, 'Air movers').locator('.sizing-flag')).toHaveText('Below');
  // A later edit still saves, so the reloaded draft is not a revision conflict.
  await page.locator('#rooms .room-more summary').first().click();
  await room(page, 'ceiling_height_ft').fill('8.5');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#conflictActions')).toBeHidden();

  await page.locator('#scopeConfirmed').check();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  const letter = await page.evaluate(() => state.documents.iicrc_defense_letter);
  expect(letter).toContain('Room 1: 140 SF floor × 8.5 ft ceiling = 1,190 cu ft, water class 2.');
  expect(letter).toContain(
    'Entered for this proposal: 2 air movers and 1 LGR dehumidifier rated 70 pints/day each.',
  );
});

test('a mold-only room has no drying check and clearing an input makes it unavailable again', async ({
  page,
}) => {
  await ready(page);
  const drawer = page.locator('#rooms .room-sizing').first(),
    more = page.locator('#rooms .room-more').first();
  await more.locator('summary').click();
  await room(page, 'floor_sf').fill('140');
  await room(page, 'ceiling_height_ft').fill('8');
  await room(page, 'water_class').selectOption('3');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(drawer.locator('.summary-note')).toHaveText('· 3–4 air movers · 28 pints/day');
  // Only part of the floor is wet: the air movers follow it, and a larger area is not checked.
  await room(page, 'wet_floor_sf').fill('40');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(drawer.locator('.summary-note')).toHaveText('· 2 air movers · 28 pints/day');
  await room(page, 'wet_floor_sf').fill('200');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(drawer.locator('.summary-note')).toHaveText(
    '· check not available · the wet floor area is larger than the floor area',
  );
  await room(page, 'wet_floor_sf').fill('');
  await room(page, 'water_class').selectOption('');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(drawer.locator('.summary-note')).toHaveText(
    '· check not available · add water class',
  );
  expect(await page.evaluate(() => 'water_class' in state.record.data.rooms[0])).toBe(false);
  await page.locator('#rooms .loss-pill', { hasText: /^Mold$/ }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#sizingResult')).toHaveText(
    'No water rooms. The drying check applies to rooms with water.',
  );
  await expect(page.locator('#sizingNote')).toHaveText('· no water rooms to size');
});
