const { test, expect } = require('@playwright/test');
const { saveDraft, checkScope } = require('./actions');

// Address suggestions and the job map against the synthetic backend: the real Places routes, caps
// and permissions run, and only the call to Google is replaced. The browser must never contact
// Google itself.
test.use({ serviceWorkers: 'block' });

const TYPED = '4821 zephyr';
const FULL = '4821 Zephyr Hollow Lane, Bakersfield, CA 93301';
// The harness runs without a key unless a test turns one on.
const places = (request, settings = {}) =>
  request.post('/__test/places', { data: { key: true, ...settings } });
const calls = async (request) => (await request.get('/__test/places')).json();
const uid = (role) => 'test-owner-ws-' + role;

async function ready(page) {
  const outside = [];
  const localOrigin = new URL(test.info().project.use.baseURL).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== localOrigin)
      outside.push(request.url());
  });
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled();
  await checkScope(page);
  return outside;
}
async function choose(page) {
  await page.locator('#address').fill(TYPED);
  const option = page.getByRole('option', { name: /4821 Zephyr Hollow Lane/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator('#address')).toHaveValue(FULL);
}
const saved = (page) => page.evaluate(() => state.record?.data);

test.afterEach(async ({ request }) => {
  await places(request, { key: false });
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('a chosen suggestion fills the address, saves coordinates and shows the map', async ({
  page,
  request,
}) => {
  await places(request);
  const outside = await ready(page);
  await choose(page);
  await expect(page.locator('#addressSuggestions')).toBeHidden();
  const image = page.locator('#jobMapImage');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(image).toHaveAttribute('src', /^blob:/);
  const link = page.locator('#jobDirections');
  await expect(link).toHaveAttribute('href', /destination=35\.373292%2C-119\.018712$/);
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('#jobMapStatus')).toBeHidden();
  await page.locator('#yearBuilt').fill('1998');
  await saveDraft(page);
  await expect
    .poll(async () => (await saved(page))?.coordinates)
    .toEqual({
      latitude: 35.373292,
      longitude: -119.018712,
      address: FULL,
    });
  expect(await calls(request)).toEqual([
    'places:autocomplete',
    'ChIJsynthetic_place_id_0001',
    'staticmap',
  ]);
  // The page never loads a Google script or image, and the page has no Google script tag.
  expect(outside).toEqual([]);
  expect(await page.locator('script[src*="google"], script[src*="maps"]').count()).toBe(0);
  await page.screenshot({ path: test.info().outputPath('address-map.png') });
});

test('editing the address after choosing drops the saved location', async ({ page, request }) => {
  await places(request);
  await ready(page);
  await choose(page);
  await expect(page.locator('#jobMapImage')).toBeVisible();
  await page.locator('#address').fill(FULL + ' Unit 2');
  await expect(page.locator('#jobMapImage')).toBeHidden();
  await expect(page.locator('#jobDirections')).toHaveAttribute(
    'href',
    /destination=4821%20Zephyr%20Hollow%20Lane%2C%20Bakersfield%2C%20CA%2093301%20Unit%202$/,
  );
  await page.locator('#yearBuilt').fill('1998');
  await saveDraft(page);
  await expect.poll(async () => (await saved(page))?.address).toBe(FULL + ' Unit 2');
  expect((await saved(page)).coordinates).toBeNull();
});

test('arrow keys and Enter choose a suggestion; Escape closes the list', async ({
  page,
  request,
}) => {
  await places(request);
  await ready(page);
  const field = page.locator('#address');
  await field.fill(TYPED);
  await expect(page.locator('#addressSuggestions').getByRole('option')).toHaveCount(1);
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await field.press('Escape');
  await expect(page.locator('#addressSuggestions')).toBeHidden();
  await field.fill(TYPED + ' ');
  await expect(page.locator('#addressSuggestions').getByRole('option')).toHaveCount(1);
  await field.press('ArrowDown');
  await expect(page.locator('#addressSuggestions').getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await field.press('Enter');
  await expect(field).toHaveValue(FULL);
  await expect(page.locator('#jobMapImage')).toBeVisible();
});

test('without a key the address stays a plain text box and no error is shown', async ({
  page,
  request,
}) => {
  await places(request, { key: false });
  await ready(page);
  await page.locator('#address').fill(TYPED);
  await expect.poll(async () => (await calls(request)).length).toBe(0);
  await page.waitForTimeout(600);
  await expect(page.locator('#addressSuggestions')).toBeHidden();
  await expect(page.locator('#message')).not.toContainText(/address|suggest|map/i);
  await expect(page.locator('#address')).toHaveValue(TYPED);
  // Only the keyless directions link follows the typed address.
  await expect(page.locator('#jobMapImage')).toBeHidden();
  await expect(page.locator('#jobDirections')).toHaveAttribute(
    'href',
    /destination=4821%20zephyr$/,
  );
});

test('a spent daily cap says so and typing continues', async ({ page, request }) => {
  await places(request);
  await ready(page);
  // The cap is enforced by the real route; a fresh user is far below it, so exhaust it directly.
  await page.evaluate(async () => {
    const token = await state.user.getIdToken();
    for (let i = 0; i < 31; i++)
      await fetch('/api/places/autocomplete', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'cap burst', session: 'session_token_0001' }),
      });
  });
  await page.locator('#address').fill(TYPED);
  await expect(page.locator('#addressHint')).toContainText('paused');
  await expect(page.locator('#addressSuggestions')).toBeHidden();
  await page.locator('#address').fill(TYPED + ' Lane');
  await expect(page.locator('#address')).toHaveValue(TYPED + ' Lane');
});

