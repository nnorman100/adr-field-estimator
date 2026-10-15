const { chromium } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M4ZVRFP70BTNDBS6163F2H22/node_modules/@playwright/test');
(async () => {
  const b = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const B = 'https://localhost:8799';
  for (const role of ['estimator', 'office', 'other', 'admin']) {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await ctx.request.post(B + '/__test/workspaces', { data: { enabled: true } });
    const p = await ctx.newPage();
    await p.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), 'test-owner-ws-' + role);
    await p.goto(B + '/');
    await p.locator('#workspaceDashboard').waitFor();
    await p.waitForTimeout(1200);
    const n = await p.getByRole('button', { name: 'Manage companies' }).count();
    const s = await p.getByRole('button', { name: 'Open read-only support view' }).count();
    console.log(role, 'heading=', await p.locator('#dashboardHeading').textContent(), 'adminPanelVisible=', await p.locator('#dashboardAdmin').isVisible(), 'manageCompaniesButtons=', n, 'supportViewButtons=', s);
    await p.screenshot({ path: '/home/nnorm/.no-mistakes/evidence/01M4ZVRFP70BTNDBS6163F2H22/dashboard-' + role + '.png', fullPage: false });
    await ctx.close();
  }
  await b.close();
})();
