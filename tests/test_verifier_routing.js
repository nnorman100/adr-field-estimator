const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PRODUCTION_LIVE,
  bridgeLiveSocket,
  compareHealth,
  createRoutingAudit,
  liveTarget,
} = require('../scripts/verify_routing');
const BASE = 'https://alert-disaster-field-2026.web.app';
const TAGGED = 'https://tag---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app';
const PRODUCTION = 'https://alert-disaster-field-estimator-545776254070.us-west2.run.app';

function request(method, url) {
  return { method: () => method, url: () => url };
}
function route(req, fetch) {
  const calls = { fetch: [], fulfill: [], abort: [] };
  return {
    calls,
    request: () => req,
    fetch: async (options) => {
      calls.fetch.push(options);
      const result = await fetch(options);
      return { status: () => result.status, ok: () => result.status < 300 };
    },
    fulfill: async (options) => calls.fulfill.push(options),
    abort: async (code) => calls.abort.push(code),
  };
}
function audit(service = TAGGED, lines = []) {
  return createRoutingAudit({ base: BASE, service, record: (line) => lines.push(line) });
}

test('Live target and the production Live URL the app accepts', () => {
  assert.equal(liveTarget(TAGGED), TAGGED.replace('https:', 'wss:') + '/api/live');
  assert.equal(liveTarget(PRODUCTION), PRODUCTION_LIVE);
});

test('an /api request is fetched from the selected backend with its path and query', async () => {
  const lines = [],
    tracker = audit(TAGGED, lines);
  tracker.phase('ui');
  const req = request('PUT', BASE + '/api/inspections/ADR-INS-1?x=1');
  tracker.observe(req);
  const handled = route(req, async () => ({ status: 200 }));
  const { response } = await tracker.proxy(handled);
  assert.equal(response.status(), 200);
  assert.deepEqual(handled.calls.fetch[0], {
    url: TAGGED + '/api/inspections/ADR-INS-1?x=1',
    maxRedirects: 0,
    timeout: 115000,
  });
  assert.equal(handled.calls.fulfill.length, 1);
  tracker.observeResponse({
    url: () => req.url(),
    request: () => req,
    fromServiceWorker: () => false,
  });
  await tracker.settle();
  assert.doesNotThrow(() => tracker.assertClean());
  assert.equal(
    tracker.report(),
    'BACKEND[ui]: 1 /api requests routed to ' +
      TAGGED +
      '; 0 unrouted; 0 failed; 0 Live sockets bridged to ' +
      liveTarget(TAGGED) +
      '.',
  );
  assert.equal(
    tracker.describe('PUT', '/api/inspections/ADR-INS-1'),
    'PUT /api/inspections/ADR-INS-1 -> HTTP 200 via ' + TAGGED + '/api/inspections/ADR-INS-1?x=1',
  );
  assert.equal(
    lines[0],
    'ui PUT /api/inspections/ADR-INS-1 -> HTTP 200 via ' +
      TAGGED +
      '/api/inspections/ADR-INS-1?x=1',
  );
  assert.equal(tracker.describe('POST', '/api/audit'), 'no POST /api/audit request was observed');
});

test('redirects and backend failures abort the request and fail the phase without throwing', async () => {
  const tracker = audit();
  tracker.phase('ui');
  const redirected = route(request('GET', BASE + '/api/session'), async () => ({ status: 302 }));
  assert.deepEqual(await tracker.proxy(redirected), { response: null });
  assert.deepEqual(redirected.calls.abort, ['blockedbyclient']);
  assert.throws(
    () => tracker.assertClean(),
    /ROUTING_VIOLATION\[ui\]: GET \/api\/session failed \(redirect 302 refused\)/,
  );
  const dead = route(request('POST', BASE + '/api/audit'), async () => {
    throw Error('getaddrinfo ENOTFOUND tag---host\nmore detail');
  });
  assert.deepEqual(await tracker.proxy(dead), { response: null });
  assert.deepEqual(dead.calls.abort, ['failed']);
  assert.equal(
    tracker.describe('POST', '/api/audit'),
    'POST /api/audit -> failed: getaddrinfo ENOTFOUND tag---host via ' + TAGGED + '/api/audit',
  );
  assert.equal(tracker.summary().failed.length, 2);
  const thrown = route(request('POST', BASE + '/api/inspections'), async () => ({ status: 200 }));
  tracker.fail(thrown, 'Unexpected token in JSON');
  assert.equal(
    tracker.describe('POST', '/api/inspections'),
    'POST /api/inspections -> failed: Unexpected token in JSON via ' + TAGGED + '/api/inspections',
  );
  assert.equal(tracker.summary().failed.length, 3);
  tracker.fail(
    route(request('GET', BASE + '/app.js'), async () => ({ status: 200 })),
    'missing',
  );
  assert.equal(
    tracker.summary().failed.length,
    3,
    'non-API failures are not backend routing failures',
  );
});

