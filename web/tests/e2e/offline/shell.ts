// Helpers for the field shell and worker tests (S6-2): a saved sign-in for the shell to start from,
// the worker's own file list, and a window that is under the worker's control.
import { expect, type Page } from '@playwright/test';
import { ME_DB, ME_DB_VERSION, ME_STORE, meKey } from '../../../src/lib/field/ds-me';
import type { NetworkLane } from './lane';

export const COMPANY = 'Shell Test Restoration';

// Writes the row the sign-in page writes (ds-me), straight into the page's IndexedDB, so a test
// need not sign in to give the shell something to start from.
export async function seedMe(page: Page, lane: NetworkLane, company = COMPANY): Promise<void> {
  const row = {
    key: meKey('tenant-shell', 'uid-shell'),
    tenantId: 'tenant-shell',
    uid: 'uid-shell',
    companyName: company,
    address: 'shell-test',
    config: { apiKey: 'demo-emulator-api-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo-dryscope', authEmulatorUrl: `http://${lane.authHost}` },
    savedAt: Date.now(),
  };
  await page.evaluate(
    ([db, store, version, value]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db as string, version as number);
        open.onupgradeneeded = () => open.result.createObjectStore(store as string, { keyPath: 'key' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction(store as string, 'readwrite');
          transaction.objectStore(store as string).put(value);
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    [ME_DB, ME_STORE, ME_DB_VERSION, row] as const,
  );
}

// The worker's own source as the server serves it, and the two values the build put in it.
export async function workerText(lane: NetworkLane): Promise<string> {
  const response = await fetch(`${lane.appUrl}/sw.js`);
  expect(response.status).toBe(200);
  return response.text();
}

export function precacheOf(worker: string): string[] {
  const match = /const PRECACHE = (\[[^\]]*\]);/.exec(worker);
  if (!match) throw new Error('the worker has no precache list');
  return JSON.parse(match[1]!) as string[];
}

export function buildIdOf(worker: string): string {
  const match = /const BUILD_ID = "([^"]+)";/.exec(worker);
  if (!match) throw new Error('the worker has no build id');
  return match[1]!;
}

// Opens the shell, saves a sign-in for it, waits for the worker to be active and reloads so the
// window is under its control, as the second visit of a phone is. Returns the same-origin paths
// the window asked for on that controlled load.
export async function openControlled(page: Page, lane: NetworkLane, company = COMPANY): Promise<string[]> {
  await page.goto(`${lane.appUrl}/field`);
  await seedMe(page, lane, company);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const asked: string[] = [];
  const origin = new URL(lane.appUrl).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) asked.push(url.pathname);
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  return asked;
}

// Makes the page's reachability check run now (it also runs on its own every few seconds).
export async function nudge(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

export async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys()).sort());
}

// Every entry of a worker cache: the address it is kept under (with any query) and the response
// kept for it, so a test can see that each one is the file itself, never a redirect or an error.
export async function keptEntries(page: Page, name: string): Promise<{ path: string; status: number; redirected: boolean }[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    const entries = await Promise.all(
      (await cache.keys()).map(async (request) => {
        const response = (await cache.match(request))!;
        const url = new URL(request.url);
        return { path: url.pathname + url.search, status: response.status, redirected: response.redirected };
      }),
    );
    return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  }, name);
}

// What keptEntries reads for a cache that holds exactly `paths`, each as the file itself.
export const keptAsFiles = (paths: readonly string[]) =>
  [...paths].sort().map((path) => ({ path, status: 200, redirected: false }));

export async function cachedPaths(page: Page, name: string): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => new URL(request.url).pathname + new URL(request.url).search).sort();
  }, name);
}
