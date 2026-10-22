const { test, expect } = require('@playwright/test');
// The signed-out landing page: DryScope marketing around the existing email-first sign-in card.
// Signed-in accounts, homeowner signing links and invitation links keep their current routes.
const uid = (role) => 'test-owner-ws-' + role;
// Signed out until a test stores an account to sign in as and reloads.
const signedOut = (page) =>
  page.addInitScript(() => {
    if (!sessionStorage.getItem('synthetic-landing-account'))
      sessionStorage.setItem('synthetic-signed-out', '1');
  });
async function call(page, path, method = 'GET', body, role = 'owner') {
  return page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
}
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('signed-out visitors see the DryScope landing with sign-in one tap away', async ({
  page,
  browserName,
}) => {
  await signedOut(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/login-page/);
  await expect(page.locator('#landingHero')).toBeVisible();
  await expect(page.locator('#landingBody')).toBeVisible();
  await expect(page.locator('h1:visible')).toHaveCount(1);
  await expect(page.locator('#landingHeading')).toHaveText(
    'Water & mold loss estimates, signed on site.',
  );
  await expect(page.locator('#landingHero .eyebrow')).toHaveText(
    'FOR WATER MITIGATION & DISASTER RESTORATION COMPANIES',
  );
  for (const heading of ['Three steps, one visit', 'Four documents from one inspection'])
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  // The existing email-first card stays embedded; the bar's one control is Sign in. Help and
  // Account return with an account, and the hero adds no second button above the form.
  await expect(page.locator('#headerSignIn')).toBeVisible();
  await expect(page.locator('.product-bar a:visible, .product-bar button:visible')).toHaveCount(2);
  await expect(page.locator('#helpButton')).toBeHidden();
  await expect(page.locator('#accountMenu')).toBeHidden();
  await expect(page.locator('#landingHero .landing-button:visible')).toHaveCount(0);
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await expect(page.locator('#emailSignIn')).toHaveClass(/primary/);
  await expect(page.locator('#googleSignIn')).toBeVisible();
  await expect(page.locator('a[href="#authPanel"]:visible')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(1);
  // The footer names DryScope once; the attribution line belongs to a signed-in company.
  await expect(page.locator('#footerText')).toHaveText('DryScope · Private field inspections');
  await expect(page.locator('footer .powered')).toBeHidden();
  // Public sign-up is off and no contact address is configured: no account-creating or dangling CTA.
  for (const id of ['requestAccess', 'requestAccessFooter']) {
    await expect(page.locator('#' + id)).toBeHidden();
    await expect(page.locator('#' + id)).not.toHaveAttribute('href', /./);
  }
  await expect(page.getByRole('link', { name: /request access|book a demo/i })).toHaveCount(0);
  // Social and search metadata name DryScope; the pre-sign-in page carries no company identity.
  await expect(page).toHaveTitle('DryScope · Water & mold loss estimates');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /DryScope/);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /./);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https:/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /./);
  await expect(page.locator('body')).not.toContainText(/Alert Disaster|950983|661/);
  expect(await overflow(page)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('landing-phone.png'), fullPage: true });
  // Keyboard: the header link is the first control after the lockup and lands on the email field.
  await page.locator('.lockup').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#headerSignIn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#authEmail')).toBeFocused();
  await page.locator('#landingClosing').scrollIntoViewIfNeeded();
  await page.locator('.landing-closing a[href="#authPanel"]').click();
  await expect(page.locator('#authEmail')).toBeFocused();
  expect(
    await page.locator('#authPanel').evaluate((el) => el.getBoundingClientRect().top),
  ).toBeLessThan(120);
  // One tap on the narrowest phones too.
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator('#headerSignIn')).toBeVisible();
  expect((await page.locator('.product-bar .lockup img').boundingBox()).width).toBeGreaterThan(80);
  expect(await overflow(page)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#headerSignIn')).toBeVisible();
  expect(await overflow(page)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('landing-desktop.png'), fullPage: true });
  test.info().annotations.push({ type: 'browser', description: browserName });
});