test('an /api request nobody routed or a service-worker answer is a violation', async () => {
  const tracker = audit();
  tracker.phase('target');
  const leaked = request('GET', BASE + '/api/health');
  tracker.observe(leaked);
  tracker.observe(request('GET', BASE + '/app.js'));
  assert.equal(tracker.summary().unrouted.length, 1);
  assert.throws(
    () => tracker.assertClean(),
    /GET \/api\/health was not routed to https:\/\/tag---/,
  );
  const worker = request('GET', BASE + '/api/session');
  const handled = route(worker, async () => ({ status: 200 }));
  await tracker.proxy(handled);
  tracker.observeResponse({
    url: () => worker.url(),
    request: () => worker,
    fromServiceWorker: () => true,
  });
  assert.equal(tracker.summary().failed[0].failure, 'answered by a service worker');
});

test('phases start fresh and follow the selected backend when it changes', async () => {
  let service = TAGGED;
  const tracker = createRoutingAudit({ base: BASE, service: () => service });
  tracker.phase('staged');
  tracker.live({ event: 'open', url: PRODUCTION_LIVE, target: liveTarget(TAGGED) });
  tracker.live({ event: 'close', target: liveTarget(TAGGED), code: 1006, reason: '' });
  tracker.live({ event: 'open', url: PRODUCTION_LIVE, target: liveTarget(TAGGED) });
  tracker.live({ event: 'connected', target: liveTarget(TAGGED) });
  assert.equal(
    tracker.summary().sockets,
    1,
    'only sockets that connected upstream count as bridged',
  );
  await tracker.proxy(route(request('GET', BASE + '/api/health'), async () => ({ status: 200 })));
  service = PRODUCTION;
  tracker.phase('production');
  const handled = route(request('GET', BASE + '/api/health'), async () => ({ status: 200 }));
  await tracker.proxy(handled);
  assert.equal(handled.calls.fetch[0].url, PRODUCTION + '/api/health');
  assert.equal(tracker.summary('production').routed, 1);
  assert.match(
    tracker.report(),
    /^BACKEND\[production\]: 1 \/api requests routed to https:\/\/alert-disaster-field-estimator-545776254070/,
  );
});

test('settle waits for running handlers and then reports what was never routed', async () => {
  const tracker = audit();
  tracker.phase('ui');
  let release;
  const slow = route(
    request('GET', BASE + '/api/health'),
    () => new Promise((resolve) => (release = () => resolve({ status: 200 }))),
  );
  const proxied = tracker.proxy(slow);
  const settled = tracker.settle(2000);
  setTimeout(() => release(), 150);
  await proxied;
  await settled;
  assert.equal(tracker.summary().routed, 1);
  const started = Date.now();
  tracker.observe(request('GET', BASE + '/api/session'));
  await tracker.settle(300);
  const waited = Date.now() - started;
  assert(
    waited >= 250 && waited < 1500,
    'a just-observed request gets the grace period, then counts',
  );
  assert.throws(() => tracker.assertClean(), /GET \/api\/session was not routed/);
  const slowRoute = route(request('POST', BASE + '/api/audit'), () => new Promise(() => {}));
  tracker.proxy(slowRoute);
  await tracker.settle(200);
  assert.equal(
    tracker.describe('POST', '/api/audit'),
    'POST /api/audit -> pending via ' + TAGGED + '/api/audit',
  );
});

test('the health comparison proves the routed path reaches the selected backend', () => {
  const direct = { status: 'healthy', schema_version: 3, source_commit: 'a'.repeat(40) };
  assert.deepEqual(compareHealth({ routed: direct, direct }), {
    ok: true,
    message: 'source_commit ' + 'a'.repeat(40),
  });
  assert.deepEqual(compareHealth({ routed: { source_commit: 'b'.repeat(40) }, direct }), {
    ok: false,
    message:
      'the page reached source_commit ' +
      'b'.repeat(40) +
      ' but the selected backend reports ' +
      'a'.repeat(40),
  });
  assert.equal(compareHealth({ routed: {}, direct }).ok, false);
  assert.match(compareHealth({ routed: {}, direct }).message, /reached source_commit none/);
  assert.deepEqual(compareHealth({ routed: direct, direct: { status: 'healthy' } }), {
    ok: false,
    message: 'The selected backend did not report source_commit.',
  });
  assert.match(
    compareHealth({ routed: direct, direct, production: direct }).message,
    /production reports the same commit; the routing audit is the proof/,
  );
  assert.match(
    compareHealth({ routed: direct, direct, production: { source_commit: 'c'.repeat(40) } })
      .message,
    /^source_commit a+$/,
  );
  const unknown = { source_commit: 'unknown' };
  assert.match(compareHealth({ routed: unknown, direct: unknown }).message, /unstamped build/);
});

