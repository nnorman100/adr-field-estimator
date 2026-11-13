import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { serverLogLinesWith } from './server-log';

// TC-2 (docs/plans/TC.md) at phone width, in Chromium and WebKit: a page that throws and rejects
// sends exactly two reports to the real server route, scrubbed, and the server's log sink receives
// exactly two scrubbed Error Reporting events for them; with the network cut and restored the same
// two arrive once. What the page sent is read from the request, and what the server logged from its
// standard output (tests/e2e/server-log.ts). Each test's errors carry a marker of its own, so the
// lines of tests running beside it are not counted.
test.use({ viewport: { width: 390, height: 844 } });

const EMAIL = 'jane.doe@example.com';
const TOKEN = 'Bearer sekritvalue4ever';
const COORDS = '34.05223, -118.24368';
const PERSONAL = /example\.com|jane|sekritvalue|34\.05|118\.24/;
const ENDPOINT = '/api/client-errors';

type Exchange = { body: { reports: Record<string, unknown>[] }; status: number };

// Every request to the route and the server's answer to it.
function watch(page: Page) {
  const exchanges: Exchange[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== ENDPOINT) return;
    const body = JSON.parse(response.request().postData() ?? '{}') as Exchange['body'];
    exchanges.push({ body, status: response.status() });
  });
  return exchanges;
}

const markerFor = (name: string, testInfo: TestInfo) => `${name}-${testInfo.project.name}-r${testInfo.retry}`;

// Throws one error from a timer and rejects one promise nobody handles, as a broken page would.
async function breakThePage(page: Page, marker: string) {
  await page.evaluate(
    ({ email, token, coords, marker }) => {
      setTimeout(() => {
        throw new TypeError(`could not load for ${email} at ${coords} in ${marker}`);
      }, 0);
      void Promise.reject(new RangeError(`refused with ${token} in ${marker}`));
    },
    { email: EMAIL, token: TOKEN, coords: COORDS, marker },
  );
}

// The Error Reporting events the server logged for this test's errors.
function loggedEvents(marker: string): Record<string, unknown>[] {
  return serverLogLinesWith(marker).flatMap((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return (event.serviceContext as { service?: unknown } | undefined)?.service === 'dryscope-web-client' ? [event] : [];
    } catch {
      return [];
    }
  });
}

function expectTwoScrubbedReports(exchanges: Exchange[], browserFamily: string) {
  expect(exchanges).toHaveLength(1);
  const [{ body, status }] = exchanges as [Exchange];
  expect(status).toBe(202);
  expect(body.reports).toHaveLength(2);
  expect(body.reports.map((r) => r.name).sort()).toEqual(['RangeError', 'TypeError']);
  for (const report of body.reports) expect(report).toMatchObject({ route: '/', browser: browserFamily });
  const text = JSON.stringify(body);
  expect(text).not.toMatch(PERSONAL);
}

async function expectTwoScrubbedEvents(marker: string, browserFamily: string) {
  await expect.poll(() => loggedEvents(marker).length, { timeout: 15_000 }).toBe(2);
  const events = loggedEvents(marker);
  expect(events).toHaveLength(2);
  expect(events.map((event) => String(event.message).split(':')[0]).sort()).toEqual(['RangeError', 'TypeError']);
  for (const event of events) {
    expect(event).toMatchObject({ severity: 'ERROR', context: { httpRequest: { url: '/' } }, browser: browserFamily });
  }
  const lines = serverLogLinesWith(marker);
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line).not.toMatch(PERSONAL);
}

test('a page that throws and rejects sends exactly two scrubbed reports', async ({ page, browserName }, testInfo) => {
  const marker = markerFor('normal', testInfo);
  const family = browserName === 'webkit' ? 'safari' : 'chrome';
  const exchanges = watch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();
  await breakThePage(page, marker);
  await expect.poll(() => exchanges.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // Nothing more arrives after the batch.
  await page.waitForTimeout(3000);
  expectTwoScrubbedReports(exchanges, family);
  await expectTwoScrubbedEvents(marker, family);
});

test('with the network cut and restored, the same two reports arrive once', async ({ page, context, browserName }, testInfo) => {
  const marker = markerFor('reconnect', testInfo);
  const family = browserName === 'webkit' ? 'safari' : 'chrome';
  const exchanges = watch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();

  await context.setOffline(true);
  await breakThePage(page, marker);
  await page.waitForTimeout(3000);
  expect(exchanges).toHaveLength(0);
  expect(loggedEvents(marker)).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => exchanges.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  expectTwoScrubbedReports(exchanges, family);
  await expectTwoScrubbedEvents(marker, family);
});
