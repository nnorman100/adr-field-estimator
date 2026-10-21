const { test, expect } = require('@playwright/test');

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
  // Clearing a tag counts the photo as untagged again.
  await card.locator('.photo .photo-shot').first().selectOption('');
  await expect(card.locator('.shot-items li').first()).toHaveText('MissingRoom overview');
  await expect(card.locator('.shot-drawer > summary')).toHaveText('Photo shots · 3 missing');
  await expect.poll(() => settled(page)).toEqual([null, 'source']);
});

test('the photo log groups tagged photos by shot type and keeps their numbers', async ({
  page,
}) => {
  await open(page);
  const headings = await page.evaluate(() => {
    const photo = (id, room, shot_label) => ({
      id,
      room,
      captured_at: '2026-10-21T19:00:00Z',
      width: 10,
      height: 10,
      ocr_status: 'no_meter',
      ...(shot_label ? { shot_label } : {}),
    });
    const log = [
      photo('a', 'Kitchen', 'Meter reading'),
      photo('b', 'Kitchen'),
      photo('c', 'Hall', 'Room overview'),
      photo('d', 'Kitchen', 'Room overview'),
    ];
    const docs = {
      adr_estimate: {
        property_address: '1 Test Way',
        proposed_cost: 100,
        proposed_cost_low: 90,
        findings: [],
        recommendations: [],
        disclaimers: [],
      },
      xactimate_scope: [],
      xactimate_total: 90,
      iicrc_defense_letter: '',
      photo_audit_log: log,
    };
    const read = () =>
      [...document.querySelectorAll('#photoAuditLog > *')].map((el) =>
        el.tagName === 'H3' ? '# ' + el.textContent : el.querySelector('p').textContent,
      );
    ADRDocuments.render(docs, log, () => '');
    const grouped = read();
    // A log saved before the shot list has no tags and keeps its plain numbered order.
    ADRDocuments.render(
      { ...docs, photo_audit_log: log.map((entry) => ({ ...entry, shot_label: undefined })) },
      log,
      () => '',
    );
    return { grouped, plain: read() };
  });
  expect(headings.grouped).toEqual([
    '# Room overview',
    'Photo 3 (Hall)',
    'Photo 4 (Kitchen)',
    '# Meter reading',
    'Photo 1 (Kitchen)',
    '# Untagged photos',
    'Photo 2 (Kitchen)',
  ]);
  expect(headings.plain).toEqual([
    'Photo 1 (Kitchen)',
    'Photo 2 (Kitchen)',
    'Photo 3 (Hall)',
    'Photo 4 (Kitchen)',
  ]);
});
