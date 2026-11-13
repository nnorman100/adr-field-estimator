// The field worker and shell (S6-2), in Chromium and WebKit, with the network cut at the lane (not
// only `setOffline`, which WebKit does not apply to a worker): the shell opens and reloads with no
// signal; the worker keeps the listed files and nothing else; and a deployment never changes a
// window that is running.
import { expect, test } from './fixture';
import { missingFromPrecache } from '../../../scripts/build-sw';
import { PROBE_PATH } from '../../../src/app/field/connection';
import { buildIdOf, cacheNames, cachedPaths, COMPANY, nudge, openControlled, precacheOf, workerText } from './shell';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('the field shell with no signal', () => {
  test('opens and reloads with the network cut, without asking the server for anything', async ({ context, lane }) => {
    const page = await context.newPage();
    await openControlled(page, lane);
    lane.cut();
    const sent = lane.bytes('app');

    await page.reload();
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
    // A path under /field is the same shell (views are client state), and a Home Screen launch.
    await page.goto(`${lane.appUrl}/field/jobs`);
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
    await page.goto(`${lane.appUrl}/field`);
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();

    // The cut was real: a page the worker does not keep cannot be reached, and nothing the shell
    // showed came from the server.
    await expect(page.goto(`${lane.appUrl}/sign-in/anything`)).rejects.toThrow();
    expect(lane.bytes('app')).toBe(sent);
  });

  test('says "No signal" while the network is cut and stops when it is back', async ({ context, lane }) => {
    const page = await context.newPage();
    await openControlled(page, lane);
    const banner = page.getByText('No signal: your work is saved on this phone');
    await expect(banner).toBeHidden();
    lane.cut();
    await nudge(page);
    await expect(banner).toBeVisible();
    lane.restore();
    await nudge(page);
    await expect(banner).toBeHidden();
  });
});

test.describe('what the worker keeps', () => {
  test('after a full session its caches hold exactly the listed shell files', async ({ context, lane }) => {
    const worker = await workerText(lane);
    const listed = precacheOf(worker);
    const page = await context.newPage();
    await openControlled(page, lane);
    // A session: the shell, a deeper path of it, calls to the app's API (a read, a refused read,
    // a write and a photo-shaped upload) and a page outside the shell.
    await page.goto(`${lane.appUrl}/field/jobs`);
    await page.evaluate(async () => {
      await fetch('/api/health');
      await fetch('/api/me');
      await fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"x"}' });
      await fetch('/api/jobs/job-1/photos/photo-1');
      await fetch('/api/jobs/job-1/photos/photo-1', { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
    });
    await page.goto(`${lane.appUrl}/`);
    await page.goto(`${lane.appUrl}/field`);

    expect(await cacheNames(page)).toEqual([`ds-field-${buildIdOf(worker)}`]);
    expect(await cachedPaths(page, `ds-field-${buildIdOf(worker)}`)).toEqual([...listed].sort());
    expect(listed.some((path) => path.startsWith('/api/'))).toBe(false);
  });

  test('every file the shell loads is in the list', async ({ context, lane }) => {
    const listed = precacheOf(await workerText(lane));
    const page = await context.newPage();
    const asked = await openControlled(page, lane);
    const shellFiles = asked.filter((path) => !path.startsWith('/api/') && path !== '/sw.js' && path !== PROBE_PATH);
    expect(shellFiles.length).toBeGreaterThan(3);
    expect(missingFromPrecache(shellFiles, listed)).toEqual([]);
  });

  test('a build whose list misses a file the shell loads is caught', async ({ context, lane }) => {
    const worker = await workerText(lane);
    const listed = precacheOf(worker);
    // A script the shell's page itself loads.
    const html = await (await fetch(`${lane.appUrl}/field`)).text();
    const chunk = [...html.matchAll(/<script src="(\/_next\/static\/[^"]+\.js)"(?![^>]*noModule)/g)].at(-1)![1]!;
    expect(listed).toContain(chunk);
    // The same worker with one chunk the shell loads left out of its list.
    const short = worker.replace(JSON.stringify(chunk) + ',', '').replace(',' + JSON.stringify(chunk), '');
    expect(precacheOf(short)).not.toContain(chunk);
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: short });
    const page = await context.newPage();
    const asked = await openControlled(page, lane);
    const shellFiles = asked.filter((path) => !path.startsWith('/api/') && path !== '/sw.js' && path !== PROBE_PATH);
    expect(missingFromPrecache(shellFiles, precacheOf(short))).toEqual([chunk]);
  });
});

test.describe('a deployment', () => {
  test('installs the files the new build serves, not the copies this worker keeps', async ({ context, lane }) => {
    const worker = await workerText(lane);
    const page = await context.newPage();
    await openControlled(page, lane);
    const manifest = await (await fetch(`${lane.appUrl}/manifest.webmanifest`)).text();
    lane.serve('/manifest.webmanifest', { type: 'application/manifest+json', body: manifest.replace('"/field"', '"/field?next-build"') });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'next-build') });
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null))
      .toBe(true);
    const startUrls = await page.evaluate(async (current) => {
      const read = async (name: string) =>
        ((await (await (await caches.open(name)).match('/manifest.webmanifest'))!.json()) as { start_url: string }).start_url;
      return { current: await read(current), next: await read('ds-field-next-build') };
    }, `ds-field-${buildIdOf(worker)}`);
    expect(startUrls).toEqual({ current: '/field', next: '/field?next-build' });
  });

  test('does not change a window that is running or one that opens before the person updates', async ({ context, lane }) => {
    const worker = await workerText(lane);
    const page = await context.newPage();
    await openControlled(page, lane);

    // A new build goes out: new shell page, a new worker for it, and the old build's files gone.
    const shell = await (await fetch(`${lane.appUrl}/field`)).text();
    lane.serve('/field', { type: 'text/html; charset=utf-8', body: shell.replace('</body>', '<!--new-build--></body>') });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'next-build') });
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null))
      .toBe(true);
    lane.drop('/_next/static/');
    expect(await cacheNames(page)).toEqual([`ds-field-${buildIdOf(worker)}`, 'ds-field-next-build'].sort());

    // The running window is as it was, and so is a reload and a window opened now: the old build's
    // shell and files, from the old worker's own cache, while the server has moved on.
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
    expect(await page.content()).not.toContain('new-build');
    const other = await context.newPage();
    await other.goto(`${lane.appUrl}/field`);
    await expect(other.getByRole('heading', { name: COMPANY })).toBeVisible();
    expect(await other.content()).not.toContain('new-build');
    // The server really has the new page: only a navigation is the worker's to answer.
    expect(await page.evaluate(async () => (await (await fetch('/field')).text()).includes('new-build'))).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null)).toBe(true);
  });
});
