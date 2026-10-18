const { test, expect } = require('@playwright/test');

// Walkthrough-first field flow on an iPhone-sized touch viewport against the synthetic backend.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const chips = (page) => page.locator('#roomChips');
const chip = (page, name) => chips(page).getByRole('button', { name, exact: true });
const renameBox = (page) => page.locator('#roomChips .room-chip-input');
const room = (page, index, key) =>
  page.locator('[data-room-index="' + index + '"][data-room-key="' + key + '"]');
async function open(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
}
async function addImage(page, name, width = 300, height = 600) {
  const image = await page.evaluate(
    ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').fillRect(0, 0, width / 2, height / 2);
      return canvas.toDataURL('image/png');
    },
    [width, height],
  );
  await page.locator('#photoFileInput').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
}
async function rename(page, name) {
  await expect(renameBox(page)).toBeFocused();
  await renameBox(page).fill(name);
  await renameBox(page).press('Enter');
  await expect(renameBox(page)).toHaveCount(0);
}
const settled = (page) =>
  page.evaluate(async () => {
    await syncChain.catch(() => {});
    await Promise.all([...state.ocr.values()]);
    return state.record.photos.map((photo) => photo.room);
  });

test('a new job opens on Walk & Photo and a two-room walkthrough never leaves it', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#panel-walkthrough')).toBeVisible();
  await expect(page.locator('#panel-property')).toBeHidden();
  await expect(page.locator('.task-nav [data-task="walkthrough"]')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.locator('.task-nav button')).toHaveText([
    '1Walk & Photo',
    '2Check Scope',
    '3Review & Sign',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // One capture button: idle, it opens the camera or file chooser instead of staying disabled.
  await expect(page.locator('#takePhoto')).toBeEnabled();
  await expect(page.locator('#takePhoto')).toHaveText('Capture photo');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#takePhoto').click();
  expect((await chooser).isMultiple()).toBe(false);
  // Tapping the selected chip renames the default room in place.
  await expect(chip(page, 'Room 1')).toHaveAttribute('aria-pressed', 'true');
  await chip(page, 'Room 1').click();
  await rename(page, 'Kitchen');
  await expect(chip(page, 'Kitchen')).toHaveAttribute('aria-pressed', 'true');
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await addImage(page, 'kitchen.png');
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Kitchen']);
  // + Room adds Hallway, selects it and takes its name without leaving the walkthrough.
  await page.locator('#addRoomChip').click();
  await rename(page, 'Hallway');
  await expect(chip(page, 'Hallway')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Kitchen')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => $('photoRoom').value)).toBe('Hallway');
  await addImage(page, 'hallway.png', 200, 100);
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Kitchen', 'Hallway']);
  await expect(page.locator('#photoCount')).toContainText('2 photos');
  await expect(page.locator('#photoGallery .ocr-badge')).toHaveCount(2);
  await expect.poll(() => settled(page)).toEqual(['Kitchen', 'Hallway']);
  await expect(page.locator('#photoGallery .ocr-badge').first()).toHaveText('no meter');
  await expect(page.locator('#photoGallery')).toContainText('200 × 100');
  await page.screenshot({ path: test.info().outputPath('walk-first-two-rooms.png') });
  // Each photo card can move the photo to another room; the server record follows.
  const hallwayPhoto = page.locator('#photoGallery .photo').nth(1);
  await hallwayPhoto.locator('select').selectOption('Kitchen');
  await expect(hallwayPhoto.locator('strong')).toHaveText('Kitchen');
  await expect.poll(() => settled(page)).toEqual(['Kitchen', 'Kitchen']);
  await hallwayPhoto.locator('select').selectOption('Hallway');
  await expect.poll(() => settled(page)).toEqual(['Kitchen', 'Hallway']);
  // Still on Walk & Photo: the transcript sits behind More walkthrough options and fills from here.
  expect(await page.evaluate(() => ui.task)).toBe('walkthrough');
  await expect(page.locator('#technicianTranscript')).toBeHidden();
  await page.locator('#panel-walkthrough .capture-options summary').click();
  await page
    .locator('#technicianTranscript')
    .fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await page.locator('#fillScope').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('#panel-property')).toBeVisible();
  await expect(room(page, 0, 'name')).toHaveValue('Kitchen');
  await expect(room(page, 0, 'finished_sf')).toHaveValue('80');
  await expect(room(page, 1, 'name')).toHaveValue('Hallway');
  await expect(page.locator('#scopeMissing')).toContainText(
    'No measured demolition area for Hallway',
  );
  // Check Scope shows each room's photos inside its card.
  const cards = page.locator('#rooms .room');
  await expect(cards.nth(0).locator('.room-photos .photo strong')).toHaveText(['Kitchen']);
  await expect(cards.nth(1).locator('.room-photos .photo strong')).toHaveText(['Hallway']);
  await expect(cards.nth(1).locator('.room-photos select')).toHaveValue('Hallway');
  // The former Evidence step now opens Walk & Photo with its photo strip.
  await page.evaluate(() => showTask('evidence'));
  await expect(page.locator('#panel-walkthrough')).toBeVisible();
  await expect(page.locator('#panel-property')).toBeHidden();
  await expect(page.locator('.task-nav [data-task="walkthrough"]')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Kitchen', 'Hallway']);
});

test('a chip rename relabels saved photos through a reload and Escape cancels', async ({
  page,
}) => {
  await open(page);
  await chip(page, 'Room 1').click();
  await rename(page, 'Kitchen');
  await addImage(page, 'before-rename.png');
  await expect(page.locator('#photoGallery .photo')).toHaveCount(1);
  await expect.poll(() => settled(page)).toEqual(['Kitchen']);
  // A rename after the upload is not the default-room transition, so the server is told explicitly.
  await chip(page, 'Kitchen').click();
  await rename(page, 'Master bath');
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Master bath']);
  await expect.poll(() => settled(page)).toEqual(['Master bath']);
  await page.reload();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await expect(chip(page, 'Master bath')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Master bath']);
  expect(await page.evaluate(() => state.draft.photos[0].pending_room)).toBeUndefined();
  await chip(page, 'Master bath').click();
  await renameBox(page).fill('Discarded');
  await renameBox(page).press('Escape');
  await expect(renameBox(page)).toHaveCount(0);
  await expect(chip(page, 'Master bath')).toHaveAttribute('aria-pressed', 'true');
  await expect(room(page, 0, 'name')).toHaveValue('Master bath');
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
});

test('a room chosen while its photo uploads or offline is kept and saved', async ({ page }) => {
  await open(page);
  await chip(page, 'Room 1').click();
  await rename(page, 'Kitchen');
  await page.locator('#addRoomChip').click();
  await rename(page, 'Hallway');
  await chip(page, 'Kitchen').click();
  await expect.poll(() => page.evaluate(() => stable(state.draft.data) === state.ack)).toBe(true);
  // Hold the upload so the photo is reassigned while its POST is still in flight.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let posted;
  const sent = new Promise((resolve) => (posted = resolve));
  await page.route('**/api/inspections/*/photos', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted();
    await held;
    await route.continue();
  });
  await addImage(page, 'in-flight.png');
  await sent;
  await page.locator('#photoGallery .photo select').selectOption('Hallway');
  release();
  await expect.poll(() => settled(page)).toEqual(['Hallway']);
  await expect(page.locator('#photoGallery .photo strong')).toHaveText(['Hallway']);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  // An offline reassignment of an uploaded photo is unsynced work until the server stores it.
  await page.context().setOffline(true);
  await page.locator('#photoGallery .photo select').selectOption('Kitchen');
  await expect(page.locator('#saveStatus')).toContainText('offline');
  expect(await page.evaluate(() => openDraftUnsynced())).toBe(true);
  await page.context().setOffline(false);
  await expect.poll(() => settled(page)).toEqual(['Kitchen']);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  expect(await page.evaluate(() => openDraftUnsynced())).toBe(false);
  // Renaming the chosen room on Check Scope before it syncs carries the reassignment along.
  await page.context().setOffline(true);
  await page.locator('#photoGallery .photo select').selectOption('Hallway');
  await page.locator('.task-nav [data-task="property"]').click();
  await room(page, 1, 'name').fill('Bathroom');
  await expect(
    page.locator('#rooms .room').nth(1).locator('.room-photos .photo strong'),
  ).toHaveText(['Bathroom']);
  await page.context().setOffline(false);
  await expect.poll(() => settled(page)).toEqual(['Bathroom']);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
});
