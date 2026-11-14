// The S8 coexistence check (S6-2): the new worker is served at /sw.js, the old app's worker URL, so
// on an origin the old app also used it replaces the old worker, but only once every window of the
// old app is closed, and it leaves the old app's caches and IndexedDB alone.
//
// The old app is its real worker (public/sw.js, copied as it is) and its real static files, served
// by the lane at the old addresses, with a small stand-in page that registers the worker and keeps
// one record in the old app's drafts database.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixture';
import type { NetworkLane, StaticFile } from './lane';
import { COMPANY, keptAsFiles, keptEntries, precacheOf, seedMe, workerText } from './shell';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

const OLD_PUBLIC = fileURLToPath(new URL('../../../../public', import.meta.url));
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name), `${prefix}/${name}`) : [`${prefix}/${name}`],
  );
}

const STAND_IN = `<!doctype html><meta charset="utf-8"><title>old app</title><p>old app</p><script>
(async () => {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('adr-private-drafts-v2', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put({ id: 'draft-1', note: 'unsent' });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  window.oldReady = true;
})();
</script>`;

// Serves the old app as it was: its worker, every file of its public folder and the pages its worker
// keeps. The new app answers everything else (/field, /_next, /api).
function serveOldApp(lane: NetworkLane): string {
  const worker = readFileSync(join(OLD_PUBLIC, 'sw.js'), 'utf8');
  const serve = (path: string, body: string | Buffer, type: string) => lane.serve(path, { type, body } satisfies StaticFile);
  for (const path of filesUnder(OLD_PUBLIC)) {
    if (path === '/sw.js') continue;
    serve(path, readFileSync(join(OLD_PUBLIC, path)), TYPES[extname(path)] ?? 'application/octet-stream');
  }
  serve('/', readFileSync(join(OLD_PUBLIC, 'index.html')), TYPES['.html']!);
  serve('/app', readFileSync(join(OLD_PUBLIC, 'app.html')), TYPES['.html']!);
  serve('/__/firebase/init.json', '{}', TYPES['.json']!);
  serve('/__old/', STAND_IN, TYPES['.html']!);
  // Anything else the old worker lists that the old public folder does not hold.
  for (const [, path] of worker.matchAll(/'(\/[^'?]*)[?']/g)) {
    if (path && !path.startsWith('/__old')) {
      try {
        statSync(join(OLD_PUBLIC, path));
      } catch {
        if (!['/', '/app', '/__/firebase/init.json'].includes(path)) serve(path, '', 'text/plain');
      }
    }
  }
  lane.serve('/sw.js', { type: TYPES['.js']!, body: worker });
  return worker;
}

