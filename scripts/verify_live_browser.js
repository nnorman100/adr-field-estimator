/* Normal Google staff sign-in and synthetic release verification. No auth state is exported. */
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process'),
  readline = require('node:readline');
const { parseArgs } = require('node:util');
const { canonicalPath, isWithin } = require('./artifact-paths');
const {
  PRODUCTION_LIVE,
  bridgeLiveSocket,
  compareHealth,
  createRoutingAudit,
  liveTarget,
} = require('./verify_routing');
const ROOT = path.resolve(__dirname, '..'),
  BASE = 'https://alert-disaster-field-2026.web.app';
const PRODUCTION = 'https://alert-disaster-field-estimator-545776254070.us-west2.run.app';
const SERVICE_HOST = 'alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app';
// Every wait is bounded so a stalled phase fails with a message and cleanup still runs.
const ACTION_TIMEOUT_MS = 60000;
const SIGN_IN_TIMEOUT_MS = 60000;
const FINALIZE_TIMEOUT_MS = 90000;
const PROBE_TIMEOUT_MS = 20000;
const PYTHON_TIMEOUT_MS = 20 * 60000;
const CLEANUP_TIMEOUT_MS = 5 * 60000;
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
function firstLine(text) {
  return String(text).split('\n')[0];
}
async function healthJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'manual' });
  if (!response.ok) throw Error('GET ' + url + ' answered HTTP ' + response.status + '.');
  return response.json();
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
  const audit = createRoutingAudit({
    base: BASE,
    service: () => service,
    record: (line) => fs.appendFileSync(path.join(logDir, 'routing.txt'), line + '\n'),
  });
  function python(args, input, label, timeoutMs = PYTHON_TIMEOUT_MS) {
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
      let output = '',
        timedOut = false;
      const record = (data) => {
        const clean = safe(data.toString());
        output += clean;
        process.stdout.write(clean);
      };
      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', record);
      child.stderr.on('data', record);
      child.once('error', (error) => {
        clearTimeout(watchdog);
        reject(Error(label + ' could not start Python (' + error.message + ').'));
      });
      child.once('exit', (code) => {
        clearTimeout(watchdog);
        fs.writeFileSync(path.join(logDir, label + '.txt'), output);
        if (timedOut)
          reject(
            Error(
              label + ' timed out after ' + timeoutMs / 1000 + ' s; see its credential-free log.',
            ),
          );
        else if (code === 0) resolve();
        else reject(Error(label + ' failed; see its credential-free log.'));
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
      // The manual tab is never routed: signing in there creates an empty production draft, which this run removes with its own records.
      if (existing.inspection) {
        inspections.add(existing.inspection);
        console.log(
          'SIGN_IN_TAB: production draft ' +
            existing.inspection +
            ' from the manual sign-in is tracked for cleanup.',
        );
      } else console.log('SIGN_IN_TAB: the manual sign-in tab holds no pristine draft to track.');
      await signedPage.evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations())
          await registration.unregister();
      });
      page = await sameContextPage(browser, signedPage);
      // The same bypass Playwright applies for serviceWorkers: 'block': a worker must never answer the automated tab's navigation, assets or API calls, or the route would not see them.
      const session = await context.newCDPSession(page);
      await session.send('Network.enable');
      await session.send('Network.setBypassServiceWorker', { bypass: true });
    } else {
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
      });
      page = await context.newPage();
    }
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  } catch (error) {
    await closeManual(browser, manual);
    throw error;
  }
  try {
    page.on('request', (request) => audit.observe(request));
    page.on('response', (response) => audit.observeResponse(response));
    // A callback that throws would leave the request pending and exit Node before cleanup; failures abort the request and count against the phase instead.
    await page.route(BASE + '/**', async (route) => {
      try {
        await serve(route);
      } catch (error) {
        audit.fail(route, firstLine(error.message));
        await route.abort('failed').catch(() => {});
      }
    });
    async function serve(route) {
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
        const { response } = await audit.proxy(route);
        if (response && url.pathname === '/api/session' && response.ok())
          userUid = (await response.json()).uid;
        return;
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
    }
    // The app only accepts the production Live URL; the bridge carries that socket to the selected backend with the app's origin.
    await page.routeWebSocket(/\/api\/live$/, (socket) =>
      bridgeLiveSocket(socket, liveTarget(service), BASE, { record: audit.live }),
    );
    audit.phase('load');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    if (smoke) {
      await expect(page.locator('#signInButton')).toBeVisible({ timeout: 30000 });
      await page.waitForFunction(
        () => typeof auth !== 'undefined' && !!auth,
        {},
        { timeout: 30000 },
      );
      console.log(
        'PASS: actual Firebase SDK initializes with the dedicated sign-in UI. No jobs or IAM changes.',
      );
      return;
    }
    console.log(
      "VERIFYING_MANUAL_SESSION: the automated tab inherits the private window's Google sign-in.",
    );
    await page.waitForFunction(
      () =>
        typeof auth !== 'undefined' &&
        auth?.currentUser &&
        document.getElementById('address').disabled === false,
      {},
      { timeout: SIGN_IN_TIMEOUT_MS },
    );
    userUid = await page.evaluate(() => auth.currentUser.uid);
    await audit.settle();
    console.log(audit.report('load'));
    audit.assertClean('load');
    console.log('PASS: ordinary Google staff sign-in reached the automated tab; no IAM changes.');
    if (signedPage && !signedPage.isClosed()) {
      await signedPage.close();
      signedPage = null;
    }
    async function token() {
      let timer;
      try {
        cachedToken = await Promise.race([
          page.evaluate(() => auth.currentUser.getIdToken(true)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Token refresh timed out.')), PROBE_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        if (!cachedToken) throw error;
      } finally {
        clearTimeout(timer);
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
        CLEANUP_TIMEOUT_MS,
      );
      inspections.clear();
      agreements.clear();
    }
    // Positive proof before any workflow: the page's own /api path answers with the selected backend's commit, and its Live socket reaches that backend.
    async function verifyTarget(label) {
      const direct = await healthJson(service + '/api/health');
      const routed = await page.evaluate(() =>
        fetch('/api/health', { cache: 'no-store' }).then((response) => response.json()),
      );
      const production =
        service === PRODUCTION
          ? null
          : await healthJson(PRODUCTION + '/api/health').catch(() => null);
      const health = compareHealth({ routed, direct, production });
      await audit.settle();
      if (!health.ok) throw Error('TARGET_MISMATCH: ' + health.message + '.');
      audit.assertClean(label);
      const liveUrl = await page.evaluate(
        () => (typeof state !== 'undefined' && state.session?.live_url) || null,
      );
      if (liveUrl !== PRODUCTION_LIVE)
        throw Error(
          'LIVE_URL_UNEXPECTED: the app reported ' +
            liveUrl +
            ' but the bridge only intercepts ' +
            PRODUCTION_LIVE +
            '.',
        );
      const probe = await page.evaluate(
        ({ url, timeout }) =>
          new Promise((resolve) => {
            const socket = new WebSocket(url);
            const timer = setTimeout(() => resolve('timeout'), timeout);
            socket.onopen = () =>
              socket.send(
                JSON.stringify({
                  type: 'authenticate',
                  token: 'synthetic-invalid-not-a-token',
                  inspection_id: 'ADR-INS-' + 'f'.repeat(32),
                }),
              );
            socket.onmessage = (event) => {
              clearTimeout(timer);
              let type = 'unparsed';
              try {
                type = JSON.parse(event.data).type;
              } catch {}
              resolve(type);
              socket.close();
            };
            socket.onclose = (event) => {
              clearTimeout(timer);
              resolve('closed:' + event.code);
            };
          }),
        { url: liveUrl, timeout: PROBE_TIMEOUT_MS },
      );
      if (probe !== 'error')
        throw Error(
          'LIVE_PROBE_FAILED: the bridged Live socket to ' +
            liveTarget(service) +
            ' answered "' +
            probe +
            '" instead of the expected authentication error.',
        );
      console.log(
        'TARGET_VERIFIED[' +
          label +
          ']: /api -> ' +
          service +
          ' (' +
          health.message +
          '); Live ' +
          liveUrl +
          ' -> ' +
          liveTarget(service) +
          '.',
      );
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
      try {
        await expect(page.locator('#itemizedTotal')).toHaveText('$1,775.00', {
          timeout: FINALIZE_TIMEOUT_MS,
        });
      } catch (error) {
        await audit.settle();
        throw Error(
          'FINALIZE_TIMEOUT: no itemized total within ' +
            FINALIZE_TIMEOUT_MS / 1000 +
            ' s of Finish & review; ' +
            audit.describe('POST', '/api/audit') +
            '. ' +
            firstLine(error.message),
        );
      }
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
      audit.phase(label);
      await verifyTarget(label);
      try {
        await python([service, '--token-stdin'], await token(), label + '-authenticated');
        await uiCheck(label);
      } finally {
        await audit.settle();
        console.log(audit.report(label));
        await cleanBrowserRecords(label);
      }
      // A request that escaped the route or failed at the backend fails the phase even after the UI passed.
      audit.assertClean(label);
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
          'AUTH_RETAINED: the private window stays signed in. Send retry after repair, or quit.',
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
          : 'READY_FOR_CUTOVER: staged checks passed through the routed tab. Send production after backend/Hosting release, or quit.',
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
        CLEANUP_TIMEOUT_MS,
      ).catch(() =>
        console.error('Synthetic cleanup needs attention; see its credential-free log.'),
      );
    }
    // Credentials are never exported as browser storage state; the private profile is deleted with the window.
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