test('request-access links appear only with a mailto or https contact address', async ({
  browser,
}) => {
  for (const [value, shown] of [
    ['mailto:access@example.invalid', true],
    ['https://example.invalid/demo', true],
    ['javascript:alert(1)', false],
  ]) {
    // A fresh context with no service worker, so the rewritten script is the one that runs.
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    await signedOut(page);
    await page.route(
      (url) => url.pathname === '/app.js',
      async (route) => {
        const body = (await route.fetch()).text();
        route.fulfill({
          contentType: 'text/javascript',
          body: (await body).replace(
            "const REQUEST_ACCESS_URL = '';",
            `const REQUEST_ACCESS_URL = '${value}';`,
          ),
        });
      },
    );
    await page.goto('/');
    await expect(page.locator('#landingHero')).toBeVisible();
    const links = [page.locator('#requestAccess'), page.locator('#requestAccessFooter')];
    for (const link of links) {
      if (shown) {
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', value);
      } else {
        await expect(link).toBeHidden();
        await expect(link).not.toHaveAttribute('href', /./);
      }
    }
    await context.close();
  }
});

test('the homeowner signing page carries no landing', async ({ page }) => {
  await page.goto('/sign');
  await expect(page.locator('.sign-header h1')).toHaveText('Review and sign your estimate');
  await expect(page.locator('.landing, #headerSignIn, #authPanel')).toHaveCount(0);
  await expect(page.locator('.product-bar .lockup img')).toHaveAttribute('alt', 'DryScope');
});

test.describe('company workspaces', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  test('signed-in users go straight to their dashboard', async ({ page }) => {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('owner'),
    );
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(page.locator('#dashboardHeading')).toHaveText('Alert Disaster Restoration');
    for (const hidden of ['#landingHero', '#landingBody', '#headerSignIn', '#authPanel'])
      await expect(page.locator(hidden)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/login-page/);
    // The signed-in header and footer are unchanged.
    await expect(page.locator('#helpButton')).toBeVisible();
    await expect(page.locator('#accountMenu')).toBeVisible();
    await expect(page.locator('footer .powered')).toHaveText('Powered by DryScope');
    // Signing out returns to the landing without a reload.
    await page.evaluate(() => auth.signOut());
    await expect(page.locator('#landingHero')).toBeVisible();
    await expect(page.locator('#headerSignIn')).toBeVisible();
    await expect(page.locator('#helpButton')).toBeHidden();
    await expect(page.locator('#emailAuthForm')).toBeVisible();
    await expect(page.locator('#workspaceDashboard')).toBeHidden();
  });
  test('invitation links keep their route signed out and signed in', async ({ page }) => {
    const invitation = await (
      await call(page, '/api/companies/adr/invitations', 'POST', {
        email: uid('pending') + '@example.invalid',
        role: 'office',
      })
    ).json();
    await signedOut(page);
    await page.goto('/?invite=' + invitation.invitation_id);
    await expect(page.locator('#landingHero')).toBeVisible();
    await expect(page.locator('#emailAuthForm')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('invite')).toBe(invitation.invitation_id);
    // The invited account signs in: its dashboard offers the invitation, with no landing around it.
    await page.evaluate((value) => {
      sessionStorage.removeItem('synthetic-signed-out');
      sessionStorage.setItem('synthetic-landing-account', '1');
      sessionStorage.setItem('synthetic-uid', value);
    }, uid('pending'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await expect(page.locator('#landingHero')).toBeHidden();
    await expect(page.locator('#headerSignIn')).toBeHidden();
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.locator('#dashboardJobs')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('invite')).toBe(false);
  });
});

test('legacy mode without workspaces opens the inspection, not the landing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#landingHero')).toBeHidden();
  await expect(page.locator('#headerSignIn')).toBeHidden();
  await expect(page.locator('#helpButton')).toBeVisible();
  await expect(page.locator('#accountMenu')).toBeVisible();
});
