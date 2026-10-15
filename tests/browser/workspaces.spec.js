const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function call(page, path, method = 'GET', body, role = 'owner') {
  return page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
}
// Phones show the workspace destinations behind a menu toggle; wider screens show them in a row.
async function navigate(page, id) {
  // Wait for the workspace session to show the nav so the toggle check is not raced by a reload.
  await expect(page.locator('#workspaceNav')).toBeVisible();
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator('#' + id).click();
}
async function firstScreen(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect(),
      bar = document.querySelector('.draft-actions').getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      scrolled: scrollY,
      inside:
        r.height > 0 &&
        r.top >= 0 &&
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= Math.min(innerHeight, bar.top),
      hit: top === el || el.contains(top),
    };
  });
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner dashboard has no automatic blank inspection and fits phones', async ({
  page,
  browserName,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, 'owner');
  expect((await (await page.request.get('/__test/workspaces-stats')).json()).inspection_count).toBe(
    1,
  );
  await expect(page.locator('#dashboardTeam')).toBeVisible();
  await expect(page.locator('#dashboardAdmin')).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  }
  if (browserName === 'chromium')
    await page.screenshot({
      path: test.info().outputPath('workspace-owner-mobile.png'),
      fullPage: true,
    });
  await navigate(page, 'dashboardTeam');
  await expect(page.locator('#dashboardHeading')).toHaveText('Team & invitations');
  await page
    .locator('form')
    .filter({ has: page.locator('input[name=email]') })
    .locator('input[name=email]')
    .fill('new-estimator@example.invalid');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Email sent');
  const office = page.locator('.dashboard-card').filter({
    has: page.getByRole('heading', { name: uid('office') + '@example.invalid', exact: true }),
  });
  await office.locator('select[name=status]').selectOption('disabled');
  await office.getByRole('button', { name: 'Save access' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Office staff · disabled');
  expect(errors).toEqual([]);
});

for (const role of ['owner', 'estimator'])
  for (const width of [320, 390])
    test(
      role + ' phone at ' + width + '×844 shows Start walkthrough on the first screen',
      async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 844 });
        await start(page, role);
        const toggle = page.locator('#workspaceMenuToggle');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#dashboardHome')).toBeHidden();
        expect((await page.locator('#workspaceNav').boundingBox()).height).toBeLessThan(64);
        await navigate(page, 'dashboardJobs');
        await page.getByRole('button', { name: /Assigned bathroom/ }).click();
        await expect(page.locator('#address')).toBeEnabled();
        const expand = page.locator('#coordinationToggle');
        if (role === 'owner') {
          await expect(page.locator('#jobCoordination')).toBeVisible();
          await expect(expand).toHaveAttribute('aria-expanded', 'false');
          await expect(page.locator('#coordinationForm')).toBeHidden();
        } else await expect(page.locator('#jobCoordination')).toBeHidden();
        await page.locator('.task-nav [data-task="walkthrough"]').click();
        await expect(page.locator('#startWalk')).toBeVisible();
        expect(await firstScreen(page, '#startWalk')).toEqual({
          scrolled: 0,
          inside: true,
          hit: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        if (browserName === 'chromium')
          await page.screenshot({
            path: test.info().outputPath('workspace-' + role + '-walkthrough-' + width + '.png'),
          });
        if (role === 'owner') {
          await expand.click();
          await expect(expand).toHaveAttribute('aria-expanded', 'true');
          for (const id of ['coordAddress', 'coordEstimator', 'coordName', 'coordNotes'])
            await expect(page.locator('#' + id)).toBeVisible();
          await expect(page.locator('#saveCoordination')).toBeEnabled();
          await expand.click();
          await expect(page.locator('#coordinationForm')).toBeHidden();
        }
      },
    );

