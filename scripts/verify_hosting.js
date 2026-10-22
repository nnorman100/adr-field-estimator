const { chromium } = require('playwright'),
  fs = require('node:fs'),
  nodePath = require('node:path'),
  assert = require('node:assert/strict');
// Screenshots are local evidence (review-artifacts/ is gitignored).
const EVIDENCE = nodePath.join(__dirname, '..', 'review-artifacts');
// Mirrors scripts/stamp_hosting.py: compare deployed and local shells apart from the release stamp.
const unstamp = (text) =>
  text
    .replace(/^(const VERSION=')[^']*(';)/m, '$1unstamped$2')
    .replace(/(\.(?:css|js)\?v=)[0-9A-Za-z-]+/g, '$1unstamped')
    .replace(/(App version )[^<]+(<\/small>)/, '$1unstamped$2');
// Each versioned asset a page loads, with its ?v= stamp; the local copies define what to expect.
const versioned = (html) =>
  [...html.matchAll(/"\/([^"?]+\.(?:css|js))\?v=([0-9A-Za-z-]+)"/g)].map((m) => ({
    file: m[1],
    stamp: m[2],
  }));
const localShell = fs.readFileSync('public/index.html', 'utf8'),
  localSigning = fs.readFileSync('public/sign.html', 'utf8');
