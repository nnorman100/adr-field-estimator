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
  await expect(page.locator('#dashboardDescription')).toContainText(
    'Water & mold loss estimates, signed on site.',
  );
  await expect(page.locator('#dashboardDescription')).toContainText(
    'Walk the loss, talk and photograph as you go, and leave with a priced proposal, itemized claim, scope defense letter and photo log.',
  );
  await expect(page.locator('#dashboardEyebrow')).toHaveText('LOSS ESTIMATES · PLATFORM & COMPANY');
  await expect(page.locator('#authPanel')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/login-page/);
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
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
        // The folded coordination card, Help and Account live in the one-row header's More menu.
        const expand = page.locator('#coordinationToggle'),
          more = page.locator('#jobMenu > summary');
        await expect(page.locator('#coordinationForm')).toBeHidden();
        await expect(expand).toBeHidden();
        await page.locator('.task-nav [data-task="walkthrough"]').click();
        await expect(page.locator('#startWalk')).toBeVisible();
        await more.click();
        const help = page.getByRole('button', { name: 'Help', exact: true });
        await expect(help).toBeVisible();
        expect(await firstScreen(page, '.help-button')).toMatchObject({ inside: true, hit: true });
        await expect(page.locator('#moreCoordination')).toBeVisible({ visible: role === 'owner' });
        await page.keyboard.press('Escape');
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
          await more.click();
          await page.locator('#moreCoordination').click();
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

for (const [role, label] of [
  ['owner', 'Owner · Superadmin'],
  ['other', 'Owner'],
  ['estimator', 'Estimator'],
  ['admin', 'Superadmin'],
]) {
  test(`account menu names the ${role} access`, async ({ page }) => {
    await start(page, role);
    await page.locator('#accountMenu summary').click();
    await expect(page.locator('#workspaceAccountDetails p').first()).toHaveText(label);
  });
}

