// Registers the field worker (public/sw.js, built by scripts/build-sw.mjs) for the whole origin.
// The worker caches the shell and build files only and lets every other request through
// untouched, so registering it on a page outside the shell changes nothing there. A browser
// without service workers, or a build with no worker file (`next dev`), simply goes without: the
// shell then needs a connection to open, and nothing else breaks.
//
// `updateViaCache: 'none'` makes the browser fetch the worker script itself past its HTTP cache,
// so a new build is noticed on the next open. A new worker waits; it is applied only by the
// "Update ready" step (S6-6), never by this file.
const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });

export function registerFieldWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const start = () => void register().catch(() => undefined);
  // After the page has loaded, so registering never competes with the shell's own files.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

export const PREPARE_WITHIN_MS = 20_000;
// The worker's caches (sw.js keeps the shell in ds-field-<build id>).
const SHELL_CACHE_PREFIX = 'ds-field-';

function activated(worker: ServiceWorker): Promise<boolean> {
  return new Promise((done) => {
    const settle = () => {
      if (worker.state === 'activated') done(true);
      else if (worker.state === 'redundant') done(false);
      else return;
      worker.removeEventListener('statechange', settle);
    };
    worker.addEventListener('statechange', settle);
    settle();
  });
}

// The online sign-in (S6-3): registers the worker and waits until it is active with the shell page
// in its cache, so a phone that loses signal right after signing in can still open the field app.
// True when that is so; false when it is not within PREPARE_WITHIN_MS, or cannot be (no service
// workers, the worker would not install).
export async function prepareFieldShell(withinMs = PREPARE_WITHIN_MS): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof caches === 'undefined') return false;
  const ready = (async () => {
    const registration = await register();
    if (!registration.active) {
      const coming = registration.installing ?? registration.waiting;
      if (!coming || !(await activated(coming))) return false;
    }
    for (const name of await caches.keys()) {
      if (name.startsWith(SHELL_CACHE_PREFIX) && (await (await caches.open(name)).match('/field'))) return true;
    }
    return false;
  })().catch(() => false);
  return Promise.race([ready, new Promise<boolean>((done) => setTimeout(() => done(false), withinMs))]);
}