test('every workspace destination stays reachable from the phone menu', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await start(page, 'owner');
  const toggle = page.locator('#workspaceMenuToggle'),
    nav = page.getByRole('navigation', { name: 'Company workspace' });
  await expect(toggle).toHaveAttribute('aria-controls', 'workspaceLinks');
  const destinations = [
    ['Dashboard', 'Alert Disaster Restoration'],
    ['Company jobs', 'Company jobs'],
    ['Team & invitations', 'Team & invitations'],
    ['Company settings', 'Company settings'],
    ['Companies', 'Companies'],
  ];
  for (const [name] of destinations)
    await expect(nav.getByRole('button', { name, exact: true })).toBeHidden();
  // Keyboard: open the menu, move to a destination and choose it.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('button', { name: 'Company jobs', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Escape closes an open menu and returns focus to its toggle.
  await toggle.click();
  await nav.getByRole('button', { name: 'Dashboard', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  for (const [name, heading] of destinations) {
    await toggle.click();
    const destination = nav.getByRole('button', { name, exact: true });
    await destination.click();
    await expect(page.locator('#dashboardHeading')).toHaveText(heading);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current]')).toHaveCount(1);
    await toggle.click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('superadmin manages companies and cannot use member job routes', async ({ page }) => {
  await start(page, 'admin');
  await expect(page.locator('#dashboardJobs')).toBeHidden();
  await expect(page.locator('#dashboardTeam')).toBeHidden();
  await page.locator('#dashboardAdmin').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
  await page.locator('input[name=name]').fill('New California Restoration');
  await page.locator('input[name=owner_email]').fill('new-owner@example.invalid');
  await page.getByRole('button', { name: 'Create & invite owner' }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('New California Restoration');
  await expect(page.locator('#dashboardContent')).toContainText('new-owner@example.invalid');
  expect(
    (
      await call(page, '/api/inspections/ADR-INS-' + 'c'.repeat(32), 'GET', undefined, 'admin')
    ).status(),
  ).toBe(403);
  await page.getByRole('button', { name: 'Suspend company', exact: true }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Company status: suspended');
  await page.getByRole('button', { name: 'Reactivate company', exact: true }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Company status: active');
});

test('superadmin support view is read-only with audited team fixes', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const invited = await call(
    page,
    '/api/companies/adr/invitations',
    'POST',
    { email: 'support-invitee@example.invalid', role: 'office' },
    'owner',
  );
  expect(invited.status()).toBe(200);
  await start(page, 'admin');
  await page.locator('#dashboardAdmin').click();
  await page
    .locator('.dashboard-card')
    .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
    .getByRole('button', { name: 'Manage company' })
    .click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await expect(page.locator('#dashboardEyebrow')).toHaveText('READ-ONLY SUPPORT VIEW');
  await expect(page.locator('#dashboardHeading')).toHaveText(
    'Support · Alert Disaster Restoration',
  );
  const content = page.locator('#dashboardContent');
  await expect(content).toContainText('recorded in the audit log');
  const editable = content.locator('form, input, select, textarea');
  await expect(editable).toHaveCount(0);
  const owner = content.locator('.dashboard-card').filter({
    has: page.getByRole('heading', { name: uid('owner') + '@example.invalid', exact: true }),
  });
  await expect(owner.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Job details');
  await expect(content).toContainText('Bathroom · Category 1');
  await expect(content).toContainText('No documents generated for this revision.');
  await expect(editable).toHaveCount(0);
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Back to support view' }).click();

  const office = content.locator('.dashboard-card').filter({
    has: page.getByRole('heading', { name: uid('office') + '@example.invalid', exact: true }),
  });
  await office.getByRole('button', { name: 'Change to estimator' }).click();
  await expect(office).toContainText('Estimator · active');
  await expect(office.getByRole('button', { name: 'Change to office staff' })).toBeVisible();
  const invitation = content.locator('.dashboard-card').filter({
    has: page.getByRole('heading', { name: 'support-invitee@example.invalid', exact: true }),
  });
  await invitation.getByRole('button', { name: 'Cancel invitation' }).click();
  await expect(invitation).toContainText('Office staff · cancelled');
  await expect(invitation.getByRole('button')).toHaveCount(0);

  const audit = await call(
    page,
    '/api/audit',
    'POST',
    { inspection_id: 'ADR-INS-' + 'c'.repeat(32), expected_revision: 1 },
    'estimator',
  );
  const record = await audit.json();
  const signaturePng = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    context.lineWidth = 3;
    context.moveTo(10, 35);
    context.lineTo(40, 12);
    context.lineTo(105, 15);
    context.stroke();
    return canvas.toDataURL('image/png');
  });
  const signed = await call(
    page,
    '/api/authorize',
    'POST',
    {
      inspection_id: record.inspection_id,
      expected_revision: record.revision,
      auth_id: 'ADR-AUTH-supportview1',
      proposal_hash: record.audit.proposal_hash,
      signature_png: signaturePng,
      documents_confirmed: true,
    },
    'estimator',
  );
  expect(signed.status()).toBe(200);
  await page.getByRole('button', { name: 'Back to company administration' }).click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: /Signed agreement/ }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Signed agreement');
  await expect(content).toContainText('Customer estimate range: $1,775.00–$1,788.90');
  const signature = content.getByRole('img', { name: 'Customer signature' });
  await expect.poll(() => signature.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(editable).toHaveCount(0);

  expect(
    (
      await call(
        page,
        '/api/inspections/ADR-INS-' + 'c'.repeat(32),
        'PUT',
        { expected_revision: 1, data: { address: 'Support edit' } },
        'admin',
      )
    ).status(),
  ).toBe(403);
  const events = await (await request.get('/__test/support-events')).json();
  const actions = events.map((e) => e.action);
  for (const action of [
    'support_view_company',
    'support_view_jobs',
    'support_view_documents',
    'support_view_team',
    'support_view_invitations',
    'support_view_job',
    'support_member_access',
    'support_invitation_cancel',
    'support_view_document',
    'support_view_evidence',
  ])
    expect(actions).toContain(action);
  expect(events.every((e) => e.actor_uid === uid('admin') && e.company_id === 'adr')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('example.invalid');
  expect(errors).toEqual([]);
});

test('office creates empty scope and coordinates without scope or signing controls', async ({
  page,
}) => {
  await start(page, 'office');
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  await expect(page.locator('#dashboardTeam')).toBeHidden();
  await expect(page.locator('#dashboardAdmin')).toBeHidden();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#jobCoordination')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();
  await expect(page.locator('#yearBuilt')).toHaveValue('');
  await expect(page.locator('#technicianTranscript')).toHaveJSProperty('readOnly', true);
  await page.locator('#coordAddress').fill('Office-created property');
  await page.locator('#coordName').fill('Synthetic customer');
  await page.locator('#coordEstimator').selectOption(uid('estimator'));
  await page.locator('#saveCoordination').click();
  await expect(page.locator('#coordinationStatus')).toHaveText('Coordination saved.');
  await expect(page.locator('#address')).toHaveValue('Office-created property');
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardJobs').click();
  await expect(page.locator('#dashboardContent')).toContainText('Office-created property');
});

test('estimator opens assigned workflow and loses scope controls on role change', async ({
  page,
}) => {
  await start(page, 'estimator');
  await expect(page.locator('#dashboardHeading')).toHaveText('My jobs');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toBeEnabled();
  await expect(page.locator('#jobCoordination')).toBeHidden();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#estimateRange')).toHaveText('$1,775.00–$1,788.90');
  const result = await call(page, '/api/companies/adr/team/' + uid('estimator'), 'PUT', {
    expected_version: 1,
    role: 'office',
    status: 'active',
  });
  expect(result.ok()).toBe(true);
  await page.evaluate(() => WorkspaceUI.refresh());
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await expect(page.locator('#address')).toHaveValue('');
  await expect(page.locator('#proposalBody')).toHaveText('');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toBeDisabled();
  await expect(page.locator('#finishAudit')).toBeDisabled();
  await expect(page.locator('#signingArea')).toBeHidden();
});

test('company profile edits require regenerated documents and render labels safely', async ({
  page,
}) => {
  await start(page, 'owner');
  await page.locator('#dashboardProfile').click();
  await page.locator('input[name=signoff]').fill('<img src=x onerror=window.companyInjected=true>');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.locator('#message')).toContainText('Company details saved');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#proposalBody')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.companyInjected)).toBeUndefined();
});

test('invitation is explicit and bound to the matching Google account', async ({ page }) => {
  const invitation = await (
    await call(page, '/api/companies/adr/invitations', 'POST', {
      email: uid('pending') + '@example.invalid',
      role: 'office',
    })
  ).json();
  await page.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    uid('pending'),
  );
  await page.goto('/?invite=' + invitation.invitation_id);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  expect((await call(page, '/api/session', 'GET', undefined, 'pending')).status()).toBe(200); // The harness overrides identity only; membership still comes from real policy.
  await expect(page.locator('#dashboardJobs')).toBeHidden();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.locator('#dashboardJobs')).toBeVisible();
  await expect(page.locator('#dashboardTeam')).toBeHidden();
  expect(new URL(page.url()).searchParams.has('invite')).toBe(false);
});

test('email failures stay visible and can be retried', async ({ page, request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true, send_fail: true } });
  await start(page, 'owner');
  await page.locator('#dashboardTeam').click();
  await page.locator('input[name=email]').fill('fail@example.invalid');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Email failed');
  await expect(page.locator('#dashboardContent')).toContainText(
    'Invitation email could not be sent',
  );
  await expect(page.getByRole('button', { name: 'Resend invitation' })).toBeVisible();
});

