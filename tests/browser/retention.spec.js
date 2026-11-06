const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function navigate(page, id) {
  await expect(page.locator('#workspaceNav')).toBeVisible();
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator('#' + id).click();
}

for (const width of [320, 390]) {
  test(`the owner sets how long records are kept and sees the effect in plain words at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
    await page.setViewportSize({ width, height: 844 });
    await start(page, 'owner');
    await navigate(page, 'dashboardProfile');
    const card = page.locator('#recordRetention');
    await expect(card.getByRole('heading', { name: 'How long records are kept' })).toBeVisible();
    await expect(card).toContainText('Automatic deletion is not switched on yet');
    const invitations = card.getByLabel('Invitations (days)');
    await expect(invitations).toHaveValue('90');
    const effect = card.locator('#retentionEffect-invitations');
    await expect(effect).toContainText('deleted 90 days after they expire');
    await invitations.fill('10');
    await expect(effect).toHaveText('Enter 30 to 3650 days.');
    await expect(invitations).toHaveAttribute('aria-invalid', 'true');
    await invitations.fill('45');
    await expect(effect).toContainText('deleted 45 days after they expire');
    await card.getByLabel('Photos on archived drafts (days)').fill('365');
    let asked = '';
    page.once('dialog', (dialog) => {
      asked = dialog.message();
      dialog.accept();
    });
    await card.getByRole('button', { name: 'Save record retention' }).click();
    await expect(page.locator('#message')).toHaveText('Record retention saved.');
    expect(asked).toContain('Invitations');
    expect(asked).not.toContain('Photos on archived drafts');
    await page.reload();
    await navigate(page, 'dashboardProfile');
    await expect(page.locator('#recordRetention').getByLabel('Invitations (days)')).toHaveValue(
      '45',
    );
    await expect(
      page.locator('#recordRetention').getByLabel('Photos on archived drafts (days)'),
    ).toHaveValue('365');
    // Nothing overflows the phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('cancelling the shorter-period confirmation saves nothing', async ({ page, request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await start(page, 'owner');
  await navigate(page, 'dashboardProfile');
  const card = page.locator('#recordRetention');
  await card.getByLabel('Company activity log (days)').fill('30');
  page.once('dialog', (dialog) => dialog.dismiss());
  let saved = false;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/retention')) saved = true;
  });
  await card.getByRole('button', { name: 'Save record retention' }).click();
  await page.reload();
  await navigate(page, 'dashboardProfile');
  await expect(
    page.locator('#recordRetention').getByLabel('Company activity log (days)'),
  ).toHaveValue('90');
  expect(saved).toBe(false);
});

for (const role of ['estimator', 'office']) {
  test(`${role} has no retention setting and asks for the sweep only when it is on`, async ({
    page,
    request,
  }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
    const runs = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/retention/run')) runs.push(r.method());
    });
    await start(page, role);
    await expect(page.locator('#dashboardProfile')).toBeHidden();
    await expect(page.locator('#recordRetention')).toHaveCount(0);
    expect(runs).toEqual([]);
    await request.post('/__test/workspaces', { data: { enabled: true, retention: true } });
    const run = page.waitForResponse((r) => r.url().endsWith('/api/companies/adr/retention/run'));
    await page.reload();
    expect((await run).status()).toBe(200);
    expect(await (await run).json()).toEqual({
      ran: true,
      deleted: { invitations: 0, admin_events: 0, job_monitoring: 0, evidence_photos: 0 },
    });
    expect(runs).toEqual(['POST']);
  });
}

test('both archive confirmations say archived photos follow the retention period', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  const promise =
    "Its photos are kept until the company's retention period for archived-draft photos passes, once automatic deletion is switched on, and cannot be restored after that.";
  await start(page, 'owner');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#archiveJob').click();
  await expect(page.locator('#archiveDescription')).toContainText(promise);
  await expect(page.locator('#archiveDescription')).not.toContainText(
    'photos and history are kept',
  );
  await page.locator('#cancelArchive').click();

  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid('admin'));
  await page.goto('/app');
  await page.locator('#dashboardAdmin').click();
  await page
    .locator('.dashboard-card')
    .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
    .getByRole('button', { name: 'Manage company' })
    .click();
  await page.getByRole('button', { name: 'Suspend company' }).click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.getByRole('button', { name: 'Archive draft (support action)' }).click();
  await expect(page.locator('#archiveDescription')).toContainText(promise);
  await page.locator('#cancelArchive').click();
});
