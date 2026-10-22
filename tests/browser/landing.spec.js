const { test, expect } = require('@playwright/test');
// The public landing page at "/", the app at /app, and every route that must keep working around them.
const uid = (role) => 'test-owner-ws-' + role;
async function call(page, path, method = 'GET', body, role = 'owner') {
  return page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
}
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Console errors, CSP violations included, fail the landing tests.
function watchConsole(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

test('the front page is the static DryScope landing with a plain Log in link', async ({
  page,
  browserName,
}) => {
  const problems = watchConsole(page);
  // The harness would otherwise sign a synthetic user in on /app; this visitor has no account.
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/');
  expect(response.status()).toBe(200);
  // Everything a reader or crawler needs is in the HTML source, before any script runs.
  const source = await response.text();
  for (const needle of [
    '<h1 id="landingHeading">Water &amp; mold loss estimates, signed on site.</h1>',
    '<title>DryScope · Water &amp; mold loss estimates signed on site</title>',
    '<link rel="canonical" href="https://alert-disaster-field-2026.web.app/">',
    '<meta property="og:title"',
    '<script type="application/ld+json">',
    'Does the AI set the prices?',
    'superadmins, owners, estimators and office staff',
  ])
    expect(source).toContain(needle);
  expect(source).not.toMatch(/name="robots"/);
  await expect(page).toHaveTitle('DryScope · Water & mold loss estimates signed on site');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#landingHeading')).toHaveText(
    'Water & mold loss estimates, signed on site.',
  );
  for (const heading of [
    'Three steps, one visit',
    'Questions owners ask',
    'Four documents from one inspection',
    'What the crew gets on the phone',
  ])
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  // Log in is an ordinary link to the app's sign-in screen: header, hero note and closing line.
  const logins = page.getByRole('link', { name: 'Log in', exact: true });
  await expect(logins).toHaveCount(3);
  for (const link of await logins.all()) await expect(link).toHaveAttribute('href', '/app');
  await expect(page.locator('#headerLogin')).toBeVisible();
  // A plain text link, not a button: no border or background, underlined, still a full tap target.
  expect(
    await page.locator('#headerLogin').evaluate((el) => {
      const style = getComputedStyle(el),
        box = el.getBoundingClientRect();
      return [style.borderStyle, style.backgroundColor, style.textDecorationLine, box.height >= 44];
    }),
  ).toEqual(['none', 'rgba(0, 0, 0, 0)', 'underline', true]);
  await expect(page.locator('#accessNote')).toContainText(
    'superadmins, owners, estimators and office staff',
  );
  // No sign-in form, no account-creating control, no Help or Account, nothing of a company.
  await expect(page.locator('form:visible')).toHaveCount(0);
  await expect(page.locator('input:visible, button:visible')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /request access|book a demo/i })).toHaveCount(0);
  await expect(page.locator('#requestAccess')).toBeHidden();
  await expect(page.locator('body')).not.toContainText(/Alert Disaster|950983|661|Powered by/);
  await expect(page.locator('footer')).toHaveText('DryScope · Private field inspections');
  // The JSON-LD restates only what the page shows.
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  const graph = JSON.parse(jsonLd)['@graph'];
  const faq = graph.find((node) => node['@type'] === 'FAQPage');
  const visibleFaq = await page
    .locator('.landing-faq > li')
    .evaluateAll((items) =>
      items.map((item) => [
        item.querySelector('h3').textContent,
        item.querySelector('p').textContent,
      ]),
    );
  expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(visibleFaq);
  const software = graph.find((node) => node['@type'] === 'SoftwareApplication');
  expect(software.featureList).toEqual(
    await page.locator('.landing-features h3').allTextContents(),
  );
  expect(software.description).toBe(await page.locator('.landing-lede').textContent());
  for (const key of ['aggregateRating', 'review', 'offers'])
    expect(software).not.toHaveProperty(key);
  expect(await overflow(page)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('landing-phone.png'), fullPage: true });
  // Keyboard: the header link is the first control after the lockup and leads to the sign-in page.
  await page.locator('.lockup').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#headerLogin')).toBeFocused();
  await page.setViewportSize({ width: 320, height: 844 });
  expect((await page.locator('.lockup img').boundingBox()).width).toBeGreaterThan(80);
  expect(await overflow(page)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await overflow(page)).toBe(0);
  await page.locator('#headerLogin').evaluate((el) => el.blur());
  await page.screenshot({ path: test.info().outputPath('landing-desktop.png'), fullPage: true });
  expect(problems).toEqual([]);
  await page.locator('#headerLogin').click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await expect(page.locator('#googleSignIn')).toBeVisible();
  test.info().annotations.push({ type: 'browser', description: browserName });
});

