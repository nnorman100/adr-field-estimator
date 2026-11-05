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

test('every retry reads a URL no earlier attempt used', async () => {
  const urls = [];
  const fetchImpl = async (url) => (urls.push(url), { text: async () => 'previous release' });
  await assert.rejects(
    assertEventuallyEqual(
      async (attempt) =>
        (await fetchFresh(URL_, { bust: true, token: 'run-' + attempt, fetchImpl })).text(),
      'current release',
      'Deployed asset differs: app.js',
      { wait: noWait },
    ),
  );
  assert.equal(urls.length, 13);
  assert.equal(new Set(urls).size, 13);
});

const { waitForRelease } = require('../scripts/verify_fetch');

test('the new release appearing after several tries passes, with growing short waits', async () => {
  let reads = 0;
  const waits = [];
  await waitForRelease(async (attempt) => (reads++, attempt >= 3), {
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(reads, 4);
  assert.equal(waits.length, 3);
  assert.deepEqual(
    waits,
    [...waits].sort((a, b) => a - b),
  );
  assert(waits.every((ms) => ms > 0 && ms <= 15000));
});

test('an immediate new release does not wait', async () => {
  await waitForRelease(async () => true, { wait: async () => assert.fail('should not wait') });
});

test('a release that never appears fails after the bounded wait', async () => {
  let reads = 0,
    waited = 0;
  await assert.rejects(
    waitForRelease(async () => (reads++, false), {
      timeoutMs: 240000,
      message: 'Hosting still serves the previous release',
      wait: async (ms) => (waited += ms),
    }),
    (error) =>
      error.code === 'ERR_ASSERTION' &&
      error.message.startsWith('Hosting still serves the previous release'),
  );
  assert(waited >= 240000 && waited < 240000 + 15000);
  assert(reads > 10);
});

test('a read that throws while Hosting propagates counts as not yet there', async () => {
  let reads = 0;
  await waitForRelease(
    async () => {
      if (reads++ < 2) throw new Error('fetch failed');
      return true;
    },
    { wait: async () => {} },
  );
  assert.equal(reads, 3);
});
