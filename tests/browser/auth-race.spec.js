const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
async function gateFirstSession(page) {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    let first = true;
    const gate = new Promise((resolve) => {
      window.__releaseSession = resolve;
    });
    window.fetch = async function (input, options) {
      if (input === '/api/session' && first) {
        first = false;
        window.__sessionStarted = true;
        await gate;
        const response = await fetch.call(this, input, options);
        window.__sessionReturned = true;
        return response;
      }
      return fetch.call(this, input, options);
    };
  });
  return async () => {
    await page.evaluate(() => window.__releaseSession());
    await page.waitForFunction(() => window.__sessionReturned);
    await page.waitForTimeout(500);
  };
}

test('signing out while the session request is delayed ends signed out with no stale session', async ({
  page,
}) => {
  const release = await gateFirstSession(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__sessionStarted);
  await page.evaluate(() => auth.signOut());
  await expect(page.locator('#googleSignIn')).toBeVisible();
  await release();
  expect(
    await page.evaluate(() => ({ user: state.user, session: state.session, draft: state.draft })),
  ).toEqual({ user: null, session: null, draft: null });
  await expect(page.locator('#googleSignIn')).toBeVisible();
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();
  await expect(page.locator('#workspaceNav')).toBeHidden();
  await expect(page.locator('#message')).toBeHidden();
});

test.describe('company workspaces', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
  test('switching accounts while the first session request is delayed opens only the second account', async ({
    page,
  }) => {
    const release = await gateFirstSession(page);
    await page.addInitScript((value) => {
      if (!sessionStorage.getItem('synthetic-uid')) sessionStorage.setItem('synthetic-uid', value);
    }, uid('owner'));
    await page.goto('/');
    await page.waitForFunction(() => window.__sessionStarted);
    await page.evaluate(async (value) => {
      sessionStorage.setItem('synthetic-uid', value);
      await window.__testAuthChanged({
        uid: value,
        email: value + '@example.invalid',
        getIdToken: async () => value,
      });
    }, uid('other'));
    await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');
    const session = await page.evaluate(
      async () =>
        await (
          await fetch('/api/session', { headers: { Authorization: 'Bearer ' + state.user.uid } })
        ).json(),
    );
    await release();
    expect(await page.evaluate(() => [state.user.uid, state.session])).toEqual([
      uid('other'),
      session,
    ]);
    await expect(page.locator('#message')).toBeHidden();
    await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');
    await expect(page.locator('#workspaceNav')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
  });
  test('a sign-out auth callback clears company shell identity without reloading', async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      uid('owner'),
    );
    await page.goto('/');
    await expect(page.locator('#dashboardHeading')).toHaveText('Alert Disaster Restoration');
    // Configure a real synthetic profile logo so the reset must clear both its image and its text.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 20;
      canvas.getContext('2d').fillRect(0, 0, 20, 20);
      const company = state.session.company;
      const response = await fetch('/api/companies/adr', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + state.user.uid,
          'Content-Type': 'application/json',
          'X-ADR-Workspace-Protocol': '1',
        },
        body: JSON.stringify({
          expected_version: company.version,
          profile: { ...company.profile, logo_data_url: canvas.toDataURL('image/png') },
        }),
      });
      if (!response.ok) throw Error('Synthetic company profile update failed');
      await WorkspaceUI.refresh();
      window.noReloadMarker = true;
    });
    await expect(page.locator('.masthead .brand img')).toBeVisible();
    await expect(page.locator('.masthead .brand')).toHaveAttribute(
      'aria-label',
      'Alert Disaster Restoration',
    );
    await expect(page.locator('#workspaceAccountDetails')).toContainText('950983');
    // This invokes the SDK's shared auth callback, as a sign-out in another tab does, without
    // the local Account handler's location.reload().
    await page.evaluate(() => auth.signOut());
    await expect(page.locator('#authPanel')).toBeVisible();
    expect(await page.evaluate(() => window.noReloadMarker)).toBe(true);
    await expect(page.locator('body')).not.toHaveClass(/company-brand/);
    await expect(page.locator('.masthead .brand strong')).toHaveText('DryScope');
    await expect(page.locator('.masthead .brand')).toHaveAttribute('aria-label', 'DryScope');
    // Signed out there is no company strip; DryScope lives in the navy bar.
    await expect(page.locator('.masthead')).toBeHidden();
    await expect(page.locator('.product-bar .lockup img')).toBeVisible();
    await expect(page.locator('.masthead .brand img')).toHaveAttribute('alt', 'DryScope');
    await expect(page.locator('.masthead .brand img')).toHaveAttribute(
      'src',
      '/brand/dryscope-wordmark.svg',
    );
    await expect(page.locator('#workspaceAccountDetails')).toBeEmpty();
    await expect(page.locator('#footerText')).toHaveText('DryScope · Private field inspections');
    // Signed out the bar offers only Sign in; the help contact line is still reset for the next account.
    await expect(page.locator('#helpButton')).toBeHidden();
    await expect(page.locator('#headerSignIn')).toBeVisible();
    await expect(page.locator('#helpContact')).toHaveText(
      'For company access, ask your company owner.',
    );
    await expect(page.locator('body')).not.toContainText(/Alert Disaster|950983|661/);
  });
});
