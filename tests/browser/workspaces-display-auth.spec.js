const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
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
          await page.goto('/app');
          await expect(page.locator('#saveStatus')).toHaveText('Saved');
        } else if (mode.startsWith('other company')) {
          await start(page, 'other');
          await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
          if (mode.endsWith('with logo'))
            await page.evaluate(() => {
              const logo = document.querySelector('.masthead .brand img');
              logo.src = '/icon-192.png';
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
  await page.goto('/app');
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
    // Another tab's sign-in that this page has not applied yet sends nothing.
    const sent = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/owner-login')) sent.push(request.url());
    });
    await page.evaluate(() => {
      window.appliedUser = auth.currentUser;
      auth.currentUser = { uid: 'switched-account' };
    });
    await replace.getByRole('button', { name: 'Create login' }).click();
    await expect(page.locator('#message')).toHaveText(
      'Your sign-in changed. Reload and try again.',
    );
    expect(sent).toEqual([]);
    await page.evaluate(() => {
      auth.currentUser = window.appliedUser;
    });
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
  await page.goto('/app');
  await expect(page.locator('#emailAuthForm')).toBeVisible();
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(TEMPORARY);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('owner login waits for a pending sign-in to finish applying, even for the same account', async ({
  page,
}) => {
  await start(page, 'admin');
  await navigate(page, 'dashboardAdmin');
  await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
  const sent = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/admin/companies'))
      sent.push(request.url());
  });
  // A to B and back to A: the latest callback for A is still applying.
  await page.evaluate(() => {
    const user = auth.currentUser;
    user.getIdTokenResult = () =>
      new Promise((resolve) => {
        window.finishApplying = () => {
          delete user.getIdTokenResult;
          resolve({ claims: {} });
        };
      });
    applyUser(user);
  });
  const form = page.locator('#dashboardContent form').first();
  await form.locator('input[name=name]').fill('Pending Sign-in Restoration');
  await form.locator('input[name=owner_email]').fill('test-owner-ws-pending@example.invalid');
  await form.locator('select[name=owner_signin]').selectOption('password');
  await form.locator('input[name=password]').fill(TEMPORARY);
  await form.getByRole('button', { name: 'Create company & owner login' }).click();
  await expect(page.locator('#message')).toHaveText('Your sign-in changed. Reload and try again.');
  expect(sent).toEqual([]);
  await page.evaluate(() => window.finishApplying());
  await expect(page.locator('#workspaceNav')).toBeVisible();
});
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

test.describe('invitation list clearing', () => {
  // WebKit service workers can bypass page.route and send the mocked failure to the server.
  test.use({ serviceWorkers: 'block' });

  test('owner clears cancelled and expired invitations and leaves pending ones', async ({
    page,
  }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const pending = await call(page, '/api/companies/adr/invitations', 'POST', {
      email: 'stay-pending@example.invalid',
      role: 'estimator',
    });
    const cancelled = await call(page, '/api/companies/adr/invitations', 'POST', {
      email: 'cancelled-staff@example.invalid',
      role: 'office',
    });
    const expired = await call(page, '/api/companies/adr/invitations', 'POST', {
      email: 'expired-staff@example.invalid',
      role: 'office',
    });
    expect(pending.status()).toBe(200);
    const cancelledId = (await cancelled.json()).invitation_id;
    const expiredId = (await expired.json()).invitation_id;
    expect(
      (
        await call(page, '/api/companies/adr/invitations/' + cancelledId + '/cancel', 'POST')
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.post('/__test/expire-invitations', {
          data: { invitation_id: expiredId },
        })
      ).status(),
    ).toBe(200);
    await start(page, 'owner');
    await navigate(page, 'dashboardTeam');
    const content = page.locator('#dashboardContent');
    const card = (email) =>
      content.locator('.dashboard-card').filter({
        has: page.getByRole('heading', { name: email, exact: true }),
      });
    const pendingCard = card('stay-pending@example.invalid');
    const cancelledCard = card('cancelled-staff@example.invalid');
    const expiredCard = card('expired-staff@example.invalid');
    await expect(pendingCard).toBeVisible();
    await expect(cancelledCard).toContainText('cancelled');
    await expect(expiredCard).toBeVisible();
    await expect(pendingCard.getByRole('button', { name: 'Resend invitation' })).toBeVisible();
    const clear = page.getByRole('button', { name: 'Clear cancelled and expired', exact: true });
    await expect(clear).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await fitsWidth(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await clear.click();
    await expect(content).toContainText('Pending invitations stay. Nothing is deleted.');
    await page.getByRole('button', { name: 'Keep them', exact: true }).click();
    await expect(cancelledCard).toBeVisible();
    await expect(clear).toBeVisible();
    await page.context().setOffline(true);
    const offlineClear = page.getByRole('button', {
      name: 'Clear cancelled and expired (needs a connection)',
    });
    await expect(offlineClear).toBeDisabled();
    await fitsWidth(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await fitsWidth(page);
    await page.context().setOffline(false);
    await expect(clear).toBeEnabled();
    await page.route('**/api/companies/adr/invitations/clear', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'The invitation list could not be cleared.' }),
      }),
    );
    await clear.click();
    await page.getByRole('button', { name: 'Confirm clear', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('The invitation list could not be cleared.');
    await expect(cancelledCard).toBeVisible();
    await expect(expiredCard).toBeVisible();
    await page.unroute('**/api/companies/adr/invitations/clear');
    await page.getByRole('button', { name: 'Confirm clear', exact: true }).click();
    await expect(page.locator('#message')).toHaveText(
      'Cleared 2 cancelled and expired invitations.',
    );
    await expect(cancelledCard).toHaveCount(0);
    await expect(expiredCard).toHaveCount(0);
    await expect(pendingCard).toBeVisible();
    await expect(pendingCard.getByRole('button', { name: 'Cancel invitation' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Clear cancelled and expired/ })).toHaveCount(0);
    const hidden = await call(page, '/api/companies/adr/invitations');
    const emails = (await hidden.json()).invitations.map((row) => row.email);
    expect(emails).toContain('stay-pending@example.invalid');
    expect(emails).not.toContain('cancelled-staff@example.invalid');
    expect(emails).not.toContain('expired-staff@example.invalid');
    const kept = await call(
      page,
      '/api/companies/adr/invitations/' + cancelledId + '/cancel',
      'POST',
    );
    expect(kept.status()).toBe(409);
    expect(errors).toEqual([]);
  });
});
