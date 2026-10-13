const { test, expect } = require('@playwright/test');
const fs = require('node:fs'),
  path = require('node:path');
const PUBLIC = path.resolve(__dirname, '../../public');
// The test server stubs the SDK and sends no CSP; this spec serves the vendored SDK under Hosting's policy instead.
const CSP = require('../../firebase.json')
  .hosting.headers.find((rule) => rule.source === '**')
  .headers.find((header) => header.key === 'Content-Security-Policy').value;
// report-sample adds diagnostics only; the Hosting policy's enforcement stays intact.
const DIAGNOSTIC_CSP = CSP.replace("style-src 'self'", "style-src 'self' 'report-sample'");
test.use({ serviceWorkers: 'block' });

async function observeCsp(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        sample: event.sample,
        sourceFile: event.sourceFile,
        target: event.target.id || '',
        nativeSelect:
          event.target instanceof HTMLSelectElement && !event.target.hasAttribute('style'),
      }),
    );
  });
}
async function unexpectedCsp(page, browserName, nativeSelectIds) {
  const violations = await page.evaluate(() => window.__cspViolations);
  // WebKit 2370 sets this style on a detached UA select slot, before its shadow-tree CSP exemption applies.
  // https://github.com/WebKit/WebKit/commit/ef67848e58750b33e018150541e1085fd5dedfd9
  // Keep authored styles (even identical text), script reports and every other style report visible.
  return violations.filter(
    (event) =>
      !(
        browserName === 'webkit' &&
        event.nativeSelect &&
        nativeSelectIds.includes(event.target) &&
        event.directive === 'style-src-attr' &&
        event.blockedURI === 'inline' &&
        event.sample === 'text-overflow:inherit' &&
        event.sourceFile === ''
      ),
  );
}

test('the vendored modular Firebase SDK starts the app same-origin under the Hosting CSP', async ({
  page,
  baseURL,
  browserName,
}) => {
  const origin = new URL(baseURL).origin,
    external = [];
  await observeCsp(page);
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    // Sign-in helpers and reCAPTCHA stay offline; the SDK itself must never come from another origin.
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/vendor/firebase/'))
      return route.fulfill({
        contentType: 'text/javascript',
        body: fs.readFileSync(path.join(PUBLIC, url.pathname)),
      });
    if (request.resourceType() === 'document') {
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': DIAGNOSTIC_CSP },
      });
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('#signInButton')).toBeVisible();
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  expect(
    await page.evaluate(() => ({
      user: auth.currentUser,
      project: auth.app.options.projectId,
      persistence: auth.persistenceManager.persistence.type,
    })),
  ).toEqual({ user: null, project: 'alert-disaster-field-2026', persistence: 'LOCAL' });
  // App Check joins the same app instance, and a failed attestation still yields no token instead of an error.
  expect(
    await page.evaluate(async () => {
      const sdk = await loadAppCheck('synthetic-site-key');
      activateAppCheck(auth.app, sdk, 'synthetic-site-key');
      return appCheckToken();
    }),
  ).toBe('');
  expect(await unexpectedCsp(page, browserName, ['coordEstimator', 'photoRoom'])).toEqual([]);
  expect(external.filter((url) => url.includes('/firebasejs/'))).toEqual([]);
});

test('native select CSP diagnostics keep authored inline styles visible', async ({
  page,
  browserName,
}) => {
  await observeCsp(page);
  // No app scripts or Firebase: a native select alone reproduces WebKit's internal style report.
  await page.route('**/csp-select', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'content-security-policy': DIAGNOSTIC_CSP },
      body: '<!doctype html><select id="native"><option value="one">One</option><option value="two">Two</option></select>',
    }),
  );
  await page.goto('/csp-select');
  await page.locator('#native').selectOption('two');
  await expect(page.locator('#native')).toHaveValue('two');
  expect(await unexpectedCsp(page, browserName, ['native'])).toEqual([]);
  // An authored style with the exact same payload must still be blocked and reported.
  await page.evaluate(() => {
    document.body.style.textOverflow = 'ellipsis';
    document.querySelector('#native').setAttribute('style', 'text-overflow:inherit');
  });
  await expect
    .poll(async () => (await unexpectedCsp(page, browserName, ['native'])).length)
    .toBe(1);
  const [violation] = await unexpectedCsp(page, browserName, ['native']);
  expect(violation).toMatchObject({
    directive: 'style-src-attr',
    blockedURI: 'inline',
    sample: 'text-overflow:inherit',
    target: 'native',
    nativeSelect: false,
  });
  expect(
    await page.locator('#native').evaluate((select) => getComputedStyle(select).textOverflow),
  ).toBe('clip');
});
