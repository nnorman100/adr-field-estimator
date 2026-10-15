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
    [...shell.matchAll(/\.(?:css|js)\?v=([0-9A-Za-z-]+)/g)].map((m) => m[1]),
    Array(5).fill(marker),
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
    [...signingPage.matchAll(/\.(?:css|js)\?v=([0-9A-Za-z-]+)/g)].map((m) => m[1]),
    Array(4).fill(marker),
    'Signing page asset URLs carry another marker',
  );
  assert.equal(unstamp(signingPage), unstamp(fs.readFileSync('public/sign.html', 'utf8')));
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
  assert.equal(unstamp(shell), unstamp(fs.readFileSync('public/index.html', 'utf8')));
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
  for (const file of [
    'app.js',
    'workspaces.js',
    'app.css',
    'core.js',
    'documents.js',
    'sign.js',
    'audio-worklet.js',
    'sw.js',
  ])
    assert.equal(
      unstamp(await (await fetch(base + '/' + file + '?verify=repair-20261006')).text()),
      unstamp(fs.readFileSync('public/' + file, 'utf8')),
      'Deployed asset differs: ' + file,
    );
  for (const file of [
    'brand/adr-logo.jpg',
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
      (await page.locator('.masthead').boundingBox()).height < 85,
      'Narrow header is oversized',
    );
    await page.locator('.task-nav [data-task="walkthrough"]').click();
    // This check runs signed out, where the email sign-in panel sits above the tasks. It models the
    // workspaces-off signed-in layout (sign-in panel hidden, no #workspaceNav), so measure the
    // capture action with the panel hidden. The workspaces-on signed-in layout, where #workspaceNav
    // appears above the tasks, is not covered by this check.
    await page.evaluate(() => (document.getElementById('authPanel').hidden = true));
    const start = await page.locator('#startWalk').boundingBox();
    await page.evaluate(() => (document.getElementById('authPanel').hidden = false));
    assert(start.y + start.height < 844, 'Capture action is below the first screen');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Mobile task layout overflows',
    );
    assert(await page.locator('#stopWalk').isHidden(), 'Idle Stop control is visible');
  }
  assert.equal(await page.locator('.brand img').evaluate((img) => img.naturalWidth), 225);
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
  console.log(
    'PASS: deployed assets, narrow/mobile task navigation and capture layout, local fonts/cache, dedicated Firebase/API, CSP and real Google OAuth popup',
  );
  assert.equal(errors.length, 0, 'Browser initialization/CSP error: ' + errors.join(';'));
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
