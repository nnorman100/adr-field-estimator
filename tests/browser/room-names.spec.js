const { checkScope } = require('./actions');
const { test, expect } = require('@playwright/test');
// Photos, shot lists and equipment scans are keyed by room name, so no two rooms may share one.
const roomName = (page, index) =>
  page.locator('[data-room-index="' + index + '"][data-room-key="name"]');
const names = (page) => page.evaluate(() => state.draft.data.rooms.map((room) => room.name));
async function ready(page) {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await checkScope(page);
}

test('a room added after a removal takes the lowest unused name', async ({ page }) => {
  await ready(page);
  await roomName(page, 0).fill('Room 1');
  await page.locator('#addRoom').click();
  await expect(roomName(page, 1)).toHaveValue('Room 2');
  await page
    .locator('#rooms .room')
    .nth(0)
    .getByRole('button', { name: /Remove/ })
    .click();
  await page.locator('#confirmRoomRemoval').click();
  expect(await names(page)).toEqual(['Room 2']);
  await page.locator('#addRoom').click();
  expect(await names(page)).toEqual(['Room 2', 'Room 1']);
});

test('renaming a room to another room’s name is refused and reverts', async ({ page }) => {
  await ready(page);
  await roomName(page, 0).fill('Kitchen');
  await page.locator('#addRoom').click();
  await roomName(page, 1).fill(' kitchen ');
  expect(await roomName(page, 1).evaluate((input) => input.validationMessage)).toContain(
    'Another room already has this name',
  );
  expect((await names(page))[1]).toBe('Room 1');
  await roomName(page, 1).blur();
  await expect(roomName(page, 1)).toHaveValue('Room 1');
  expect(await roomName(page, 1).evaluate((input) => input.validity.valid)).toBe(true);
  await roomName(page, 1).fill('Hall');
  expect(await names(page)).toEqual(['Kitchen', 'Hall']);
});