test('offline the address is plain text and makes no lookups', async ({
  page,
  request,
  context,
}) => {
  await places(request);
  await ready(page);
  await choose(page);
  await expect(page.locator('#jobMapImage')).toBeVisible();
  await page.locator('#yearBuilt').fill('1998');
  await saveDraft(page);
  await expect.poll(async () => (await saved(page))?.coordinates?.address).toBe(FULL);
  await context.setOffline(true);
  await expect(page.locator('#jobMapStatus')).toBeVisible();
  await expect(page.locator('#jobMapStatus')).toHaveText('Map unavailable offline');
  await expect(page.locator('#jobMapImage')).toBeHidden();
  await expect(page.locator('#jobDirections')).toBeVisible();
  const before = (await calls(request)).length;
  await page.locator('#address').fill(FULL);
  await page.waitForTimeout(600);
  await expect(page.locator('#addressSuggestions')).toBeHidden();
  await context.setOffline(false);
  await expect(page.locator('#jobMapImage')).toBeVisible();
  await expect(page.locator('#jobMapStatus')).toBeHidden();
  expect((await calls(request)).length).toBe(before);
});

test('a saved location whose image cannot load reads "Map unavailable offline" and recovers online', async ({
  page,
  request,
}) => {
  await places(request);
  await ready(page);
  await choose(page);
  await expect(page.locator('#jobMapImage')).toBeVisible();
  await page.locator('#yearBuilt').fill('1998');
  await saveDraft(page);
  await expect.poll(async () => (await saved(page))?.coordinates?.address).toBe(FULL);
  // A reload forgets the in-memory image; the connection drops before it can be fetched again.
  await page.route('**/api/places/map', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('#address')).toHaveValue(FULL);
  await checkScope(page);
  await expect(page.locator('#jobMapStatus')).toHaveText('Map unavailable offline');
  await expect(page.locator('#jobMapImage')).toBeHidden();
  await expect(page.locator('#jobDirections')).toBeVisible();
  await page.unroute('**/api/places/map');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#jobMapImage')).toBeVisible();
});

test.describe('company roles', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
    await places(request);
  });
  async function start(page, role) {
    await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
    await checkScope(page);
  }
  test('an older job without coordinates shows only the directions link', async ({
    page,
    request,
  }) => {
    await start(page, 'estimator');
    await expect(page.locator('#jobMapImage')).toBeHidden();
    await expect(page.locator('#jobMapStatus')).toBeHidden();
    await expect(page.locator('#jobDirections')).toHaveAttribute(
      'href',
      /destination=Assigned%20bathroom$/,
    );
    expect(await calls(request)).toEqual([]);
  });
  test('the estimator gets suggestions; office staff only the directions link', async ({
    page,
    request,
  }) => {
    await start(page, 'estimator');
    await choose(page);
    await expect(page.locator('#jobMapImage')).toBeVisible();
    await saveDraft(page);
    await expect.poll(async () => (await saved(page))?.coordinates?.address).toBe(FULL);
    const mine = await calls(request);
    expect(mine.length).toBeGreaterThan(0);
    const office = await page.context().newPage();
    await office.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('office'),
    );
    await office.goto('/app');
    await expect(office.locator('#workspaceDashboard')).toBeVisible();
    await office.locator('#dashboardJobs').click();
    await office.getByRole('button', { name: new RegExp(FULL.slice(0, 20)) }).click();
    await expect(office.locator('#jobDirections')).toBeVisible();
    await expect(office.locator('#jobMapImage')).toBeHidden();
    await expect(office.locator('#jobMapStatus')).toBeHidden();
    expect((await calls(request)).length).toBe(mine.length);
  });
});

