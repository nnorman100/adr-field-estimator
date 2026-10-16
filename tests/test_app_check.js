const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { registerHooks } = require('node:module'),
  { pathToFileURL } = require('node:url');
const LIVE_URL = 'wss://alert-disaster-field-estimator-545776254070.us-west2.run.app/api/live';
// app.js imports the SDK by its Hosting path; serve those imports from public/, or fail them while vendorMissing is set.
const imports = [];
let vendorMissing = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/vendor/')) {
      imports.push(specifier);
      if (vendorMissing) throw Error('Failed to fetch dynamically imported module');
      specifier = pathToFileURL(path.resolve('public' + specifier)).href;
    }
    const resolved = next(specifier, context);
    return resolved.url.includes('/public/vendor/') ? { ...resolved, format: 'module' } : resolved;
  },
});
const firebaseApp = { name: '[DEFAULT]' };
// Runs the production app.js; activateAppCheck receives a fake modular App Check SDK whose getToken decides what attestation returns.
function load({
  hostname = 'alert-disaster-field-2026.web.app',
  debug,
  getToken = async () => ({ token: 'app-check-token' }),
} = {}) {
  const calls = { initialize: [], getToken: [], fetches: [], sent: [] },
    instance = {};
  class ReCaptchaEnterpriseProvider {
    constructor(siteKey) {
      this.siteKey = siteKey;
    }
  }
  const sdk = {
    ReCaptchaEnterpriseProvider,
    initializeAppCheck: (app, options) => {
      calls.initialize.push([app, options]);
      return instance;
    },
    getToken: (appCheck, ...args) => {
      calls.getToken.push([appCheck === instance, ...args]);
      return getToken();
    },
  };
  const elements = new Map(),
    element = (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', className: '' });
      return elements.get(id);
    };
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
    }
    send(data) {
      calls.sent.push(JSON.parse(data));
    }
  }
  const context = {
    ADRCore: require('../public/core.js'),
    navigator: { onLine: true },
    WebSocket: Socket,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    location: { hostname, href: 'https://' + hostname + '/' },
    document: { getElementById: element, addEventListener() {} },
    fetch: async (path, options) => {
      calls.fetches.push({ path, headers: { ...options.headers } });
      return { ok: true, json: async () => ({}) };
    },
  };
  context.window = context.self = context;
  if (debug !== undefined) context.FIREBASE_APPCHECK_DEBUG_TOKEN = debug;
  vm.runInNewContext(
    fs.readFileSync('public/app.js', 'utf8') +
      ';globalThis.hooks={state,api,connectLive,loadAppCheck,activateAppCheck:siteKey=>activateAppCheck(firebaseApp,sdk,siteKey)};',
    Object.assign(context, { firebaseApp, sdk }),
    { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  );
  const { state } = context.hooks;
  state.user = { uid: 'u', getIdToken: async () => 'id-token' };
  state.session = { live_url: LIVE_URL };
  return { context, calls, ...context.hooks };
}
(async () => {
  {
    const { calls, activateAppCheck, loadAppCheck, api } = load();
    assert.equal(await loadAppCheck(), null);
    activateAppCheck();
    assert.deepEqual(imports, []);
    assert.equal(calls.initialize.length, 0);
    await api('/api/inspections');
    assert.deepEqual(calls.fetches[0].headers, { Authorization: 'Bearer id-token' });
    console.log(
      'PASS: no site key loads no App Check script, activates nothing and sends no App Check header',
    );
  }
  {
    const loaded = await load().loadAppCheck('site-key');
    assert.deepEqual(imports, ['/vendor/firebase/13.0.0/firebase-app-check.js']);
    for (const name of ['initializeAppCheck', 'ReCaptchaEnterpriseProvider', 'getToken'])
      assert.equal(typeof loaded[name], 'function');
    vendorMissing = true;
    assert.equal(await load().loadAppCheck('site-key'), null);
    vendorMissing = false;
    console.log(
      'PASS: a configured site key loads the vendored modular App Check build, and a failed load is not fatal',
    );
  }
  {
    const production = load({ debug: true });
    production.activateAppCheck('site-key');
    assert.equal(production.context.FIREBASE_APPCHECK_DEBUG_TOKEN, undefined);
    const [[app, { provider, isTokenAutoRefreshEnabled }]] = production.calls.initialize;
    assert.equal(app, production.context.firebaseApp);
    assert.equal(provider.siteKey, 'site-key');
    assert.equal(provider.constructor.name, 'ReCaptchaEnterpriseProvider');
    assert.equal(isTokenAutoRefreshEnabled, true);
    for (const hostname of ['localhost', '127.0.0.1']) {
      const local = load({ hostname, debug: 'registered-debug-token' });
      local.activateAppCheck('site-key');
      assert.equal(local.context.FIREBASE_APPCHECK_DEBUG_TOKEN, 'registered-debug-token');
      assert.equal(local.calls.initialize.length, 1);
    }
    const lookalike = load({ hostname: 'localhost.example.com', debug: true });
    lookalike.activateAppCheck('site-key');
    assert.equal(lookalike.context.FIREBASE_APPCHECK_DEBUG_TOKEN, undefined);
    console.log(
      'PASS: reCAPTCHA Enterprise with auto-refresh; a debug token survives only on localhost and 127.0.0.1',
    );
  }
  {
    const { calls, activateAppCheck, api } = load();
    activateAppCheck('site-key');
    await api('/api/inspections', { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(calls.fetches[0].headers, {
      'Content-Type': 'application/json',
      'X-Firebase-AppCheck': 'app-check-token',
      Authorization: 'Bearer id-token',
    });
    assert.deepEqual(calls.getToken, [[true]]);
    for (const getToken of [
      async () => {
        throw Error('reCAPTCHA unavailable');
      },
      async () => ({}),
      () => new Promise(() => {}),
    ]) {
      const failing = load({ getToken });
      failing.activateAppCheck('site-key');
      await failing.api('/api/inspections');
      assert.deepEqual(failing.calls.fetches[0].headers, { Authorization: 'Bearer id-token' });
    }
    console.log(
      'PASS: API requests carry X-Firebase-AppCheck when a token exists and still go out without one',
    );
  }
  {
    let getToken = () => new Promise(() => {});
    const stalled = load({ getToken: () => getToken() });
    stalled.activateAppCheck('site-key');
    let started = Date.now();
    await stalled.api('/api/inspections');
    assert.ok(Date.now() - started >= 2900);
    started = Date.now();
    await stalled.api('/api/inspections');
    assert.ok(Date.now() - started < 500);
    assert.deepEqual(
      stalled.calls.fetches.map((fetch) => fetch.headers),
      [{ Authorization: 'Bearer id-token' }, { Authorization: 'Bearer id-token' }],
    );
    getToken = async () => ({ token: 'app-check-token' });
    started = Date.now();
    await stalled.api('/api/inspections');
    assert.ok(Date.now() - started < 500);
    assert.equal(stalled.calls.fetches[2].headers['X-Firebase-AppCheck'], 'app-check-token');
    getToken = () => new Promise(() => {});
    started = Date.now();
    await stalled.api('/api/inspections');
    assert.ok(Date.now() - started >= 2900);
    console.log(
      'PASS: after one attestation hang, later requests send at once, use a ready token, and wait again once attestation recovers',
    );
  }
  {
    const live = async (options) => {
      const app = load(options);
      app.activateAppCheck('site-key');
      Object.assign(app.state, {
        stopping: false,
        media: {},
        draft: {
          inspection_id: 'ADR-INS-' + 'c'.repeat(32),
          data: { capture_metadata: { capture_id: 'd'.repeat(32) } },
        },
      });
      await app.connectLive();
      app.state.socket.onopen();
      return app.calls.sent[0];
    };
    const sent = await live();
    assert.equal(sent.type, 'authenticate');
    assert.equal(sent.token, 'id-token');
    assert.equal(sent.app_check, 'app-check-token');
    assert.equal(
      'app_check' in
        (await live({
          getToken: async () => {
            throw Error('reCAPTCHA unavailable');
          },
        })),
      false,
    );
    console.log(
      'PASS: the Live authentication message carries the App Check token only when one exists',
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
