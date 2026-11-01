// Cache-safe fetching for scripts/verify_hosting.js. Right after a Firebase Hosting release a CDN or
// browser cache can still serve the previous release's copy of a fixed URL, which fails a good release.
const assert = require('node:assert/strict');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One token per verification run: a timestamp plus a random suffix, so no two runs share a URL.
const newRunToken = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const NO_CACHE = { 'cache-control': 'no-cache', pragma: 'no-cache' };
// Fetch asking caches not to answer from storage; bust=true also gives the URL this run's own query.
function fetchFresh(url, { bust = false, token, fetchImpl = fetch } = {}) {
  let target = url;
  if (bust) {
    const parsed = new URL(url);
    parsed.searchParams.set('verify', token);
    target = parsed.toString();
  }
  return fetchImpl(target, { headers: NO_CACHE, cache: 'no-store' });
}
// Compare fetched text with the expected text, retrying a mismatch only while Hosting propagates.
// read receives the attempt number so each attempt can use a URL no earlier attempt cached.
// A persistent mismatch fails with the same assert.equal diff and message as a single try.
async function assertEventuallyEqual(read, expected, message, options = {}) {
  const { timeoutMs = 60000, delayMs = 5000, wait = sleep } = options;
  const retries = Math.floor(timeoutMs / delayMs);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if ((await read(attempt)) === expected) return;
    await wait(delayMs);
  }
  assert.equal(await read(retries), expected, message);
}
module.exports = { assertEventuallyEqual, fetchFresh, newRunToken };
