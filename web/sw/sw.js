/* global self, caches, fetch, Request, URL */
// The DryScope field worker (S6-2). Hand-written (owner decision O6); scripts/build-sw.ts copies
// this file to public/sw.js after `next build`, filling in the two placeholders below: the build's
// id and the list of files the field shell needs. Served at /sw.js, the old app's worker URL, so
// that on an origin the old app also used this worker replaces that one (once every window of the
// old app is closed: neither worker calls skipWaiting at install).
//
// What it does, and all it does:
//   * installs by keeping every file of the list, and nothing else, in the cache ds-field-<build id>;
//   * answers a navigation to /field or /field/* with the kept shell page, whether or not there is
//     signal, and a request for a kept file with the kept copy (cache-first);
//   * lets everything else through untouched: /api/*, photos, sign-in pages, other origins,
//     anything that is not a GET. It stores nothing it answers, so the cache holds exactly the
//     list and no person's data (docs/plans/S6.md section 3).
// A new build installs beside this one and waits; it reaches a window only when the person taps
// "Update ready" (S6-6), so a deployment never changes a running window. A build whose list is empty
// is the kill switch: it unregisters itself when it activates.
'use strict';

const BUILD_ID = '__BUILD_ID__';
const PRECACHE = __PRECACHE__;

// Only caches with this prefix are ours to delete. The old app's worker owns dryscope-* and
// alert-disaster-* caches, and this one never touches them.
const CACHE_PREFIX = 'ds-field-';
const CACHE = CACHE_PREFIX + BUILD_ID;
const SHELL = '/field';
const MANIFEST = '/manifest.webmanifest';
const KEPT = new Set(PRECACHE);
// Install asks for each file with this query, which no worker answers from its cache (the old app's
// worker matches its files by path and query, and this one lets the query through below), so what
// is kept is the server's file and never another worker's copy.
const PRECACHE_QUERY = 'ds-precache';

self.addEventListener('install', (event) => {
  if (PRECACHE.length === 0) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await Promise.all(
          PRECACHE.map(async (path) => {
            // Past the browser's HTTP cache: the shell page and the manifest keep their names
            // from build to build.
            const query = '?' + PRECACHE_QUERY + '=' + encodeURIComponent(BUILD_ID);
            const response = await fetch(new Request(path + query, { cache: 'reload' }));
            // An error page must never be kept as if it were the file.
            if (!response.ok) throw new Error('could not keep ' + path);
            if (path === MANIFEST) {
              const manifest = await response.clone().json();
              if (manifest.start_url !== SHELL) throw new Error('the manifest does not open ' + SHELL);
            }
            // Kept under its own address as the file itself: a response that was redirected cannot
            // be served for a navigation, so only its status, headers and body are kept.
            const file = new Response(await response.blob(), { status: response.status, headers: response.headers });
            await cache.put(path, file);
          }),
        );
      } catch (error) {
        // A half-kept build would open with files missing. Install fails and the old worker stays.
        await caches.delete(CACHE);
        throw error;
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      // The kill switch (docs/plans/S6.md section 11): a build with an empty list keeps nothing and
      // removes its own registration, so the next navigation is the server's.
      if (PRECACHE.length === 0) {
        await caches.delete(CACHE);
        await self.registration.unregister();
      }
    })(),
  );
});

async function kept(path, request) {
  const cache = await caches.open(CACHE);
  // ignoreVary: module scripts and fonts send Origin, and a server's Vary header must not hide the
  // one kept copy of each file.
  return (await cache.match(path, { ignoreVary: true })) || fetch(request);
}

self.addEventListener('fetch', (event) => {
  if (PRECACHE.length === 0) return;
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/') || url.searchParams.has(PRECACHE_QUERY)) return;
  if (request.mode === 'navigate' && (path === SHELL || path.startsWith(SHELL + '/'))) {
    event.respondWith(kept(SHELL, request));
    return;
  }
  // Not the shell page itself here: a script's fetch of /field (the router's data request, say) is
  // not a navigation and is the server's to answer.
  if (path !== SHELL && KEPT.has(path)) event.respondWith(kept(path, request));
});
