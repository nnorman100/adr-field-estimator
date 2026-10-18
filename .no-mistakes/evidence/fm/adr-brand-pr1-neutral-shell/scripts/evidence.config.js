const { defineConfig } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56FCN0WGK5FYX4CQP1MTN3E/node_modules/@playwright/test');
module.exports = defineConfig({
  testDir: __dirname, testMatch: 'brand.evidence.js', workers: 1, timeout: 90000,
  outputDir: __dirname + '/../pw-output',
  use: { baseURL: 'https://localhost:8765', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 },
    browserName: 'chromium', launchOptions: { args: ['--ignore-certificate-errors'] } },
  webServer: { command: 'python tests/browser_server.py', cwd: '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56FCN0WGK5FYX4CQP1MTN3E', url: 'https://localhost:8765/api/health',
    ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30000 },
});
