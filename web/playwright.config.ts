import { defineConfig } from '@playwright/test';
import { AUTH_EMULATOR_HOST, E2E_PROJECT } from './tests/e2e/sign-in/emulator';
import { FIELD_DATABASE, FIRESTORE_EMULATOR_HOST } from './tests/e2e/offline/emulators';
import { SERVER_LOG, SERVER_LOG_DIR } from './tests/e2e/server-log';
import { FIXTURE_PATH } from './tests/e2e/sign-in/seed';
import { JOBS_BASE_URL, STORAGE_CONFIG, STORAGE_EMULATOR_HOST } from './tests/e2e/jobs/backend';

const port = 3100;

// Same pinned CLI as tests/emu/run.ts. The Firestore emulator needs Java 21, as test:emu does.
const FIREBASE_TOOLS = 'firebase-tools@15.31.0';

// Browser tests against a local production build, in the two engines iPhones use for testing
// (Chromium for the Android/desktop baseline, WebKit for iOS Safari 16.4+). The sign-in screens
// (tests/e2e/sign-in.spec.ts) sign in to the Firebase Auth emulator, under a demo- project only;
// the server checks those sign-ins as it would in production, with a local file standing in
// for the database (LOCAL_SIGN_IN_FIXTURE, written by the global setup once both servers answer).
// The Firestore emulator runs beside the Auth emulator for the offline tests (tests/e2e/offline),
// which put each test behind a switchable network of its own (lane.ts) to cut and restore.
// The job screens (tests/e2e/jobs.spec.ts) use a second server built from the same build, with a
// throwaway PostgreSQL behind it in place of the local file (tests/e2e/jobs/server.ts), and the
// Storage emulator in place of the evidence bucket, under its own config so no deploy can see it.
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
      command: `npx --yes ${FIREBASE_TOOLS} emulators:start --only auth,firestore --project ${E2E_PROJECT} --config firebase.json`,
      // Firestore's emulator is the slower of the two to start, so its answer means both are up.
      url: `http://${FIRESTORE_EMULATOR_HOST}/`,
      reuseExistingServer: false,
      timeout: 180_000,
      // Playwright's default is to kill the CLI outright, which leaves the Firestore emulator's Java
      // process holding its port. The CLI stops it cleanly on SIGINT.
      gracefulShutdown: { signal: 'SIGINT', timeout: 15_000 },
    },
    {
      // A production build and server, not `next dev`: the dev server stopped listening in the
      // middle of a CI run (2026-11-11), and every later test got ECONNREFUSED. Its stdout, where
      // the structured log lines go, is kept in a file the tests read (tests/e2e/server-log.ts).
      command: `npm run build && mkdir -p ${JSON.stringify(SERVER_LOG_DIR)} && npm run start > ${JSON.stringify(SERVER_LOG)}`,
      url: `http://localhost:${port}/api/health`,
      env: {
        APP_ENV: 'local',
        GOOGLE_CLOUD_PROJECT: E2E_PROJECT,
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
        // The field database, for the screens that read a draft in the browser (Finish and review,
        // tests/e2e/finish.spec.ts): the browser gets the emulator's address from the server.
        FIRESTORE_DATABASE_ID: FIELD_DATABASE,
        FIRESTORE_EMULATOR_HOST,
        LOCAL_SIGN_IN_FIXTURE: FIXTURE_PATH,
      },
      // A server started by hand would lack the emulator settings above.
      reuseExistingServer: false,
      // Long enough for the build, which runs before the server starts listening.
      timeout: 300_000,
    },
    {
      command: `npx --yes ${FIREBASE_TOOLS} emulators:start --only storage --project ${E2E_PROJECT} --config ${STORAGE_CONFIG}`,
      // Its root answers 501, which Playwright does not take as ready; the open port is.
      port: Number(STORAGE_EMULATOR_HOST.split(':')[1]),
      reuseExistingServer: false,
      timeout: 180_000,
      gracefulShutdown: { signal: 'SIGINT', timeout: 15_000 },
    },
    {
      // Starts after the build above (Playwright starts these one after another) and reuses it.
      command: 'npx tsx tests/e2e/jobs/server.ts',
      url: `${JOBS_BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      // SIGTERM lets it stop the app and remove its database; a kill would leave PostgreSQL running.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
    },
  ],
});
