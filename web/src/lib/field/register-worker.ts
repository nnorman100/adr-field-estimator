// Registers the field worker (public/sw.js, built by scripts/build-sw.mjs) for the whole origin.
// The worker caches the shell and build files only and lets every other request through
// untouched, so registering it on a page outside the shell changes nothing there. A browser
// without service workers, or a build with no worker file (`next dev`), simply goes without: the
// shell then needs a connection to open, and nothing else breaks.
//
// `updateViaCache: 'none'` makes the browser fetch the worker script itself past its HTTP cache,
// so a new build is noticed on the next open.
const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });

// What a window knows of its worker. `waiting`: a new build downloaded and not yet running.
// `replaced`: another window already made a new worker the controller of this one, so this window
// runs old code under it and only needs to reload. `unsupported`: no worker here (an old browser,
// `next dev`), so a plain reload loads the new build from the server.
export type WorkerState = { waiting: ServiceWorker | null; replaced: boolean; unsupported: boolean };
export const NO_WORKER: WorkerState = { waiting: null, replaced: false, unsupported: false };

export function watchFieldWorker(report: (state: WorkerState) => void): () => void {
  if (!('serviceWorker' in navigator)) {
    report({ ...NO_WORKER, unsupported: true });
    return () => undefined;
  }
  const hour = 60 * 60 * 1000;
  let stop = () => { window.removeEventListener('load', start); };
  let live = true;
  const controlled = navigator.serviceWorker.controller !== null;
  let replaced = false;
  const start = () => void register().then((registration) => {
    if (!live) return;
    let installer: ServiceWorker | null = null;
    const show = () => report({ waiting: registration.waiting, replaced, unsupported: false });
    const swapped = () => {
      if (controlled) replaced = true;
      show();
    };
    const installing = () => {
      installer?.removeEventListener('statechange', show);
      installer = registration.installing;
      installer?.addEventListener('statechange', show);
      show();
    };
    const check = () => {
      show();
      if (document.visibilityState === 'visible') void registration.update().then(show).catch(() => undefined);
    };
    registration.addEventListener('updatefound', installing);
    navigator.serviceWorker.addEventListener('controllerchange', swapped);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('online', check);
    const timer = window.setInterval(check, hour);
    stop = () => {
      installer?.removeEventListener('statechange', show);
      registration.removeEventListener('updatefound', installing);
      navigator.serviceWorker.removeEventListener('controllerchange', swapped);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('online', check);
      window.clearInterval(timer);
    };
    installing();
    check();
  }, () => {
    if (live) report({ ...NO_WORKER, unsupported: true });
  });
  // After the page has loaded, so registering never competes with the shell's own files.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
  return () => {
    live = false;
    stop();
  };
}

// A waiting worker changes the controller of an already controlled page. A first visit can
// still be uncontrolled, in which case wait for activation before navigating into that build.
// A worker that is active already (an earlier tap, or another window's) needs nothing more.
export function applyWaitingWorker(worker: ServiceWorker): Promise<boolean> {
  if (worker.state === 'activated') return Promise.resolve(true);
  return new Promise((done) => {
    const workers = navigator.serviceWorker;
    const previous = workers.controller;
    const finish = (applied: boolean) => {
      clearTimeout(timer);
      workers.removeEventListener('controllerchange', changed);
      worker.removeEventListener('statechange', changed);
      done(applied);
    };
    const changed = () => {
      if (workers.controller === worker || (!previous && worker.state === 'activated')) finish(true);
      else if (worker.state === 'redundant') finish(false);
    };
    const timer = setTimeout(() => finish(false), PREPARE_WITHIN_MS);
    workers.addEventListener('controllerchange', changed);
    worker.addEventListener('statechange', changed);
    worker.postMessage('SKIP_WAITING');
  });
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