class FakeUpstream extends EventTarget {
  constructor(url, options) {
    super();
    FakeUpstream.instances.push(this);
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closed = null;
  }
  send(message) {
    this.sent.push(message);
  }
  close(code, reason) {
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999))
      throw Error('InvalidAccessError: invalid code ' + code);
    this.readyState = 2;
    this.closed = { code, reason };
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(data) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  drop(code, reason) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}
FakeUpstream.instances = [];
function fakeRoute(url) {
  const page = { sent: [], closed: [], handlers: {} };
  return {
    page,
    url: () => url,
    send: (message) => page.sent.push(message),
    close: async (options) => {
      if (options && options.code === 1006) throw Error('invalid close code');
      page.closed.push(options || {});
    },
    onMessage: (handler) => (page.handlers.message = handler),
    onClose: (handler) => (page.handlers.close = handler),
  };
}

test('the Live bridge carries the app origin, queues until open and relays both ways', async () => {
  const events = [],
    pageSocket = fakeRoute(PRODUCTION_LIVE);
  const upstream = bridgeLiveSocket(pageSocket, liveTarget(TAGGED), BASE, {
    WebSocket: FakeUpstream,
    record: (event) => events.push(event),
  });
  assert.equal(upstream.url, liveTarget(TAGGED));
  assert.deepEqual(upstream.options, { headers: { origin: BASE } });
  assert.equal(upstream.binaryType, 'arraybuffer');
  assert.deepEqual(events, [{ event: 'open', url: PRODUCTION_LIVE, target: liveTarget(TAGGED) }]);
  pageSocket.page.handlers.message('{"type":"authenticate"}');
  assert.deepEqual(upstream.sent, []);
  upstream.open();
  assert.deepEqual(events[1], { event: 'connected', target: liveTarget(TAGGED) });
  assert.deepEqual(upstream.sent, ['{"type":"authenticate"}']);
  const audio = Buffer.from([1, 2, 3]);
  pageSocket.page.handlers.message(audio);
  assert.equal(upstream.sent[1], audio);
  upstream.receive('{"type":"ready"}');
  upstream.receive(new Uint8Array([9, 8]).buffer);
  assert.equal(pageSocket.page.sent[0], '{"type":"ready"}');
  assert.deepEqual([...pageSocket.page.sent[1]], [9, 8]);
  upstream.drop(4001, 'server-bye');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pageSocket.page.closed, [{ code: 4001, reason: 'server-bye' }]);
  assert.deepEqual(events[2], {
    event: 'close',
    target: liveTarget(TAGGED),
    code: 4001,
    reason: 'server-bye',
  });
});

test('the Live bridge closes the backend socket when the page closes and tolerates odd codes', async () => {
  const pageSocket = fakeRoute(PRODUCTION_LIVE);
  const upstream = bridgeLiveSocket(pageSocket, liveTarget(TAGGED), BASE, {
    WebSocket: FakeUpstream,
  });
  upstream.open();
  pageSocket.page.handlers.close(1000, 'done');
  assert.deepEqual(upstream.closed, { code: 1000, reason: 'done' });
  const second = fakeRoute(PRODUCTION_LIVE);
  const abnormal = bridgeLiveSocket(second, liveTarget(TAGGED), BASE, { WebSocket: FakeUpstream });
  abnormal.open();
  second.page.handlers.close(1006, '');
  assert.deepEqual(abnormal.closed, { code: undefined, reason: undefined });
  const third = fakeRoute(PRODUCTION_LIVE);
  const dropped = bridgeLiveSocket(third, liveTarget(TAGGED), BASE, { WebSocket: FakeUpstream });
  dropped.open();
  dropped.drop(1006, '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(third.page.closed, [{}]);
  third.page.handlers.close(1000, 'late');
  assert.equal(dropped.closed, null, 'an already closed backend socket is left alone');
  assert.throws(
    () =>
      bridgeLiveSocket(fakeRoute(PRODUCTION_LIVE), liveTarget(TAGGED), BASE, { WebSocket: null }),
    /Node 22 or newer/,
  );
});
