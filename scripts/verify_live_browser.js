/* Normal Google staff sign-in and synthetic release verification. No auth state is exported. */
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process'),
  readline = require('node:readline');
const { parseArgs } = require('node:util');
const { canonicalPath, isWithin } = require('./artifact-paths');
const ROOT = path.resolve(__dirname, '..'),
  BASE = 'https://alert-disaster-field-2026.web.app';
const PRODUCTION = 'https://alert-disaster-field-estimator-545776254070.us-west2.run.app';
const SERVICE_HOST = 'alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app';
// Python resolves from ADR_TEST_PYTHON, then the repository's .venv, then PATH.
function pythonCommand(env = process.env, platform = process.platform, root = ROOT) {
  if (env.ADR_TEST_PYTHON) return env.ADR_TEST_PYTHON;
  const venv =
    platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return platform === 'win32' ? 'python' : 'python3';
}
function backendUrl(tag) {
  // This service leaves 16 characters for the tag in its 63-character DNS label.
  if (
    typeof tag !== 'string' ||
    tag.length > 16 ||
    !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(tag) ||
    /[^a-z0-9-]/.test(tag)
  )
    throw Error(
      'Backend tag must be 1-16 lowercase letters/digits/hyphens, starting with a letter and ending with a letter or digit.',
    );
  return 'https://' + tag + '---' + SERVICE_HOST;
}
function parseOptions(args) {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      'backend-tag': { type: 'string' },
      production: { type: 'boolean' },
      workspaces: { type: 'boolean' },
      'artifact-dir': { type: 'string' },
      'auth-smoke': { type: 'boolean' },
      headless: { type: 'boolean' },
      hold: { type: 'boolean' },
      'slow-init': { type: 'boolean' },
    },
  });
  const names = tokens.map((token) => token.name);
  if (new Set(names).size !== names.length) throw Error('Options must not be repeated.');
  const selectors =
    Number(values.production === true) +
    Number(values.workspaces === true) +
    Number(values['backend-tag'] !== undefined);
  if (selectors > 1)
    throw Error(
      'Choose only one of --backend-tag, --workspaces (alias for tag workspaces), or --production.',
    );
  if (!selectors && !values['auth-smoke'])
    throw Error(
      'Select --backend-tag TAG for staged verification, --workspaces (tag workspaces), or --production.',
    );
  const tag = values.workspaces ? 'workspaces' : values['backend-tag'];
  const service = tag !== undefined ? backendUrl(tag) : PRODUCTION;
  const artifactDir = values['artifact-dir'];
  if (artifactDir !== undefined && (!artifactDir || !path.isAbsolute(artifactDir)))
    throw Error('--artifact-dir must be an absolute directory outside the repository.');
  return {
    service,
    mode: values.production ? 'production' : 'staged',
    local: !values.production,
    artifactDir,
    smoke: !!values['auth-smoke'],
    headless: !!values.headless,
    hold: !!values.hold,
    slowInit: !!values['slow-init'],
  };
}
function createArtifactDirectory(parent = os.tmpdir()) {
  const canonical = canonicalPath(parent);
  if (isWithin(fs.realpathSync(ROOT), canonical))
    throw Error('Artifact directory must be outside the repository, including symlink targets.');
  fs.mkdirSync(canonical, { recursive: true });
  return fs.mkdtempSync(path.join(canonical, 'adr-live-release-'));
}
function safe(text) {
  return String(text).replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    '[token omitted]',
  );
}
async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const logDir = createArtifactDirectory(options.artifactDir);
  const { chromium, expect } = require('@playwright/test');
  const { launchManual, closeManual, sameContextPage } = require('./manual_chrome');
  const { mode, smoke, hold: HOLD, headless: HEADLESS } = options;
  let { service, local } = options;
  const inspections = new Set(),
    agreements = new Set();
  console.log(
    'TARGET: ' + service + '; UI: ' + (local ? 'local' : 'production') + '; ARTIFACTS: ' + logDir,
  );
  function python(args, input, label) {
    return new Promise((resolve, reject) => {
      const environment = {
        ...process.env,
        PYTHONPATH: path.join(ROOT, '.voice-test-deps'),
        PYTHONUNBUFFERED: '1',
      };
      const child = spawn(
        pythonCommand(),
        [path.join(ROOT, 'scripts', 'verify_live_release.py'), ...args],
        { cwd: ROOT, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let output = '';
      const record = (data) => {
        const clean = safe(data.toString());
        output += clean;
        process.stdout.write(clean);
      };
      child.stdout.on('data', record);
      child.stderr.on('data', record);
      child.once('error', reject);
      child.once('exit', (code) => {
        fs.writeFileSync(path.join(logDir, label + '.txt'), output);
        code === 0 ? resolve() : reject(Error(label + ' failed; see its credential-free log.'));
      });
      child.stdin.end(input + '\n');
    });
  }
  let manual = null,
    browser,
    context,
    page,
    signedPage = null;
  let userUid = null,
    cachedToken = null;
  try {
    if (!smoke) {
      if (HEADLESS)
        throw Error(
          'Google sign-in requires normal private Chrome; headless is only for --auth-smoke.',
        );
      manual = await launchManual(BASE);
      console.log(
        'MANUAL_SIGN_IN_REQUIRED: This is normal private Chrome, with no automation attached. Sign in to the app, then send signed-in to this helper. No password/token in chat.',
      );
      const input = readline.createInterface({ input: process.stdin });
      let requested = false;
      for await (const line of input) {
        if (line.trim() === 'signed-in') {
          requested = true;
          break;
        }
        if (line.trim() === 'quit') break;
      }
      input.close();
      if (!requested) {
        await closeManual(null, manual);
        return;
      }
      console.log('HANDOFF: attaching to the signed-in private Chrome window.');
      browser = await chromium.connectOverCDP(manual.endpoint);
      console.log('HANDOFF: connected to Chrome.');
      context = browser.contexts().find((c) => c.pages().some((p) => p.url().startsWith(BASE)));
      if (!context) throw Error('The manual sign-in tab is not available.');
      signedPage = context.pages().find((p) => p.url().startsWith(BASE));
      await signedPage.waitForFunction(
        () =>
          typeof auth !== 'undefined' &&
          auth?.currentUser &&
          document.getElementById('address').disabled === false,
        {},
        { timeout: 30000 },
      );
      const existing = await signedPage.evaluate(() => ({
        signedIn: !!auth.currentUser,
        inspection:
          typeof state !== 'undefined' &&
          state.record?.status === 'draft' &&
          stable(state.draft?.data) === stable(emptyData()) &&
          !state.draft.photos.length
            ? state.draft.inspection_id
            : null,
      }));
      if (!existing.signedIn)
        throw Error(
          'Normal Chrome is not signed in yet. Finish Google sign-in before sending signed-in.',
        );
      cachedToken = await signedPage.evaluate(() => auth.currentUser.getIdToken());
      console.log('HANDOFF: staff sign-in confirmed in the original Chrome page.');
      if (existing.inspection) inspections.add(existing.inspection);
      await signedPage.evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations())
          await registration.unregister();
      });
      page = await sameContextPage(browser, signedPage);
    } else {
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
      });
      page = await context.newPage();
    }
  } catch (error) {
    await closeManual(browser, manual);
    throw error;
  }
  try {
    await page.route(BASE + '/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (smoke && options.slowInit && url.pathname === '/__/firebase/init.json')
        await new Promise((resolve) => setTimeout(resolve, 1500));
      if (url.pathname.startsWith('/api/')) {
        const authorization = request.headers().authorization;
        if (authorization?.startsWith('Bearer ')) cachedToken = authorization.slice(7);
        if (request.method() === 'POST' && url.pathname === '/api/inspections') {
          const value = request.postDataJSON();
          inspections.add(value.inspection_id);
        }
        if (request.method() === 'POST' && url.pathname === '/api/authorize') {
          const value = request.postDataJSON();
          agreements.add(value.auth_id);
        }
        const response = await route.fetch({
          url: service + url.pathname + url.search,
          timeout: 115000,
          maxRedirects: 0,
        });
        if (response.status() >= 300 && response.status() < 400)
          return route.abort('blockedbyclient');
        if (url.pathname === '/api/session' && response.ok()) userUid = (await response.json()).uid;
        return route.fulfill({ response });
      }
      // Memory-only authentication: the app's auth module becomes a wrapper that re-exports the vendored build with in-memory persistence.
      if (
        /^\/vendor\/firebase\/[^/]+\/firebase-auth\.js$/.test(url.pathname) &&
        url.search !== '?vendored'
      ) {
        return route.fulfill({
          contentType: 'text/javascript',
          body: "export * from './firebase-auth.js?vendored';import {initializeAuth as initialize,inMemoryPersistence} from './firebase-auth.js?vendored';export const initializeAuth=(app,deps)=>initialize(app,{...deps,persistence:inMemoryPersistence});",
        });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // The local shell names its own SDK release, which Hosting may not serve yet.
      if (
        local &&
        ([
          'index.html',
          'app.js',
          'workspaces.js',
          'core.js',
          'app.css',
          'audio-worklet.js',
          'sw.js',
        ].includes(file) ||
          /^vendor\/firebase\/[^/]+\/firebase-[a-z-]+\.js$/.test(file))
      ) {
        const contentType = file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/javascript';
        return route.fulfill({
          contentType,
          body: fs.readFileSync(path.join(ROOT, 'public', file)),
        });
      }
      return route.continue();
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    if (smoke) await expect(page.locator('#signInButton')).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(
      () => typeof auth !== 'undefined' && auth?.persistenceManager?.persistence.type === 'NONE',
      {},
      { timeout: 30000 },
    );
    if (smoke) {
      console.log(
        'PASS: actual Firebase SDK initializes with memory-only authentication and the dedicated sign-in UI. No jobs or IAM changes.',
      );
      return;
    }
    console.log(
      'VERIFYING_MANUAL_SESSION: Google sign-in was completed before automation attached.',
    );
    await page.waitForFunction(
      () =>
        typeof auth !== 'undefined' &&
        auth?.currentUser &&
        document.getElementById('address').disabled === false,
      {},
      { timeout: 30000 },
    );
    userUid = await page.evaluate(() => auth.currentUser.uid);
    const memoryOnly = await page.evaluate(() => auth.persistenceManager.persistence.type);
    if (memoryOnly !== 'NONE') throw Error('Auth persistence is not memory-only.');
    console.log(
      'PASS: ordinary Google staff sign-in, memory-only Firebase authentication; no IAM changes.',
    );
    if (signedPage && !signedPage.isClosed()) {
      await signedPage.close();
      signedPage = null;
    }
    async function token() {
      try {
        cachedToken = await page.evaluate(() => auth.currentUser.getIdToken(true));
      } catch (error) {
        if (!cachedToken) throw error;
      }
      return cachedToken;
    }
    async function cleanBrowserRecords(label) {
      if (!inspections.size && !agreements.size) return;
      await python(
        [service, '--cleanup-stdin'],
        JSON.stringify({
          token: await token(),
          inspections: [...inspections],
          agreements: [...agreements],
        }),
        label + '-browser-cleanup',
      );
      inspections.clear();
      agreements.clear();
    }
    async function uiCheck(label) {
      await page.setViewportSize({ width: 390, height: 844 });
      // The page and all created IDs belong only to this ephemeral synthetic session.
      if (await page.locator('#workspaceDashboard').isVisible())
        await page.getByRole('button', { name: 'New job', exact: true }).click();
      else {
        await page.locator('#jobMenu summary').click();
        await page.locator('#newInspection').click();
      }
      await expect(page.locator('#saveStatus')).toContainText('Saved privately', {
        timeout: 30000,
      });
      await page
        .locator('#address')
        .fill('Synthetic browser release verification - no customer data');
      await page.locator('#yearBuilt').fill('2000');
      await page
        .locator('#technicianNotes')
        .fill(
          'Room 1, category 1. I measured 10 square feet of finished drywall to remove. For this job use 3 fans and 1 dehumidifier for 3 days. Proposed localized drywall removal and drying only.',
        );
      await page.locator('#fillScopeProperty').click();
      await expect(page.locator('#scopeSuggestionPanel')).toBeVisible({ timeout: 90000 });
      await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
      await expect(page.locator('#airMovers')).toHaveValue('0');
      await page
        .locator('.scope-suggestion')
        .filter({ hasText: 'Air movers' })
        .locator('input')
        .uncheck();
      await page.locator('#applyScopeSuggestions').click();
      await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('10');
      await expect(page.locator('#airMovers')).toHaveValue('0');
      await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
      await page.locator('#airMovers').fill('3');
      await page.locator('#dehumidifiers').fill('1');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#itemizedTotal')).toHaveText('$1,775.00', { timeout: 90000 });
      await expect(page.locator('#estimateRange')).toContainText('$1,788.90');
      const tabs = page.locator('[data-tab]');
      for (let index = 0; index < (await tabs.count()); index++) await tabs.nth(index).click();
      await page.locator('[data-tab="proposal"]').click();
      await page.locator('#documentsConfirmed').check();
      const box = await page.locator('#signCanvas').boundingBox();
      await page.mouse.move(box.x + 20, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 80, { steps: 12 });
      await page.mouse.move(box.x + 220, box.y + 35, { steps: 12 });
      await page.mouse.up();
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#saveStatus')).toContainText('Saved & signed', { timeout: 45000 });
      await expect(page.locator('#savedSignature')).toBeVisible();
      await expect(page.locator('#address')).toBeDisabled();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw Error('Mobile layout overflows.');
      await page.screenshot({ path: path.join(logDir, label + '-synthetic-mobile.png') });
      console.log(
        'PASS: ' +
          label +
          ' real UI reviewed form filling, selected changes, workbook range, four documents and signing.',
      );
    }
    async function run(label) {
      try {
        await python([service, '--token-stdin'], await token(), label + '-authenticated');
        await uiCheck(label);
      } finally {
        await cleanBrowserRecords(label);
      }
    }
    let verified = false;
    while (!verified) {
      try {
        await run(mode);
        verified = true;
      } catch (error) {
        if (!HOLD) throw error;
        console.error('CHECK_FAILED: ' + safe(error.message));
        console.log(
          'AUTH_RETAINED: browser sign-in remains in memory. Send retry after repair, or quit.',
        );
        const recovery = readline.createInterface({ input: process.stdin });
        let retry = false;
        for await (const line of recovery) {
          if (line.trim() === 'retry') {
            retry = true;
            break;
          }
          if (line.trim() === 'quit') break;
        }
        recovery.close();
        if (!retry) return;
      }
    }
    if (HOLD) {
      console.log(
        mode === 'production'
          ? 'PRODUCTION_VERIFIED: authenticated production API and UI checks passed; send quit.'
          : 'READY_FOR_CUTOVER: staged checks passed; browser auth retained only in memory. Send production after backend/Hosting release, or quit.',
      );
      const commands = readline.createInterface({ input: process.stdin });
      for await (const line of commands) {
        if (line.trim() === 'quit') break;
        if (line.trim() === 'production') {
          service = PRODUCTION;
          local = false;
          try {
            await run('production');
            console.log('PRODUCTION_VERIFIED: authenticated relay and real UI checks passed.');
          } catch (error) {
            console.error('CHECK_FAILED: ' + safe(error.message));
            console.log(
              'AUTH_RETAINED: production checks failed; repair and send production again, or quit.',
            );
          }
        }
      }
    }
  } finally {
    if (cachedToken && (inspections.size || agreements.size)) {
      await python(
        [service, '--cleanup-stdin'],
        JSON.stringify({
          token: cachedToken,
          inspections: [...inspections],
          agreements: [...agreements],
        }),
        'failure-browser-cleanup',
      ).catch(() =>
        console.error('Synthetic cleanup needs attention; see its credential-free log.'),
      );
    }
    // Credentials are never exported as browser storage state.
    await page
      .evaluate(async () => {
        if (typeof auth !== 'undefined' && auth?.currentUser) await auth.signOut();
      })
      .catch(() => {});
    if (!manual) await context.close().catch(() => {});
    await closeManual(browser, manual);
    process.stdin.pause();
  }
}
module.exports = { pythonCommand, backendUrl, parseOptions, createArtifactDirectory };
if (require.main === module)
  main().catch((error) => {
    console.error('FAIL: ' + safe(error.message));
    process.exitCode = 1;
  });
