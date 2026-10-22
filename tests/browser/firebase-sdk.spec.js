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
  await expect(page.locator('#googleSignIn')).toBeVisible();
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
  expect(
    await unexpectedCsp(page, browserName, ['coordEstimator', 'photoRoom', 'equipmentTagKind']),
  ).toEqual([]);
  expect(external.filter((url) => url.includes('/firebasejs/'))).toEqual([]);
});

test('on the live web.app site Google sign-in uses the same-origin auth helper under the Hosting CSP', async ({
  page,
  baseURL,
  browserName,
}) => {
  const live = 'https://alert-disaster-field-2026.web.app';
  await observeCsp(page);
  // The live origin is served from the local test server; Google's scripts stay offline.
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== live) return route.abort();
    if (url.pathname.startsWith('/vendor/firebase/'))
      return route.fulfill({
        contentType: 'text/javascript',
        body: fs.readFileSync(path.join(PUBLIC, url.pathname)),
      });
    if (url.pathname === '/__/auth/iframe')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>helper</title>',
      });
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({
      response,
      headers:
        request.resourceType() === 'document'
          ? { ...response.headers(), 'content-security-policy': DIAGNOSTIC_CSP }
          : response.headers(),
    });
  });
  await page.goto(live + '/');
  await expect(page.locator('#googleSignIn')).toBeVisible();
  expect(await page.evaluate(() => [auth.app.options.authDomain, auth.config.authDomain])).toEqual([
    'alert-disaster-field-2026.web.app',
    'alert-disaster-field-2026.web.app',
  ]);
  // The SDK frames /__/auth/iframe from authDomain, now the page's own origin.
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const frame = document.createElement('iframe');
          frame.hidden = true;
          frame.onload = () => resolve(frame.contentDocument?.title);
          frame.src = '/__/auth/iframe';
          document.body.append(frame);
        }),
    ),
  ).toBe('helper');
  expect(
    await unexpectedCsp(page, browserName, ['coordEstimator', 'photoRoom', 'equipmentTagKind']),
  ).toEqual([]);
});

test('a trailing-dot web.app address reopens on the live host before Firebase starts', async ({
  page,
  baseURL,
}) => {
  const live = 'https://alert-disaster-field-2026.web.app',
    dotted = 'https://alert-disaster-field-2026.web.app.',
    dottedRequests = [];
  // Both hosts are served from the local test server; Google's scripts stay offline.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== live && url.origin !== dotted) return route.abort();
    if (url.origin === dotted) dottedRequests.push(url.pathname);
    if (url.pathname.startsWith('/vendor/firebase/'))
      return route.fulfill({
        contentType: 'text/javascript',
        body: fs.readFileSync(path.join(PUBLIC, url.pathname)),
      });
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
  await page.goto(dotted + '/?from=link#top');
  await expect(page).toHaveURL(live + '/?from=link#top');
  await expect(page.locator('#googleSignIn')).toBeVisible();
  expect(await page.evaluate(() => auth.app.options.authDomain)).toBe(
    'alert-disaster-field-2026.web.app',
  );
  expect(dottedRequests).not.toContain('/__/firebase/init.json');
  // The homeowner signing link keeps its token fragment.
  await page.goto(dotted + '/sign#synthetic-link-token');
  await expect(page).toHaveURL(live + '/sign#synthetic-link-token');
});

test('a Home Screen app on the trailing-dot address says to re-add the icon', async ({
  page,
  baseURL,
}) => {
  const dotted = 'https://alert-disaster-field-2026.web.app.';
  // iOS opens the canonical origin in a sheet above the installed app; a 204 keeps this page in view.
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== dotted) return route.fulfill({ status: 204 });
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
  // Locators would wait for the cancelled redirect to finish, so the page is read directly.
  await page.goto(dotted + '/', { waitUntil: 'commit' });
  await expect
    .poll(() => page.evaluate(() => document.getElementById('message')?.textContent))
    .toBe(
      'This Home Screen icon opens a wrong address, where Google sign-in and walkthroughs fail. Delete the icon, then open alert-disaster-field-2026.web.app in Safari and add it to the Home Screen again.',
    );
  expect(page.url()).toBe(dotted + '/');
});

test('a trailing-dot address with unsynced drafts stays until they sync', async ({
  page,
  baseURL,
}) => {
  const dotted = 'https://alert-disaster-field-2026.web.app.';
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== dotted) return route.abort();
    if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: '' });
    if (url.pathname.startsWith('/vendor/firebase/'))
      return route.fulfill({
        contentType: 'text/javascript',
        body: fs.readFileSync(path.join(PUBLIC, url.pathname)),
      });
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
  await page.goto(dotted + '/seed');
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('adr-private-drafts-v2', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('photos', { keyPath: ['draft_key', 'id'] });
          request.result.createObjectStore('drafts', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const tx = request.result.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({
            key: 'synthetic-uid:synthetic-inspection',
            uid: 'synthetic-uid',
            draft: { inspection_id: 'synthetic-inspection', data: { address: 'x' }, photos: [] },
            ack: null,
          });
          tx.oncomplete = () => {
            request.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await page.goto(dotted + '/');
  await expect(page.locator('#hostSyncNotice')).toHaveText(
    'Drafts on this device are still syncing. Sign in with email and keep this Home Screen icon until they finish.',
  );
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  expect(page.url()).toBe(dotted + '/');
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
