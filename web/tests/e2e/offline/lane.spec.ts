// The switchable network itself (lane.ts): that it passes traffic through, that a cut really cuts
// what it says for the page in each engine, and that a restore brings it back. The other offline
// tests trust these, so each fails here first if the lane stops doing its job.
import { connect } from 'node:net';
import { expect, test } from './fixture';

const reachable = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2000) }).then(
    (response) => response.status,
    () => null,
  );

test.describe('the network lane', () => {
  test('passes the app and both emulators through', async ({ lane }) => {
    expect(await reachable(`${lane.appUrl}/__harness/`)).toBe(200);
    // The real app answers behind the lane.
    expect(await reachable(`${lane.appUrl}/api/health`)).toBe(200);
    expect(await reachable(`http://${lane.authHost}/`)).toBe(200);
    expect(await reachable(`http://${lane.firestoreHost}/`)).toBe(200);
    expect(lane.bytes('app')).toBeGreaterThan(0);
    expect(lane.bytes('auth')).toBeGreaterThan(0);
    expect(lane.bytes('firestore')).toBeGreaterThan(0);
  });

  test('a cut refuses every connection to what it cuts and leaves the rest alone, and restore brings it back', async ({ lane }) => {
    lane.cut(['firestore']);
    expect(await reachable(`http://${lane.firestoreHost}/`)).toBeNull();
    expect(lane.refused('firestore')).toBeGreaterThan(0);
    expect(await reachable(`http://${lane.authHost}/`)).toBe(200);
    expect(await reachable(`${lane.appUrl}/__harness/`)).toBe(200);
    expect(lane.refused('auth')).toBe(0);
    lane.restore(['firestore']);
    expect(await reachable(`http://${lane.firestoreHost}/`)).toBe(200);
  });

  test('a cut tears down a connection already open', async ({ lane }) => {
    // A connection held open with a request half sent, as a streaming Firestore call is.
    const [host, port] = lane.firestoreHost.split(':');
    const socket = connect(Number(port), host!);
    await new Promise<void>((open) => socket.once('connect', () => open()));
    socket.write('GET / HTTP/1.1\r\nHost: lane\r\n');
    socket.on('error', () => undefined);
    const closed = new Promise<boolean>((done) => socket.once('close', () => done(true)));
    lane.cut(['firestore']);
    expect(await Promise.race([closed, new Promise<boolean>((done) => setTimeout(() => done(false), 2000))])).toBe(true);
  });

  // Playwright cannot route a service worker's requests outside Chromium, so the cut is made here,
  // below the browser: the page itself cannot load, in either engine.
  test('a cut takes the page away in the browser, and restore brings it back', async ({ browser, lane }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${lane.appUrl}/__harness/`);
    await expect(page.locator('body')).toHaveText('offline harness');
    lane.cut(['app']);
    await expect(page.goto(`${lane.appUrl}/__harness/`)).rejects.toThrow();
    lane.restore(['app']);
    // Chromium may still be settling on its error page from the failed load.
    await expect(async () => {
      await page.goto(`${lane.appUrl}/__harness/`);
    }).toPass();
    await expect(page.locator('body')).toHaveText('offline harness');
    // The page's own script ran: the harness is on the window.
    expect(await page.evaluate(() => typeof (window as unknown as { h?: unknown }).h)).toBe('object');
  });
});