test('other company branding and signing snapshots stay isolated from ADR', async ({
  page,
  browserName,
}) => {
  await start(page, 'other');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.masthead .brand strong')).toBeVisible();
  await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('#address').fill('Other company synthetic property');
  await page.locator('#yearBuilt').fill('2000');
  await expect(page.locator('#coordAddress')).toHaveValue('Other company synthetic property');
  await page.locator('#coordinationToggle').click();
  await page.locator('#coordNotes').fill('Office note retains the measured property address');
  await page.locator('#saveCoordination').click();
  await expect(page.locator('#coordinationStatus')).toHaveText('Coordination saved.');
  await expect(page.locator('#address')).toHaveValue('Other company synthetic property');
  await page.locator('[data-room-key=finished_sf]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#doc-proposal > h2')).toContainText('Other Restoration');
  await expect(page.locator('#proposalBody')).toContainText('Other Estimator · CSLB #123456');
  await expect(page.locator('.document-letterhead img')).toBeHidden();
  await expect(page.locator('#defenseBody')).not.toContainText('Matthew Myers');
  if (browserName === 'chromium')
    await page.screenshot({
      path: test.info().outputPath('other-company-proposal-mobile.png'),
      fullPage: true,
    });
  for (const name of ['proposal', 'claim', 'defense', 'photos'])
    await page.locator('[data-tab=' + name + ']').click();
  await page.locator('[data-tab=proposal]').click();
  await page.locator('#documentsConfirmed').check();
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 110, rect.y + 80, { steps: 8 });
  await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#savedSignature')).toBeVisible();
  await page.reload();
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Other company synthetic property.*Signed/s }).click();
  await expect(page.locator('#proposalBody')).toContainText('Other Estimator');
  await expect(page.locator('#savedSignature')).toBeVisible();
  expect(
    (
      await call(page, '/api/inspections/ADR-INS-' + 'c'.repeat(32), 'GET', undefined, 'other')
    ).status(),
  ).toBe(404);
});

