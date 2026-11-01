const { checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
// Removing a room must not leave its photos or equipment scans tagged with a name that no room has.
const photoRooms = (page) => page.evaluate(() => state.draft.photos.map((photo) => photo.room));
const scanRooms = (page) =>
  page.evaluate(() => (state.draft.data.equipment_scans || []).map((scan) => scan.room));
const names = (page) => page.evaluate(() => state.draft.data.rooms.map((room) => room.name));
async function selectRoom(page, index) {
  const chip = page.locator('[data-room-chip="' + index + '"]');
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}
async function addImage(page, tint) {
  const image = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 300;
    const context = canvas.getContext('2d');
    context.fillStyle = fill;
    context.fillRect(0, 0, 100, 150);
    return canvas.toDataURL('image/png');
  }, tint);
  await page.locator('#photoFileInput').setInputFiles({
    name: 'room-' + tint.slice(1) + '.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
}
async function twoRooms(page) {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
  await page.locator('[data-room-index="0"][data-room-key="name"]').fill('Kitchen');
  await page.locator('#addRoom').click();
  await page.locator('[data-room-index="1"][data-room-key="name"]').fill('Hall');
  await page.locator('.task-nav [data-task="walkthrough"]').click();
}
const removeFirst = async (page) => {
  await checkScope(page);
  await page
    .locator('#rooms .room')
    .nth(0)
    .getByRole('button', { name: /Remove/ })
    .click();
};
test('a room with photos or scans cannot be removed until they move to another room', async ({
  page,
}) => {
  await twoRooms(page);
  await selectRoom(page, 0);
  await addImage(page, '#aa0000');
  await expect.poll(() => photoRooms(page)).toEqual(['Kitchen']);
  await page.evaluate(() => {
    state.draft.data.equipment_scans = [{ kind: 'air_mover', asset_id: 'FAN-1', room: 'Kitchen' }];
  });
  await removeFirst(page);
  const dialog = page.locator('#removeRoomDialog');
  // Blocked: the dialog names what the room holds and offers a move, not the removal.
  await expect(page.locator('#removeRoomDescription')).toContainText('1 photo and 1 scan');
  await expect(page.locator('#confirmRoomRemoval')).toBeHidden();
  await expect(page.locator('#removeRoomMoveTarget')).toHaveValue('1');
  await expect(page.locator('#removeRoomMoveTarget option')).toHaveText(['Hall']);
  expect(await names(page)).toEqual(['Kitchen', 'Hall']);
  // Move them; the same dialog then allows the removal.
  await page.locator('#moveRoomItems').click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#confirmRoomRemoval')).toBeVisible();
  await expect(page.locator('#moveRoomItems')).toBeHidden();
  expect(await photoRooms(page)).toEqual(['Hall']);
  expect(await scanRooms(page)).toEqual(['Hall']);
  // The photo is queued for a room change, so an offline or slow sync relabels it too.
  expect(await page.evaluate(() => state.draft.photos[0].pending_room)).toBe('Hall');
  await page.locator('#confirmRoomRemoval').click();
  await expect(dialog).toBeHidden();
  expect(await names(page)).toEqual(['Hall']);
  expect(await photoRooms(page)).toEqual(['Hall']);
  expect(await scanRooms(page)).toEqual(['Hall']);
});
test('a room with no photos or scans removes straight away', async ({ page }) => {
  await twoRooms(page);
  await selectRoom(page, 1);
  await addImage(page, '#00aa00');
  await expect.poll(() => photoRooms(page)).toEqual(['Hall']);
  await removeFirst(page);
  await expect(page.locator('#removeRoomMove')).toBeHidden();
  await expect(page.locator('#removeRoomDescription')).toContainText('Remove "Kitchen"?');
  await page.locator('#confirmRoomRemoval').click();
  expect(await names(page)).toEqual(['Hall']);
  expect(await photoRooms(page)).toEqual(['Hall']);
});
