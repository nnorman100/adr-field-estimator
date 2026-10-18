async function saveDraft(page) {
  const menu = page.locator('#jobMenu');
  if (!(await menu.evaluate((el) => el.open))) await menu.locator('summary').click();
  await page.locator('#saveDraft').click();
}
module.exports = { saveDraft };
