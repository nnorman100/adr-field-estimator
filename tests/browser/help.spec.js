const { test, expect } = require('@playwright/test');
// Visible login controls from top to bottom, with each control's font size.
const LOGIN_ORDER = [
  ['authEmail', 'email'],
  ['authPassword', 'password'],
  ['emailSignIn', 'big'],
  ['emailReset', 'small'],
  ['googleSignIn', 'small'],
];
const signedOutLoginOrder = () => {
  const ids = ['authEmail', 'authPassword', 'emailSignIn', 'emailReset', 'googleSignIn'];
  const signIn = parseFloat(getComputedStyle(document.getElementById('emailSignIn')).fontSize);
  return ids
    .map((id) => document.getElementById(id))
    .filter((el) => el.checkVisibility())
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map((el) => [
      el.id,
      el.tagName === 'INPUT'
        ? el.type
        : parseFloat(getComputedStyle(el).fontSize) < signIn
          ? 'small'
          : 'big',
    ]);
};
const uid = (role) => 'test-owner-ws-' + role;
const topics = (page, group) =>
  page.locator('#' + group + ' > details > summary').allTextContents();
const FIELD = [
  'My jobs and Company jobs',
  'Property and scope',
  'Walkthrough with the live camera assistant',
  'Photo evidence',
  'QR room and equipment tags',
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
// Signed out, the navy bar shows the loaded white DryScope lockup with the controls; no empty company strip.
async function expectWordmark(page) {
  const lockup = page.locator('.product-bar .lockup img');
  await expect(lockup).toBeVisible();
  await expect(lockup).toHaveAttribute('src', '/brand/dryscope-wordmark-white.svg');
  await expect(lockup).toHaveAttribute('alt', 'DryScope');
  await expect
    .poll(() => lockup.evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  expect((await lockup.boundingBox()).width).toBeGreaterThan(80);
  await expect(page.locator('.product-bar #helpButton')).toBeVisible();
  await expect(page.locator('.product-bar #accountMenu')).toBeVisible();
  await expect(page.locator('.masthead')).toBeHidden();
  expect((await page.locator('.product-bar').boundingBox()).height).toBeLessThan(85);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}
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
        await expectWordmark(page);
        const help = page.getByRole('button', { name: 'Help', exact: true });
        await expect(help).toHaveAttribute('aria-haspopup', 'dialog');
        let dialog = await openHelp(page);
        await expect(page.locator('#helpYours')).toBeHidden();
        await expect(page.locator('#helpOtherHeading')).toHaveText('App features');
        expect(await topics(page, 'helpOther')).toEqual(ALL);
        await expect(dialog.locator('[data-help-topic="start"]')).toHaveAttribute('open', '');
        await expect(dialog.locator('#helpContact')).toHaveText(
          'For company access, ask your company owner.',
        );
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveTitle('DryScope · Water & mold loss estimates');
  for (const hidden of [
    '.inspection-shell',
    '.workspace',
    '.workspace-bar',
    '#jobCoordination',
    '.draft-actions',
  ])
    await expect(page.locator(hidden).first()).toBeHidden();
  await expect(page.locator('.masthead .brand strong')).toHaveText('DryScope');
  for (const width of [320, 390, 641, 700, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expectWordmark(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.masthead .brand')).toHaveAttribute('aria-label', 'DryScope');
  await expect(page.locator('#footerText')).toHaveText('DryScope · Private field inspections');
  await expect(page.locator('footer .powered')).toHaveText('Powered by DryScope');
  await expect(page.locator('#accountMenu')).toContainText('DryScope · App version');
  await expect(page.locator('#workspaceAccountDetails')).toBeEmpty();
  await expect(page.locator('#authPanel #googleSignIn')).toBeVisible();
  await expect(page.getByRole('button', { name: /google/i })).toHaveCount(1);
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  // Email and password lead; Google is the smaller, non-primary option below them.
  expect(await page.evaluate(signedOutLoginOrder)).toEqual(LOGIN_ORDER);
  await expect(page.locator('#emailSignIn')).toHaveClass(/primary/);
  await expect(page.locator('#googleSignIn')).not.toHaveClass(/primary/);
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
      ['My jobs and Company jobs', 'Review and claim documents', ALL[7]],
      ALL[7],
    ],
    ['owner', 'For you: Owner and Superadmin', ALL, ALL[8]],
    ['admin', 'For you: Superadmin', [ALL[10]], ALL[10]],
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
      // Signed in, the company takes the white strip; DryScope stays in the bar, Account and footer.
      await expect(page.locator('.product-bar .lockup img')).toBeVisible();
      expect((await page.locator('.product-bar').boundingBox()).height).toBeLessThan(85);
      await expect(page.locator('.masthead .brand')).toBeVisible();
      await expect(page.locator('#accountMenu')).toContainText('DryScope · App version');
      await expect(page.locator('footer .powered')).toHaveText('Powered by DryScope');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
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
    expect(await topics(page, 'helpYours')).toEqual([FIELD[0], FIELD[5], ALL[7]]);
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
  await expect(page.locator('#helpContact')).toHaveText(
    'For company access, ask your company owner.',
  );
});

// The cached navigation shell must be as neutral as the online sign-in page.
test('signed-out offline shell keeps DryScope identity', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#authPanel')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.masthead .brand strong')).toHaveText('DryScope');
  for (const width of [320, 390, 641, 700, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expectWordmark(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#footerText')).toHaveText('DryScope · Private field inspections');
  await expect(page.locator('body')).not.toContainText(/Alert Disaster|950983|661/);
});