test('replacement owner can manage the disabled former owner as staff', async ({ page }) => {
  const invitation = await (
    await call(page, '/api/companies/adr/invitations', 'POST', {
      email: uid('pending') + '@example.invalid',
      role: 'owner',
    })
  ).json();
  expect(
    (
      await call(
        page,
        '/api/invitations/' + invitation.invitation_id + '/accept',
        'POST',
        {},
        'pending',
      )
    ).ok(),
  ).toBe(true);
  await start(page, 'pending');
  await page.locator('#dashboardTeam').click();
  const former = page.locator('.dashboard-card').filter({
    has: page.getByRole('heading', { name: uid('owner') + '@example.invalid', exact: true }),
  });
  await expect(former).toContainText('Owner · disabled');
  await former.locator('select[name=role]').selectOption('office');
  await former.locator('select[name=status]').selectOption('active');
  await former.getByRole('button', { name: 'Save access' }).click();
  await expect(page.locator('#message')).toContainText('Staff access updated.');
  await expect(former).toContainText('Office staff · active');
  const session = await (await call(page, '/api/session', 'GET', undefined, 'owner')).json();
  expect(session.role).toBe('office');
  expect(session.superadmin).toBe(true);
});

test('account switch clears customer fields and documents before another company opens', async ({
  page,
}) => {
  await start(page, 'owner');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#proposalBody')).toContainText('Assigned bathroom');
  await page.evaluate(async (value) => {
    sessionStorage.setItem('synthetic-uid', value);
    await window.__testAuthChanged({
      uid: value,
      email: value + '@example.invalid',
      getIdToken: async () => value,
    });
  }, uid('other'));
  await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');
  await expect(page.locator('#address')).toHaveValue('');
  await expect(page.locator('#proposalBody')).toHaveText('');
  await expect(page.locator('#rooms')).toBeEmpty();
  await expect(page.locator('#savedSignature')).toBeHidden();
  await page.locator('#dashboardJobs').click();
  await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
});