test('the app at /app is the sign-in screen, marked noindex, and keeps its own branding', async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  const response = await page.goto('/app');
  expect(response.status()).toBe(200);
  expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(response.headers()['permissions-policy']).toBe('tools=()');
  expect(response.headers()['cache-control']).toContain('no-store');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await expect(page.locator('#emailSignIn')).toHaveClass(/primary/);
  await expect(page.locator('#googleSignIn')).toBeVisible();
  await expect(page.locator('#helpButton')).toBeVisible();
  await expect(page.locator('#accountMenu')).toBeVisible();
  await expect(page.locator('.product-bar .lockup')).toHaveAttribute('href', '/app');
  await expect(page.locator('.landing-faq, #headerLogin, [toolname]')).toHaveCount(0);
  // The file's own name is a redirect, never a second address for the app.
  const direct = await page.request.get('/app.html', { maxRedirects: 0 });
  expect(direct.status()).toBe(301);
  expect(direct.headers()['location']).toBe('/app');
  // A nested app path serves the same shell.
  expect((await page.request.get('/app/anything')).status()).toBe(200);
});

test('a device holding a Firebase session is handed from / to /app', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  // Nothing persisted: the landing stays.
  await page.goto('/');
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#landingHeading')).toBeVisible();
  // localStorage persistence (the SDK's fallback where IndexedDB is unavailable).
  await page.evaluate(() => localStorage.setItem('firebase:authUser:key:[DEFAULT]', '{"uid":"x"}'));
  await page.goto('/');
  await expect(page).toHaveURL(/\/app$/);
  await page.evaluate(() => localStorage.removeItem('firebase:authUser:key:[DEFAULT]'));
  // IndexedDB persistence, the SDK's default: the database and store it creates.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('firebaseLocalStorageDb', 1);
        open.onupgradeneeded = () =>
          open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('firebaseLocalStorage', 'readwrite');
          tx.objectStore('firebaseLocalStorage').put({
            fbase_key: 'firebase:authUser:key:[DEFAULT]',
            value: { uid: 'x' },
          });
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await page.goto('/');
  await expect(page).toHaveURL(/\/app$/);
  // Query and hash travel with the hand-off, and old app deep links go over even without a session.
  await page.goto('/?v=ui-20261006-6#notes');
  await expect(page).toHaveURL(/\/app\?v=ui-20261006-6#notes$/);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('firebaseLocalStorageDb');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  );
  await page.goto('/?mode=resetPassword&oobCode=abc');
  await expect(page).toHaveURL(/\/app\?mode=resetPassword&oobCode=abc$/);
  await page.goto('/?utm_source=card');
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/\?utm_source=card$/);
  await expect(page.locator('#landingHeading')).toBeVisible();
});

test('request-access links and form appear only with a mailto or https address', async ({
  browser,
}) => {
  for (const [value, shown] of [
    ['mailto:access@example.invalid', true],
    ['https://example.invalid/demo', true],
    ['javascript:alert(1)', false],
  ]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const problems = watchConsole(page);
    await page.route(
      (url) => url.pathname === '/landing.js',
      async (route) => {
        const body = await (await route.fetch()).text();
        route.fulfill({
          contentType: 'text/javascript',
          body: body.replace(
            "const REQUEST_ACCESS_URL = '';",
            `const REQUEST_ACCESS_URL = '${value}';`,
          ),
        });
      },
    );
    await page.goto('/');
    await expect(page.locator('#landingHeading')).toBeVisible();
    const links = page.getByRole('link', { name: /request access|book a demo/i });
    const form = page.locator('#requestAccessForm');
    if (!shown) {
      await expect(links).toHaveCount(0);
      await expect(form).toBeHidden();
      expect(problems).toEqual([]);
      await context.close();
      continue;
    }
    await expect(links).toHaveCount(2);
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute('toolname', 'request_access');
    expect(await form.evaluate((el) => el.hasAttribute('toolautosubmit'))).toBe(false);
    await page.getByRole('link', { name: 'Request access' }).first().click();
    await expect(page).toHaveURL(/#requestAccess$/);
    await form.locator('[name=company]').fill('Synthetic Restoration');
    await form.locator('[name=name]').fill('Sam Synthetic');
    await form.locator('[name=email]').fill('sam@example.invalid');
    if (value.startsWith('https://')) {
      await expect(form).toHaveAttribute('action', value);
      // A plain GET to the configured page: no DryScope endpoint is involved.
      await page.route(value + '*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>demo</title>' }),
      );
      await page.locator('#requestAccessSubmit').click();
      await expect(page).toHaveURL(
        value +
          '?company=Synthetic+Restoration&name=Sam+Synthetic&email=sam%40example.invalid&message=',
      );
    } else {
      // The mail app gets the request (tests/test_landing.js checks the mailto: URL itself); the
      // page stays put and nothing is sent to DryScope.
      const requests = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.locator('#requestAccessSubmit').click();
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(/\/#requestAccess$/);
      expect(requests.filter((url) => url.includes('/api/') || url.includes('?company='))).toEqual(
        [],
      );
    }
    expect(problems).toEqual([]);
    await context.close();
  }
});

