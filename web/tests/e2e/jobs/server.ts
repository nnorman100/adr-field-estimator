// The job-screen tests' app server (playwright.config.ts starts it after the production build):
// a throwaway PostgreSQL 16 set up like a fresh Cloud SQL instance (the same roles and migrations
// as `npm run test:db`, tests/db/postgres-harness.ts), then `next start` on JOBS_PORT with the app
// connecting as the API login, which has only the runtime's rights under forced row-level security.
// Sign-in checks go to the Auth emulator, field drafts to the Firestore emulator and photo bytes to
// the Storage emulator. On SIGTERM or SIGINT it stops the app and removes the database.
//
//   tsx tests/e2e/jobs/server.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import postgres from 'postgres';
import {
  databaseUrlFor,
  loginUrl,
  prepareRolesServer,
  quoteDiscardName,
  startOwnedServer,
} from '../../db/postgres-harness';
import { APP_CHECK_ENV, APP_CHECK_JOBS_PORT } from '../app-check/server';
import { FIRESTORE_EMULATOR_HOST, FIELD_DATABASE } from '../offline/emulators';
import { AUTH_EMULATOR_HOST, E2E_PROJECT } from '../sign-in/emulator';
import { EVIDENCE_BUCKET, JOBS_BASE_URL, JOBS_PORT, JOBS_STATE, STORAGE_EMULATOR_HOST, type JobsState } from './backend';

async function main() {
  const server = await startOwnedServer();
  let app: ChildProcess | null = null;
  let appCheckApp: ChildProcess | null = null;
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    app?.kill('SIGTERM');
    appCheckApp?.kill('SIGTERM');
    await server.stop();
    process.exit(code);
  };
  process.on('SIGTERM', () => void stop(0));
  process.on('SIGINT', () => void stop(0));

  try {
    const { templateName, roles } = await prepareRolesServer(server.databaseUrl);
    const databaseName = `dryscope_discard_${randomBytes(8).toString('hex')}`;
    const admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE ${quoteDiscardName(databaseName)} TEMPLATE ${quoteDiscardName(templateName)}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const adminUrl = databaseUrlFor(server.databaseUrl, databaseName);
    const state: JobsState = { adminUrl };
    await mkdir(dirname(JOBS_STATE), { recursive: true });
    await writeFile(JOBS_STATE, JSON.stringify(state));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ENV: 'local',
      GOOGLE_CLOUD_PROJECT: E2E_PROJECT,
      DATABASE_URL: loginUrl(adminUrl, roles.api),
      FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      FIRESTORE_EMULATOR_HOST,
      FIRESTORE_DATABASE_ID: FIELD_DATABASE,
      EVIDENCE_BUCKET,
      // firebase-admin sends the evidence bucket's calls to the Storage emulator.
      FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
    };
    // The real database, never the file the sign-in specs' server reads in its place.
    delete env.LOCAL_SIGN_IN_FIXTURE;
    app = spawn('npx', ['next', 'start', '--port', String(JOBS_PORT)], { stdio: 'inherit', env });
    app.on('exit', (code) => void stop(code ?? 1));
    // Then the App Check copy (tests/e2e/app-check.spec.ts) on the same database, once the first
    // answers, so playwright.config.ts can wait on this one alone.
    await untilAnswering(`${JOBS_BASE_URL}/api/health`);
    appCheckApp = spawn('npx', ['next', 'start', '--port', String(APP_CHECK_JOBS_PORT)], {
      stdio: 'inherit',
      env: { ...env, ...APP_CHECK_ENV },
    });
    appCheckApp.on('exit', (code) => void stop(code ?? 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'the jobs test server did not start');
    await stop(1);
  }
}

async function untilAnswering(url: string) {
  for (let i = 0; i < 600; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('the jobs test server did not answer');
}

void main();
