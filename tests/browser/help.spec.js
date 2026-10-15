const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
const topics = (page, group) =>
  page.locator('#' + group + ' > details > summary').allTextContents();
const FIELD = [
  'My jobs and Company jobs',
  'Property and scope',
  'Walkthrough with the live camera assistant',
  'Photo evidence',
  'Review and claim documents',
  "Getting the homeowner's signature",
];
const ALL = [
  ...FIELD,
  'Job coordination and assigning estimators',
  'Team and invitations',
  'Company settings',
  'Companies and the support view',
];
async function openHelp(page) {
  const help = page.getByRole('button', { name: 'Help', exact: true });
  await expect(help).toBeVisible();
  await help.click();
  const dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('signed out', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  });
  for (const width of [320, 390])
    test(
      'help opens from the header at ' + width + '×844 and closes by Escape or Close',
      async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto('/');
        await expect(page.locator('#authPanel')).toBeVisible();
        expect((await page.locator('.masthead').boundingBox()).height).toBeLessThan(85);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        const help = page.getByRole('button', { name: 'Help', exact: true });
        await expect(help).toHaveAttribute('aria-haspopup', 'dialog');
        let dialog = await openHelp(page);
        await expect(page.locator('#helpYours')).toBeHidden();
        await expect(page.locator('#helpOtherHeading')).toHaveText('App features');
        expect(await topics(page, 'helpOther')).toEqual(ALL);
        await expect(dialog.locator('[data-help-topic="start"]')).toHaveAttribute('open', '');
        await expect(dialog.locator('#helpContact')).toContainText('(661) 426-2151');
        await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(help).toBeFocused();
        // Keyboard only: Enter on the focused button opens it, the Close button closes it.
        await page.keyboard.press('Enter');
        dialog = page.getByRole('dialog', { name: 'Help' });
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(help).toBeFocused();
      },
    );
});

test('signed-out screen says what the app is for before sign-in', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page).toHaveTitle(
    'Field Estimator · Water & mold loss estimates | Alert Disaster Restoration',
  );
  for (const hidden of ['.inspection-shell', '.workspace', '.workspace-bar', '#jobCoordination'])
    await expect(page.locator(hidden).first()).toBeHidden();
  await expect(page.locator('#authPanel #googleSignIn')).toBeVisible();
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  const line = page.locator('#authPanel #positioning');
  await expect(line).toBeVisible();
  await expect(line).toContainText('Water & mold loss estimates, signed on site.');
  await expect(line).toContainText(
    'Walk the loss, talk and photograph as you go, and leave with a priced proposal, itemized claim, scope defense letter and photo log.',
  );
});

test.describe('company roles', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  for (const [role, heading, yours, topic] of [
    ['estimator', 'For you: Estimator', FIELD, FIELD[2]],
    [
      'office',
      'For you: Office staff',
      ['My jobs and Company jobs', 'Review and claim documents', ALL[6]],
      ALL[6],
    ],
    ['owner', 'For you: Owner and Superadmin', ALL, ALL[7]],
    ['admin', 'For you: Superadmin', [ALL[9]], ALL[9]],
  ])
    test(role + ' help lists the role topics first', async ({ page, browserName }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(
        (value) => sessionStorage.setItem('synthetic-uid', value),
        uid(role),
      );
      await page.goto('/');
      await expect(page.locator('#workspaceDashboard')).toBeVisible();
      await expect(page.locator('#workspaceNav button').first()).toBeEnabled();
      const dialog = await openHelp(page);
      await expect(page.locator('#helpYoursHeading')).toHaveText(heading);
      expect(await topics(page, 'helpYours')).toEqual(yours);
      const others = ALL.filter((title) => !yours.includes(title));
      if (others.length) expect(await topics(page, 'helpOther')).toEqual(others);
      else await expect(page.locator('#helpOther')).toBeHidden();
      // Getting started follows the role topics; nothing is open until chosen.
      const order = await dialog
        .locator('.help-group:visible')
        .evaluateAll((groups) => groups.map((group) => group.id));
      expect(order).toEqual(['helpYours', 'helpGeneral', ...(others.length ? ['helpOther'] : [])]);
      await expect(dialog.locator('details[open]')).toHaveCount(0);
      // Company staff see their company's contact; a platform-only superadmin has none.
      if (role === 'admin') await expect(dialog.locator('#helpContact')).toBeHidden();
      else await expect(dialog.locator('#helpContact')).toContainText('Alert Disaster Restoration');
      // Help is text only: no forms or inputs ride along with any role.
      await expect(dialog.locator('form, input, select, textarea')).toHaveCount(0);
      const summary = dialog.locator('summary', { hasText: topic });
      await summary.click();
      await expect(summary.locator('..')).toHaveAttribute('open', '');
      await summary.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (browserName === 'chromium' && ['estimator', 'owner'].includes(role))
        await page.screenshot({ path: test.info().outputPath('help-' + role + '-390.png') });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeHidden();
    });
  test('a role change without reload keeps the topics in workflow order', async ({ page }) => {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('office'),
    );
    await page.goto('/');
    await expect(page.locator('#workspaceNav button').first()).toBeEnabled();
    await openHelp(page);
    expect(await topics(page, 'helpYours')).toEqual([FIELD[0], FIELD[4], ALL[6]]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const result = await page.request.fetch('/api/companies/adr/team/' + uid('office'), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + uid('owner'), 'X-ADR-Workspace-Protocol': '1' },
      data: { expected_version: 1, role: 'estimator', status: 'active' },
    });
    expect(result.ok()).toBe(true);
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#dashboardJobs')).toHaveText('My jobs');
    await openHelp(page);
    await expect(page.locator('#helpYoursHeading')).toHaveText('For you: Estimator');
    expect(await topics(page, 'helpYours')).toEqual(FIELD);
    expect(await topics(page, 'helpOther')).toEqual(ALL.slice(FIELD.length));
  });
});

test('help without company workspaces lists the field workflow first', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled();
  await openHelp(page);
  await expect(page.locator('#helpYoursHeading')).toHaveText('For you: Estimator');
  expect(await topics(page, 'helpYours')).toEqual(FIELD);
  await expect(page.locator('#helpContact')).toContainText('(661) 426-2151');
});