(async () => {
  const base = 'https://alert-disaster-field-2026.web.app';
  const response = await fetch(base);
  assert(response.ok);
  const shell = await response.text();
  const marker =
    ((await (await fetch(base + '/sw.js?verify=stamp')).text()).match(
      /^const VERSION='([^']*)';/m,
    ) || [])[1] || '';
  assert.match(
    marker,
    /^[0-9a-f]{40}(-dirty)?$/,
    'The deployed shell is not stamped with a source commit: ' + marker,
  );
  assert.deepEqual(
    versioned(shell).map((asset) => asset.stamp),
    Array(versioned(localShell).length).fill(marker),
    'Deployed asset URLs carry another marker',
  );
  // The homeowner signing page: its own rewrite, never cached, same files as the commit.
  const signing = await fetch(base + '/sign');
  assert.match(
    signing.headers.get('cache-control') || '',
    /\bno-store\b/,
    'The signing page can stay stale in a browser',
  );
  const signingPage = await signing.text();
  assert.deepEqual(
    versioned(signingPage).map((asset) => asset.stamp),
    Array(versioned(localSigning).length).fill(marker),
    'Signing page asset URLs carry another marker',
  );
  assert.equal(unstamp(signingPage), unstamp(localSigning));
  // Without a link the anonymous route answers with the link-specific 404, not a missing route.
  assert.equal(
    (await (await fetch(base + '/api/sign')).json()).detail,
    'This signing link is not available. Ask your technician for a new link.',
  );
  assert(
    shell.includes(
      'App version ' +
        marker.slice(0, 12) +
        (marker.endsWith('-dirty') ? '-dirty' : '') +
        '</small>',
    ),
    'Displayed app version is not the stamped commit',
  );
  assert.equal(unstamp(shell), unstamp(localShell));
  for (const path of ['/', '/index.html', '/?v=ui-20261006-6']) {
    const html = await fetch(base + path);
    assert.match(
      html.headers.get('cache-control') || '',
      /\bno-store\b/,
      'The app shell can stay stale in a browser: ' + path,
    );
    assert(
      (await html.text()).includes('class="task-nav"'),
      'Redesigned task navigation is missing: ' + path,
    );
  }
  for (const file of new Set([
    ...[...versioned(localShell), ...versioned(localSigning)].map((asset) => asset.file),
    'audio-worklet.js',
    'sw.js',
  ]))
    assert.equal(
      unstamp(await (await fetch(base + '/' + file + '?verify=repair-20261006')).text()),
      unstamp(fs.readFileSync('public/' + file, 'utf8')),
      'Deployed asset differs: ' + file,
    );
  for (const file of [
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
    'brand/adr-logo.jpg',
    'brand/dryscope-mark.svg',
    'brand/dryscope-mark-navy.svg',
    'brand/dryscope-mark-white.svg',
    'brand/dryscope-mark-reverse.svg',
    'brand/dryscope-wordmark.svg',
    'brand/dryscope-wordmark-white.svg',
    'brand/dryscope-wordmark-navy.svg',
    'brand/dryscope-wordmark-mono-white.svg',
    'fonts/lato-400-latin.woff2',
    'fonts/lato-700-latin.woff2',
    'fonts/lato-900-latin.woff2',
    'fonts/ebgaramond-400-latin.woff2',
  ]) {
    const asset = await fetch(base + '/' + file);
    assert(asset.ok);
    assert.deepEqual(
      Buffer.from(await asset.arrayBuffer()),
      fs.readFileSync('public/' + file),
      'Deployed branding differs: ' + file,
    );
  }
  assert(response.headers.get('content-security-policy').includes("object-src 'none'"));
  const health = await (await fetch(base + '/api/health')).json();
  const {
    status,
    schema_version,
    source_commit = 'not reported (built before release stamping)',
    ...extra
  } = health;
  assert.deepEqual(
    { status, schema_version, extra },
    { status: 'healthy', schema_version: 3, extra: {} },
  );
  console.log(
    'Frontend commit ' +
      marker +
      '; backend source_commit ' +
      source_commit +
      (source_commit === marker
        ? ' (same commit)'
        : ' (different builds; RELEASES.md records each)'),
  );
  assert.equal((await fetch(base + '/api/inspections')).status, 401);
  const config = await (await fetch(base + '/__/firebase/init.json')).json();
  assert.equal(config.projectId, 'alert-disaster-field-2026');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(base);
  await page.waitForFunction(
    () =>
      typeof auth !== 'undefined' &&
      auth !== null &&
      document.getElementById('googleSignIn').checkVisibility(),
  );
  await page.waitForTimeout(1500);
  assert(!(await page.locator('#message').textContent()).includes('initialization failed'));
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      (await page.locator('.product-bar').boundingBox()).height < 85,
      'Narrow header is oversized',
    );
    // Signed out, only the login page shows: email and password first, then one smaller Google sign-in below.
    assert(await page.evaluate(() => document.body.classList.contains('login-page')));
    assert.deepEqual(
      await page.evaluate(() =>
        ['authEmail', 'authPassword', 'emailSignIn', 'emailReset', 'googleSignIn']
          .map((id) => document.getElementById(id))
          .filter((el) => el.checkVisibility())
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((el) => el.id),
      ),
      ['authEmail', 'authPassword', 'emailSignIn', 'emailReset', 'googleSignIn'],
      'Signed-out login page needs email and password above Google sign-in',
    );
    assert(
      await page.evaluate(
        () =>
          document.getElementById('emailSignIn').classList.contains('primary') &&
          !document.getElementById('googleSignIn').classList.contains('primary'),
      ),
      'Email sign-in must be the primary button, Google the secondary one',
    );
    assert.equal(
      await page.evaluate(
        () =>
          [...document.querySelectorAll('button')].filter(
            (b) => b.checkVisibility() && /sign in with google/i.test(b.textContent),
          ).length,
      ),
      1,
      'Signed-out login page needs exactly one Google sign-in',
    );
    for (const selector of ['.task-nav', 'main.workspace', '#inspectionForm', '#startWalk'])
      assert(
        await page.locator(selector).evaluate((el) => !el.checkVisibility()),
        'Inspection workspace is visible while signed out: ' + selector,
      );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Mobile task layout overflows',
    );
  }
  assert.deepEqual(
    await page
      .locator('.product-bar .lockup img')
      .evaluate((img) => [img.getAttribute('src'), img.naturalWidth, img.checkVisibility()]),
    ['/brand/dryscope-wordmark-white.svg', 1754, true],
    'Signed-out header bar lacks the DryScope lockup',
  );
  assert(
    !(await page.locator('.masthead').evaluate((el) => el.checkVisibility())),
    'Signed-out page shows an empty company strip',
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Mobile page overflows',
  );
  assert(
    await page.evaluate(() => document.fonts.check('16px Lato')),
    'Local Lato font unavailable',
  );
  await page.evaluate(async () => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        urls.push(new URL(request.url).pathname);
    return urls;
  });
  for (const path of [
    '/brand/adr-logo.jpg',
    '/brand/dryscope-mark.svg',
    '/brand/dryscope-wordmark.svg',
    '/brand/dryscope-wordmark-white.svg',
    '/fonts/lato-400-latin.woff2',
    '/fonts/ebgaramond-400-latin.woff2',
  ])
    assert(cached.includes(path), 'Missing offline branding: ' + path);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: nodePath.join(EVIDENCE, 'redesigned-live-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: nodePath.join(EVIDENCE, 'redesigned-live-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 });
  await page.locator('#googleSignIn').click();
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.hostname === 'accounts.google.com', { timeout: 20000 });
  // A redirect URI missing from the OAuth client still lands on accounts.google.com, at its error page.
  assert(
    !popup.url().includes('/signin/oauth/error'),
    'Google rejected the sign-in request: ' + popup.url(),
  );
  console.log(
    'PASS: deployed assets, signed-out login page at narrow widths, local fonts/cache, dedicated Firebase/API, CSP and real Google OAuth popup',
  );
  assert.equal(errors.length, 0, 'Browser initialization/CSP error: ' + errors.join(';'));
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
