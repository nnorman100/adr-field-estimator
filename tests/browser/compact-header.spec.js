const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;

// Synthetic backend and emulated phone layouts; the physical iPhone check stays separate.
test.describe('compact phone header', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  for (const role of ['owner', 'estimator'])
    for (const width of [320, 390])
      test(
        role + ' gets a top New job button and one header row at ' + width + '×844',
        async ({ page }) => {
          await page.setViewportSize({ width, height: 844 });
          await page.addInitScript(
            (value) => sessionStorage.setItem('synthetic-uid', value),
            uid(role),
          );
          await page.goto('/');
          await expect(page.locator('#workspaceDashboard')).toBeVisible();
          const newJob = page.locator('#workspaceDashboard > .section-head > #dashboardNewJob');
          await expect(newJob).toBeVisible();
          await expect(newJob).toHaveClass(/primary/);
          await expect(page.getByRole('button', { name: 'New job', exact: true })).toHaveCount(1);
          expect((await newJob.boundingBox()).y).toBeLessThan(320);
          await newJob.click();
          await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
          await expect(page.locator('#saveStatus')).toHaveText('Saved');
          await expect(page.locator('#saveStatus')).toHaveAttribute(
            'title',
            /^Saved privately · revision \d+$/,
          );
          for (const hidden of ['.product-bar', '.masthead', '#workspaceNav', '.jobbar .eyebrow'])
            await expect(page.locator(hidden)).toBeHidden();
          const row = await page.locator('.jobbar').boundingBox();
          expect(row.y).toBe(0);
          expect(row.height).toBeLessThanOrEqual(56);
          for (const id of ['#backToJobs', '#jobTitle', '#saveStatus', '#jobMenu > summary']) {
            const box = await page.locator(id).boundingBox();
            expect(box.y).toBeGreaterThanOrEqual(row.y);
            expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
          }
          for (const task of ['property', 'walkthrough', 'evidence', 'review']) {
            await page.locator('.task-nav [data-task="' + task + '"]').click();
            const top = await page
              .locator('[data-panel="' + task + '"]')
              .evaluate((el) => el.getBoundingClientRect().top);
            expect(top, task + ' panel top').toBeLessThanOrEqual(120);
          }
          await page.locator('.task-nav [data-task="property"]').click();

          const more = page.locator('#jobMenu');
          await expect(more.locator(':scope > summary')).toHaveAccessibleName(/^More\b/);
          await more.locator(':scope > summary').click();
          for (const name of ['New inspection', 'Save draft', 'Drafts & signed jobs', 'Help'])
            await expect(more.getByRole('button', { name, exact: true })).toBeVisible();
          const coordination = more.getByRole('button', { name: 'Job coordination', exact: true });
          if (role === 'owner') await expect(coordination).toBeVisible();
          else await expect(coordination).toBeHidden();
          await more.locator('#accountMenu > summary').click();
          await expect(page.locator('#signOutButton')).toBeVisible();
          await expect(page.locator('#accountMenu')).toContainText('DryScope · App version');
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
            false,
          );
          await page.screenshot({
            path: test.info().outputPath('more-' + role + '-' + width + '.png'),
          });

          await more.getByRole('button', { name: 'Help', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Help' });
          await expect(dialog).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
          await expect(more.locator(':scope > summary')).toBeFocused();

          if (role === 'owner') {
            await more.locator(':scope > summary').click();
            await coordination.click();
            await expect(page.locator('#coordAddress')).toBeVisible();
            await expect(page.locator('#coordinationToggle')).toHaveAttribute(
              'aria-expanded',
              'true',
            );
          }

          await page.locator('#backToJobs').click();
          await expect(page.locator('#workspaceDashboard')).toBeVisible();
          await expect(page.locator('.product-bar #helpButton')).toBeVisible();
          await expect(page.locator('.product-bar #accountMenu')).toBeVisible();
          await expect(newJob).toBeVisible();
        },
      );
});
