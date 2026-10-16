// Temporary live validation spec (test phase); copied to the evidence directory and removed from the worktree.
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const EVIDENCE = '/home/nnorm/.no-mistakes/evidence/01M52NDN744D8921RMAXFKGNZ4';
const live = 'https://alert-disaster-field-2026.web.app',
  dotted = 'https://alert-disaster-field-2026.web.app.';
test.use({ serviceWorkers: 'block' });

// Builds a valid unsynced row with the real app on the test origin, then returns it with the synthetic uid.
async function template(page, context) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await context.setOffline(true);
  await page.locator('#address').fill('100 Offline Template St');
  await page.waitForTimeout(800);
  const out = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('adr-private-drafts-v2');
        r.onsuccess = () => {
          const g = r.result.transaction('drafts').objectStore('drafts').getAll();
          g.onsuccess = () => resolve({ rows: g.result, uid: sessionStorage.getItem('synthetic-uid') });
        };
      }),
  );
  await context.setOffline(false);
  return out;
}
const rowFor = (base, uid, address) => {
  const id = 'ADR-INS-' + randomUUID().replace(/-/g, '');
  return {
    ...base,
    key: uid + ':' + id,
    uid,
    record: null,
    ack: null,
    draft: { ...base.draft, inspection_id: id, data: { ...base.draft.data, address }, photos: [] },
  };
};
async function routeDotted(page, baseURL, hold) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== live && url.origin !== dotted) return route.abort();
    if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: '<p>seed</p>' });
    if (hold) await hold(route, url);
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
}
async function seed(page, uid, rows) {
  await page.goto(dotted + '/seed');
  await page.evaluate(
    ([uid, rows]) =>
      new Promise((resolve, reject) => {
        sessionStorage.setItem('synthetic-uid', uid);
        const request = indexedDB.open('adr-private-drafts-v2', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('photos', { keyPath: ['draft_key', 'id'] });
          request.result.createObjectStore('drafts', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const tx = request.result.transaction('drafts', 'readwrite');
          for (const row of rows) tx.objectStore('drafts').put(row);
          tx.oncomplete = () => {
            request.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [uid, rows],
  );
}


const hex = () => randomUUID().replace(/-/g, '');
const wsRow = (base, address) => {
  const uid = 'test-owner-ws-estimator',
    id = 'ADR-INS-' + hex();
  return {
    ...base,
    key: uid + ':adr:' + id,
    uid,
    company_id: 'adr',
    record: null,
    ack: null,
    session: null,
    draft: { ...base.draft, inspection_id: id, data: { ...base.draft.data, address }, photos: [] },
  };
};
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('rollback mode: queued draft on the dotted origin syncs, and the next launch lands on the live host', async ({
  page,
  context,
  baseURL,
}) => {
  const { rows, uid } = await template(page, context);
  const row = rowFor(rows[0], uid, '200 Basement Photo Ave');
  await routeDotted(page, baseURL);
  await seed(page, uid, [row]);
  await page.goto(dotted + '/');
  await expect(page.locator('#hostSyncNotice')).toBeVisible();
  await expect(page.locator('#address')).toHaveValue('200 Basement Photo Ave', { timeout: 15000 });
  await expect(page.locator('#saveStatus')).toContainText('Saved privately', { timeout: 15000 });
  const remote = await (
    await page.request.get('/api/inspections/' + row.draft.inspection_id, {
      headers: { Authorization: 'Bearer ' + uid },
    })
  ).json();
  console.log('server copy address', remote.data.address, 'url', page.url());
  expect(remote.data.address).toBe('200 Basement Photo Ave');
  await page.waitForTimeout(1000);
  await page.goto(dotted + '/');
  await expect(page).toHaveURL(live + '/', { timeout: 15000 });
});

test('workspace mode: queued draft on the dotted origin syncs in the background, then the app lands on the live host', async ({
  page,
  context,
  baseURL,
  request,
  browserName,
}) => {
  const { rows } = await template(page, context);
  await request.post('/__test/workspaces', { data: { enabled: true } });
  const row = wsRow(rows[0], '500 Workspace Queue Ln');
  let release;
  const held = new Promise((r) => (release = r));
  await routeDotted(page, baseURL, async (route, url) => {
    if (url.pathname.startsWith('/api/inspections/' + row.draft.inspection_id)) await held;
  });
  await seed(page, row.uid, [row]);
  await page.goto(dotted + '/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#hostSyncNotice')).toHaveText(
    'Drafts on this device are still syncing. Sign in with email and keep this Home Screen icon until they finish.',
  );
  expect(page.url()).toBe(dotted + '/');
  await page.screenshot({ path: EVIDENCE + '/dotted-workspace-sync-notice-' + browserName + '.png' });
  release();
  await expect(page).toHaveURL(live + '/', { timeout: 20000 });
  const remote = await (
    await page.request.get('/api/inspections/' + row.draft.inspection_id, {
      headers: { Authorization: 'Bearer ' + row.uid, 'X-ADR-Workspace-Protocol': '1' },
    })
  ).json();
  console.log('server copy address', remote.data?.address, 'final url', page.url());
  expect(remote.data.address).toBe('500 Workspace Queue Ln');
  await expect(page.locator('#hostSyncNotice')).toBeHidden();
  await page.screenshot({ path: EVIDENCE + '/after-sync-redirect-live-host-' + browserName + '.png' });
});

test('workspace mode: an unsaved edit in an open job blocks the post-drain redirect', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const { rows } = await template(page, context);
  await request.post('/__test/workspaces', { data: { enabled: true } });
  const row = wsRow(rows[0], '600 Held Queue Ct');
  let release;
  const held = new Promise((r) => (release = r));
  await routeDotted(page, baseURL, async (route, url) => {
    if (url.pathname.startsWith('/api/inspections/' + row.draft.inspection_id)) await held;
    // Saves of the open job never complete, so its edit stays only in memory.
    if (
      url.pathname.startsWith('/api/inspections/ADR-INS-' + 'c'.repeat(32)) &&
      route.request().method() !== 'GET'
    )
      await new Promise(() => {});
  });
  await seed(page, row.uid, [row]);
  await page.goto(dotted + '/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible({ timeout: 15000 });
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toBeEnabled();
  await page.locator('#address').fill('Edited in the field, not yet saved');
  // Release the queued draft right away, before the 400 ms local persist of the edit.
  release();
  await page.waitForTimeout(4000);
  console.log('url after drain with open edit', page.url());
  expect(page.url()).toBe(dotted + '/');
  expect(await page.locator('#address').inputValue()).toBe('Edited in the field, not yet saved');
});

test('home screen launch on the dotted origin shows the re-add message (screenshot)', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== dotted) return route.fulfill({ status: 204 });
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
  await page.goto(dotted + '/', { waitUntil: 'commit' });
  await expect
    .poll(() => page.evaluate(() => document.getElementById('message')?.textContent))
    .toContain('This Home Screen icon opens a wrong address');
  await page.waitForTimeout(500);
  await page.screenshot({ path: EVIDENCE + '/homescreen-readd-message.png' });
});
