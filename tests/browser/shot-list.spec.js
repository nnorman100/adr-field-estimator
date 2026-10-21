const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

// The per-room photo shot list on an iPhone-sized touch viewport against the synthetic backend.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const shots = (page) => page.locator('#shotList .shot-items li');
async function open(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function addImage(page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 300;
    canvas.getContext('2d').fillRect(0, 0, 100, 150);
    return canvas.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
}
const settled = (page) =>
  page.evaluate(async () => {
    await syncChain.catch(() => {});
    await Promise.all([...state.ocr.values()]);
    return state.record.photos.map((photo) => photo.shot || null);
  });

test('a new photo is tagged from the quick picker and the room shot list counts only tags', async ({
  page,
}) => {
  await open(page);
  await expect(shots(page)).toHaveText([
    'MissingRoom overview',
    'MissingAffected wall or floor',
    'MissingMeter reading',
  ]);
  // Until the technician counts surfaces and wet materials, one photo of each is asked for.
  await expect(page.locator('#shotList .shot-unset')).toHaveText(
    'Set how many affected walls or floors and wet materials so each one gets its photo.',
  );
  await expect(page.locator('#shotList [data-shot-count="affected_surfaces"]')).toHaveValue('');
  await expect(page.locator('#shotPicker')).toBeHidden();
  await addImage(page);
  // The picker offers the shots this room still needs first.
  await expect(page.locator('#shotPicker')).toBeVisible();
  await expect(page.locator('#shotPickerLabel')).toHaveText('Tag this Room 1 photo');
  await expect(page.locator('#shotPickerChoices button')).toHaveText([
    'Room overview',
    'Affected wall or floor',
    'Meter reading',
    'Source of loss',
    'Contents before moving',
    'Equipment as placed',
  ]);
  await expect(page.locator('#shotList')).toContainText('1 untagged photo');
  await page.locator('#shotPickerChoices').getByRole('button', { name: 'Room overview' }).click();
  await expect(page.locator('#shotPicker')).toBeHidden();
  await expect(shots(page).first()).toHaveText('✓ TaggedRoom overview');
  await expect(page.locator('#shotList')).not.toContainText('untagged');
  await expect.poll(() => settled(page)).toEqual(['overview']);
  // A room answer adds its shot without touching the scope confirmation.
  await page.locator('#shotList [data-shot-flag="source_of_loss"]').check();
  await expect(shots(page)).toHaveText([
    '✓ TaggedRoom overview',
    'MissingSource of loss',
    'MissingAffected wall or floor',
    'MissingMeter reading',
  ]);
  // A second photo is skipped, then tagged on its card.
  await addImage(page);
  await page.locator('#skipShotTag').click();
  await expect(page.locator('#shotPicker')).toBeHidden();
  await expect(page.locator('#shotList')).toContainText('1 untagged photo');
  await page.locator('#photoGallery .photo .photo-shot').nth(1).selectOption('source');
  await expect.poll(() => settled(page)).toEqual(['overview', 'source']);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // Reloading reads the saved answers and tags back without a revision conflict.
  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect(shots(page)).toHaveText([
    '✓ TaggedRoom overview',
    '✓ TaggedSource of loss',
    'MissingAffected wall or floor',
    'MissingMeter reading',
  ]);
  await expect(page.locator('#photoGallery .photo .photo-shot').nth(0)).toHaveValue('overview');
  await expect(page.locator('#photoGallery .photo .photo-shot').nth(1)).toHaveValue('source');
  // Check Scope's room card carries the same list and answers.
  await page.locator('.task-nav [data-task="property"]').click();
  const card = page.locator('#rooms .room').first();
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 2 missing');
  await card.locator('.shot-drawer > summary').click();
  await expect(card.locator('[data-shot-flag="source_of_loss"]')).toBeChecked();
  await expect(card.locator('.shot-items li')).toHaveText([
    '✓ TaggedRoom overview',
    '✓ TaggedSource of loss',
    'MissingAffected wall or floor',
    'MissingMeter reading',
  ]);
  // Each affected surface and wet material needs its own tagged photo once they are counted.
  const surfaces = card.locator('[data-shot-count="affected_surfaces"]');
  await surfaces.fill('2');
  await surfaces.blur();
  await expect(card.locator('.shot-items li')).toHaveText([
    '✓ TaggedRoom overview',
    '✓ TaggedSource of loss',
    '0 of 2Affected wall or floor',
    'MissingMeter reading',
  ]);
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 3 missing');
  await expect(card.locator('.shot-unset')).toHaveText(
    'Set how many wet materials so each one gets its photo.',
  );
  // No wet material in the room means no meter shot is asked for.
  const wet = card.locator('[data-shot-count="wet_materials"]');
  await wet.fill('0');
  await wet.blur();
  await expect(card.locator('.shot-items li')).toHaveText([
    '✓ TaggedRoom overview',
    '✓ TaggedSource of loss',
    '0 of 2Affected wall or floor',
  ]);
  await expect(card.locator('.shot-unset')).toHaveCount(0);
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 2 missing');
  // Clearing a tag counts the photo as untagged again.
  await card.locator('.photo .photo-shot').first().selectOption('');
  await expect(card.locator('.shot-items li').first()).toHaveText('MissingRoom overview');
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 3 missing');
  await expect.poll(() => settled(page)).toEqual([null, 'source']);
  // One of the two affected surfaces photographed still leaves one missing.
  await card.locator('.photo .photo-shot').first().selectOption('surface');
  await expect(card.locator('.shot-items li')).toHaveText([
    'MissingRoom overview',
    '✓ TaggedSource of loss',
    '1 of 2Affected wall or floor',
  ]);
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 2 missing');
  await expect.poll(() => settled(page)).toEqual(['surface', 'source']);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  const room = await page.evaluate(() => state.record.data.rooms[0]);
  expect([room.affected_surfaces, room.wet_materials]).toEqual([2, 0]);
  // The counts read back after a reload without a revision conflict.
  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect(shots(page)).toHaveText([
    'MissingRoom overview',
    '✓ TaggedSource of loss',
    '1 of 2Affected wall or floor',
  ]);
  await expect(page.locator('#shotList [data-shot-count="affected_surfaces"]')).toHaveValue('2');
});

test('a conflict fork keeps each photo tag on its uploaded copy', async ({ page }) => {
  await open(page);
  await addImage(page);
  await page.locator('#shotPickerChoices').getByRole('button', { name: 'Meter reading' }).click();
  await expect.poll(() => settled(page)).toEqual(['meter']);
  const first = await page.evaluate(() => state.record.inspection_id);
  // Another device changes the saved job, so this device's next save conflicts.
  await page.evaluate(async (id) => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('synthetic-uid'),
      'Content-Type': 'application/json',
    };
    const r = await (await fetch('/api/inspections/' + id, { headers })).json();
    r.data.technician_notes = 'Other device changed the scope';
    await fetch('/api/inspections/' + id, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expected_revision: r.revision, data: r.data }),
    });
  }, first);
  await checkScope(page);
  await page.locator('#technicianNotes').fill('Keep this device work and photo');
  await saveDraft(page);
  await expect(page.locator('#conflictActions')).toBeVisible();
  await page.locator('#forkLocal').click();
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // The copy uploads untagged and its tag follows, so the new job keeps the meter shot.
  await expect.poll(() => settled(page)).toEqual(['meter']);
  expect(await page.evaluate(() => state.record.inspection_id)).not.toBe(first);
});
