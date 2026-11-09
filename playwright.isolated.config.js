const fs = require('node:fs');
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { canonicalPath, isWithin } = require('./scripts/artifact-paths');

const portValue = process.env.ADR_BROWSER_PORT ?? '8876';
const port = Number(portValue);
if (!/^[0-9]{1,5}$/.test(portValue) || port < 1 || port > 65535 || port === 8765) {
  throw new Error('ADR_BROWSER_PORT must be an integer from 1 to 65535 other than 8765.');
}

const artifactsValue = process.env.ADR_BROWSER_ARTIFACTS;
if (!artifactsValue || !path.isAbsolute(artifactsValue)) {
  throw new Error(
    'ADR_BROWSER_ARTIFACTS must explicitly name an absolute directory outside the repository.',
  );
}

const repository = fs.realpathSync(__dirname);
const artifacts = canonicalPath(artifactsValue);
const outputDir = canonicalPath(path.join(artifacts, 'test-results'));
const reportDir = canonicalPath(path.join(artifacts, 'playwright-report'));
if ([artifacts, outputDir, reportDir].some((directory) => isWithin(repository, directory))) {
  throw new Error(
    'ADR_BROWSER_ARTIFACTS and its output/report directories must be outside the repository, including symlink targets.',
  );
}
if ([outputDir, reportDir].some((directory) => isWithin(directory, repository))) {
  throw new Error('Browser output/report directories must not contain the repository.');
}

const baseURL = `https://localhost:${port}`;
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'browser'),
  outputDir,
  reporter: [['line'], ['html', { outputFolder: reportDir, open: 'never' }]],
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', launchOptions: { args: ['--ignore-certificate-errors'] } },
    },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'python -B tests/browser_server.py',
    cwd: __dirname,
    env: {
      ADR_BROWSER_PORT: String(port),
      ADR_BROWSER_ARTIFACTS: artifacts,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    url: `${baseURL}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
