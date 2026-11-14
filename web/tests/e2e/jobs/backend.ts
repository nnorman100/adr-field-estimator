// Where the job-screen browser tests (tests/e2e/jobs.spec.ts) find their backend: a second app
// server on its own port with a throwaway PostgreSQL 16 behind it (server.ts), the Firestore and
// Auth emulators the other specs use, and the Storage emulator standing in for the evidence bucket.
// Everything runs under a demo- project on loopback, so nothing here can reach a real project.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_EMU } from '../emu-ports';

export const JOBS_PORT = 3101;
export const JOBS_BASE_URL = `http://localhost:${JOBS_PORT}`;
export const STORAGE_EMULATOR_HOST = `127.0.0.1:${E2E_EMU.ports.storage}`;
export const EVIDENCE_BUCKET = 'dryscope-evidence-e2e';

const webDir = fileURLToPath(new URL('../../..', import.meta.url));
// Under test-results/, which Playwright empties before it starts the servers.
export const JOBS_STATE = join(webDir, 'test-results', 'jobs-state', 'database.json');
export const STORAGE_CONFIG = 'tests/e2e/jobs/storage/firebase.json';

// What server.ts writes once the database is migrated: the superuser address of the copy the app
// server uses, for the tests' own seeding and checks (never the app's login).
export type JobsState = { adminUrl: string };
