const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { chromePath, launchArgs, removeOwnedProfile } = require('../scripts/manual_chrome');
const args = launchArgs(
  'C:\\temporary\\adr-manual-chrome-example',
  9337,
  'https://alert-disaster-field-2026.web.app',
);
assert(args.includes('--incognito'));
assert(args.includes('--remote-debugging-address=127.0.0.1'));
assert(args.includes('--remote-debugging-port=9337'));
assert(
  !args.some(
    (arg) =>
      arg.includes('--enable-automation') ||
      arg.includes('--headless') ||
      arg.includes('--remote-debugging-port=0'),
  ),
);
assert.throws(() => removeOwnedProfile(path.join(os.homedir(), 'Documents')), /unexpected profile/);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-chrome-test-'));
try {
  const fake = path.join(sandbox, 'chromium');
  fs.writeFileSync(fake, '');
  assert.equal(chromePath({ ADR_CHROME_PATH: fake }, 'linux'), fake);
  assert.throws(
    () => chromePath({ ADR_CHROME_PATH: path.join(sandbox, 'missing') }, 'linux'),
    /ADR_CHROME_PATH/,
  );
  assert.equal(chromePath({ PATH: sandbox }, 'linux'), fake);
  assert.throws(
    () => chromePath({ PATH: path.join(sandbox, 'empty') }, 'linux'),
    /ADR_CHROME_PATH/,
  );
  const program = path.join(sandbox, 'Google', 'Chrome', 'Application');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, 'chrome.exe'), '');
  assert.equal(chromePath({ PROGRAMFILES: sandbox }, 'win32'), path.join(program, 'chrome.exe'));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
const { pythonCommand } = require('../scripts/verify_live_browser');
assert.equal(pythonCommand({ ADR_TEST_PYTHON: '/opt/python' }, 'linux', '/repo'), '/opt/python');
assert.equal(pythonCommand({}, 'linux', '/nonexistent-root'), 'python3');
assert.equal(pythonCommand({}, 'win32', '/nonexistent-root'), 'python');
const source = fs.readFileSync('scripts/verify_live_browser.js', 'utf8');
const signedIn = source.indexOf("line.trim() === 'signed-in'");
const attach = source.indexOf('chromium.connectOverCDP(manual.endpoint)');
assert(signedIn >= 0 && attach >= 0 && signedIn < attach);
assert(!source.includes('ignoreDefaultArgs'));
// The automated tab must inherit the private window's sign-in (no memory-only auth stand-in), bypass
// any service worker, prove its target and bridge Live before each workflow phase.
assert(!source.includes('inMemoryPersistence'));
assert(source.includes("'Network.setBypassServiceWorker'"));
const bypass = source.indexOf("'Network.setBypassServiceWorker'"),
  routes = source.indexOf('page.route(BASE');
assert(bypass >= 0 && routes >= 0 && bypass < routes);
const verify = source.indexOf('await verifyTarget(label)'),
  authenticated = source.indexOf("label + '-authenticated'"),
  workflow = source.indexOf('await uiCheck(label)');
assert(
  verify >= 0 &&
    authenticated >= 0 &&
    workflow >= 0 &&
    verify < authenticated &&
    authenticated < workflow,
);
assert(source.includes('page.routeWebSocket(') && source.includes('bridgeLiveSocket('));
assert(source.includes('FINALIZE_TIMEOUT'));
console.log(
  'PASS: normal private Chrome handoff precedes automation; the automated tab is routed, bypasses workers and proves its target; cleanup rejects unrelated profiles.',
);
