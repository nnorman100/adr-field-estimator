const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const core = require('../../public/core.js');
const JOB = 'ADR-INS-' + 'c'.repeat(32);
const headers = { Authorization: 'Bearer test-owner-ws-owner' };
test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page, request }) => {
  await page.close();
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

async function owner(page) {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-owner'));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}

test('monthly spending uses real settlement with synthetic provider usage and no count feature', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary'] },
  });
  const summary = await request.get(`/api/jobs/${JOB}/insight`, { headers });
  expect(summary.status()).toBe(200);
  const session = await (await request.get('/api/session', { headers })).json();
  expect(session.ai_spending).toBeUndefined();
  const spending = await (await request.get('/api/companies/adr/ai-spending', { headers })).json();
  expect(spending.monthly_cap_microusd).toBe(10000000);
  expect(spending.spent_microusd).toBe(990);
  expect(spending.reserved_microusd).toBe(0);
  await owner(page);
  const card = page.locator('.ai-spending');
  await expect(card).toHaveText('AI used this month: $0.00 of $10.00');
  await expect(card.locator('button')).toHaveCount(0);
  await expect(page.locator('.ai-usage')).toHaveCount(0);
});

test('monthly cap refuses generation while saved work and the owner display stay available', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary'], ai_monthly_cap_microusd: 0 },
  });
  const before = await (await request.get(`/api/inspections/${JOB}`, { headers })).json();
  const refused = await request.get(`/api/jobs/${JOB}/insight`, { headers });
  expect(refused.status()).toBe(429);
  expect((await refused.json()).detail).toContain('next month (UTC)');
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(1);
  const after = await (await request.get(`/api/inspections/${JOB}`, { headers })).json();
  expect(after).toEqual(before);
  expect(
    (await request.get(`/api/jobs/${JOB}/insight?facts_only=true`, { headers })).status(),
  ).toBe(200);
  await owner(page);
  await expect(page.locator('.ai-spending')).toHaveText('AI used this month: $0.00 of $0.00');
});

test('a refused queued photo recognition stays pending while later queued drafts still sync', async ({
  page,
}) => {
  const uid = 'test-owner-spending-' + randomUUID(),
    hex = () => randomUUID().replaceAll('-', '').slice(1),
    open = 'ADR-INS-f' + hex(),
    first = 'ADR-INS-0' + hex(),
    later = 'ADR-INS-1' + hex();
  let recognitions = 0;
  await page.route('**/api/inspections/*/photos/*/ocr', (route) => {
    recognitions++;
    return route.fulfill({
      status: 429,
      headers: { 'Retry-After': '3600', 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail: "Your company has reached this month's AI spending limit." }),
    });
  });
  await page.goto('/manifest.webmanifest');
  await page.evaluate(
    async ({ uid, open, first, later, data }) => {
      sessionStorage.setItem('synthetic-uid', uid);
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = 80;
      c.getContext('2d').fillRect(0, 0, 10, 10);
      const row = (id, address, photos, updated_at) => ({
        key: uid + ':' + id,
        uid,
        company_id: null,
        draft: { inspection_id: id, data: { ...data, address }, photos },
        record: null,
        ack: null,
        session: null,
        updated_at,
      });
      const rows = [
        row(open, 'Open property', [], '2026-10-10T12:00:00.000Z'),
        row(
          first,
          'Queued photo property',
          [
            {
              id: '2'.repeat(32),
              room: 'Room 1',
              captured_at: new Date().toISOString(),
              data_url: c.toDataURL('image/png'),
              width: 120,
              height: 80,
              ocr_status: 'pending',
              uploaded: false,
            },
          ],
          '2026-10-09T12:00:00.000Z',
        ),
        row(later, 'Queued manual property', [], '2026-10-08T12:00:00.000Z'),
      ];
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('adr-private-drafts-v2', 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('drafts', { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        for (const r of rows) tx.objectStore('drafts').put(r);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
    },
    { uid, open, first, later, data: core.emptyData() },
  );
  await page.goto('/app');
  await expect(page.locator('#address')).toHaveValue('Open property', { timeout: 15000 });
  const remote = async (id) => {
    const response = await page.request.get('/api/inspections/' + id, {
      headers: { Authorization: 'Bearer ' + uid },
    });
    return response.ok() ? response.json() : null;
  };
  await expect.poll(async () => (await remote(later))?.data.address).toBe('Queued manual property');
  const queued = await remote(first);
  expect(queued.photos.map((p) => [p.width, p.ocr_status])).toEqual([[120, 'pending']]);
  expect(recognitions).toBeGreaterThan(0);
});
