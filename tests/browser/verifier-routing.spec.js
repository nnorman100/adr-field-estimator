/* Real-browser guards for scripts/verify_live_browser.js: the automated tab's navigation, assets, API calls and Live socket must reach the selected backend. */
const { test, expect, chromium } = require('@playwright/test');
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path');
const { attachWebSocket } = require('./ws-server');
const { sameContextPage } = require('../../scripts/manual_chrome');
const {
  PRODUCTION_LIVE,
  bridgeLiveSocket,
  compareHealth,
  createRoutingAudit,
  liveTarget,
} = require('../../scripts/verify_routing');
const APP_ORIGIN = 'https://alert-disaster-field-2026.web.app';
const WORKER = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');
const SHELL = (name) =>
  '<!doctype html><title>' +
  name +
  '</title><p id="shell">' +
  name +
  '</p><script>' +
  "window.__registered = navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'rejected:' + e.message);" +
  "window.__controlled = navigator.serviceWorker.controller ? Promise.resolve(true) : new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(true), { once: true }));" +
  "window.probe = (p) => fetch(p, { cache: 'no-store' }).then((r) => r.text());" +
  '</script>';
// The "production" origin serves the real worker, which precaches app assets (every path answers 200 here) and proxies navigations.
function productionServer(log) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    log.push({ kind: 'http', method: request.method, path: url.pathname + url.search });
    if (url.pathname === '/' || url.pathname === '/plain') {
      response.setHeader('Content-Type', 'text/html');
      return response.end(
        url.pathname === '/'
          ? SHELL('production-shell')
          : '<!doctype html><title>plain</title><p>plain</p>',
      );
    }
    if (url.pathname === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      return response.end(WORKER);
    }
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ status: 'healthy', source_commit: 'p'.repeat(40) }));
    }
    response.setHeader('Content-Type', 'text/plain');
    response.end('production:' + url.pathname + url.search);
  });
  attachWebSocket(server, '/api/live', (connection) => {
    log.push({ kind: 'ws-open', origin: connection.headers.origin || null });
    connection.onmessage = (data, binary) => {
      log.push({ kind: 'ws-message', binary, data: binary ? data.toString('hex') : data });
      if (binary) connection.sendBinary(data);
      else if (data === 'close-me') connection.close(4001, 'server-bye');
      else connection.send('echo:' + data);
    };
    connection.onclose = (code, reason) => log.push({ kind: 'ws-close', code, reason });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function taggedServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'healthy', source_commit: 't'.repeat(40) }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const origin = (server) => 'http://127.0.0.1:' + server.address().port;
let production, tagged, log;
test.beforeAll(async () => {
  log = [];
  production = await productionServer(log);
  tagged = await taggedServer();
});
test.afterAll(async () => {
  for (const server of [production, tagged]) await new Promise((resolve) => server.close(resolve));
});
// The verifier's route: /api goes through the audit to the tagged service; the shell and assets are local candidates.
async function installVerifierRoutes(page, audit, base) {
  await page.route(base + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return audit.proxy(route);
    if (url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: SHELL('local-shell') });
    if (url.pathname === '/app.js')
      return route.fulfill({ contentType: 'text/javascript', body: '/* local app.js */' });
    return route.continue();
  });
  page.on('request', (request) => audit.observe(request));
  page.on('response', (response) => audit.observeResponse(response));
}