test('superadmin manages companies and cannot use member job routes', async ({ page }) => {
  await start(page, 'admin');
  await expect(page.locator('#dashboardJobs')).toBeHidden();
  await expect(page.locator('#dashboardTeam')).toBeHidden();
  await page.locator('#dashboardAdmin').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
  await page.locator('input[name=name]').fill('New California Restoration');
  await page.locator('input[name=owner_email]').fill('new-owner@example.invalid');
  // A short password typed in login mode cannot block the invitation, even after a policy refresh.
  const signin = page.locator('select[name=owner_signin]');
  await signin.selectOption('password');
  await page.locator('input[name=password]').fill('short');
  await signin.selectOption('invite');
  await page.evaluate(() => WorkspaceUI.policy());
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

// Temporary until PR 2 stores ADR's logo in its profile: only 'adr' falls back to the bundled logo.
test('ADR without a profile logo shows the bundled logo until a saved logo replaces it', async ({
  page,
}) => {
  await start(page, 'owner');
  await expect(page.locator('.masthead .brand img')).toHaveAttribute('src', '/brand/adr-logo.jpg');
  await expect(page.locator('.masthead .brand img')).toBeVisible();
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  for (const doc of ['#doc-proposal', '#doc-defense'])
    await expect(page.locator(doc + ' .document-letterhead img')).toHaveAttribute(
      'src',
      '/brand/adr-logo.jpg',
    );
  await navigate(page, 'dashboardProfile');
  await page.locator('input[name=logo]').setInputFiles('public/brand/adr-logo.jpg');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.locator('#message')).toContainText('Company details saved');
  await expect(page.locator('.masthead .brand img')).toHaveAttribute('src', /^data:image\/jpeg/);
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  for (const doc of ['#doc-proposal', '#doc-defense'])
    await expect(page.locator(doc + ' .document-letterhead img')).toHaveAttribute(
      'src',
      /^data:image\/jpeg/,
    );
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
  await expect(page.locator('.masthead .brand img')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/company-brand/);
  await expect(page.locator('#workspaceAccountDetails')).toContainText('Other Restoration');
  await expect(page.locator('#footerText')).toHaveText(
    'Other Restoration · Private company workspaces',
  );
  await expect(page.locator('footer .powered')).toHaveText('Powered by DryScope');
  await page.locator('#helpButton').click();
  await expect(page.locator('#helpContact')).toContainText('Other Restoration');
  for (const selector of ['#accountMenu', '#helpDialog', 'footer'])
    await expect(page.locator(selector)).not.toContainText(
      /Alert Disaster|950983|Matthew Myers|661|ADR/,
    );
  await page.locator('#closeHelp').click();

  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('Other company synthetic property');
  await page.locator('#yearBuilt').fill('2000');
  await expect(page.locator('#coordAddress')).toHaveValue('Other company synthetic property');
  await page.locator('#jobMenu > summary').click();
  await page.locator('#moreCoordination').click();
  await page.locator('#coordNotes').fill('Office note retains the measured property address');
  await page.locator('#coordName').fill('Synthetic Homeowner');
  await page.locator('#saveCoordination').click();
  await expect(page.locator('#coordinationStatus')).toHaveText('Coordination saved.');
  await expect(page.locator('#address')).toHaveValue('Other company synthetic property');
  await page.locator('[data-room-key=finished_sf]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#doc-proposal > h2')).toHaveText(
    'Other Restoration · Official proposal',
  );
  await expect(page.locator('#proposalBody')).toContainText('Other Estimator · CSLB #123456');
  await expect(page.locator('#proposalBody p').first()).toHaveText('Customer: Synthetic Homeowner');
  await expect(page.locator('#claimParty')).toHaveText(
    'Customer: Synthetic HomeownerProperty: Other company synthetic property',
  );
  await expect(page.locator('#defenseBody')).toContainText('Customer: Synthetic Homeowner');
  // The defense letter carries the proposal's letterhead from the same company profile.
  await expect(page.locator('.document-letterhead')).toHaveCount(2);
  for (const doc of ['#doc-proposal', '#doc-defense']) {
    await expect(page.locator(doc + ' .document-letterhead img')).toBeHidden();
    await expect(page.locator(doc + ' .document-letterhead p')).toContainText('CSLB #123456');
  }
  await expect(page.locator('#defenseBody')).not.toContainText('Matthew Myers');
  await expect(page.locator('body')).not.toContainText(/Alert Disaster|950983|Matthew Myers|661/);
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
  await expect(page.locator('#googleSignIn')).toBeVisible();
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
  await page.getByRole('button', { name: 'Send reset link' }).click();
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

// Forgot password sits just above Sign in with Google, so a stray tap must not send a reset email.
test('Forgot password asks before it sends a reset email', async ({ page, browserName }) => {
  const email = 'a-long-staff-address.synthetic@restoration-company.example.invalid';
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  const forgot = page.getByRole('button', { name: 'Forgot password' }),
    dialog = page.getByRole('dialog', { name: 'Reset password?' }),
    emails = () => page.evaluate(() => window.__testEmails);
  // An empty Email field still only shows the browser's validation message.
  await forgot.click();
  await expect(dialog).toBeHidden();
  expect(await page.locator('#authEmail').evaluate((input) => input.validity.valueMissing)).toBe(
    true,
  );
  await page.locator('#authEmail').fill(email);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await forgot.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Send a password reset link to ' + email + '?');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (browserName === 'chromium')
      await page.screenshot({ path: test.info().outputPath('reset-confirm-' + width + '.png') });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  }
  await forgot.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await emails()).toEqual([]);
  await expect(page.locator('#authStatus')).toBeHidden();
  await forgot.click();
  await dialog.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.locator('#authStatus')).toHaveText(
    'If an account uses ' + email + ', a password reset email is on its way.',
  );
  expect(await emails()).toEqual([{ type: 'reset', email }]);
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
      [
        '/api/admin/companies/' + target + '/owner-login',
        'POST',
        {
          email: 'forged-owner@example.invalid',
          password: 'synthetic-temporary-0001',
          expected_version: 1,
        },
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

// A new release shows the compact "Update ready" banner; it must never hide the first action.
async function showUpdateBanner(page) {
  await page.evaluate(() => (document.getElementById('updateBanner').hidden = false));
  await expect(page.locator('#updateBanner')).toBeVisible();
  await expect(page.locator('#updateBanner .update-text')).toHaveText('Update ready.');
}
// Both the button and the "Update ready." wording must be on screen and uncovered, so the
// prompt reads as an app update rather than a job save.
async function bannerUsable(page) {
  return page.locator('#updateBanner').evaluate((banner) =>
    ['.update-text', 'button'].every((selector) => {
      const el = banner.querySelector(selector),
        r = el.getBoundingClientRect(),
        top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (
        r.width > 8 &&
        r.height > 8 &&
        r.top >= 0 &&
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        (top === el || el.contains(top))
      );
    }),
  );
}
// The company name must stay fully readable beside the banner and must not run under it.
async function brandReadable(page) {
  return page.locator('.masthead .brand strong').evaluate((el) => {
    const r = el.getBoundingClientRect(),
      banner = document.getElementById('updateBanner').getBoundingClientRect();
    return {
      unclipped: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
      clear:
        r.right <= banner.left ||
        r.left >= banner.right ||
        r.bottom <= banner.top ||
        r.top >= banner.bottom,
    };
  });
}
for (const mode of [
  'owner',
  'estimator',
  'legacy owner-only',
  'other company',
  'other company with logo',
])
  for (const width of [320, 390])
    test(
      mode + ' phone at ' + width + '×844 keeps Start walkthrough clear of the Update ready banner',
      async ({ page, request, browserName }) => {
        await page.setViewportSize({ width, height: 844 });
        if (mode === 'legacy owner-only') {
          await request.post('/__test/workspaces', { data: { enabled: false } });
          await page.goto('/');
          await expect(page.locator('#saveStatus')).toHaveText('Saved');
        } else if (mode.startsWith('other company')) {
          await start(page, 'other');
          await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
          if (mode.endsWith('with logo'))
            await page.evaluate(() => {
              const logo = document.querySelector('.masthead .brand img');
              logo.src = '/brand/adr-logo.jpg';
              logo.hidden = false;
            });
          await page.getByRole('button', { name: 'New job', exact: true }).click();
        } else {
          await start(page, mode);
          await navigate(page, 'dashboardJobs');
          await page.getByRole('button', { name: /Assigned bathroom/ }).click();
        }
        await expect(page.locator('#address')).toBeEnabled();
        await page.locator('.task-nav [data-task="walkthrough"]').click();
        await expect(page.locator('#startWalk')).toBeVisible();
        const startTop = () =>
          page.locator('#startWalk').evaluate((el) => el.getBoundingClientRect().top);
        const before = await startTop();
        await showUpdateBanner(page);
        // The banner shares the navy job bar row, so it must not push Start walkthrough down.
        expect(Math.abs((await startTop()) - before)).toBeLessThan(1);
        if (browserName === 'chromium')
          await page.screenshot({
            path: test
              .info()
              .outputPath('update-banner-' + mode.replace(/\W+/g, '-') + '-' + width + '.png'),
          });
        expect(await firstScreen(page, '#startWalk')).toEqual({
          scrolled: 0,
          inside: true,
          hit: true,
        });
        expect(await bannerUsable(page)).toBe(true);
        // With a job open the company strip folds away; the dashboard keeps the brand.
        await expect(page.locator('.masthead')).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
      },
    );

test('long company name keeps its phone rendering when the Update ready banner shows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await start(page, 'other');
  const name = page.locator('.masthead .brand strong');
  await page.evaluate(() => {
    document.querySelector('.masthead .brand strong').textContent =
      'Central Valley Water Damage & Mold Remediation Specialists';
  });
  const render = () =>
    name.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        style = getComputedStyle(el);
      return {
        box: [r.left, r.top, r.width, r.height],
        overflow: style.overflow,
        clamp: style.webkitLineClamp,
      };
    });
  const before = await render();
  expect(before).toMatchObject({ overflow: 'visible', clamp: 'none' });
  // The banner lives in the navy bar above, so the company strip never reflows for it.
  await page.evaluate(() => (document.getElementById('updateBanner').hidden = false));
  expect(await render()).toEqual(before);
  expect(await brandReadable(page)).toEqual({ unclipped: true, clear: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.evaluate(() => (document.getElementById('updateBanner').hidden = true));
  expect(await render()).toEqual(before);
});

test('signed-out phone header at 320×844 fits the Update ready banner without overlap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#googleSignIn')).toBeVisible();
  await showUpdateBanner(page);
  await expect(page.locator('.lockup img')).toBeVisible();
  await expect(page.locator('.lockup img')).toHaveAttribute(
    'src',
    '/brand/dryscope-wordmark-white.svg',
  );
  const boxes = await page.evaluate(() =>
    ['.lockup', '#updateBanner', '#accountMenu'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [r.left, r.right];
    }),
  );
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1]);
  expect(boxes[0][1] - boxes[0][0]).toBeGreaterThan(0);
  expect(boxes[2][1]).toBeLessThanOrEqual(320);
  expect(await bannerUsable(page)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('company without a logo keeps its name visible between phone and tablet widths', async ({
  page,
}) => {
  await start(page, 'other');
  for (const width of [641, 670, 700]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.masthead .brand img')).toBeHidden();
    await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
    await expect(page.locator('.masthead .brand strong')).toBeVisible();
  }
});

// Superadmin-created owner logins: the superadmin emails the temporary password; the owner replaces it.
const TEMPORARY = 'synthetic-temporary-0001',
  CHOSEN = 'synthetic-chosen-0002';
async function fitsWidth(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'no horizontal scroll',
  ).toBe(true);
}
for (const width of [320, 390])
  test(`superadmin creates and replaces an owner login with a temporary password at ${width}×844`, async ({
    page,
    context,
    browserName,
  }) => {
    if (browserName === 'chromium')
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 844 });
    const bodies = [];
    page.on('response', async (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/'))
        bodies.push(await response.text().catch(() => ''));
    });
    await start(page, 'admin');
    await navigate(page, 'dashboardAdmin');
    await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
    const form = page.locator('#dashboardContent form').first(),
      password = form.locator('input[name=password]');
    await expect(password).toBeHidden();
    await form.locator('input[name=name]').fill('Direct Login Restoration');
    await form.locator('select[name=owner_signin]').selectOption('password');
    await expect(password).toBeVisible();
    const create = form.getByRole('button', { name: 'Create company & owner login' });
    await expect(create).toBeVisible();
    await expect(form.getByRole('button', { name: 'Generate' })).toHaveCount(0);
    const chosen = 'synthetic-typed-first-01';
    await password.fill(chosen);
    // Typed masked; Show and Hide switch it without changing what was typed.
    await expect(password).toHaveAttribute('type', 'password');
    const show = form.getByRole('button', { name: 'Show' });
    await expect(show).toHaveAttribute('aria-pressed', 'false');
    await show.click();
    await expect(password).toHaveAttribute('type', 'text');
    const hide = form.getByRole('button', { name: 'Hide' });
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    await hide.click();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveValue(chosen);
    await fitsWidth(page);
    // Server refusals show their own message and create nothing.
    for (const [email, message] of [
      [
        'test-owner-ws-google@example.invalid',
        'This email signs in with Google. Send an owner invitation instead.',
      ],
      [
        'test-owner-ws-estimator@example.invalid',
        'This email already has company access. Choose a different email.',
      ],
    ]) {
      await form.locator('input[name=owner_email]').fill(email);
      await create.click();
      await expect(page.locator('#message')).toHaveText(message);
      await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
    }
    const email = 'test-owner-ws-direct@example.invalid';
    await form.locator('input[name=owner_email]').fill(email);
    await create.click();
    await expect(page.locator('#dashboardHeading')).toHaveText('Direct Login Restoration');
    await expect(page.locator('#message')).toHaveText('Company created with an owner login.');
    const card = page.locator('.login-created');
    await expect(card).toContainText('Owner login created');
    await expect(card).toContainText('Email: ' + email);
    await expect(card.locator('code')).toHaveText(chosen);
    await card.getByRole('button', { name: 'Copy password' }).click();
    if (browserName === 'chromium') {
      await expect(page.locator('#message')).toHaveText('Password copied.');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(chosen);
    } else await expect(page.locator('#message')).toContainText(/Password copied|copy it yourself/);
    await fitsWidth(page);
    // Manage company: replace that owner with a second login.
    const replace = page.locator('form', { hasText: 'Create login with temporary password' });
    await expect(replace).toContainText('Replaces the current owner now');
    await replace.locator('input[name=email]').fill('test-owner-ws-second@example.invalid');
    const second = 'synthetic-typed-second-02';
    await expect(replace.locator('input[name=password]')).toHaveAttribute('type', 'password');
    await replace.locator('input[name=password]').fill(second);
    await replace.getByRole('button', { name: 'Create login' }).click();
    await expect(page.locator('#message')).toHaveText('Owner login created.');
    await expect(page.locator('.login-created code')).toHaveText(second);
    await fitsWidth(page);
    // The page is the only place the passwords appear; no response carries them back.
    expect(bodies.length).toBeGreaterThan(3);
    for (const body of bodies) {
      expect(body).not.toContain(chosen);
      expect(body).not.toContain(second);
    }
  });

