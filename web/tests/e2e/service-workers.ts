import { expect, type Page } from '@playwright/test';

// The browser suite blocks service workers by default (playwright.config.ts). A spec about the
// field worker or the offline shell allows it with `test.use({ serviceWorkers: 'allow' })` and
// proves, with expectWorkerRuns, that the worker really runs there, so offline coverage cannot be
// lost silently by a blocked worker. Under 'block' a registration still resolves but the worker
// never becomes ready (checked in Chromium and WebKit, Playwright 1.65), which is what this waits on.
export const WORKER_READY_MS = 15_000;

export async function expectWorkerRuns(page: Page): Promise<void> {
  const state = await page.evaluate(async (ms) => {
    if (!('serviceWorker' in navigator)) return 'no service workers';
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    return Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise<string>((done) => setTimeout(() => done('never ready: service workers are blocked'), ms)),
    ]);
  }, WORKER_READY_MS);
  expect(state, 'this spec needs the service worker allowed').toBe('ready');
}
