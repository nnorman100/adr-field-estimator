import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_LOG_DIR } from '../server-log';

// The App Check browser tests' app server (TC-5): the same production build and the same emulators
// and sign-in file as the main test server, started on a port of its own with App Check set up, so
// the other specs keep running with App Check off. The app id and site key are made up: nothing
// here reaches Google. The specs stand in for the token exchange (or stall reCAPTCHA) with
// page.route, and the server checks whatever token arrives as it would in production.
export const APP_CHECK_PORT = 3103;
export const APP_CHECK_BASE_URL = `http://localhost:${APP_CHECK_PORT}`;
export const APP_CHECK_ENV = {
  FIREBASE_APP_ID: '1:000000000000:web:0000000000e2e000',
  APP_CHECK_SITE_KEY: 'e2e-not-a-real-recaptcha-site-key',
};

// The same again for the screens that need the real database (the field app, Finish and review):
// tests/e2e/jobs/server.ts starts a second app on this port, beside the jobs server and on its
// database, with App Check set up.
export const APP_CHECK_JOBS_PORT = 3104;
export const APP_CHECK_JOBS_BASE_URL = `http://localhost:${APP_CHECK_JOBS_PORT}`;

// Its standard output, where its App Check lines go (beside the main server's, under test-results/).
export const APP_CHECK_SERVER_LOG = join(SERVER_LOG_DIR, 'app-check.log');

// Every App Check line the server has written so far, parsed.
export function appCheckLines(): Record<string, unknown>[] {
  if (!existsSync(APP_CHECK_SERVER_LOG)) return [];
  return readFileSync(APP_CHECK_SERVER_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"App Check"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