async function signInWithTemporary(page, email, before) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('synthetic-uid'))
      sessionStorage.setItem('synthetic-signed-out', '1');
  });
  if (before) await page.addInitScript(before);
  await page.goto('/');
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(TEMPORARY);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
for (const width of [320, 390])
  test(`temporary password allows only the set-password step until replaced at ${width}×844`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = 'test-owner-ws-direct@example.invalid';
    const created = await call(
      page,
      '/api/admin/companies/other/owner-login',
      'POST',
      { email, password: TEMPORARY, expected_version: 1 },
      'admin',
    );
    expect(created.status()).toBe(200);
    const authenticated = [];
    page.on('request', (request) => {
      if (request.headers().authorization) authenticated.push(new URL(request.url()).pathname);
    });
    await signInWithTemporary(page, email);
    const step = page.locator('#setPassword');
    await expect(step).toBeVisible();
    await expect(step).toContainText('Set your own password');
    await expect(page.locator('#setPasswordAddress')).toHaveText(email);
    await expect(page.locator('#emailAuthForm')).toBeHidden();
    await expect(page.locator('#workspaceDashboard')).toBeHidden();
    await expect(page.locator('#address')).toBeDisabled();
    for (const id of ['newPassword', 'confirmPassword', 'savePassword', 'setPasswordSignOut']) {
      const box = await page.locator('#' + id).boundingBox();
      expect(box.x >= 0 && box.x + box.width <= width, id + ' fits').toBe(true);
    }
    await fitsWidth(page);
    // A reload keeps the step; nothing calls the session, job or workspace routes.
    await page.reload();
    await expect(step).toBeVisible();
    expect(authenticated).toEqual([]);
    await page.locator('#newPassword').fill(CHOSEN);
    await page.locator('#confirmPassword').fill(CHOSEN + 'x');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.locator('#authStatus')).toHaveText('The two passwords do not match.');
    expect(authenticated).toEqual([]);
    await page.locator('#confirmPassword').fill(CHOSEN);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(page.locator('#authPanel')).toBeHidden();
    await expect(page.locator('#dashboardTeam')).toBeAttached();
    expect(authenticated[0]).toBe('/api/account/password');
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(step).toBeHidden();
    // The temporary password no longer signs in; the chosen one does.
    expect(
      (
        await page.request.post('/__test/auth/sign-in', { data: { email, password: TEMPORARY } })
      ).status(),
    ).toBe(401);
  });

test('a token without the claim still lands on the set-password step from the server gate', async ({
  page,
}) => {
  const email = 'test-owner-ws-direct@example.invalid';
  await call(
    page,
    '/api/admin/companies/other/owner-login',
    'POST',
    { email, password: TEMPORARY, expected_version: 1 },
    'admin',
  );
  await signInWithTemporary(page, email, () => (window.__testStaleClaims = true));
  await expect(page.locator('#setPassword')).toBeVisible();
  await expect(page.locator('#workspaceDashboard')).toBeHidden();
  // Forgot password still works from the sign-in page.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await page.locator('#authEmail').fill(email);
  await page.getByRole('button', { name: 'Forgot password' }).click();
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.locator('#authStatus')).toContainText('a password reset email is on its way');
  expect(await page.evaluate(() => window.__testEmails)).toEqual([{ type: 'reset', email }]);
});
