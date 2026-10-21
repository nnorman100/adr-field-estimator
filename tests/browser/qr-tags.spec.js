const { test, expect } = require('@playwright/test');
const { checkScope, saveDraft } = require('./actions');

// QR room and equipment tags on an iPhone-sized touch viewport against the synthetic backend.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const chip = (page, name) => page.locator('#roomChips').getByRole('button', { name, exact: true });
const renameBox = (page) => page.locator('#roomChips .room-chip-input');
async function open(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function rename(page, name) {
  await expect(renameBox(page)).toBeFocused();
  await renameBox(page).fill(name);
  await renameBox(page).press('Enter');
  await expect(renameBox(page)).toHaveCount(0);
}
async function twoRooms(page) {
  await chip(page, 'Room 1').click();
  await rename(page, 'Kitchen');
  await page.locator('#addRoomChip').click();
  await rename(page, 'Hallway');
  await expect(chip(page, 'Hallway')).toHaveAttribute('aria-pressed', 'true');
}
const jobTag = (page) => page.evaluate(() => state.draft.inspection_id.slice(8, 16));
async function typeCode(page, code) {
  const dialog = page.locator('#tagScanDialog');
  await dialog.locator('#tagCodeInput').fill(code);
  await dialog.locator('#applyTagCode').click();
}
const status = (page) => page.locator('#tagScanStatus');
const savedScans = (page) =>
  page.evaluate(() =>
    (state.record.data.equipment_scans || []).map((scan) => [scan.kind, scan.asset_id, scan.room]),
  );

test('without a camera the scanner takes typed codes: room tags pick the room, equipment tags are placed per room, saved and reloaded', async ({
  page,
}) => {
  await open(page);
  await twoRooms(page);
  await expect(page.locator('#tagCount')).toHaveText('No equipment tags scanned');
  await expect(page.locator('#equipmentPlacements .empty')).toBeVisible();
  await page.locator('#scanTag').click();
  const dialog = page.locator('#tagScanDialog');
  await expect(dialog).toBeVisible();
  // Headless browsers grant no camera (Chromium finds none, WebKit denies permission), so the
  // dialog says why and hands over to typed entry.
  await expect(dialog.locator('#tagCameraEmpty')).toContainText(
    /type the code printed on the tag/i,
  );
  await expect(dialog.locator('#retryTagCamera')).toBeVisible();
  await expect(dialog.locator('#tagCodeInput')).toBeFocused();
  await expect(dialog.locator('#tagScanRoom')).toHaveText('Hallway');
  const job = await jobTag(page);
  await typeCode(page, 'DEHU-108: Phoenix');
  await expect(status(page)).toHaveText(
    /^Not a DryScope tag: "DEHU-108: Phoenix"\. .*nothing was recorded\.$/,
  );
  await expect(status(page)).toHaveClass(/refused/);
  await typeCode(page, 'DS1-RM-00000000-Kitchen');
  await expect(status(page)).toHaveText(/printed for a different job/);
  await typeCode(page, 'DS1-RM-' + job + '-Pantry');
  await expect(status(page)).toHaveText(/No room named "Pantry" is on this job/);
  await typeCode(page, 'DS1-RM-' + job + '-  kitchen');
  await expect(status(page)).toHaveText('Current room: Kitchen.');
  await expect(status(page)).not.toHaveClass(/refused/);
  await expect(chip(page, 'Kitchen')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('#tagScanRoom')).toHaveText('Kitchen');
  await expect(dialog.locator('#tagCodeInput')).toHaveValue('');
  await typeCode(page, 'ds1-eq-dh-dh-0042');
  await expect(status(page)).toHaveText(/^LGR dehumidifier DH-0042 placed in Kitchen · \d/);
  await typeCode(page, 'DS1-EQ-AM-AM-1');
  await expect(status(page)).toHaveText(/^Air mover AM-1 placed in Kitchen · \d/);
  await expect(dialog.locator('#tagScanLog li')).toHaveCount(6);
  await dialog.locator('#closeTagScan').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#tagCount')).toHaveText('2 units tagged · 1 room');
  await expect(page.locator('#equipmentPlacements h4')).toHaveText(['Kitchen']);
  await expect(page.locator('#equipmentPlacements .placement-unit')).toHaveText([
    'LGR dehumidifier DH-0042',
    'Air mover AM-1',
  ]);
  // Check Scope names the tagged equipment per room; the priced counts stay what was entered.
  await checkScope(page);
  await expect(page.locator('#rooms .room').nth(0).locator('.room-equipment')).toHaveText(
    'Tagged equipment: 1 air mover, 1 LGR dehumidifier · placement only, not the priced counts',
  );
  await expect(page.locator('#rooms .room').nth(1).locator('.room-equipment')).toHaveCount(0);
  await expect(page.locator('#airMovers')).toHaveValue('0');
  await expect(page.locator('#dehumidifiers')).toHaveValue('0');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  expect(await savedScans(page)).toEqual([
    ['dehumidifier', 'DH-0042', 'Kitchen'],
    ['air_mover', 'AM-1', 'Kitchen'],
  ]);
  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#tagCount')).toHaveText('2 units tagged · 1 room');
  await expect(page.locator('#rooms .room').nth(0).locator('.room-equipment')).toContainText(
    '1 air mover, 1 LGR dehumidifier',
  );
  // Scanning a recorded unit in another room moves it; Remove deletes a record.
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await chip(page, 'Hallway').click();
  await page.locator('#scanTag').click();
  await typeCode(page, 'DS1-EQ-DH-DH-0042');
  await expect(status(page)).toHaveText(
    /^LGR dehumidifier DH-0042 moved from Kitchen to Hallway · \d/,
  );
  await page.locator('#closeTagScan').click();
  await expect(page.locator('#tagCount')).toHaveText('2 units tagged · 2 rooms');
  await expect(page.locator('#equipmentPlacements h4')).toHaveText(['Kitchen', 'Hallway']);
  await page
    .locator('#equipmentPlacements li', { hasText: 'Air mover AM-1' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.locator('#tagCount')).toHaveText('1 unit tagged · 1 room');
  await expect(page.locator('#equipmentPlacements .placement-unit')).toHaveText([
    'LGR dehumidifier DH-0042',
  ]);
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  expect(await savedScans(page)).toEqual([['dehumidifier', 'DH-0042', 'Hallway']]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a camera frame that decodes to a tag is applied once while it stays in view', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit never starts the synthetic camera stream; physical iPhone acceptance remains open.',
  );
  await page.addInitScript(() => {
    // A synthetic camera (a redrawn canvas) and a jsQR reader that reports the code the test sets.
    window.jsQR = () => (window.__tagInView ? { data: window.__tagInView } : null);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    setInterval(() => {
      context.fillStyle =
        '#' +
        Math.floor(Math.random() * 0xffffff)
          .toString(16)
          .padStart(6, '0');
      context.fillRect(0, 0, 320, 240);
    }, 100);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => canvas.captureStream(10) },
    });
  });
  await open(page);
  await twoRooms(page);
  await page.locator('#scanTag').click();
  const dialog = page.locator('#tagScanDialog');
  await expect(dialog).toHaveClass(/scanning/);
  await expect(dialog.locator('#tagVideo')).toBeVisible();
  await expect(dialog.locator('#retryTagCamera')).toBeHidden();
  await page.evaluate(() => (window.__tagInView = 'DS1-EQ-AS-AS-7'));
  await expect(status(page)).toHaveText(/^Air scrubber AS-7 placed in Hallway · \d/);
  await page.waitForTimeout(700);
  await expect(dialog.locator('#tagScanLog li')).toHaveCount(1);
  await page.evaluate(
    () => (window.__tagInView = 'DS1-RM-' + state.draft.inspection_id.slice(8, 16) + '-Kitchen'),
  );
  await expect(status(page)).toHaveText('Current room: Kitchen.');
  await expect(chip(page, 'Kitchen')).toHaveAttribute('aria-pressed', 'true');
  await dialog.locator('#closeTagScan').click();
  expect(await page.evaluate(() => document.getElementById('tagVideo').srcObject)).toBeNull();
  await expect(page.locator('#tagCount')).toHaveText('1 unit tagged · 1 room');
  await expect(page.locator('#equipmentPlacements h4')).toHaveText(['Hallway']);
});