test('a worker-controlled private window answers for a new tab until the verifier bypasses it', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The manual handoff attaches to Chrome over CDP.');
  // The verifier's exact shape: an externally reachable Chrome, connectOverCDP, the existing
  // context, and a popup opened by the signed-in page (scripts/manual_chrome.js sameContextPage).
  const base = origin(production);
  const launched = await chromium.launch({ args: ['--remote-debugging-port=9344'] });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9344');
  try {
    const context = browser.contexts()[0];
    const signIn = await context.newPage();
    await signIn.goto(base);
    await signIn.evaluate(() => window.__controlled);
    // Without the bypass, the registered worker serves the navigation and precached assets; the route never sees them.
    const uncontrolled = await sameContextPage(browser, signIn);
    const unguarded = createRoutingAudit({ base, service: origin(tagged) });
    await installVerifierRoutes(uncontrolled, unguarded, base);
    const navigation = await uncontrolled.goto(base);
    expect(navigation.fromServiceWorker()).toBe(true);
    await expect(uncontrolled.locator('#shell')).toHaveText('production-shell');
    expect(await uncontrolled.evaluate(() => probe('/app.js?v=unstamped'))).toContain(
      'production:',
    );
    // Fall-through /api requests are still page requests, so the route does see those.
    expect(JSON.parse(await uncontrolled.evaluate(() => probe('/api/health'))).source_commit).toBe(
      't'.repeat(40),
    );
    // The verifier's bypass (what Playwright's serviceWorkers: 'block' sends) makes every request page-owned and routable.
    const guarded = await sameContextPage(browser, signIn);
    const session = await context.newCDPSession(guarded);
    await session.send('Network.enable');
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    const audit = createRoutingAudit({ base, service: origin(tagged) });
    audit.phase('target');
    await installVerifierRoutes(guarded, audit, base);
    const routed = await guarded.goto(base);
    expect(routed.fromServiceWorker()).toBe(false);
    await expect(guarded.locator('#shell')).toHaveText('local-shell');
    expect(await guarded.evaluate(() => window.__registered)).toBe('registered');
    expect(await guarded.evaluate(() => probe('/app.js?v=unstamped'))).toBe('/* local app.js */');
    const viaPage = JSON.parse(await guarded.evaluate(() => probe('/api/health')));
    const direct = await (await fetch(origin(tagged) + '/api/health')).json();
    const productionHealth = await (await fetch(base + '/api/health')).json();
    expect(compareHealth({ routed: viaPage, direct, production: productionHealth })).toEqual({
      ok: true,
      message: 'source_commit ' + 't'.repeat(40),
    });
    await audit.settle();
    expect(() => audit.assertClean('target')).not.toThrow();
    expect(audit.summary('target').routed).toBe(1);
    expect(audit.report('target')).toContain('1 /api requests routed to ' + origin(tagged));
    expect(
      log.filter((entry) => entry.kind === 'http' && entry.path === '/api/health').length,
    ).toBe(1);
  } finally {
    await browser.close();
    await launched.close();
  }
});

test('an /api request the route never handled fails the phase instead of passing silently', async ({
  browser,
}) => {
  const base = origin(production),
    context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const audit = createRoutingAudit({ base, service: origin(tagged) });
    audit.phase('ui');
    page.on('request', (request) => audit.observe(request));
    // Only non-API paths are routed here, mimicking a request that escapes the handler.
    await page.route(base + '/plain', (route) => route.continue());
    await page.goto(base + '/plain');
    await page.evaluate(() => fetch('/api/session', { cache: 'no-store' }).then((r) => r.text()));
    await audit.settle(500);
    expect(() => audit.assertClean('ui')).toThrow(
      /ROUTING_VIOLATION\[ui\]: GET \/api\/session was not routed to/,
    );
  } finally {
    await context.close();
  }
});

test('the Live socket the app opens is bridged to the selected backend with the app origin', async ({
  browser,
}) => {
  const base = origin(production),
    context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const events = [];
    const target = liveTarget(base.replace('http:', 'https:')).replace('wss:', 'ws:');
    await page.routeWebSocket(/\/api\/live$/, (socket) =>
      bridgeLiveSocket(socket, target, APP_ORIGIN, { record: (event) => events.push(event) }),
    );
    await page.goto(base + '/plain');
    const seen = await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const out = [],
            socket = new WebSocket(url);
          socket.binaryType = 'arraybuffer';
          socket.onopen = () => {
            out.push('open');
            socket.send('hello');
            socket.send(new Uint8Array([1, 2, 3]));
          };
          socket.onmessage = (event) => {
            out.push(
              typeof event.data === 'string'
                ? event.data
                : 'binary:' + Array.from(new Uint8Array(event.data)).join(','),
            );
            if (out.length === 3) socket.send('close-me');
          };
          socket.onclose = (event) =>
            resolve(out.concat('close:' + event.code + ':' + event.reason));
          setTimeout(() => resolve(out.concat('timeout')), 10000);
        }),
      PRODUCTION_LIVE,
    );
    expect(seen).toEqual(['open', 'echo:hello', 'binary:1,2,3', 'close:4001:server-bye']);
    expect(log.filter((entry) => entry.kind === 'ws-open').pop()).toEqual({
      kind: 'ws-open',
      origin: APP_ORIGIN,
    });
    expect(events[0]).toEqual({ event: 'open', url: PRODUCTION_LIVE, target });
    expect(events[1]).toEqual({ event: 'connected', target });
    expect(events.pop()).toEqual({ event: 'close', target, code: 4001, reason: 'server-bye' });
  } finally {
    await context.close();
  }
});
