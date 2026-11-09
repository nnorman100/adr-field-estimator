import { defineConfig } from '@playwright/test';

const port = 3100;

// Smoke test against the local dev server, in the two engines iPhones use for testing
// (Chromium for the Android/desktop baseline, WebKit for iOS Safari 16.4+).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${port}/api/health`,
    env: { APP_ENV: 'local' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
