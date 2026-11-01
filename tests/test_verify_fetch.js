const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertEventuallyEqual, fetchFresh, newRunToken } = require('../scripts/verify_fetch');

const URL_ = 'https://example.test/app.js?verify=old';
const noWait = async () => {};

test('a stale first response then the current one passes', async () => {
  const replies = ['previous release', 'current release'];
  let reads = 0;
  await assertEventuallyEqual(async () => replies[reads++], 'current release', 'differs', {
    wait: noWait,
  });
  assert.equal(reads, 2);
});

test('a persistent mismatch fails after bounded retries with the same diff message', async () => {
  let reads = 0,
    waits = [];
  await assert.rejects(
    assertEventuallyEqual(
      async () => (reads++, 'previous release'),
      'current release',
      'Deployed asset differs: app.js',
      { timeoutMs: 60000, delayMs: 5000, wait: async (ms) => waits.push(ms) },
    ),
    (error) =>
      error.code === 'ERR_ASSERTION' &&
      error.message.startsWith('Deployed asset differs: app.js') &&
      error.actual === 'previous release' &&
      error.expected === 'current release',
  );
  assert.equal(waits.length, 12);
  assert.equal(reads, 13);
});

test('an immediate match does not wait', async () => {
  await assertEventuallyEqual(async () => 'same', 'same', 'x', {
    wait: async () => assert.fail('should not wait'),
  });
});

test('each run gets its own cache-busting query and no-cache headers', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push({ url, init }), { ok: true });
  const first = newRunToken(),
    second = newRunToken();
  assert.notEqual(first, second);
  await fetchFresh(URL_, { bust: true, token: first, fetchImpl });
  await fetchFresh(URL_, { bust: true, token: second, fetchImpl });
  assert.equal(new URL(seen[0].url).searchParams.get('verify'), first);
  assert.equal(new URL(seen[1].url).searchParams.get('verify'), second);
  assert.notEqual(seen[0].url, seen[1].url);
  for (const { init } of seen) {
    assert.equal(init.headers['cache-control'], 'no-cache');
    assert.equal(init.headers.pragma, 'no-cache');
    assert.equal(init.cache, 'no-store');
  }
});

test('without bust the URL is untouched but caches are still bypassed', async () => {
  let seen;
  await fetchFresh('https://example.test/app?v=ui-1', {
    fetchImpl: async (url, init) => ((seen = { url, init }), {}),
  });
  assert.equal(seen.url, 'https://example.test/app?v=ui-1');
  assert.equal(seen.init.headers['cache-control'], 'no-cache');
});
