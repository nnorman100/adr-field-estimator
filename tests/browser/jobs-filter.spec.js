const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const uid = (role) => 'test-owner-ws-' + role;
const DRAFT = 'ADR-INS-' + 'e'.repeat(32);
async function call(page, path, method = 'GET', body) {
  const response = await page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid('owner'), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
  expect(response.ok(), path).toBe(true);
  return response.json();
}
const signed = (i) => ({
  auth_id: 'ADR-AUTH-filter-' + i,
  address: 'Signed property ' + i,
  proposed_cost_low: 1775,
  proposed_cost: 1788.9,
  created_at: '2026-10-2' + i + 'T12:00:00Z',
  photos_count: 0,
  schema_version: 3,
  customer_name: i === 1 ? 'Sam Ortiz' : '',
  claim_number: '',
});

test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('company jobs tabs count and search loaded jobs and say when older ones remain', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid('owner'));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  // A real draft whose customer and claim live only on the job's coordination record.
  await call(page, '/api/inspections', 'POST', {
    inspection_id: DRAFT,
    data: { address: '12 Oak Street' },
  });
  const job = await call(page, '/api/jobs/' + DRAFT + '/coordination');
  await call(page, '/api/jobs/' + DRAFT + '/coordination', 'PUT', {
    expected_version: job.version,
    customer_name: 'Jordan Lee',
  });
  const claim = await call(page, '/api/jobs/' + DRAFT + '/claim');
  await call(page, '/api/jobs/' + DRAFT + '/claim', 'PUT', {
    expected_version: claim.claim_version,
    claim: { ...claim.claim, claim_number: 'CLM-0042-77' },
  });
  // Signed agreements come in two pages, so the first view must not read as complete.
  await page.route(
    (url) => url.pathname === '/api/authorizations',
    (route) => {
      const older = new URL(route.request().url()).searchParams.has('cursor');
      return route.fulfill({
        json: older
          ? { authorizations: [signed(2)], next_cursor: null }
          : { authorizations: [signed(1)], next_cursor: 'ADR-AUTH-filter-1' },
      });
    },
  );
  await page.locator('#dashboardJobs').click();
  const tabs = page.getByRole('navigation', { name: 'Job status' }),
    jobs = page.locator('#dashboardContent .job-link'),
    search = page.getByLabel('Search jobs'),
    note = page.getByText('Counts and search cover the jobs loaded so far.');
  await expect(tabs.getByRole('button')).toHaveText(['All (3+)', 'Drafts (2)', 'Signed (1+)']);
  await expect(note).toBeVisible();
  await expect(jobs.filter({ hasText: '12 Oak Street' })).toContainText(
    'Jordan Lee · Claim CLM-0042-77',
  );

  for (const [query, address] of [
    ['jordan', '12 Oak Street'],
    ['clm-0042', '12 Oak Street'],
    ['OAK st', '12 Oak Street'],
    ['ortiz', 'Signed property 1'],
  ]) {
    await search.fill(query);
    await expect(jobs).toHaveCount(1);
    await expect(jobs).toContainText(address);
  }
  await search.fill('nobody here');
  await expect(jobs).toHaveCount(0);
  await expect(page.locator('#dashboardContent')).toContainText('No jobs match.');
  await search.fill('');

  await tabs.getByRole('button', { name: 'Signed (1+)' }).click();
  await expect(tabs.getByRole('button', { name: 'Signed (1+)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(jobs).toHaveText(['Signed property 1\nSigned · $1,775.00–$1,788.90 · Sam Ortiz']);
  await tabs.getByRole('button', { name: 'Drafts (2)' }).click();
  await expect(jobs).toHaveCount(2);
  await expect(jobs.filter({ hasText: /^Signed property/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Load older agreements' }).click();
  await expect(tabs.getByRole('button')).toHaveText(['All (4)', 'Drafts (2)', 'Signed (2)']);
  await expect(note).toBeHidden();
  await expect(page.getByRole('button', { name: 'Load older agreements' })).toHaveCount(0);
  // The chosen tab survives the new page.
  await expect(jobs).toHaveCount(2);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    for (const box of await tabs
      .getByRole('button')
      .evaluateAll((els) =>
        els.map((el) => [el.scrollWidth <= el.clientWidth, el.getBoundingClientRect().right]),
      ))
      expect(box[0] && box[1] <= width).toBe(true);
  }
  expect(errors).toEqual([]);
});