test('WebMCP: read-only tools register from the page text where a model context exists', async ({
  page,
}) => {
  const problems = watchConsole(page);
  await page.addInitScript(() => {
    window.__tools = [];
    // A stand-in for Chrome's origin-trial API: tools register against document.modelContext.
    Object.defineProperty(document, 'modelContext', {
      value: { registerTool: async (tool) => window.__tools.push(tool) },
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__tools.length)).toBe(3);
  const summary = await page.evaluate(async () => {
    const results = {};
    for (const tool of window.__tools)
      results[tool.name] = {
        readOnly: tool.annotations?.readOnlyHint === true,
        params: Object.keys(tool.inputSchema.properties),
        result: await tool.execute({}),
      };
    results.faqMatch = await window.__tools
      .find((tool) => tool.name === 'dryscope_faq')
      .execute({ question: 'which losses' });
    return results;
  });
  expect(Object.keys(summary).sort()).toEqual([
    'dryscope_access',
    'dryscope_faq',
    'dryscope_overview',
    'faqMatch',
  ]);
  for (const name of ['dryscope_overview', 'dryscope_faq', 'dryscope_access'])
    expect(summary[name].readOnly).toBe(true);
  expect(summary.dryscope_overview.params).toEqual([]);
  expect(summary.dryscope_access.params).toEqual([]);
  expect(summary.dryscope_faq.params).toEqual(['question']);
  const origin = new URL(page.url()).origin;
  expect(summary.dryscope_overview.result.headline).toBe(
    await page.locator('#landingHeading').textContent(),
  );
  expect(summary.dryscope_overview.result.features.map((f) => f.title)).toEqual(
    await page.locator('.landing-features h3').allTextContents(),
  );
  expect(summary.dryscope_faq.result.faq.length).toBe(
    await page.locator('.landing-faq > li').count(),
  );
  expect(summary.faqMatch.faq.map((entry) => entry.title)).toEqual([
    'Which losses does it estimate?',
  ]);
  expect(summary.dryscope_access.result).toEqual({
    how: await page.locator('#accessNote').evaluate((el) => el.textContent.trim()),
    login_url: origin + '/app',
    request_access_url: null,
    request_access_form: null,
  });
  // Nothing about credentials is exposed, and the only declarative tool is the hidden request form.
  expect(JSON.stringify(Object.values(summary).map((s) => s.params))).not.toMatch(
    /password|credential/i,
  );
  await expect(page.locator('[toolname]')).toHaveCount(1);
  await expect(page.locator('[toolname]')).toHaveAttribute('id', 'requestAccessForm');
  expect(problems).toEqual([]);
});

test('the homeowner signing page keeps its route, noindex and no tools', async ({ page }) => {
  const response = await page.goto('/sign');
  expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(response.headers()['permissions-policy']).toBe('tools=()');
  await expect(page.locator('.sign-header h1')).toHaveText('Review and sign your estimate');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('#landingHeading, #headerLogin, #authPanel, [toolname]')).toHaveCount(
    0,
  );
});

test('crawling files: robots.txt, the one-page sitemap and the 404 page', async ({ page }) => {
  const robots = await page.request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  const rules = await robots.text();
  expect(rules).toContain('Sitemap: https://alert-disaster-field-2026.web.app/sitemap.xml');
  expect(rules).not.toMatch(/Disallow: \/$/m);
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  const locations = [...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  expect(locations).toEqual(['https://alert-disaster-field-2026.web.app/']);
  const missing = await page.goto('/no-such-page');
  expect(missing.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('There is nothing at this address.');
  await expect(page.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/app');
});

test.describe('company workspaces', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  test('signed-in users open /app straight on their dashboard', async ({ page }) => {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('owner'),
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(page.locator('#dashboardHeading')).toHaveText('Alert Disaster Restoration');
    await expect(page.locator('#authPanel')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/login-page/);
    await expect(page.locator('#helpButton')).toBeVisible();
    await expect(page.locator('#accountMenu')).toBeVisible();
    await expect(page.locator('footer .powered')).toHaveText('Powered by DryScope');
    // Signing out stays on the app's own sign-in screen.
    await page.evaluate(() => auth.signOut());
    await expect(page.locator('#authPanel')).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
  });
  test('invitation links work at /app and old root links are handed over', async ({ page }) => {
    const invitation = await (
      await call(page, '/api/companies/adr/invitations', 'POST', {
        email: uid('pending') + '@example.invalid',
        role: 'office',
      })
    ).json();
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('pending'),
    );
    // Invitation emails now link to /app?invite=…; one sent before the move linked to /?invite=….
    await page.goto('/?invite=' + invitation.invitation_id);
    await expect(page).toHaveURL(/\/app\?invite=[a-f0-9]{32}$/);
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.locator('#dashboardJobs')).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/app');
    expect(url.searchParams.has('invite')).toBe(false);
  });
});
