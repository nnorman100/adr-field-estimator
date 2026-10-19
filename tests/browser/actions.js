async function saveDraft(page) {
  const menu = page.locator('#jobMenu');
  if (!(await menu.evaluate((el) => el.open))) await menu.locator(':scope > summary').click();
  await page.locator('#saveDraft').click();
}
// A blank job opens on 1. Walk & Photo; scope-first tests switch to 2. Check Scope after loading.
async function checkScope(page) {
  await page.locator('.task-nav [data-task="property"]').click();
}
module.exports = { saveDraft, checkScope };
