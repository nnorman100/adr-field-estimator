// Registers the field worker (public/sw.js, built by scripts/build-sw.mjs) for the whole origin.
// The worker caches the shell and build files only and lets every other request through
// untouched, so registering it on a page outside the shell changes nothing there. A browser
// without service workers, or a build with no worker file (`next dev`), simply goes without: the
// shell then needs a connection to open, and nothing else breaks.
//
// `updateViaCache: 'none'` makes the browser fetch the worker script itself past its HTTP cache,
// so a new build is noticed on the next open. A new worker waits; it is applied only by the
// "Update ready" step (S6-6), never by this file.
export function registerFieldWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
  };
  // After the page has loaded, so registering never competes with the shell's own files.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