test('room and equipment tags are rendered by the server and printed as a sheet', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'Room 1').click();
  await rename(page, 'Kitchen');
  await checkScope(page);
  await page.locator('#address').fill('12 Synthetic Way');
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await page.locator('#printTags').click();
  const dialog = page.locator('#tagSheetDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#roomTagChoices input')).toHaveCount(1);
  await expect(dialog.locator('#roomTagChoices input')).toBeChecked();
  await expect(dialog.locator('#roomTagChoices')).toContainText('Kitchen');
  await dialog.locator('#equipmentTagAsset').fill('dh 42');
  await dialog.locator('#addEquipmentTag').click();
  await expect(dialog.locator('#tagSheetStatus')).toHaveText(/letters, digits and/);
  await expect(dialog.locator('#equipmentTagList li')).toHaveCount(0);
  await dialog.locator('#equipmentTagKind').selectOption('dehumidifier');
  await dialog.locator('#equipmentTagAsset').fill('dh-0042');
  await dialog.locator('#addEquipmentTag').click();
  await expect(dialog.locator('#equipmentTagList li')).toHaveText([
    'LGR dehumidifier DH-0042Remove',
  ]);
  await expect(dialog.locator('#tagSheetStatus')).toHaveText('');
  await dialog.locator('#makeTags').click();
  const job = await jobTag(page);
  const cards = dialog.locator('#tagPreview .tag-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('strong')).toHaveText('Kitchen');
  await expect(cards.nth(0).locator('span')).toHaveText('12 Synthetic Way');
  await expect(cards.nth(0).locator('code')).toHaveText('DS1-RM-' + job + '-Kitchen');
  await expect(cards.nth(1).locator('strong')).toHaveText('LGR dehumidifier');
  await expect(cards.nth(1).locator('span')).toHaveText('DH-0042');
  await expect(cards.nth(1).locator('code')).toHaveText('DS1-EQ-DH-DH-0042');
  for (const index of [0, 1])
    expect(await cards.nth(index).locator('img').getAttribute('src')).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
  await expect(dialog.locator('#tagSheetStatus')).toHaveText('2 tags ready. Tap Print.');
  // Printing shows only the sheet, then puts the page back.
  await page.evaluate(() => {
    window.print = () => {
      const sheet = document.getElementById('tagSheet');
      window.__printed = {
        tags: document.body.classList.contains('printing-tags'),
        shown: !sheet.hidden,
        cards: sheet.querySelectorAll('.tag-card').length,
      };
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  await dialog.locator('#printTagSheet').click();
  expect(await page.evaluate(() => window.__printed)).toEqual({
    tags: true,
    shown: true,
    cards: 2,
  });
  expect(await page.evaluate(() => document.body.classList.contains('printing-tags'))).toBe(false);
  expect(await page.evaluate(() => document.getElementById('tagSheet').hidden)).toBe(true);
  // The code on the printed tag is what Scan tag reads back.
  await dialog.locator('#closeTagSheet').click();
  await page.locator('#scanTag').click();
  await typeCode(page, 'DS1-EQ-DH-DH-0042');
  await expect(status(page)).toHaveText(/^LGR dehumidifier DH-0042 placed in Kitchen · \d/);
});

test('equipment placements follow their room when it is renamed on Walk & Photo or Check Scope', async ({
  page,
}) => {
  await open(page);
  await twoRooms(page);
  await chip(page, 'Kitchen').click();
  await page.locator('#scanTag').click();
  await typeCode(page, 'DS1-EQ-AM-AM-1');
  await expect(status(page)).toHaveText(/^Air mover AM-1 placed in Kitchen · \d/);
  await page.locator('#closeTagScan').click();
  await chip(page, 'Kitchen').click();
  await rename(page, 'Utility');
  await expect(page.locator('#equipmentPlacements h4')).toHaveText(['Utility']);
  await checkScope(page);
  const name = page.locator('[data-room-index="0"][data-room-key="name"]');
  await name.focus();
  await name.fill('Laundry');
  await expect(page.locator('#rooms .room').nth(0).locator('.room-equipment')).toContainText(
    '1 air mover',
  );
  await expect(page.locator('#equipmentPlacements h4')).toHaveText(['Laundry']);
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  expect(await savedScans(page)).toEqual([['air_mover', 'AM-1', 'Laundry']]);
});

test('leaving the job clears the tag sheet and drops a tag response that arrives afterwards', async ({
  page,
}) => {
  await open(page);
  await page.locator('#printTags').click();
  const dialog = page.locator('#tagSheetDialog');
  await dialog.locator('#equipmentTagAsset').fill('AM-1');
  await dialog.locator('#addEquipmentTag').click();
  await expect(dialog.locator('#equipmentTagList li')).toHaveCount(1);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/qr-tags', async (route) => {
    await held;
    await route.continue();
  });
  const answered = page.waitForResponse('**/api/qr-tags');
  await dialog.locator('#makeTags').click();
  await expect(dialog.locator('#tagSheetStatus')).toHaveText(/^Making \d+ tags…$/);
  await page.evaluate(() => TagsUI.closeDialogs());
  await expect(dialog).toBeHidden();
  release();
  await answered;
  await page.locator('#printTags').click();
  await expect(dialog.locator('#equipmentTagList li')).toHaveCount(0);
  await expect(dialog.locator('#tagPreview .tag-card')).toHaveCount(0);
  await expect(dialog.locator('#printTagSheet')).toBeHidden();
  expect(await page.evaluate(() => document.querySelectorAll('#tagSheet .tag-card').length)).toBe(
    0,
  );
});
