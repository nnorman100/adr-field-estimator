const { checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
// C1 end to end: removing a room and adding another must not give two rooms one name, and each
// room keeps the photos taken under its own name.
const roomName = (page, index) =>
  page.locator('[data-room-index="' + index + '"][data-room-key="name"]');
const names = (page) => page.evaluate(() => state.draft.data.rooms.map((room) => room.name));
const photoRooms = (page) => page.evaluate(() => state.record.photos.map((photo) => photo.room));
// Tapping the selected chip renames the room, so only tap a chip that is not yet selected.
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
test('each room keeps its own photos when a room is removed and another is added', async ({
  page,
}) => {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
  await roomName(page, 0).fill('Room 1');
  await page.locator('#addRoom').click();
  await expect(roomName(page, 1)).toHaveValue('Room 2');
  await page.locator('.task-nav [data-task="walkthrough"]').click();
  await selectRoom(page, 0);
  await addImage(page, '#aa0000');
  await expect.poll(() => photoRooms(page)).toEqual(['Room 1']);
  await selectRoom(page, 1);
  await addImage(page, '#00aa00');
  await expect.poll(() => photoRooms(page)).toEqual(['Room 1', 'Room 2']);
  await checkScope(page);
  await page
    .locator('#rooms .room')
    .nth(0)
    .getByRole('button', { name: /Remove/ })
    .click();
  await page.locator('#confirmRoomRemoval').click();
  await page.locator('#addRoom').click();
  const after = await names(page);
  expect(after).toHaveLength(2);
  expect(new Set(after.map((name) => name.trim().toLowerCase())).size).toBe(after.length);
  // The surviving room still has exactly its own photo, and no photo was lost or moved to it.
  expect(after).toContain('Room 2');
  const photos = await page.evaluate(() => state.record.photos.map((photo) => photo.room));
  expect(photos.filter((room) => room === 'Room 2')).toHaveLength(1);
  expect(photos).toHaveLength(2);
});
