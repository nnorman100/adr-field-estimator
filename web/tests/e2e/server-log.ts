import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The app server's standard output: the log sink the TC-1 logger writes to (Cloud Run sends the
// same lines to Cloud Logging). playwright.config.ts sends the test server's stdout here. Under
// test-results/, which Playwright empties before it starts the servers, so a run never reads an
// earlier run's lines.
const webDir = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER_LOG_DIR = join(webDir, 'test-results', 'server-log');
export const SERVER_LOG = join(SERVER_LOG_DIR, 'stdout.log');

// Every line the server has written so far that holds `marker`, as written.
export function serverLogLinesWith(marker: string): string[] {
  if (!existsSync(SERVER_LOG)) return [];
  return readFileSync(SERVER_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.includes(marker));
}
