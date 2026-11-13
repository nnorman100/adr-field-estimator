import { expect, test, type Page } from '@playwright/test';

// TC-2 (docs/plans/TC.md) at phone width, in Chromium and WebKit: a page that throws and rejects
// sends exactly two reports to the real server route, scrubbed; with the network cut and restored
// the same two arrive once. What the page sent is read from the request and the server's answer is its
// status (202); what the route writes to the log for each report is the unit tests' (the server's
// output is not readable from here, and Chromium gives no body for a keepalive response).
test.use({ viewport: { width: 390, height: 844 } });

const EMAIL = 'jane.doe@example.com';
const TOKEN = 'Bearer sekritvalue4ever';
const COORDS = '34.05223, -118.24368';
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

// Throws one error from a timer and rejects one promise nobody handles, as a broken page would.
async function breakThePage(page: Page) {
  await page.evaluate(
    ({ email, token, coords }) => {
      setTimeout(() => {
        throw new TypeError(`could not load for ${email} at ${coords}`);
      }, 0);
      void Promise.reject(new RangeError(`refused with ${token}`));
    },
    { email: EMAIL, token: TOKEN, coords: COORDS },
  );
}

function expectTwoScrubbedReports(exchanges: Exchange[], browserFamily: string) {
  expect(exchanges).toHaveLength(1);
  const [{ body, status }] = exchanges as [Exchange];
  expect(status).toBe(202);
  expect(body.reports).toHaveLength(2);
  expect(body.reports.map((r) => [r.kind, r.name]).sort()).toEqual([
    ['error', 'TypeError'],
    ['rejection', 'RangeError'],
  ]);
  for (const report of body.reports) expect(report).toMatchObject({ route: '/', browser: browserFamily });
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/example\.com|jane|sekritvalue|34\.05|118\.24/);
}

test('a page that throws and rejects sends exactly two scrubbed reports', async ({ page, browserName }) => {
  const exchanges = watch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();
  await breakThePage(page);
  await expect.poll(() => exchanges.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // Nothing more arrives after the batch.
  await page.waitForTimeout(3000);
  expectTwoScrubbedReports(exchanges, browserName === 'webkit' ? 'safari' : 'chrome');
});

test('with the network cut and restored, the same two reports arrive once', async ({ page, context, browserName }) => {
  const exchanges = watch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();

  await context.setOffline(true);
  await breakThePage(page);
  await page.waitForTimeout(3000);
  expect(exchanges).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => exchanges.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  expectTwoScrubbedReports(exchanges, browserName === 'webkit' ? 'safari' : 'chrome');
});