for (const status of [429, 502, 403, 503]) {
  test(`lookup ${status} ${status < 503 && status !== 403 ? 'recovers after Retry-After' : 'stays disabled for the page'}`, async ({
    page,
    request,
  }) => {
    await places(request);
    await ready(page);
    let count = 0;
    await page.route('**/api/places/autocomplete', async (route) => {
      count++;
      if (count === 1)
        return route.fulfill({
          status,
          headers: { 'Retry-After': '2' },
          json: { detail: 'Synthetic availability failure' },
        });
      return route.continue();
    });
    await page.locator('#address').fill(TYPED);
    await expect.poll(() => count).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(900);
    expect(count).toBe(1);
    if ([429, 502].includes(status)) {
      await expect(page.locator('#addressSuggestions').getByRole('option')).toBeVisible();
      await page.locator('#addressSuggestions').getByRole('option').click();
      await expect(page.locator('#jobMapImage')).toBeVisible();
    } else {
      await page.waitForTimeout(1700);
      await page.locator('#address').fill(TYPED + ' Lane');
      await page.waitForTimeout(600);
      expect(count).toBe(1);
      await expect(page.locator('#addressSuggestions').getByRole('option')).toHaveCount(0);
    }
  });
}

for (const offline of [false, true]) {
  test(`new manual job shows unavailable ${offline ? 'offline' : 'without a key'}`, async ({
    page,
    request,
    context,
  }) => {
    await places(request, { key: !offline ? false : true });
    await ready(page);
    if (offline) await context.setOffline(true);
    await page.locator('#address').fill('Manual synthetic property');
    await expect(page.locator('#jobMapStatus')).toHaveText('Map unavailable offline');
    await expect(page.locator('#jobMapStatus')).toBeVisible();
    await expect(page.locator('#jobMapImage')).toBeHidden();
    await expect(page.locator('#jobDirections')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('manual-unavailable.png') });
  });
}

test('newly generated proposal displays both approved location notices', async ({
  page,
  request,
}) => {
  await places(request);
  await ready(page);
  await choose(page);
  await page.locator('#yearBuilt').fill('1998');
  await page
    .locator('#technicianNotes')
    .fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#confirmFilledScope').click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#proposalBody')).toContainText(
    'When the job address is entered, the typed address is sent to Google Maps to suggest matching addresses, and the selected location is saved with the job.',
  );
  await expect(page.locator('#proposalBody')).toContainText(
    "Photos taken during the inspection are stamped with the location reported by the technician's phone",
  );
  await page
    .locator('#proposalBody')
    .screenshot({ path: test.info().outputPath('proposal-privacy.png') });
});

test('lookup routes enforce sign-in and company roles before calling the provider', async ({
  request,
}) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await places(request);
  const endpoints = [
    ['autocomplete', { input: TYPED, session: 'session_token_0001' }],
    ['details', { place_id: 'ChIJsynthetic_place_id_0001', session: 'session_token_0001' }],
    ['map', { latitude: 35, longitude: -119 }],
  ];
  for (const role of [null, 'office', 'admin', 'stranger', 'owner', 'estimator', 'other']) {
    for (const [endpoint, data] of endpoints) {
      const response = await request.post('/api/places/' + endpoint, {
        data,
        headers: role
          ? { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' }
          : {},
      });
      expect(response.status()).toBe(
        role === null ? 401 : ['office', 'admin', 'stranger'].includes(role) ? 403 : 200,
      );
    }
  }
  expect((await calls(request)).length).toBe(9);
});