test('the new worker replaces the old one at /sw.js only when every old window is closed, and leaves the old app alone', async ({ context, lane }) => {
  serveOldApp(lane);

  // An old-app window: its worker installs, takes control and keeps its own cache.
  const old = await context.newPage();
  await old.goto(`${lane.appUrl}/__old/`);
  await old.waitForFunction(() => (window as unknown as { oldReady?: boolean }).oldReady === true);
  await expect.poll(() => old.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  expect(await old.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith('dryscope-')))).toEqual(['dryscope-o1-o4-unstamped']);

  // The new app is deployed at the same address: /sw.js is now the new worker, and every file it
  // lists is the new app's own.
  lane.unserve('/sw.js');
  for (const path of precacheOf(await workerText(lane))) lane.unserve(path);
  await old.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect
    .poll(() => old.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null))
    .toBe(true);
  // It has installed (its own cache is full) and waits: the old window is still the old worker's.
  const names = await old.evaluate(async () => (await caches.keys()).sort());
  expect(names.filter((name) => name.startsWith('ds-field-'))).toHaveLength(1);
  expect(names).toContain('dryscope-o1-o4-unstamped');
  await old.waitForTimeout(2000);
  expect(await old.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null)).toBe(true);

  // Every old window is closed: the new worker activates by itself. A window cannot be opened to
  // ask (it would be the old worker's client), so each try is made with the network cut, which only
  // the new worker's kept shell can answer.
  await old.close();
  await expect(async () => {
    const probe = await context.newPage();
    try {
      lane.cut();
      await probe.goto(`${lane.appUrl}/field`, { timeout: 5000 });
      await expect(probe.locator('[data-shell="field"]')).toBeVisible({ timeout: 3000 });
    } finally {
      lane.restore();
      await probe.close();
    }
  }).toPass({ timeout: 45_000, intervals: [1000] });

  // The old app's cache and drafts database are exactly as they were.
  const page = await context.newPage();
  await page.goto(`${lane.appUrl}/field`);
  await seedMe(page, lane);
  await page.reload();
  await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
  const caches_ = await page.evaluate(async () => (await caches.keys()).sort());
  expect(caches_.filter((name) => name.startsWith('dryscope-'))).toEqual(['dryscope-o1-o4-unstamped']);
  expect(caches_.filter((name) => name.startsWith('ds-field-'))).toHaveLength(1);
  const drafts = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('adr-private-drafts-v2');
        open.onsuccess = () => {
          const all = open.result.transaction('drafts').objectStore('drafts').getAll();
          all.onsuccess = () => {
            open.result.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  expect(drafts).toEqual([{ id: 'draft-1', note: 'unsent' }]);
  // Beside the old app's database, exactly the new app's own: ds-me, and the Firebase SDK's two
  // saved-sign-in databases, which the job screens (S5a-6) create when they open the saved sign-in
  // (the sign-in page creates the same ones on a real phone; this test seeds ds-me without signing
  // in). Firstmate decision, 2026-11-13; any other database still fails here.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).sort())).toEqual([
    'adr-private-drafts-v2',
    'ds-me',
    'firebase-heartbeat-database',
    'firebaseLocalStorageDb',
  ]);
});

test('the new worker keeps the files of the new deployment, not the copies the old worker kept at the same addresses', async ({ context, lane }) => {
  serveOldApp(lane);
  const old = await context.newPage();
  await old.goto(`${lane.appUrl}/__old/`);
  await old.waitForFunction(() => (window as unknown as { oldReady?: boolean }).oldReady === true);
  await expect.poll(() => old.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const startUrl = () => old.evaluate(async () => ((await (await fetch('/manifest.webmanifest')).json()) as { start_url: string }).start_url);
  // The old worker keeps its own copy of the manifest, which opens the old app.
  expect(await startUrl()).toBe('/app');

  // The new app is deployed: /sw.js and every file its worker lists are the new app's own.
  lane.unserve('/sw.js');
  const listed = precacheOf(await workerText(lane));
  for (const path of listed) lane.unserve(path);
  await old.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect
    .poll(() => old.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null))
    .toBe(true);
  // The old window still gets the old worker's copy, and the new worker kept the new manifest.
  expect(await startUrl()).toBe('/app');
  const kept = await old.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith('ds-field-'))!;
    const manifest = await (await caches.open(name)).match('/manifest.webmanifest');
    return ((await manifest!.json()) as { start_url: string }).start_url;
  });
  expect(kept).toBe('/field');
  // Each listed file is kept under its own address as the file itself: no redirect, no variant.
  const name = await old.evaluate(async () => (await caches.keys()).find((key) => key.startsWith('ds-field-'))!);
  expect(await keptEntries(old, name)).toEqual(keptAsFiles(listed));

  // Once the old window is closed and the new worker has taken over, a window gets the new manifest
  // from it, with no signal.
  await old.close();
  await expect(async () => {
    const probe = await context.newPage();
    try {
      lane.cut();
      await probe.goto(`${lane.appUrl}/field`, { timeout: 5000 });
      await expect(probe.locator('[data-shell="field"]')).toBeVisible({ timeout: 3000 });
      expect(await probe.evaluate(async () => ((await (await fetch('/manifest.webmanifest')).json()) as { start_url: string }).start_url)).toBe('/field');
    } finally {
      lane.restore();
      await probe.close();
    }
  }).toPass({ timeout: 45_000, intervals: [1000] });
});