test('invited password account stays unverified without authenticated calls, then accepts its invitation', async ({
  page,
}) => {
  const email = uid('pending') + '@example.invalid';
  const invitation = await (
    await call(page, '/api/companies/adr/invitations', 'POST', { email, role: 'office' })
  ).json();
  const authenticated = [];
  page.on('request', (request) => {
    if (request.headers().authorization) authenticated.push(request.url());
  });
  // The invitation provisioned this account and its set-password link was used; the address is not verified yet.
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem('synthetic-accounts')) {
      sessionStorage.setItem(
        'synthetic-accounts',
        JSON.stringify({ [value]: { password: 'synthetic-password', verified: false } }),
      );
      sessionStorage.setItem('synthetic-signed-out', '1');
    }
  }, email);
  await page.goto('/?invite=' + invitation.invitation_id);
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await expect(page.locator('#signInButton')).toBeVisible();
  await expect(page.locator('#emailAuthForm')).toContainText('link in your invitation email');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#verifyEmail')).toBeVisible();
  await expect(page.locator('#verifyAddress')).toHaveText(email);
  await expect(page.locator('#emailAuthForm')).toBeHidden();
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  await expect(page.locator('#authStatus')).toHaveText('Verification email sent to ' + email + '.');
  expect(await page.evaluate(() => window.__testEmails)).toEqual([{ type: 'verify', email }]);
  await page.getByRole('button', { name: "I've verified" }).click();
  await expect(page.locator('#authStatus')).toContainText('not verified yet');
  await page.reload();
  await expect(page.locator('#verifyEmail')).toBeVisible();
  await expect(page.locator('#workspaceDashboard')).toBeHidden();
  await expect(page.locator('#address')).toBeDisabled();
  expect(authenticated).toEqual([]);
  await page.evaluate((value) => window.__testVerify(value), email);
  await page.getByRole('button', { name: "I've verified" }).click();
  await expect(page.locator('#authPanel')).toBeHidden();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.locator('#dashboardJobs')).toBeVisible();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  expect(authenticated.length).toBeGreaterThan(0);
});

test('email sign-in errors share one message and do not reveal accounts', async ({ page }) => {
  const email = uid('owner') + '@example.invalid';
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem('synthetic-accounts')) {
      sessionStorage.setItem(
        'synthetic-accounts',
        JSON.stringify({ [value]: { password: 'correct-password', verified: true } }),
      );
      sessionStorage.setItem('synthetic-signed-out', '1');
    }
  }, email);
  await page.goto('/');
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  const signIn = async (address, password) => {
    await page.locator('#authEmail').fill(address);
    await page.locator('#authPassword').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  await signIn(email, 'wrong-password');
  await expect(page.locator('#authStatus')).toHaveText('Email or password is incorrect.');
  await signIn('nobody@example.invalid', 'wrong-password');
  await expect(page.locator('#authStatus')).toHaveText('Email or password is incorrect.');
  await page.getByRole('button', { name: 'Forgot password' }).click();
  await expect(page.locator('#authStatus')).toHaveText(
    'If an account uses nobody@example.invalid, a password reset email is on its way.',
  );
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  await expect(page.locator('#emailCreate')).toHaveCount(0);
  await expect(page.locator('#workspaceDashboard')).toBeHidden();
  await signIn(email, 'correct-password');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await expect(page.locator('#authPanel')).toBeHidden();
  await expect(page.locator('#dashboardTeam')).toBeVisible();
});

test('server validation errors show the field message instead of a generic retry', async ({
  page,
}) => {
  await start(page, 'owner');
  await page.locator('#dashboardProfile').click();
  await page.locator('input[name=name]').fill('Visit www.evil.example');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.locator('#message')).toHaveText(
    "Company name must be up to 80 letters, numbers, spaces or . , & ' ( ) - characters, with no web address.",
  );
});

// The server refusal is the control; the UI only has to keep the superadmin tools out of sight.
for (const role of ['estimator', 'office', 'other', 'outsider']) {
  test(`superadmin tools are hidden from and refused to ${role}`, async ({ page }) => {
    await start(page, role);
    await navigate(page, 'dashboardHome');
    await expect(page.locator('#dashboardHeading')).not.toHaveText('Companies');
    await expect(page.locator('#dashboardAdmin')).toBeHidden();
    for (const name of ['Manage companies', 'Open read-only support view'])
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    const target = role === 'other' ? 'adr' : 'other';
    for (const [path, method, body] of [
      ['/api/admin/companies', 'GET'],
      [
        '/api/admin/companies',
        'POST',
        { name: 'Forged Restoration', owner_email: 'forged@example.invalid' },
      ],
      [
        '/api/admin/companies/' + target + '/status',
        'PUT',
        { expected_version: 1, status: 'suspended' },
      ],
      ['/api/admin/companies/' + target + '/jobs', 'GET'],
      ['/api/companies/' + target + '/team', 'GET'],
      [
        '/api/companies/' + target + '/invitations',
        'POST',
        { email: 'forged-owner@example.invalid', role: 'owner' },
      ],
    ])
      expect((await call(page, path, method, body, role)).status(), method + ' ' + path).toBe(403);
    const companies = await (
      await call(page, '/api/admin/companies', 'GET', undefined, 'admin')
    ).json();
    expect(companies.companies.map((c) => [c.company_id, c.status]).sort()).toEqual([
      ['adr', 'active'],
      ['other', 'active'],
    ]);
  });
}
