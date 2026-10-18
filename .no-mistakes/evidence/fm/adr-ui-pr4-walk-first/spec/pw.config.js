const { defineConfig } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58A3J8XFY00TDSWMDSC3X2Y/node_modules/@playwright/test');
module.exports = defineConfig({
  testDir: '/home/nnorm/.no-mistakes/evidence/01M58A3J8XFY00TDSWMDSC3X2Y/spec', testMatch: /.*\.evidence\.js/, workers: 1, timeout: 90000,
  outputDir: '/home/nnorm/.no-mistakes/evidence/01M58A3J8XFY00TDSWMDSC3X2Y/evidence-run',
  use: { baseURL: 'https://localhost:8765', ignoreHTTPSErrors: true, browserName: 'chromium',
    launchOptions: { args: ['--ignore-certificate-errors'] } },
  webServer: { command: 'cd /home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58A3J8XFY00TDSWMDSC3X2Y && /home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58A3J8XFY00TDSWMDSC3X2Y/.venv/bin/python tests/browser_server.py', url: 'https://localhost:8765/api/health',
    ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30000 },
});
