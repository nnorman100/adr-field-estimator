import { defineConfig } from '@playwright/test';
import { AUTH_EMULATOR_HOST, E2E_PROJECT } from './tests/e2e/sign-in/emulator';
import { FIXTURE_PATH } from './tests/e2e/sign-in/seed';

const port = 3100;

// Same pinned CLI as tests/emu/run.ts. The Auth emulator needs no Java, unlike Firestore's.
const FIREBASE_TOOLS = 'firebase-tools@15.31.0';

// Browser tests against a local production build, in the two engines iPhones use for testing
// (Chromium for the Android/desktop baseline, WebKit for iOS Safari 16.4+). The sign-in screens
// (tests/e2e/sign-in.spec.ts) sign in to the Firebase Auth emulator, under a demo- project only;
// the server checks those sign-ins as it would in production, with a local file standing in
// for the database (LOCAL_SIGN_IN_FIXTURE, written by the global setup once both servers answer).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/e2e/sign-in/global-setup.ts',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: [
    {
      command: `npx --yes ${FIREBASE_TOOLS} emulators:start --only auth --project ${E2E_PROJECT} --config firebase.json`,
      url: `http://${AUTH_EMULATOR_HOST}/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // A production build and server, not `next dev`: the dev server stopped listening in the
      // middle of a CI run (2026-11-11), and every later test got ECONNREFUSED.
      command: 'npm run build && npm run start',
      url: `http://localhost:${port}/api/health`,
      env: {
        APP_ENV: 'local',
        GOOGLE_CLOUD_PROJECT: E2E_PROJECT,
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
        LOCAL_SIGN_IN_FIXTURE: FIXTURE_PATH,
      },
      // A server started by hand would lack the emulator settings above.
      reuseExistingServer: false,
      // Long enough for the build, which runs before the server starts listening.
      timeout: 300_000,
    },
  ],
});
