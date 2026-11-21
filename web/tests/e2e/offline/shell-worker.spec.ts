// The field worker and shell (S6-2), in Chromium and WebKit, with the network cut at the lane (not
// only `setOffline`, which WebKit does not apply to a worker): the shell opens and reloads with no
// signal; the worker keeps the listed files and nothing else; and a deployment never changes a
// window that is running.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixture';
import { makeWorker, missingFromPrecache } from '../../../scripts/build-sw';
import { PROBE_PATH } from '../../../src/app/field/connection';
import { buildIdOf, cacheNames, cachedPaths, COMPANY, keptAsFiles, keptEntries, nudge, openControlled, precacheOf, workerText } from './shell';
import { expectWorkerRuns } from '../service-workers';

// Offline and worker tests need the service worker, which the suite blocks by default.
test.use({ serviceWorkers: 'allow' });

test('the offline suite runs with the service worker allowed', async ({ page, lane }) => {
  await page.goto(`${lane.appUrl}/field`);
  await expectWorkerRuns(page);
});

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
  test('offers a waiting update and reloads into it only after the technician taps', async ({ page, lane }) => {
    const worker = await workerText(lane);
    await openControlled(page, lane);
    const shell = await (await fetch(`${lane.appUrl}/field`)).text();
    lane.serve('/field', { type: 'text/html; charset=utf-8', body: shell.replace('</body>', '<!--updated-shell--></body>') });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'update-on-tap') });
    await nudge(page);

    const update = page.getByRole('button', { name: 'Update now' });
    await expect(update).toBeEnabled();
    expect(await page.content()).not.toContain('updated-shell');
    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await update.click();
    await reloaded;
    await page.waitForLoadState('domcontentloaded');
    expect(await page.content()).toContain('updated-shell');
    await expect(update).toBeHidden();
    await expect(page.getByRole('heading', { name: COMPANY })).toBeVisible();
  });

  test('a controller change reloads a second window, and a canceled reload can be tried again', async ({ context, page, lane }) => {
    const worker = await workerText(lane);
    await openControlled(page, lane);
    const other = await context.newPage();
    await other.goto(`${lane.appUrl}/field`);
    const shell = await (await fetch(`${lane.appUrl}/field`)).text();
    lane.serve('/field', { type: 'text/html; charset=utf-8', body: shell.replace('</body>', '<!--updated-shell--></body>') });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'two-windows') });
    await nudge(page);
    await nudge(other);
    await expect(other.getByRole('button', { name: 'Update now' })).toBeEnabled();

    // Give the second window a user gesture so the browser allows its leave-this-page prompt.
    await other.getByRole('heading', { name: COMPANY }).click();
    await other.evaluate(() => {
      (window as unknown as { stay: EventListener }).stay = (event) => event.preventDefault();
      addEventListener('beforeunload', (window as unknown as { stay: EventListener }).stay);
    });
    other.once('dialog', (dialog) => void dialog.dismiss());
    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await page.getByRole('button', { name: 'Update now' }).click();
    await reloaded;

    // The other window attempted to reload from controllerchange without another tap.
    await expect.poll(() => other.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting ?? null)).toBeNull();
    await expect(other.getByText('The update did not start. Try again.')).toBeVisible();
    const update = other.getByRole('button', { name: 'Update now' });
    await expect(update).toBeEnabled();
    await other.evaluate(() => removeEventListener('beforeunload', (window as unknown as { stay: EventListener }).stay));
    const again = other.waitForEvent('framenavigated', (frame) => frame === other.mainFrame());
    await update.click();
    await again;
    await other.waitForLoadState('domcontentloaded');
    expect(await other.content()).toContain('updated-shell');
  });

  test('a signing or documents page installs no worker and shows no update', async ({ page, lane }) => {
    for (const path of ['/sign', '/documents']) {
      await page.goto(`${lane.appUrl}${path}`);
      await page.waitForLoadState('load');
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    }
    await page.goto(`${lane.appUrl}/field`);
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
  });

  test('a build with an empty precache unregisters its worker, and the next navigation reaches the server', async ({ page, lane }) => {
    const worker = await workerText(lane);
    await openControlled(page, lane);
    const template = readFileSync(fileURLToPath(new URL('../../../sw/sw.js', import.meta.url)), 'utf8');
    const recovery = makeWorker({ template, buildId: 'recovery', list: [] });
    expect(precacheOf(recovery)).toEqual([]);
    expect(await cacheNames(page)).toEqual([`ds-field-${buildIdOf(worker)}`]);
    const shell = await (await fetch(`${lane.appUrl}/field`)).text();
    lane.serve('/field', { type: 'text/html; charset=utf-8', body: shell.replace('</body>', '<!--served-by-the-server--></body>') });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: recovery });
    await nudge(page);

    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await page.getByRole('button', { name: 'Update now' }).click();
    await reloaded;
    const registrations = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    await expect.poll(registrations).toBe(0);
    await expect.poll(() => cacheNames(page)).toEqual([]);

    const asked = lane.bytes('app');
    await page.goto(`${lane.appUrl}/field`);
    expect(await page.content()).toContain('served-by-the-server');
    expect(lane.bytes('app')).toBeGreaterThan(asked);
  });

  test('the new worker takes over naturally after the last controlled window closes', async ({ context, page, lane }) => {
    const worker = await workerText(lane);
    await openControlled(page, lane);
    const other = await context.newPage();
    await other.goto(`${lane.appUrl}/field`);
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'all-windows-closed') });
    await other.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await expect.poll(() => other.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed');
    await page.close();
    await expect.poll(() => cacheNames(other)).toContain(`ds-field-${buildIdOf(worker)}`);
    await other.close();

    const observer = await context.newPage();
    await observer.goto('about:blank');
    await observer.goto(`${lane.appUrl}/field`);
    await expect.poll(() => cacheNames(observer)).toEqual(['ds-field-all-windows-closed']);
  });

  test('installs the files the new build serves, not the copies this worker keeps', async ({ context, lane }) => {
    const worker = await workerText(lane);
    const page = await context.newPage();
    await openControlled(page, lane);
    const manifest = (await (await fetch(`${lane.appUrl}/manifest.webmanifest`)).json()) as Record<string, unknown>;
    lane.serve('/manifest.webmanifest', { type: 'application/manifest+json', body: JSON.stringify({ ...manifest, name: 'next-build' }) });
    lane.serve('/sw.js', { type: 'text/javascript; charset=utf-8', body: worker.replace(buildIdOf(worker), 'next-build') });
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null))
      .toBe(true);
    const manifests = await page.evaluate(async (current) => {
      const read = async (name: string) => {
        const kept = (await (await (await caches.open(name)).match('/manifest.webmanifest'))!.json()) as { name: string; start_url: string };
        return { name: kept.name, start_url: kept.start_url };
      };
      return { current: await read(current), next: await read('ds-field-next-build') };
    }, `ds-field-${buildIdOf(worker)}`);
    expect(manifests).toEqual({
      current: { name: 'DryScope', start_url: '/field' },
      next: { name: 'next-build', start_url: '/field' },
    });
    // Each listed file is kept under its own address as the file itself: no redirect, no variant.
    expect(await keptEntries(page, 'ds-field-next-build')).toEqual(keptAsFiles(precacheOf(worker)));
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
