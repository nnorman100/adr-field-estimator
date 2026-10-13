/* Routing guards for verify_live_browser.js: every /api request and Live socket of a run must reach the selected backend. */
const PRODUCTION_LIVE =
  'wss://alert-disaster-field-estimator-545776254070.us-west2.run.app/api/live';
const FETCH_TIMEOUT_MS = 115000;
function firstLine(text) {
  return String(text).split('\n')[0];
}
function liveTarget(service) {
  return service.replace(/^https:/, 'wss:') + '/api/live';
}
// Tracks each /api request the automated tab makes and where the route handler sent it.
function createRoutingAudit({ base, service, record = () => {} }) {
  const origin = new URL(base).origin;
  const target = () => (typeof service === 'function' ? service() : service);
  const entries = [],
    byRequest = new Map(),
    sockets = [];
  let phaseName = 'start',
    phaseStart = 0,
    socketStart = 0;
  function isApi(url) {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname.startsWith('/api/');
  }
  function entryFor(request) {
    let entry = byRequest.get(request);
    if (!entry) {
      const url = new URL(request.url());
      entry = {
        method: request.method(),
        path: url.pathname,
        search: url.search,
        target: null,
        status: null,
        failure: null,
        settled: false,
        seenAt: Date.now(),
      };
      byRequest.set(request, entry);
      entries.push(entry);
    }
    return entry;
  }
  function line(entry) {
    return (
      phaseName +
      ' ' +
      entry.method +
      ' ' +
      entry.path +
      ' -> ' +
      outcome(entry) +
      ' via ' +
      entry.target
    );
  }
  function outcome(entry) {
    if (entry.failure) return 'failed: ' + entry.failure;
    return entry.settled ? 'HTTP ' + entry.status : 'pending';
  }
  function observe(request) {
    if (isApi(request.url())) entryFor(request);
  }
  function observeResponse(response) {
    if (!isApi(response.url())) return;
    const entry = entryFor(response.request());
    if (response.fromServiceWorker())
      entry.failure = entry.failure || 'answered by a service worker';
  }
  // Never throws: a failing backend aborts the request instead of leaving it pending or crashing the run.
  async function proxy(route, options = {}) {
    const request = route.request(),
      url = new URL(request.url()),
      entry = entryFor(request);
    entry.target = target() + url.pathname + url.search;
    try {
      const response = await route.fetch({
        url: entry.target,
        maxRedirects: 0,
        timeout: options.timeout ?? FETCH_TIMEOUT_MS,
      });
      entry.status = response.status();
      if (entry.status >= 300 && entry.status < 400) {
        entry.failure = 'redirect ' + entry.status + ' refused';
        await route.abort('blockedbyclient');
        return { response: null };
      }
      await route.fulfill({ response });
      return { response };
    } catch (error) {
      entry.failure = firstLine(error.message);
      await route.abort('failed').catch(() => {});
      return { response: null };
    } finally {
      entry.settled = true;
      record(line(entry));
    }
  }
  // Records a route callback that threw before or instead of proxying; the caller then aborts the request.
  function fail(route, message) {
    const request = route.request(),
      url = new URL(request.url());
    if (!isApi(request.url())) return;
    const entry = entryFor(request);
    entry.target = entry.target || target() + url.pathname + url.search;
    entry.failure = message;
    entry.settled = true;
    record(line(entry));
  }
  function live(event) {
    sockets.push(event);
    record(phaseName + ' LIVE ' + JSON.stringify(event));
  }
  function phase(name) {
    phaseName = name;
    phaseStart = entries.length;
    socketStart = sockets.length;
  }
  const current = () => entries.slice(phaseStart);
  // Waits for route callbacks that are still running or about to start; a request nobody routed stays unrouted.
  async function settle(timeoutMs = 5000, graceMs = 1000) {
    const until = Date.now() + timeoutMs;
    const busy = () =>
      current().some(
        (entry) =>
          (entry.target && !entry.settled) ||
          (!entry.target && Date.now() - entry.seenAt < graceMs),
      );
    while (busy() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  function summary(name = phaseName) {
    const list = current();
    return {
      name,
      routed: list.filter((entry) => entry.target && !entry.failure).length,
      unrouted: list.filter((entry) => !entry.target),
      failed: list.filter((entry) => entry.failure),
      sockets: sockets.slice(socketStart).filter((event) => event.event === 'connected').length,
    };
  }
  function report(name = phaseName) {
    const result = summary(name);
    return (
      'BACKEND[' +
      name +
      ']: ' +
      result.routed +
      ' /api requests routed to ' +
      target() +
      '; ' +
      result.unrouted.length +
      ' unrouted; ' +
      result.failed.length +
      ' failed; ' +
      result.sockets +
      ' Live sockets bridged to ' +
      liveTarget(target()) +
      '.'
    );
  }
  function assertClean(name = phaseName) {
    const result = summary(name),
      offender = result.unrouted[0] || result.failed[0];
    if (!offender) return;
    throw Error(
      'ROUTING_VIOLATION[' +
        name +
        ']: ' +
        offender.method +
        ' ' +
        offender.path +
        (offender.target
          ? ' failed (' + offender.failure + ')'
          : ' was not routed to ' + target()) +
        '; stopping so production is not tested by mistake.',
    );
  }
  function describe(method, pathname) {
    const entry = entries.filter((e) => e.method === method && e.path === pathname).pop();
    if (!entry) return 'no ' + method + ' ' + pathname + ' request was observed';
    return method + ' ' + pathname + ' -> ' + outcome(entry) + ' via ' + entry.target;
  }
  return {
    observe,
    observeResponse,
    proxy,
    fail,
    live,
    phase,
    settle,
    summary,
    report,
    assertClean,
    describe,
  };
}
// Compares the health the page saw through the route with the selected backend's own answer.
function compareHealth({ routed, direct, production = null }) {
  const commit = (health) =>
    health && typeof health.source_commit === 'string' ? health.source_commit : null;
  if (!commit(direct))
    return { ok: false, message: 'The selected backend did not report source_commit.' };
  if (commit(routed) !== commit(direct))
    return {
      ok: false,
      message:
        'the page reached source_commit ' +
        (commit(routed) || 'none') +
        ' but the selected backend reports ' +
        commit(direct),
    };
  let message = 'source_commit ' + commit(direct);
  if (commit(direct) === 'unknown') message += ' (unstamped build; the routing audit is the proof)';
  else if (production && commit(production) === commit(direct))
    message += ' (production reports the same commit; the routing audit is the proof)';
  return { ok: true, message };
}
// Connects the page's Live socket to the selected backend with the app's origin, both directions.
function bridgeLiveSocket(route, target, origin, options = {}) {
  const Impl = 'WebSocket' in options ? options.WebSocket : globalThis.WebSocket;
  if (typeof Impl !== 'function')
    throw Error('The Live bridge needs the global WebSocket client of Node 22 or newer.');
  const record = options.record || (() => {});
  const upstream = new Impl(target, { headers: { origin } });
  upstream.binaryType = 'arraybuffer';
  const pending = [];
  let open = false;
  record({ event: 'open', url: route.url(), target });
  upstream.addEventListener('open', () => {
    open = true;
    record({ event: 'connected', target });
    for (const message of pending.splice(0)) upstream.send(message);
  });
  upstream.addEventListener('message', (event) =>
    route.send(typeof event.data === 'string' ? event.data : Buffer.from(event.data)),
  );
  upstream.addEventListener('error', () => record({ event: 'error', target }));
  upstream.addEventListener('close', (event) => {
    record({ event: 'close', target, code: event.code, reason: event.reason });
    Promise.resolve()
      .then(() => route.close({ code: event.code, reason: event.reason }))
      .catch(() => route.close())
      .catch(() => {});
  });
  route.onMessage((message) => {
    if (open) upstream.send(message);
    else pending.push(message);
  });
  route.onClose((code, reason) => {
    if (upstream.readyState > 1) return;
    try {
      upstream.close(code, reason);
    } catch {
      upstream.close();
    }
  });
  return upstream;
}
module.exports = {
  PRODUCTION_LIVE,
  bridgeLiveSocket,
  compareHealth,
  createRoutingAudit,
  liveTarget,
};
